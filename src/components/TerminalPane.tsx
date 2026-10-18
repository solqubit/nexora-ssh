import { useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { AlertTriangle, ArrowDown, ArrowUp, ClipboardPaste, Copy, Eraser, Network, Power, RefreshCw, Search, ShieldCheck, TextSelect, X } from "lucide-react";
import {
  copyToClipboard,
  disconnectSshSession,
  openExternalUrl,
  readFromClipboard,
  resizeSshSession,
  startSshSession,
  startLocalSession,
  trustSshHostKey,
  writeSshSession,
} from "../lib/desktop";
import { useAppStore } from "../store/appStore";
import type { AppPreferences } from "../lib/preferences";
import { getTerminalTheme } from "../lib/terminalThemes";
import { prepareSnippetInput } from "../lib/terminalInput";
import { resolveConnectionProfile } from "../lib/connectionProfile";
import { LOCAL_POWERSHELL_ID, sessionSnapshot, connectionTargetLabel, hostEndpointLabel } from "../lib/sessionTarget";
import { hostEnvironment } from "../lib/hostFilters";
import type { Host, SessionStatus, SessionTab, SshEvent } from "../types";
import { ContextMenuSurface } from "./ContextMenuSurface";
import { useDialogFocus } from "../hooks/useDialogFocus";

interface HostKeyPrompt {
  hostId?: string;
  kind: "unknown" | "changed";
  algorithm: string;
  fingerprint: string;
  address: string;
  challengeId: string | null;
}

interface TerminalContextMenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

export function TerminalPane({ host, session, visible, focused = visible, showSessionTitle = true, preferences, onPreferencesChange, onSaveTemporary, onForgetTemporary }: { host: Host; session: SessionTab; visible: boolean; focused?: boolean; showSessionTitle?: boolean; preferences: AppPreferences; onPreferencesChange: (changes: Partial<AppPreferences>) => void; onSaveTemporary?: (hostId: string) => void; onForgetTemporary?: (host: Host) => void }) {
  const baseSnapshot = useAppStore(state => state.snapshot);
  const temporaryHosts = useAppStore(state => state.temporaryHosts);
  const snapshot = useMemo(() => sessionSnapshot(baseSnapshot, temporaryHosts), [baseSnapshot, temporaryHosts]);
  const isTemporary = temporaryHosts.some(item => item.host.id === host.id);
  const isLocal = host.id === LOCAL_POWERSHELL_ID;
  const effectiveHost = resolveConnectionProfile(snapshot, host, preferences.keepaliveSeconds).host;
  const environment = isLocal ? "Local" : hostEnvironment(snapshot, host.id);
  const [connectionTarget, setConnectionTarget] = useState<Host | null>(null);
  const displayedTarget = connectionTarget ?? effectiveHost;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchOpenRef = useRef(false);
  const statusRef = useRef<SessionStatus>(session.status);
  const mountedRef = useRef(true);
  const autoStartedRef = useRef(false);
  const fontSizeRef = useRef(preferences.terminalFontSize);
  const wheelZoomAtRef = useRef(0);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectIntervalRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const manualDisconnectRef = useRef(false);
  const preferencesRef = useRef(preferences);
  const focusedRef = useRef(focused);
  const connectionGenerationRef = useRef(0);
  const startRequestRef = useRef<Promise<void> | null>(null);
  const disconnectingRef = useRef(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const outputFrameRef = useRef<number | null>(null);
  const outputQueueRef = useRef<Uint8Array[]>([]);
  const flushInputRef = useRef<(() => Promise<void>) | null>(null);
  const [statusMessage, setStatusMessage] = useState("Sesión lista para conectar");
  const [hostKey, setHostKey] = useState<HostKeyPrompt | null>(null);
  const [fontSize, setFontSize] = useState(preferences.terminalFontSize);
  const [reconnectCountdown, setReconnectCountdown] = useState<{ attempt: number; seconds: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<TerminalContextMenuState | null>(null);
  const [hasPreviousAttempt, setHasPreviousAttempt] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCount, setSearchCount] = useState(0);
  const [searchPosition, setSearchPosition] = useState({ index: -1, count: 0 });
  const [searchFound, setSearchFound] = useState<boolean | null>(null);
  const setSessionStatus = useAppStore((state) => state.setSessionStatus);
  const rememberKnownHost = useAppStore((state) => state.rememberKnownHost);
  const recordHostActivity = useAppStore((state) => state.recordHostActivity);

  useEffect(() => { preferencesRef.current = preferences; }, [preferences]);
  useEffect(() => { focusedRef.current = focused; }, [focused]);

  useEffect(() => {
    const send = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; text: string; execute: boolean; resolve: () => void; reject: (reason: Error) => void }>).detail;
      if (detail?.sessionId !== session.id) return;
      if (statusRef.current !== "connected" || !terminalRef.current) { detail.reject(new Error("La sesión ya no está conectada.")); return; }
      let payload: string;
      try { payload = prepareSnippetInput(detail.text, detail.execute, terminalRef.current.modes.bracketedPasteMode); }
      catch (reason) { detail.reject(reason instanceof Error ? reason : new Error(String(reason))); return; }
      void (async () => {
        const generation = connectionGenerationRef.current;
        await flushInputRef.current?.();
        if (statusRef.current !== "connected" || generation !== connectionGenerationRef.current) throw new Error("La sesión cambió antes del envío.");
        await writeSshSession(session.id, payload);
      })().then(detail.resolve, reason => detail.reject(reason instanceof Error ? reason : new Error(String(reason))));
    };
    window.addEventListener("nexora:send-session-text", send);
    return () => window.removeEventListener("nexora:send-session-text", send);
  }, [session.id]);

  useEffect(() => {
    statusRef.current = session.status;
  }, [session.status]);

  useEffect(() => {
    const reconnect = (event: Event) => {
      const requestedSessionId = (event as CustomEvent<{ sessionId: string }>).detail?.sessionId;
      if (requestedSessionId !== session.id) return;
      void (async () => {
        connectionGenerationRef.current += 1;
        await stopNativeSession().catch(() => undefined);
        applyStatus("disconnected", "Reconectando la sesión…", false);
        await connect();
      })();
    };
    window.addEventListener("nexora:reconnect-session", reconnect);
    return () => window.removeEventListener("nexora:reconnect-session", reconnect);
  }, [host.address, host.id, host.port, session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    mountedRef.current = true;
    autoStartedRef.current = false;
    if (!containerRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: preferences.terminalCursor,
      // Requerido por registerDecoration(): sin esto el resaltado de búsqueda
      // lanza "You must set the allowProposedApi option to true".
      allowProposedApi: true,
      overviewRuler: { width: 14 },
      fontFamily: `"${preferences.terminalFontFamily}", Consolas, monospace`,
      fontSize: preferences.terminalFontSize,
      lineHeight: 1.35,
      scrollback: 10_000,
      allowTransparency: true,
      theme: getTerminalTheme(preferences.terminalTheme),
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    const searchResultsDisposable = searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
      setSearchPosition({ index: resultIndex, count: resultCount });
    });
    // El esquema se valida en el núcleo nativo: la salida remota no es de fiar.
    terminal.loadAddon(new WebLinksAddon((event, uri) => {
      event.preventDefault();
      void openExternalUrl(uri).catch(() => undefined);
    }));
    terminal.open(containerRef.current);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    fitAddon.fit();
    terminal.writeln(`\x1b[38;2;142;162;255mNexora\x1b[0m  \x1b[1m${isLocal ? "PowerShell · este equipo" : `${effectiveHost.username || "usuario"}@${effectiveHost.address}:${effectiveHost.port}`}\x1b[0m`);
    terminal.writeln(session.autoConnect === false ? `Sesión restaurada · pulsa ${isLocal ? "Abrir" : "Conectar"} para iniciar.` : isLocal ? "Abriendo PowerShell local…" : `Iniciando conexión ${host.protocol === "telnet" ? "Telnet" : "SSH"}…`);
    terminal.writeln("");

    const autoConnectTimer = window.setTimeout(() => {
      if (session.autoConnect === false) return;
      if (autoStartedRef.current) return;
      autoStartedRef.current = true;
      void connect();
    }, 120);

    let frame = 0;
    let lastWidth = 0;
    let lastHeight = 0;
    let inputQueue = "";
    let inputTimer = 0;
    let inputTail: Promise<void> = Promise.resolve();
    const flushInput = () => {
      if (inputTimer) window.clearTimeout(inputTimer);
      inputTimer = 0;
      if (!inputQueue || statusRef.current !== "connected") {
        inputQueue = "";
        return inputTail;
      }
      const data = inputQueue;
      const generation = connectionGenerationRef.current;
      inputQueue = "";
      const result = inputTail.then(() => { if (connectionGenerationRef.current !== generation || statusRef.current !== "connected") throw new Error("La sesión cambió antes del envío."); return writeSshSession(session.id, data); });
      inputTail = result.catch((reason) => {
        if (generation !== connectionGenerationRef.current) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        terminal.writeln(`\r\n\x1b[31mNo se pudo enviar la entrada: ${message}\x1b[0m`);
        applyStatus("error", message);
      });
      return result;
    };
    flushInputRef.current = flushInput;
    const inputDisposable = terminal.onData((data) => {
      if (statusRef.current !== "connected") return;
      inputQueue += data;
      if (!inputTimer) inputTimer = window.setTimeout(() => { void flushInput().catch(() => undefined); }, 8);
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (statusRef.current === "connected") void resizeSshSession(session.id, cols, rows).catch(() => undefined);
    });
    const selectionDisposable = terminal.onSelectionChange(() => {
      // La búsqueda selecciona cada coincidencia; no debe llenar el portapapeles.
      if (!preferencesRef.current.copyOnSelect || searchOpenRef.current) return;
      const selection = terminal.getSelection();
      if (selection) void copyToClipboard(selection).catch(() => undefined);
    });
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (!width || !height || (width === lastWidth && height === lastHeight)) return;
      lastWidth = width;
      lastHeight = height;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => fitAddon.fit());
    });
    observer.observe(containerRef.current);

    return () => {
      mountedRef.current = false;
      connectionGenerationRef.current += 1;
      observer.disconnect();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      selectionDisposable.dispose();
      searchResultsDisposable.dispose();
      window.cancelAnimationFrame(frame);
      window.clearTimeout(autoConnectTimer);
      if (reconnectTimeoutRef.current !== null) window.clearTimeout(reconnectTimeoutRef.current);
      if (reconnectIntervalRef.current !== null) window.clearInterval(reconnectIntervalRef.current);
      if (inputTimer) window.clearTimeout(inputTimer);
      flushInputRef.current = null;
      if (outputFrameRef.current !== null) window.cancelAnimationFrame(outputFrameRef.current);
      outputFrameRef.current = null;
      outputQueueRef.current = [];
      void stopNativeSession().catch(() => undefined);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [host.id, session.autoConnect, session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (preferences.terminalFontSize !== fontSizeRef.current) setTerminalFontSize(preferences.terminalFontSize, false);
  }, [preferences.terminalFontSize]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = getTerminalTheme(preferences.terminalTheme);
  }, [preferences.terminalTheme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontFamily = `"${preferences.terminalFontFamily}", Consolas, monospace`;
    terminal.options.cursorStyle = preferences.terminalCursor;
    fitAddonRef.current?.fit();
  }, [preferences.terminalFontFamily, preferences.terminalCursor]);

  useEffect(() => {
    if (!preferences.autoReconnect) cancelScheduledReconnect(true);
  }, [preferences.autoReconnect]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!visible || !focused) {
      setContextMenu(null);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      terminalRef.current?.focus();
    });

    const overlayOpen = () => Boolean(document.querySelector(".modal-backdrop, .settings-backdrop, .host-key-backdrop"));
    const handleZoomKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (!["+", "=", "-", "_", "0"].includes(event.key)) return;
      if (overlayOpen()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "0") setTerminalFontSize(14);
      else changeTerminalFontSize(event.key === "+" || event.key === "=" ? 1 : -1);
    };
    const handleZoomWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (overlayOpen()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const now = performance.now();
      if (now - wheelZoomAtRef.current < 80) return;
      wheelZoomAtRef.current = now;
      changeTerminalFontSize(event.deltaY < 0 ? 1 : -1);
    };
    // Solo Ctrl+Shift: esas combinaciones no llegan al PTY, así que no pisan
    // los atajos de las aplicaciones remotas (nano usa Ctrl+W, Ctrl+F…).
    const handleTerminalShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (!["c", "v", "f"].includes(key)) return;
      if (overlayOpen()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (key === "c") void copyTerminalSelection();
      else if (key === "v") void pasteIntoTerminal();
      else openTerminalSearch();
    };
    const closeContextMenuOutsideTerminal = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".terminal-pane") && !target.closest(".terminal-context-menu")) setContextMenu(null);
    };
    window.addEventListener("keydown", handleZoomKey, true);
    window.addEventListener("keydown", handleTerminalShortcut, true);
    window.addEventListener("wheel", handleZoomWheel, { capture: true, passive: false });
    document.addEventListener("contextmenu", closeContextMenuOutsideTerminal, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleZoomKey, true);
      window.removeEventListener("keydown", handleTerminalShortcut, true);
      window.removeEventListener("wheel", handleZoomWheel, true);
      document.removeEventListener("contextmenu", closeContextMenuOutsideTerminal, true);
    };
  }, [visible, focused]); // eslint-disable-line react-hooks/exhaustive-deps

  function setTerminalFontSize(requestedSize: number, persist = true) {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const nextSize = Math.min(24, Math.max(10, requestedSize));
    fontSizeRef.current = nextSize;
    terminal.options.fontSize = nextSize;
    setFontSize(nextSize);
    if (persist) onPreferencesChange({ terminalFontSize: nextSize });
    window.requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      terminal.scrollToBottom();
      terminal.focus();
      if (statusRef.current === "connected") {
        void resizeSshSession(session.id, terminal.cols, terminal.rows).catch(() => undefined);
      }
    });
  }

  function changeTerminalFontSize(delta: number) {
    setTerminalFontSize(fontSizeRef.current + delta);
  }

  function openTerminalContextMenu(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const terminal = terminalRef.current;
    terminal?.focus();
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 240),
      y: Math.min(event.clientY, window.innerHeight - 230),
      hasSelection: Boolean(terminal?.hasSelection()),
    });
  }

  async function copyTerminalSelection() {
    const selection = terminalRef.current?.getSelection() ?? "";
    setContextMenu(null);
    if (!selection) return;
    try {
      await copyToClipboard(selection);
    } catch {
      terminalRef.current?.writeln("\r\n\x1b[31mNo se pudo copiar al portapapeles.\x1b[0m");
    }
  }

  async function pasteIntoTerminal() {
    setContextMenu(null);
    if (statusRef.current !== "connected") return;
    try {
      const text = await readFromClipboard();
      if (text) await writeSshSession(session.id, text);
      terminalRef.current?.focus();
    } catch {
      terminalRef.current?.writeln("\r\n\x1b[31mNo se pudo leer el portapapeles.\x1b[0m");
    }
  }

  function runSearch(query: string, direction: "next" | "previous", incremental = false) {
    const addon = searchAddonRef.current;
    if (!addon) return;
    if (!query) {
      addon.clearDecorations();
      setSearchCount(0);
      setSearchPosition({ index: -1, count: 0 });
      setSearchFound(null);
      return;
    }
    // `incremental` evita que cada tecla salte a la coincidencia siguiente.
    const options = {
      incremental,
      decorations: {
        activeMatchBackground: "#8ea2ff",
        activeMatchBorder: "#c3cdff",
        activeMatchColorOverviewRuler: "#8ea2ff",
        matchBackground: "#39415e",
        matchOverviewRuler: "#6b7590",
      },
    };
    let found: boolean;
    try {
      found = direction === "next" ? addon.findNext(query, options) : addon.findPrevious(query, options);
    } catch {
      found = false;
    }
    setSearchFound(found);
    setSearchCount(countMatches(query));
  }

  /** El addon solo expone el total con decoraciones activas, así que se cuenta aquí. */
  function countMatches(query: string): number {
    const terminal = terminalRef.current;
    if (!terminal || !query) return 0;
    const needle = query.toLowerCase();
    const buffer = terminal.buffer.active;
    const limit = buffer.baseY + terminal.rows;
    let total = 0;
    let logical = "";
    const countInLogicalLine = () => {
      if (!logical) return;
      const text = logical.toLowerCase();
      for (let from = text.indexOf(needle); from !== -1; from = text.indexOf(needle, from + needle.length)) total += 1;
      logical = "";
    };
    for (let row = 0; row < limit; row += 1) {
      const line = buffer.getLine(row);
      if (!line) continue;
      // Una línea envuelta continúa la anterior: se unen antes de contar.
      if (!line.isWrapped) countInLogicalLine();
      logical += line.translateToString(true);
    }
    countInLogicalLine();
    return total;
  }

  function openTerminalSearch() {
    setContextMenu(null);
    searchOpenRef.current = true;
    setSearchOpen(true);
    window.requestAnimationFrame(() => searchInputRef.current?.select());
  }

  function closeTerminalSearch() {
    searchOpenRef.current = false;
    setSearchOpen(false);
    setSearchQuery("");
    setSearchCount(0);
    setSearchPosition({ index: -1, count: 0 });
    setSearchFound(null);
    searchAddonRef.current?.clearDecorations();
    terminalRef.current?.clearSelection();
    terminalRef.current?.focus();
  }

  function cancelScheduledReconnect(resetAttempts: boolean) {
    if (reconnectTimeoutRef.current !== null) window.clearTimeout(reconnectTimeoutRef.current);
    if (reconnectIntervalRef.current !== null) window.clearInterval(reconnectIntervalRef.current);
    reconnectTimeoutRef.current = null;
    reconnectIntervalRef.current = null;
    setReconnectCountdown(null);
    if (resetAttempts) reconnectAttemptRef.current = 0;
  }

  function scheduleReconnect() {
    const currentPreferences = preferencesRef.current;
    if (!currentPreferences.autoReconnect || manualDisconnectRef.current) return;
    const attempt = reconnectAttemptRef.current + 1;
    if (attempt > currentPreferences.reconnectAttempts) {
      setStatusMessage(`Reconexión detenida después de ${currentPreferences.reconnectAttempts} intentos`);
      return;
    }
    cancelScheduledReconnect(false);
    let seconds = currentPreferences.reconnectDelaySeconds;
    setReconnectCountdown({ attempt, seconds });
    reconnectIntervalRef.current = window.setInterval(() => {
      seconds = Math.max(0, seconds - 1);
      setReconnectCountdown({ attempt, seconds });
    }, 1_000);
    reconnectTimeoutRef.current = window.setTimeout(() => {
      if (reconnectIntervalRef.current !== null) window.clearInterval(reconnectIntervalRef.current);
      reconnectIntervalRef.current = null;
      reconnectTimeoutRef.current = null;
      reconnectAttemptRef.current = attempt;
      setReconnectCountdown(null);
      terminalRef.current?.writeln(`\r\n\x1b[38;2;142;162;255m› Reintento ${attempt} de ${currentPreferences.reconnectAttempts}…\x1b[0m`);
      void (async () => {
        connectionGenerationRef.current += 1;
        await disconnectSshSession(session.id).catch(() => undefined);
        applyStatus("disconnected", "Preparando reconexión…", false);
        await connect(true);
      })();
    }, seconds * 1_000);
  }

  function applyStatus(status: SessionStatus, message: string | null, allowReconnect = true, retryable = false) {
    if (!mountedRef.current) return;
    statusRef.current = status;
    setSessionStatus(session.id, status);
    if (message) setStatusMessage(message);
    if (status === "connected") {
      manualDisconnectRef.current = false;
      cancelScheduledReconnect(true);
      if (!isLocal) recordHostActivity(host.id, "success", message);
      window.requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        const terminal = terminalRef.current;
        if (!terminal) return;
        terminal.scrollToBottom();
        if (focusedRef.current) terminal.focus();
        void resizeSshSession(session.id, terminal.cols, terminal.rows).catch(() => undefined);
      });
    } else if (status === "error") {
      if (!isLocal) recordHostActivity(host.id, "error", message);
      if (allowReconnect && retryable) scheduleReconnect();
    }
  }

  function handleEvent(event: SshEvent) {
    if (!mountedRef.current) return;
    if (event.event === "output") {
      useAppStore.getState().markSessionOutput(session.id, focusedRef.current);
      outputQueueRef.current.push(decodeBase64(event.data.data));
      if (outputFrameRef.current === null) {
        outputFrameRef.current = window.requestAnimationFrame(flushTerminalOutput);
      }
      return;
    }
    if (event.event === "status") {
      applyStatus(event.data.status, event.data.message, true, event.data.retryable ?? false);
      return;
    }
    if (event.event === "stage") {
      setStatusMessage(event.data.message);
      return;
    }
    setHostKey(event.data);
  }

  function flushTerminalOutput() {
    outputFrameRef.current = null;
    const chunks = outputQueueRef.current;
    outputQueueRef.current = [];
    if (!chunks.length) return;
    const totalLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const output = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    terminalRef.current?.write(output);
  }

  async function connect(isRetry = false) {
    if (disconnectingRef.current || startRequestRef.current || statusRef.current === "connecting" || statusRef.current === "connected") return;
    if (!isRetry) cancelScheduledReconnect(true);
    manualDisconnectRef.current = false;
    setHostKey(null);
    const state = useAppStore.getState();
    const currentSnapshot = sessionSnapshot(state.snapshot, state.temporaryHosts);
    const target = resolveConnectionProfile(currentSnapshot, currentSnapshot.hosts.find(item => item.id === host.id) ?? host, preferencesRef.current.keepaliveSeconds).host;
    setConnectionTarget(target);
    const connectionMessage = isLocal ? "Abriendo PowerShell local…" : `Conectando con ${hostEndpointLabel(target)}…`;
    if (!isLocal) recordHostActivity(host.id, "attempt", connectionMessage);
    setHasPreviousAttempt(true);
    applyStatus("connecting", connectionMessage);
    terminalRef.current?.writeln(`\r\n\x1b[38;2;142;162;255m› ${connectionMessage}\x1b[0m`);
    const generation = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = generation;
    try {
      const terminal = terminalRef.current;
      const onEvent = (event: SshEvent) => { if (connectionGenerationRef.current === generation) handleEvent(event); };
      const request = isLocal ? startLocalSession(session.id, terminal?.cols ?? 80, terminal?.rows ?? 24, onEvent) : startSshSession(
        session.id,
        host.id,
        terminal?.cols ?? 80,
        terminal?.rows ?? 24,
        preferencesRef.current.keepaliveSeconds,
        onEvent,
      );
      startRequestRef.current = request;
      try { await request; }
      finally { if (startRequestRef.current === request) startRequestRef.current = null; }
    } catch (reason) {
      if (connectionGenerationRef.current !== generation) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      terminalRef.current?.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
      applyStatus("error", message);
    }
  }

  async function stopNativeSession() {
    // Espera la confirmación de registro IPC para que cancelar no adelante al alta.
    await startRequestRef.current?.catch(() => undefined);
    await disconnectSshSession(session.id);
  }

  async function disconnect() {
    if (disconnectingRef.current) return;
    disconnectingRef.current = true; setDisconnecting(true);
    manualDisconnectRef.current = true;
    cancelScheduledReconnect(true);
    connectionGenerationRef.current += 1;
    setStatusMessage("Cerrando la conexión…");
    try {
      await stopNativeSession();
      applyStatus("disconnected", "Sesión cerrada", false);
    } catch (reason) {
      applyStatus("error", reason instanceof Error ? reason.message : String(reason), false);
    } finally {
      disconnectingRef.current = false;
      if (mountedRef.current) setDisconnecting(false);
    }
  }

  async function trustAndConnect() {
    try {
      const known = await trustSshHostKey(hostKey?.hostId ?? host.id, hostKey?.challengeId ?? null, hostKey?.kind === "changed");
      rememberKnownHost(known);
      // La negociación inicial se cierra al rechazar una huella desconocida.
      // Elimina cualquier remitente pendiente antes de abrir la sesión confiable.
      connectionGenerationRef.current += 1;
      await stopNativeSession();
      setHostKey(null);
      applyStatus("disconnected", "Huella guardada; reconectando…");
      await connect();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      terminalRef.current?.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
      applyStatus("error", message);
    }
  }

  const busy = session.status === "connecting";
  const connected = session.status === "connected";
  return (
    <section
      id={`terminal-panel-${session.id}`}
      role="tabpanel"
      aria-labelledby={`session-tab-${session.id}`}
      className={`terminal-workspace ${visible ? "" : "terminal-hidden"}`}
      style={{ "--terminal-background": getTerminalTheme(preferences.terminalTheme).background } as React.CSSProperties}
      aria-hidden={!visible}
      hidden={!visible}
    >
      <div className={`terminal-toolbar ${showSessionTitle ? "" : "single-session"}`}>
        <div className="terminal-identity">{showSessionTitle && <span style={{ background: host.color }}>{host.name.slice(0, 1).toUpperCase()}</span>}<div>{showSessionTitle && <strong title={session.title}>{session.title}</strong>}<small title={isLocal ? "Este equipo · Windows PowerShell" : connectionTargetLabel(displayedTarget)}>{isLocal ? "Este equipo · Windows PowerShell" : connectionTargetLabel(displayedTarget)}</small></div></div>
        <div className="terminal-zoom" aria-label="Zoom del terminal">
          <button type="button" onClick={() => changeTerminalFontSize(-1)} aria-label="Reducir texto">A−</button>
          <button type="button" className="zoom-value" onClick={() => setTerminalFontSize(14)} title="Restablecer zoom">{Math.round(fontSize / 14 * 100)}%</button>
          <button type="button" onClick={() => changeTerminalFontSize(1)} aria-label="Aumentar texto">A+</button>
        </div>
        <button type="button" className={`icon-button terminal-search-toggle ${searchOpen ? "active" : ""}`} onClick={() => searchOpen ? closeTerminalSearch() : openTerminalSearch()} title="Buscar en la terminal (Ctrl Shift F)" aria-label="Buscar en la terminal"><Search size={16} /></button>
        {environment && <span className="environment-badge terminal-environment" style={{ "--host-color": host.color } as React.CSSProperties} title={`Entorno: ${environment}`}>{environment}</span>}
        <div className={`connection-state ${session.status}`} aria-label={statusLabel(session.status)} title={statusMessage || statusLabel(session.status)}><i aria-hidden="true" /><span>{statusLabel(session.status)}</span></div>
        {connected ? (
          <button className="button disconnect-button" disabled={disconnecting} aria-label={disconnecting ? "Cerrando…" : "Desconectar"} title="Desconectar" onClick={() => void disconnect()}><Power size={16} /><span>{disconnecting ? "Cerrando…" : "Desconectar"}</span></button>
        ) : busy ? (
          <button className="button disconnect-button" disabled={disconnecting} aria-label={disconnecting ? "Cancelando…" : "Cancelar"} title="Cancelar conexión" onClick={() => void disconnect()}><X size={16} /><span>{disconnecting ? "Cancelando…" : "Cancelar"}</span></button>
        ) : (
          <button className="button connect-button" disabled={busy} aria-label={isLocal ? hasPreviousAttempt ? "Reabrir" : "Abrir" : hasPreviousAttempt ? "Reconectar" : "Conectar"} title={isLocal ? "Abrir PowerShell" : "Conectar al servidor"} onClick={() => void connect()}><Network size={16} /><span>{isLocal ? hasPreviousAttempt ? "Reabrir" : "Abrir" : hasPreviousAttempt ? "Reconectar" : "Conectar"}</span></button>
        )}
      </div>
      {isTemporary && <div className="temporary-session-banner"><span>Conexión temporal · se olvida al cerrar Nexora</span>{onSaveTemporary && <button type="button" onClick={() => onSaveTemporary(host.id)}>Guardar host</button>}{onForgetTemporary && <button type="button" onClick={() => onForgetTemporary(host)}>Olvidar</button>}</div>}
      {busy && <div className="connection-progress" role="status"><RefreshCw size={14} /><span>{statusMessage}</span></div>}
      {session.status === "error" && !reconnectCountdown && <div className="connection-progress connection-failure" role="alert"><AlertTriangle size={14} /><span>{statusMessage}</span></div>}
      {reconnectCountdown && (
        <div className="reconnect-banner">
          <RefreshCw size={14} />
          <span>Reconectando en <strong>{reconnectCountdown.seconds}s</strong><small>Intento {reconnectCountdown.attempt} de {preferences.reconnectAttempts}</small></span>
          <button type="button" onClick={() => { manualDisconnectRef.current = true; cancelScheduledReconnect(true); setStatusMessage("Reconexión automática cancelada"); }}>Cancelar</button>
        </div>
      )}
      {searchOpen && (
        <div className="terminal-search" role="search">
          <Search size={14} />
          <input
            ref={searchInputRef}
            autoFocus
            value={searchQuery}
            className={searchQuery && searchFound === false ? "no-matches" : ""}
            placeholder="Buscar en el historial…"
            aria-label="Buscar en el historial de la terminal"
            onChange={(event) => { setSearchQuery(event.target.value); runSearch(event.target.value, "next", true); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); closeTerminalSearch(); }
              if (event.key === "Enter") { event.preventDefault(); runSearch(searchQuery, event.shiftKey ? "previous" : "next"); }
            }}
          />
          {searchQuery && searchFound !== null && <small className={searchFound ? "" : "no-matches"} aria-live="polite">
            {!searchFound
              ? "Sin resultados"
              : searchPosition.index >= 0 && searchPosition.count > 0
                ? `${searchPosition.index + 1} de ${searchPosition.count}`
                : searchCount === 1 ? "1 coincidencia" : `${searchCount} coincidencias`}
          </small>}
          <button type="button" onClick={() => runSearch(searchQuery, "previous")} disabled={!searchQuery} title="Anterior (Shift Enter)" aria-label="Coincidencia anterior"><ArrowUp size={14} /></button>
          <button type="button" onClick={() => runSearch(searchQuery, "next")} disabled={!searchQuery} title="Siguiente (Enter)" aria-label="Coincidencia siguiente"><ArrowDown size={14} /></button>
          <button type="button" onClick={closeTerminalSearch} title="Cerrar búsqueda (Esc)" aria-label="Cerrar búsqueda"><X size={14} /></button>
        </div>
      )}
      <div
        className="terminal-pane"
        ref={containerRef}
        role="application"
        aria-label={isLocal ? "Terminal PowerShell local" : `Terminal ${host.protocol === "telnet" ? "Telnet" : "SSH"} de ${host.name}`}
        onMouseDown={(event) => {
          if (!(event.target as HTMLElement).closest(".terminal-context-menu")) setContextMenu(null);
          window.requestAnimationFrame(() => terminalRef.current?.focus());
        }}
        onContextMenu={openTerminalContextMenu}
      />

      {contextMenu && (
        <ContextMenuSurface className="terminal-context-menu" x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
          <div className="context-menu-title">{isLocal ? "POWERSHELL LOCAL" : host.protocol === "telnet" ? "TERMINAL TELNET" : "TERMINAL SSH"}</div>
          <button role="menuitem" disabled={!contextMenu.hasSelection} onClick={() => void copyTerminalSelection()}><Copy size={15} /><span>Copiar selección</span><kbd>Ctrl Shift C</kbd></button>
          <button role="menuitem" disabled={!connected} onClick={() => void pasteIntoTerminal()}><ClipboardPaste size={15} /><span>Pegar</span><kbd>Ctrl Shift V</kbd></button>
          <button role="menuitem" onClick={() => { terminalRef.current?.selectAll(); setContextMenu(null); terminalRef.current?.focus(); }}><TextSelect size={15} /><span>Seleccionar todo</span></button>
          <button role="menuitem" onClick={openTerminalSearch}><Search size={15} /><span>Buscar…</span><kbd>Ctrl Shift F</kbd></button>
          <div className="context-menu-separator" />
          <button role="menuitem" onClick={() => { terminalRef.current?.clear(); setContextMenu(null); terminalRef.current?.focus(); }}><Eraser size={15} /><span>Limpiar terminal</span></button>
          {connected && <button className="context-danger" role="menuitem" onClick={() => { setContextMenu(null); void disconnect(); }}><Power size={15} /><span>Desconectar</span></button>}
        </ContextMenuSurface>
      )}

      {hostKey && <HostKeyDialog prompt={hostKey} onClose={() => setHostKey(null)} onTrust={trustAndConnect} />}
    </section>
  );
}

function HostKeyDialog({ prompt, onClose, onTrust }: { prompt: HostKeyPrompt; onClose: () => void; onTrust: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose, busy);
  async function confirm() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true);
    try { await onTrust(); } finally { submitting.current = false; setBusy(false); }
  }
  return (
    <div className="host-key-backdrop">
      <div ref={dialogRef} className={`host-key-dialog ${prompt.kind}`} role="alertdialog" aria-modal="true" aria-label="Verificar identidad del servidor" tabIndex={-1}>
        <span className="host-key-icon">{prompt.kind === "unknown" ? <ShieldCheck size={24} /> : <AlertTriangle size={24} />}</span>
        <div className="host-key-copy">
          <p className="eyebrow">IDENTIDAD DEL SERVIDOR</p>
          <h3>{prompt.kind === "unknown" ? "Confirma esta huella" : "La huella cambió"}</h3>
          <p>{prompt.kind === "unknown" ? "Es la primera conexión con este host. Comprueba la huella antes de guardarla." : "La clave difiere de la guardada. Si reinstalaste el servidor, verifica esta huella y confirma su reemplazo para conectar."}</p>
          <dl><dt>Servidor</dt><dd>{prompt.address}</dd><dt>Algoritmo</dt><dd>{prompt.algorithm}</dd><dt>Huella SHA-256</dt><dd>{prompt.fingerprint}</dd></dl>
        </div>
        <div className="host-key-actions">
          <button className="button secondary" disabled={busy} onClick={onClose}><X size={15} /> Cerrar</button>
          {prompt.challengeId && <button className="button primary" disabled={busy} onClick={() => void confirm()}><ShieldCheck size={15} /> {busy ? "Conectando…" : prompt.kind === "changed" ? "Reemplazar clave y conectar" : "Confiar y conectar"}</button>}
        </div>
      </div>
    </div>
  );
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = window.atob(encoded);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case "connecting": return "Conectando";
    case "connected": return "Conectado";
    case "trust_required": return "Verificar huella";
    case "error": return "Error";
    default: return "Desconectado";
  }
}
