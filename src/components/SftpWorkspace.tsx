import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { ActionMenu } from "./ActionMenu";
import { Disclosure } from "./Disclosure";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  ArrowUp,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Eye,
  EyeOff,
  File,
  FileQuestion,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  KeyRound,
  List,
  LoaderCircle,
  Monitor,
  Pause,
  Pencil,
  Play,
  PlugZap,
  RefreshCw,
  RotateCcw,
  Search,
  Scissors,
  Server,
  ShieldAlert,
  ShieldCheck,
  Star,
  TerminalSquare,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import {
  cancelFileTransfer,
  chmodSftpEntry,
  cleanupPreparedDrag,
  connectSftp,
  copyLocalEntry,
  copyToClipboard as writeSystemClipboard,
  createLocalFile,
  createLocalDirectory,
  createSftpDirectory,
  createSftpFile,
  deleteLocalEntry,
  deleteSftpEntry,
  disconnectSftp,
  listLocalDirectory,
  listSftpDirectory,
  prepareFileDrag,
  renameLocalEntry,
  renameSftpEntry,
  startFileDrag,
  transferLocalToSftp,
  transferSftpToLocal,
  transferSftpToSftp,
  trustSshHostKey,
} from "../lib/desktop";
import type { Host, HostActivity, LocalDirectory, LocalEntry, SftpDirectory, SftpEntry, SavedFileLayout, SavedFileLocation } from "../types";
import { fileLayoutSchema } from "../lib/productivityValidation";
import { ContextMenuSurface } from "./ContextMenuSurface";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { nextFileSelection } from "../lib/fileSelection";
import { RemoteTextEditor } from "./RemoteTextEditor";
import { useAppStore } from "../store/appStore";

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
type PaneSide = "left" | "right";
type PaneEntry = LocalEntry | SftpEntry;
type PaneSource = { kind: "local" } | { kind: "host"; hostId: string };
type PaneDirectory = LocalDirectory | SftpDirectory;
const FILE_ROW_HEIGHT = 38;
interface PaneState {
  source: PaneSource;
  directory: PaneDirectory | null;
  selectedPaths: string[];
  status: ConnectionStatus;
  error: string | null;
  latencyMs: number | null;
  reconnectAttempts: number;
  restoredPath: string | null;
}
type NameDialog =
  | { type: "folder"; side: PaneSide }
  | { type: "file"; side: PaneSide }
  | { type: "rename"; side: PaneSide; entry: PaneEntry }
  | null;
type PermissionsDialog = { side: PaneSide; entry: PaneEntry } | null;
type TrustPrompt = {
  verificationHostId?: string;
  kind: "unknown" | "changed";
  algorithm: string;
  fingerprint: string;
  address: string;
  challengeId: string | null;
  side: PaneSide;
  hostId: string;
  path: string | null;
} | null;
type ConfirmDialog =
  | { type: "delete"; side: PaneSide; entry: PaneEntry }
  | { type: "bulk_delete"; side: PaneSide; entries: PaneEntry[] }
  | null;
type PaneContextMenu = { x: number; y: number; side: PaneSide; entry: PaneEntry | null; entries: PaneEntry[] } | null;
type TransferJobStatus = "queued" | "running" | "conflict" | "completed" | "skipped" | "cancelled" | "error";
type ConflictPolicy = "ask" | "replace_all" | "skip_all" | "keep_all";
type ConflictChoice = "replace_once" | "replace_all" | "skip_once" | "skip_all" | "keep_once" | "keep_all" | "cancel_batch";
type TransferDestination =
  | { kind: "local"; path: string; label: string }
  | { kind: "host"; hostId: string; path: string; label: string };
type TransferSource =
  | { kind: "local"; path: string; label: string }
  | { kind: "host"; hostId: string; path: string; label: string };
interface TransferJob {
  id: string;
  batchId: string;
  sourcePath: string;
  source: TransferSource;
  sourceIsDirectory: boolean;
  operation: "copy" | "move";
  name: string;
  destination: TransferDestination;
  status: TransferJobStatus;
  estimatedBytes: number;
  transferredBytes: number;
  fileCount: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  stagingRoot: string | null;
  stagingAvailableBytes: number | null;
}
type QueueConflictPrompt = { jobId: string; name: string; isDirectory: boolean; destination: string } | null;
interface InternalDragSource {
  side: PaneSide;
  paneSource: PaneSource;
  entries: PaneEntry[];
  stagingRoot: string | null;
  estimatedBytes: number;
  availableBytes: number;
}
interface FileClipboard {
  mode: "copy" | "move";
  sourceSide: PaneSide;
  source: PaneSource;
  entries: PaneEntry[];
}
interface PaneNavigation {
  back: string[];
  forward: string[];
}
interface FavoriteLocation {
  id: string;
  sourceKey: string;
  path: string;
  label: string;
}
type PaneSortKey = "name" | "size" | "modified";
interface PaneViewSettings {
  sortKey: PaneSortKey;
  sortDirection: "asc" | "desc";
  showHidden: boolean;
  sizeColumn: number;
  modifiedColumn: number;
}

type ResizableColumn = "sizeColumn" | "modifiedColumn";

/** Límites por columna: "Modificado" necesita más ancho para la fecha completa. */
const COLUMN_WIDTH_LIMITS: Record<ResizableColumn, { min: number; max: number }> = {
  sizeColumn: { min: 58, max: 180 },
  modifiedColumn: { min: 70, max: 180 },
};

function clampColumnWidth(column: ResizableColumn, width: number): number {
  const { min, max } = COLUMN_WIDTH_LIMITS[column];
  return Math.max(min, Math.min(max, Math.round(width)));
}

interface SftpWorkspaceProps {
  host: Host | null;
  hosts: Host[];
  hostActivity: Record<string, HostActivity>;
  keepaliveSeconds: number;
  onRecordHostActivity: (hostId: string, result: "attempt" | "success" | "error", message?: string | null) => void;
  onOpenSsh: (host: Host) => void;
  ref?: Ref<SftpWorkspaceHandle>;
}
export interface SftpWorkspaceHandle { capture: () => SavedFileLayout; restore: (layout: SavedFileLayout) => Promise<void>; detachHost: (hostId: string) => Promise<void> }

const paneSides: PaneSide[] = ["left", "right"];

export function SftpWorkspace({ host, hosts, hostActivity, keepaliveSeconds, onRecordHostActivity, onOpenSsh, ref }: SftpWorkspaceProps) {
  const [panes, setPanes] = useState<Record<PaneSide, PaneState>>({
    left: emptyPane({ kind: "local" }),
    right: emptyPane(host ? { kind: "host", hostId: host.id } : { kind: "local" }),
  });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialog>(null);
  const [permissionsDialog, setPermissionsDialog] = useState<PermissionsDialog>(null);
  const [editingFile, setEditingFile] = useState<{ hostId: string; hostName: string; path: string; side: PaneSide } | null>(null);
  const editorStateRef = useRef({ dirty: false, busy: false });
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog>(null);
  const [trustPrompt, setTrustPrompt] = useState<TrustPrompt>(null);
  const [paneContextMenu, setPaneContextMenu] = useState<PaneContextMenu>(null);
  const [dropTarget, setDropTarget] = useState<PaneSide | null>(null);
  const [rightHostBrowserOpen, setRightHostBrowserOpen] = useState(true);
  const [hostBrowserSearch, setHostBrowserSearch] = useState("");
  const [transferJobs, setTransferJobs] = useState<TransferJob[]>(restoreTransferJobs);
  const [transferQueueOpen, setTransferQueueOpen] = useState(false);
  const [queuePaused, setQueuePaused] = useState(false);
  const [queueConflict, setQueueConflict] = useState<QueueConflictPrompt>(null);
  const [paneNavigation, setPaneNavigation] = useState<Record<PaneSide, PaneNavigation>>({ left: { back: [], forward: [] }, right: { back: [], forward: [] } });
  const [favoriteLocations, setFavoriteLocations] = useState<FavoriteLocation[]>(restoreFavoriteLocations);
  const [fileClipboard, setFileClipboard] = useState<FileClipboard | null>(null);
  const [splitPercent, setSplitPercent] = useState(restoreSplitPercent);
  const workspaceRef = useRef<HTMLElement>(null);
  const panesRef = useRef(panes);
  const mountedRef = useRef(true);
  const restoringRef = useRef(false);
  const paneGenerationRef = useRef<Record<PaneSide, number>>({ left: 0, right: 0 });
  const pendingPaneRequestsRef = useRef(new Set<string>());
  const connectedHostIdsRef = useRef(new Set<string>());
  const internalDragSourceRef = useRef<InternalDragSource | null>(null);
  const internalDropHandledRef = useRef(false);
  const dropHandlerRef = useRef<(paths: string[], target: PaneSide, source: InternalDragSource | null) => void>(() => undefined);
  const selectionAnchorRef = useRef<Record<PaneSide, string | null>>({ left: null, right: null });
  const transferJobsRef = useRef<TransferJob[]>(transferJobs);
  const queueRunningRef = useRef(false);
  const queuePausedRef = useRef(queuePaused);
  const batchPoliciesRef = useRef(new Map<string, ConflictPolicy>());
  const cancelledBatchesRef = useRef(new Set<string>());
  const conflictResolverRef = useRef<((choice: ConflictChoice) => void) | null>(null);
  const reconnectTimersRef = useRef<Record<PaneSide, number | null>>({ left: null, right: null });
  const paneNavigationRef = useRef(paneNavigation);
  panesRef.current = panes;
  paneNavigationRef.current = paneNavigation;
  transferJobsRef.current = transferJobs;
  queuePausedRef.current = queuePaused;

  useImperativeHandle(ref, () => ({
    detachHost: async hostId => {
      if (restoringRef.current || busyAction || pendingPaneRequestsRef.current.size || editorStateRef.current.dirty || editorStateRef.current.busy || transferJobsRef.current.some(job => ["queued", "running", "conflict"].includes(job.status))) throw new Error("Termina las operaciones de archivos y guarda o descarta el borrador antes de olvidar esta conexión.");
      restoringRef.current = true; setBusyAction("forget-temporary");
      try {
        const affected = paneSides.filter(side => { const source = panesRef.current[side].source; return source.kind === "host" && source.hostId === hostId; });
        for (const side of affected) {
          paneGenerationRef.current[side] += 1;
          if (reconnectTimersRef.current[side] !== null) window.clearTimeout(reconnectTimersRef.current[side]!);
          reconnectTimersRef.current[side] = null;
        }
        await disconnectSftp(hostId);
        if (!mountedRef.current) throw new Error("El gestor de archivos se cerró antes de desconectar.");
        connectedHostIdsRef.current.delete(hostId);
        for (const side of affected) {
          selectionAnchorRef.current[side] = null;
          updatePane(side, emptyPane({ kind: "local" }));
          setPaneNavigation(current => ({ ...current, [side]: { back: [], forward: [] } }));
        }
        setFileClipboard(current => current?.source.kind === "host" && current.source.hostId === hostId ? null : current);
        setTrustPrompt(current => current?.hostId === hostId ? null : current);
        setPaneContextMenu(current => current && affected.includes(current.side) ? null : current);
        if (editingFile?.hostId === hostId) setEditingFile(null);
        await Promise.all(affected.map(side => loadLocalPane(side, null)));
      } finally { restoringRef.current = false; if (mountedRef.current) setBusyAction(null); }
    },
    capture: () => {
      const location = (side: PaneSide): SavedFileLocation => {
        const pane = panesRef.current[side];
        return { ...pane.source, path: pane.directory?.path ?? pane.restoredPath };
      };
      return { left: location("left"), right: location("right"), splitRatio: splitPercent };
    },
    restore: async value => {
      const layout = fileLayoutSchema.parse(value);
      if (restoringRef.current || busyAction || pendingPaneRequestsRef.current.size || editorStateRef.current.dirty || editorStateRef.current.busy || transferJobsRef.current.some(job => ["queued", "running", "conflict"].includes(job.status))) {
        throw new Error("Termina las operaciones de archivos y guarda o descarta el borrador antes de abrir este espacio.");
      }
      restoringRef.current = true; setBusyAction("restore-workspace");
      try {
        await Promise.all([...connectedHostIdsRef.current].map(id => disconnectSftp(id)));
        if (!mountedRef.current) throw new Error("El gestor de archivos se cerró antes de recuperar el espacio.");
        connectedHostIdsRef.current.clear();
        setEditingFile(null); setFileClipboard(null); setTrustPrompt(null); setPaneContextMenu(null);
        setRightHostBrowserOpen(false); setSplitPercent(layout.splitRatio);
        const next = {} as Record<PaneSide, PaneState>;
        const localPaths: { side: PaneSide; path: string | null }[] = [];
        let unavailable = false;
        for (const side of paneSides) {
          paneGenerationRef.current[side] += 1;
          if (reconnectTimersRef.current[side] !== null) window.clearTimeout(reconnectTimersRef.current[side]!);
          reconnectTimersRef.current[side] = null; selectionAnchorRef.current[side] = null;
          let location = layout[side];
          if (location.kind === "host" && !hosts.map(host => host.id).includes(location.hostId)) { location = { kind: "local", path: null }; unavailable = true; }
          next[side] = { ...emptyPane(location.kind === "local" ? { kind: "local" } : { kind: "host", hostId: location.hostId }), restoredPath: location.path };
          if (location.kind === "local") localPaths.push({ side, path: location.path });
        }
        panesRef.current = next; setPanes(next); setPaneNavigation({ left: { back: [], forward: [] }, right: { back: [], forward: [] } });
        setMessage(unavailable ? "Una ubicación pertenecía a un host eliminado. Se abrió Mi equipo en su lugar." : "Rutas recuperadas · conecta los servidores cuando quieras.");
        await Promise.all(localPaths.map(({ side, path }) => loadLocalPane(side, path)));
      } finally { restoringRef.current = false; if (mountedRef.current) setBusyAction(null); }
    },
  }));

  useEffect(() => {
    safeStorageSet("nexora.sftp.favorites", JSON.stringify(favoriteLocations));
  }, [favoriteLocations]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const history = transferJobs.slice(-100);
      safeStorageSet("nexora.sftp.transfers.v1", JSON.stringify(history));
    }, 450);
    return () => window.clearTimeout(timeout);
  }, [transferJobs]);

  useEffect(() => {
    const hasActiveTransfers = transferJobs.some((job) => job.status === "queued" || job.status === "running" || job.status === "conflict");
    if (!hasActiveTransfers) return;
    const protectTransfers = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protectTransfers);
    return () => window.removeEventListener("beforeunload", protectTransfers);
  }, [transferJobs]);

  useEffect(() => {
    const timeout = window.setTimeout(() => safeStorageSet("nexora.sftp.split", String(splitPercent)), 250);
    return () => window.clearTimeout(timeout);
  }, [splitPercent]);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; paneGenerationRef.current.left += 1; paneGenerationRef.current.right += 1; }; }, []);

  useEffect(() => { void loadLocalPane("left", null); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (host) {
      setRightHostBrowserOpen(false);
      void changePaneSource("right", `host:${host.id}`);
    }
    else if (!panesRef.current.right.directory) void loadLocalPane("right", null);
  }, [host?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    for (const timer of Object.values(reconnectTimersRef.current)) if (timer !== null) window.clearTimeout(timer);
    for (const hostId of connectedHostIdsRef.current) void disconnectSftp(hostId).catch(() => undefined);
  }, []);

  useEffect(() => {
    const prepareRestore = (event: Event) => {
      (event as CustomEvent<{ handled?: boolean }>).detail.handled = true;
      const { resolve, reject } = (event as CustomEvent<{ resolve: () => void; reject: (reason: Error) => void }>).detail;
      if (restoringRef.current || editorStateRef.current.dirty || editorStateRef.current.busy) { reject(new Error("Guarda o descarta el borrador del editor remoto y termina la recuperación del espacio antes de cambiar de bóveda.")); return; }
      if (busyAction || pendingPaneRequestsRef.current.size > 0 || transferJobsRef.current.some(job => ["queued", "running", "conflict"].includes(job.status))) {
        reject(new Error("Termina o cancela las transferencias y operaciones de archivos antes de cambiar de bóveda."));
        return;
      }
      void (async () => {
        setEditingFile(null);
        for (const side of paneSides) {
          paneGenerationRef.current[side] += 1;
          if (reconnectTimersRef.current[side] !== null) window.clearTimeout(reconnectTimersRef.current[side]!);
          reconnectTimersRef.current[side] = null;
        }
        await Promise.all([...connectedHostIdsRef.current].map(id => disconnectSftp(id)));
        connectedHostIdsRef.current.clear();
        setPanes(current => ({ left: emptyPane(current.left.source), right: emptyPane(current.right.source) }));
      })().then(resolve, reason => reject(new Error(errorMessage(reason))));
    };
    window.addEventListener("nexora:prepare-vault-change", prepareRestore);
    return () => window.removeEventListener("nexora:prepare-vault-change", prepareRestore);
  }, [busyAction]);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest(".sftp-context-menu")) setPaneContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setPaneContextMenu(null); };
    const closeOnResize = () => setPaneContextMenu(null);
    document.addEventListener("mousedown", close);
    window.addEventListener("resize", closeOnResize);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("resize", closeOnResize);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      if (disposed) return;
      unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        if (!workspaceRef.current || workspaceRef.current.offsetParent === null) return;
        const payload = event.payload;
        if (payload.type === "leave") {
          setDropTarget(null);
          return;
        }
        const scale = window.devicePixelRatio || 1;
        const element = document.elementFromPoint(payload.position.x / scale, payload.position.y / scale) as HTMLElement | null;
        const pane = element?.closest<HTMLElement>("[data-file-pane]")?.dataset.filePane;
        const target = pane === "left" || pane === "right" ? pane : null;
        if (payload.type === "enter" || payload.type === "over") {
          setDropTarget(target);
          return;
        }
        setDropTarget(null);
        if (!target) return;
        const internalSource = internalDragSourceRef.current;
        if (internalSource?.side === target) {
          setMessage("Suelta la selección en el panel opuesto para transferirla");
          return;
        }
        if (internalSource) internalDropHandledRef.current = true;
        dropHandlerRef.current(payload.paths, target, internalSource);
      });
    }).catch((reason) => setGlobalError(errorMessage(reason)));
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    const refreshOnF5 = (event: KeyboardEvent) => {
      if (event.key !== "F5" || !workspaceRef.current || workspaceRef.current.offsetParent === null) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      if (!busyAction) void refreshAll();
    };
    window.addEventListener("keydown", refreshOnF5);
    return () => window.removeEventListener("keydown", refreshOnF5);
  }, [busyAction]); // eslint-disable-line react-hooks/exhaustive-deps

  const hostsById = useMemo(() => new Map(hosts.map((item) => [item.id, item])), [hosts]);
  const openEditor = (side: PaneSide, entry: PaneEntry) => {
    const pane = panesRef.current[side];
    if (entry.isDirectory || entry.isSymlink || pane.source.kind !== "host" || pane.status !== "connected") return;
    setEditingFile({ hostId: pane.source.hostId, hostName: hostsById.get(pane.source.hostId)?.name ?? "Servidor", path: entry.path, side });
  };
  const selectedEntries = useMemo(() => Object.fromEntries(paneSides.map((side) => {
    const selected = new Set(panes[side].selectedPaths);
    return [side, (panes[side].directory?.entries ?? []).filter((entry) => selected.has(entry.path))];
  })) as Record<PaneSide, PaneEntry[]>, [panes]);
  const busy = busyAction !== null || restoringRef.current;
  const activeTransferCount = transferJobs.filter((job) => job.status === "queued" || job.status === "running" || job.status === "conflict").length;
  const primaryHost = sourceHost(panes.right.source, hostsById) ?? sourceHost(panes.left.source, hostsById);
  const hostsByRecency = useMemo(
    () => [...hosts].sort((left, right) => hostActivityTime(hostActivity[right.id]) - hostActivityTime(hostActivity[left.id]) || left.name.localeCompare(right.name)),
    [hostActivity, hosts],
  );
  const recentHosts = useMemo(() => {
    const search = hostBrowserSearch.trim().toLowerCase();
    if (!search) return hostsByRecency;
    return hostsByRecency.filter((item) => [item.name, item.address, item.username].some((value) => value.toLowerCase().includes(search)));
  }, [hostsByRecency, hostBrowserSearch]);
  const connectedHostCount = new Set(paneSides
    .filter((side) => panes[side].source.kind === "host" && panes[side].status === "connected")
    .map((side) => (panes[side].source as Extract<PaneSource, { kind: "host" }>).hostId)).size;

  function updatePane(side: PaneSide, changes: Partial<PaneState>) {
    if (!mountedRef.current) return;
    setPanes((current) => ({ ...current, [side]: { ...current[side], ...changes } }));
  }

  function beginPaneRequest(side: PaneSide) {
    const generation = ++paneGenerationRef.current[side];
    pendingPaneRequestsRef.current.add(side + ":" + generation);
    return generation;
  }
  function isCurrentPaneRequest(side: PaneSide, generation: number) { return mountedRef.current && paneGenerationRef.current[side] === generation; }
  function finishPaneRequest(side: PaneSide, generation: number) {
    pendingPaneRequestsRef.current.delete(side + ":" + generation);
    if (isCurrentPaneRequest(side, generation)) setBusyAction(current => current?.startsWith(side + ":") ? null : current);
  }

  async function loadLocalPane(side: PaneSide, path: string | null): Promise<LocalDirectory | null> {
    const generation = beginPaneRequest(side);
    const source: PaneSource = { kind: "local" };
    updatePane(side, { source, status: "connecting", error: null, selectedPaths: [], latencyMs: null, reconnectAttempts: 0 });
    selectionAnchorRef.current[side] = null;
    setBusyAction(`${side}:list`);
    try {
      const directory = await listLocalDirectory(path);
      if (!isCurrentPaneRequest(side, generation)) return null;
      updatePane(side, { source, directory, status: "connected", error: null, selectedPaths: [], latencyMs: null, reconnectAttempts: 0 });
      return directory;
    } catch (reason) {
      if (!isCurrentPaneRequest(side, generation)) return null;
      updatePane(side, { source, directory: null, status: "error", error: errorMessage(reason) });
      return null;
    } finally {
      finishPaneRequest(side, generation);
    }
  }

  async function connectHostPane(side: PaneSide, hostId: string, path: string | null = null, reconnectAttempt = 0) {
    const selectedHost = hostsById.get(hostId) ?? hosts.find((item) => item.id === hostId);
    if (!selectedHost) {
      updatePane(side, { status: "error", error: "La conexión seleccionada ya no existe." });
      return;
    }
    const generation = beginPaneRequest(side);
    connectedHostIdsRef.current.add(hostId);
    const source: PaneSource = { kind: "host", hostId };
    if (reconnectTimersRef.current[side] !== null) window.clearTimeout(reconnectTimersRef.current[side]!);
    reconnectTimersRef.current[side] = null;
    updatePane(side, { source, directory: null, restoredPath: path, selectedPaths: [], status: "connecting", error: null, reconnectAttempts: reconnectAttempt });
    selectionAnchorRef.current[side] = null;
    setBusyAction(`${side}:connect`);
    setGlobalError(null);
    setTrustPrompt(null);
    onRecordHostActivity(hostId, "attempt");
    const startedAt = performance.now();
    try {
      const response = await connectSftp(hostId, path, keepaliveSeconds);
      if (!isCurrentPaneRequest(side, generation)) return;
      if (response.status === "connected") {
        connectedHostIdsRef.current.add(hostId);
        updatePane(side, { source, directory: response.directory, selectedPaths: [], status: "connected", error: null, latencyMs: Math.max(1, Math.round(performance.now() - startedAt)), reconnectAttempts: 0 });
        onRecordHostActivity(hostId, "success", "Conexión de archivos establecida");
        setMessage(`Conectado a ${selectedHost.name}`);
      } else if (response.status === "failed") {
        updatePane(side, { source, directory: null, status: "error", error: response.message, latencyMs: null, reconnectAttempts: reconnectAttempt });
        onRecordHostActivity(hostId, "error", response.message);
        if (response.retryable && reconnectAttempt < 3) schedulePaneReconnect(side, hostId, path, reconnectAttempt + 1);
      } else if (response.status === "trust_required") {
        updatePane(side, { source, directory: null, status: "disconnected", error: null });
        setTrustPrompt({ kind: "unknown", ...response, side, hostId, path });
      } else {
        updatePane(side, { source, directory: null, status: "error", error: "La identidad guardada no coincide con el servidor." });
        onRecordHostActivity(hostId, "error", "La identidad del servidor cambió");
        setTrustPrompt({ kind: "changed", ...response, side, hostId, path });
      }
    } catch (reason) {
      if (!isCurrentPaneRequest(side, generation)) return;
      const detail = errorMessage(reason);
      updatePane(side, { source, directory: null, status: "error", error: detail, latencyMs: null, reconnectAttempts: reconnectAttempt });
      onRecordHostActivity(hostId, "error", detail);
      if (reconnectAttempt < 3 && isRecoverableConnectionError(detail)) schedulePaneReconnect(side, hostId, path, reconnectAttempt + 1);
    } finally {
      finishPaneRequest(side, generation);
    }
  }

  function schedulePaneReconnect(side: PaneSide, hostId: string, path: string | null, attempt: number) {
    const delays = [0, 1_500, 3_500, 7_000];
    if (reconnectTimersRef.current[side] !== null) window.clearTimeout(reconnectTimersRef.current[side]!);
    updatePane(side, { directory: null, status: "error", latencyMs: null, reconnectAttempts: attempt, error: `Conexión interrumpida · reintentando en ${Math.ceil(delays[attempt] / 1000)} s…` });
    reconnectTimersRef.current[side] = window.setTimeout(() => {
      reconnectTimersRef.current[side] = null;
      const pane = panesRef.current[side];
      if (pane.source.kind === "host" && pane.source.hostId === hostId && pane.status !== "connected") void connectHostPane(side, hostId, path, attempt);
    }, delays[attempt]);
  }

  async function changePaneSource(side: PaneSide, value: string) {
    setPaneContextMenu(null);
    setConfirmDialog(null);
    setGlobalError(null);
    if (reconnectTimersRef.current[side] !== null) window.clearTimeout(reconnectTimersRef.current[side]!);
    reconnectTimersRef.current[side] = null;
    const nextHostId = value === "local" ? null : value.startsWith("host:") ? value.slice(5) : value;
    const currentPane = panesRef.current[side];
    const currentHostId = currentPane.source.kind === "host" ? currentPane.source.hostId : null;
    if ((value === "local" && currentPane.source.kind === "local") || (nextHostId && nextHostId === currentHostId)) return;
    paneGenerationRef.current[side] += 1;
    if (currentHostId) {
      const otherSide: PaneSide = side === "left" ? "right" : "left";
      const otherPane = panesRef.current[otherSide];
      const usedByOtherPane = otherPane.source.kind === "host" && otherPane.source.hostId === currentHostId;
      if (!usedByOtherPane) {
        setBusyAction(`${side}:switch`);
        try {
          await disconnectSftp(currentHostId);
          connectedHostIdsRef.current.delete(currentHostId);
        } catch (reason) {
          setGlobalError(errorMessage(reason));
          setBusyAction(null);
          return;
        }
        setBusyAction(null);
      }
    }

    resetPaneNavigation(side);

    if (!nextHostId) {
      await loadLocalPane(side, null);
      return;
    }
    const selectedHost = hostsById.get(nextHostId) ?? hosts.find((item) => item.id === nextHostId);
    if (!selectedHost) {
      updatePane(side, { status: "error", error: "La conexión seleccionada ya no existe." });
      return;
    }
    updatePane(side, {
      source: { kind: "host", hostId: nextHostId },
      directory: null,
      selectedPaths: [],
      status: "disconnected",
      error: null,
      latencyMs: null,
      reconnectAttempts: 0,
      restoredPath: null,
    });
    selectionAnchorRef.current[side] = null;
    setMessage(`${selectedHost.name} seleccionado · pulsa Conectar para iniciar`);
  }

  async function openPaneDirectory(side: PaneSide, path: string | null, recordHistory = true): Promise<boolean> {
    const pane = panesRef.current[side];
    const previousPath = pane.directory?.path ?? null;
    if (pane.source.kind === "local") {
      const directory = await loadLocalPane(side, path);
      if (directory && recordHistory) recordPaneNavigation(side, previousPath, directory.path);
      return Boolean(directory);
    }
    if (pane.status !== "connected" || path === null) return false;
    const generation = beginPaneRequest(side);
    setBusyAction(`${side}:list`);
    updatePane(side, { error: null });
    const startedAt = performance.now();
    try {
      const directory = await listSftpDirectory(pane.source.hostId, path);
      if (!isCurrentPaneRequest(side, generation)) return false;
      updatePane(side, { directory, selectedPaths: [], error: null, latencyMs: Math.max(1, Math.round(performance.now() - startedAt)), reconnectAttempts: 0 });
      selectionAnchorRef.current[side] = null;
      if (recordHistory) recordPaneNavigation(side, previousPath, directory.path);
      return true;
    } catch (reason) {
      if (!isCurrentPaneRequest(side, generation)) return false;
      const detail = errorMessage(reason);
      if (isRecoverableConnectionError(detail)) {
        connectedHostIdsRef.current.delete(pane.source.hostId);
        updatePane(side, { directory: null, status: "error", error: detail, latencyMs: null });
        schedulePaneReconnect(side, pane.source.hostId, path, 1);
      } else {
        updatePane(side, { error: detail });
      }
      return false;
    } finally {
      finishPaneRequest(side, generation);
    }
  }

  function resetPaneNavigation(side: PaneSide) {
    setPaneNavigation((current) => ({ ...current, [side]: { back: [], forward: [] } }));
  }

  function recordPaneNavigation(side: PaneSide, previousPath: string | null, nextPath: string) {
    if (!previousPath || previousPath === nextPath) return;
    setPaneNavigation((current) => ({
      ...current,
      [side]: { back: [...current[side].back, previousPath].slice(-50), forward: [] },
    }));
  }

  async function navigatePaneHistory(side: PaneSide, direction: "back" | "forward") {
    const navigation = paneNavigationRef.current[side];
    const stack = navigation[direction];
    const target = stack.at(-1);
    const currentPath = panesRef.current[side].directory?.path;
    if (!target || !currentPath) return;
    const opened = await openPaneDirectory(side, target, false);
    if (!opened) return;
    setPaneNavigation((current) => {
      const latest = current[side];
      return {
        ...current,
        [side]: direction === "back"
          ? { back: latest.back.slice(0, -1), forward: [...latest.forward, currentPath].slice(-50) }
          : { back: [...latest.back, currentPath].slice(-50), forward: latest.forward.slice(0, -1) },
      };
    });
  }

  function toggleFavorite(side: PaneSide) {
    const pane = panesRef.current[side];
    if (!pane.directory) return;
    const sourceKey = paneSourceKey(pane.source);
    const existing = favoriteLocations.find((favorite) => favorite.sourceKey === sourceKey && favorite.path === pane.directory?.path);
    if (existing) {
      setFavoriteLocations((current) => current.filter((favorite) => favorite.id !== existing.id));
      setMessage("Favorito eliminado");
      return;
    }
    setFavoriteLocations((current) => [...current, {
      id: createClientId(),
      sourceKey,
      path: pane.directory!.path,
      label: pathName(pane.directory!.path) || pane.directory!.path,
    }]);
    setMessage("Ruta guardada en favoritos");
  }

  async function disconnectPane(side: PaneSide) {
    const pane = panesRef.current[side];
    if (pane.source.kind !== "host") return;
    const hostId = pane.source.hostId;
    if (reconnectTimersRef.current[side] !== null) window.clearTimeout(reconnectTimersRef.current[side]!);
    reconnectTimersRef.current[side] = null;
    const otherSide: PaneSide = side === "left" ? "right" : "left";
    const otherPane = panesRef.current[otherSide];
    const shared = otherPane.source.kind === "host" && otherPane.source.hostId === hostId && otherPane.status === "connected";
    setBusyAction(`${side}:disconnect`);
    try {
      if (pane.status === "connected" && !shared) {
        await disconnectSftp(hostId);
        connectedHostIdsRef.current.delete(hostId);
      }
      updatePane(side, { directory: null, selectedPaths: [], status: "disconnected", error: null, latencyMs: null, reconnectAttempts: 0 });
      resetPaneNavigation(side);
      setMessage(`Conexión cerrada en el panel ${side === "left" ? "izquierdo" : "derecho"}`);
    } catch (reason) {
      updatePane(side, { error: errorMessage(reason) });
    } finally {
      setBusyAction(null);
    }
  }

  async function refreshAll() {
    setBusyAction("refresh-all");
    setGlobalError(null);
    const snapshot = panesRef.current;
    try {
      const refreshed = await Promise.all(paneSides.map(async (side) => {
        const pane = snapshot[side];
        if (!pane.directory || pane.status !== "connected") return null;
        const startedAt = performance.now();
        try {
          const directory = pane.source.kind === "local"
            ? await listLocalDirectory(pane.directory.path)
            : await listSftpDirectory(pane.source.hostId, pane.directory.path);
          return { side, directory, latencyMs: pane.source.kind === "host" ? Math.max(1, Math.round(performance.now() - startedAt)) : null, error: null };
        } catch (reason) {
          return { side, directory: null, latencyMs: null, error: errorMessage(reason) };
        }
      }));
      setPanes((current) => {
        const next = { ...current };
        for (const result of refreshed) {
          if (!result) continue;
          next[result.side] = result.directory
            ? { ...next[result.side], directory: result.directory, selectedPaths: [], error: null, latencyMs: result.latencyMs, reconnectAttempts: 0 }
            : { ...next[result.side], error: result.error };
        }
        return next;
      });
      for (const result of refreshed) {
        if (!result?.error || !isRecoverableConnectionError(result.error)) continue;
        const pane = snapshot[result.side];
        if (pane.source.kind === "host") {
          connectedHostIdsRef.current.delete(pane.source.hostId);
          schedulePaneReconnect(result.side, pane.source.hostId, pane.directory?.path ?? null, 1);
        }
      }
      selectionAnchorRef.current = { left: null, right: null };
      const failures = refreshed.filter((result) => result?.error).length;
      setMessage(failures > 0 ? `${paneSides.length - failures} paneles actualizados · ${failures} con error` : "Paneles actualizados");
    } catch (reason) {
      setGlobalError(errorMessage(reason));
    } finally {
      setBusyAction(null);
    }
  }

  async function closeConnections() {
    setBusyAction("disconnect-all");
    try {
      for (const side of paneSides) {
        if (reconnectTimersRef.current[side] !== null) window.clearTimeout(reconnectTimersRef.current[side]!);
        reconnectTimersRef.current[side] = null;
      }
      const ids = [...connectedHostIdsRef.current];
      await Promise.all(ids.map((hostId) => disconnectSftp(hostId)));
      connectedHostIdsRef.current.clear();
      setPanes((current) => Object.fromEntries(paneSides.map((side) => {
        const pane = current[side];
        return [side, pane.source.kind === "host"
          ? { ...pane, directory: null, selectedPaths: [], status: "disconnected" as const, error: null, latencyMs: null, reconnectAttempts: 0 }
          : pane];
      })) as Record<PaneSide, PaneState>);
      setMessage("Conexiones de archivos cerradas");
    } catch (reason) {
      setGlobalError(errorMessage(reason));
    } finally {
      setBusyAction(null);
    }
  }

  async function createNamedEntry(name: string) {
    if (!nameDialog) return;
    const pane = panesRef.current[nameDialog.side];
    if (!pane.directory) return;
    const creatingFile = nameDialog.type === "file";
    setBusyAction("create");
    try {
      const directory = pane.source.kind === "local"
        ? creatingFile ? await createLocalFile(pane.directory.path, name) : await createLocalDirectory(pane.directory.path, name)
        : creatingFile ? await createSftpFile(pane.source.hostId, pane.directory.path, name) : await createSftpDirectory(pane.source.hostId, pane.directory.path, name);
      updatePane(nameDialog.side, { directory, selectedPaths: [] });
      setNameDialog(null);
      setMessage(`${creatingFile ? "Archivo" : "Carpeta"} “${name}” ${creatingFile ? "creado" : "creada"}`);
    } catch (reason) {
      throw new Error(errorMessage(reason));
    } finally {
      setBusyAction(null);
    }
  }

  async function renameEntry(name: string) {
    if (!nameDialog || nameDialog.type !== "rename") return;
    const pane = panesRef.current[nameDialog.side];
    setBusyAction("rename");
    try {
      const directory = pane.source.kind === "local"
        ? await renameLocalEntry(nameDialog.entry.path, name)
        : await renameSftpEntry(pane.source.hostId, nameDialog.entry.path, name);
      updatePane(nameDialog.side, { directory, selectedPaths: [] });
      setNameDialog(null);
      setMessage("Elemento renombrado");
    } catch (reason) {
      throw new Error(errorMessage(reason));
    } finally {
      setBusyAction(null);
    }
  }

  async function changePermissions(mode: number) {
    if (!permissionsDialog) return;
    const pane = panesRef.current[permissionsDialog.side];
    if (pane.source.kind !== "host") return;
    setBusyAction("permissions");
    try {
      const directory = await chmodSftpEntry(pane.source.hostId, permissionsDialog.entry.path, mode);
      updatePane(permissionsDialog.side, { directory, selectedPaths: [] });
      setPermissionsDialog(null);
      setMessage(`Permisos actualizados a ${mode.toString(8).padStart(3, "0")}`);
    } catch (reason) {
      throw new Error(errorMessage(reason));
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteEntry(side: PaneSide, entry: PaneEntry) {
    const pane = panesRef.current[side];
    setBusyAction("delete");
    try {
      const directory = pane.source.kind === "local"
        ? await deleteLocalEntry(entry.path, entry.isDirectory, entry.isDirectory)
        : await deleteSftpEntry(pane.source.hostId, entry.path, entry.isDirectory, entry.isDirectory);
      updatePane(side, { directory, selectedPaths: [] });
      setConfirmDialog(null);
      setMessage(`${entry.isDirectory ? "Carpeta" : "Archivo"} eliminado`);
    } catch (reason) {
      throw new Error(errorMessage(reason));
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteEntries(side: PaneSide, entries: PaneEntry[]) {
    if (entries.length === 0) return;
    const pane = panesRef.current[side];
    setBusyAction("delete");
    try {
      const ordered = [...entries].sort((left, right) => Number(left.isDirectory) - Number(right.isDirectory));
      let updated = pane.directory;
      for (const entry of ordered) {
        updated = pane.source.kind === "local"
          ? await deleteLocalEntry(entry.path, entry.isDirectory, entry.isDirectory)
          : await deleteSftpEntry(pane.source.hostId, entry.path, entry.isDirectory, entry.isDirectory);
      }
      updatePane(side, { directory: updated, selectedPaths: [] });
      setConfirmDialog(null);
      setMessage(`${entries.length} elementos eliminados`);
    } catch (reason) {
      try { await openPaneDirectory(side, pane.directory?.path ?? null); } catch { /* Se conserva el error original. */ }
      throw new Error(errorMessage(reason));
    } finally {
      setBusyAction(null);
    }
  }

  function commitTransferJobs(next: TransferJob[]) {
    transferJobsRef.current = next;
    setTransferJobs(next);
  }

  function updateTransferJob(jobId: string, changes: Partial<TransferJob>) {
    commitTransferJobs(transferJobsRef.current.map((job) => job.id === jobId ? { ...job, ...changes } : job));
  }

  function handleTransferProgress(jobId: string, transferredBytes: number, fileCount: number, totalBytes: number) {
    const job = transferJobsRef.current.find((candidate) => candidate.id === jobId);
    if (!job || job.status !== "running") return;
    updateTransferJob(jobId, {
      transferredBytes: Math.max(job.transferredBytes, transferredBytes),
      estimatedBytes: Math.max(job.estimatedBytes, totalBytes),
      fileCount: Math.max(job.fileCount, fileCount),
    });
  }

  function enqueueTransfers(paths: string[], target: PaneSide, source: InternalDragSource | null, operation: "copy" | "move" = "copy") {
    if (paths.length === 0) return;
    const targetPane = panesRef.current[target];
    if (!targetPane.directory || targetPane.status !== "connected") {
      updatePane(target, { error: "Conecta o abre el destino antes de soltar archivos." });
      return;
    }
    const batchId = createClientId();
    const destination: TransferDestination = targetPane.source.kind === "local"
      ? { kind: "local", path: targetPane.directory.path, label: "Mi equipo" }
      : { kind: "host", hostId: targetPane.source.hostId, path: targetPane.directory.path, label: hostsById.get(targetPane.source.hostId)?.name ?? "Servidor remoto" };
    const perItemEstimate = source?.estimatedBytes && paths.length > 0 ? Math.floor(source.estimatedBytes / paths.length) : 0;
    const sourcePane = source ? panesRef.current[source.side] : null;
    const sourceKind = source?.paneSource ?? sourcePane?.source;
    const jobs = paths.map((sourcePath, index): TransferJob => ({
      id: createClientId(),
      batchId,
      sourcePath,
      source: sourceKind?.kind === "host" && !source?.stagingRoot
        ? { kind: "host", hostId: sourceKind.hostId, path: source?.entries[index]?.path ?? sourcePath, label: hostsById.get(sourceKind.hostId)?.name ?? "Servidor remoto" }
        : { kind: "local", path: sourcePath, label: sourceKind?.kind === "local" ? "Mi equipo" : sourceKind ? `${hostsById.get(sourceKind.hostId)?.name ?? "Servidor"} · temporal` : "Mi equipo" },
      sourceIsDirectory: source?.entries[index]?.isDirectory ?? false,
      operation,
      name: pathName(sourcePath),
      destination,
      status: "queued",
      estimatedBytes: source?.entries[index]?.isDirectory ? perItemEstimate : source?.entries[index]?.size ?? perItemEstimate,
      transferredBytes: 0,
      fileCount: 0,
      startedAt: null,
      finishedAt: null,
      error: null,
      stagingRoot: source?.stagingRoot ?? null,
      stagingAvailableBytes: source?.stagingRoot ? source.availableBytes : null,
    }));
    batchPoliciesRef.current.set(batchId, "ask");
    cancelledBatchesRef.current.delete(batchId);
    commitTransferJobs([...transferJobsRef.current, ...jobs]);
    setPaneContextMenu(null);
    setGlobalError(null);
    updatePane(target, { error: null });
    setTransferQueueOpen(true);
    void runTransferQueue();
  }

  async function runTransferQueue() {
    if (queueRunningRef.current || queuePausedRef.current) return;
    queueRunningRef.current = true;
    let changedDestination = false;
    try {
      while (true) {
        if (queuePausedRef.current) break;
        const job = transferJobsRef.current.find((candidate) => candidate.status === "queued");
        if (!job) break;
        if (cancelledBatchesRef.current.has(job.batchId)) {
          updateTransferJob(job.id, { status: "cancelled", finishedAt: Date.now() });
          continue;
        }
        await executeTransferJob(job);
        changedDestination = true;
      }
    } finally {
      queueRunningRef.current = false;
      await cleanupFinishedStaging();
      if (changedDestination) void refreshAll();
      if (!queuePausedRef.current && transferJobsRef.current.some((job) => job.status === "queued")) queueMicrotask(() => void runTransferQueue());
    }
  }

  async function executeTransferJob(initialJob: TransferJob) {
    const startedAt = Date.now();
    updateTransferJob(initialJob.id, { status: "running", startedAt, finishedAt: null, error: null, transferredBytes: 0 });
    let targetName: string | null = null;
    let duplicateIndex = 1;
    try {
      while (true) {
        const current = transferJobsRef.current.find((job) => job.id === initialJob.id) ?? initialJob;
        if (cancelledBatchesRef.current.has(current.batchId)) {
          updateTransferJob(current.id, { status: "cancelled", finishedAt: Date.now() });
          return;
        }
        const policy = batchPoliciesRef.current.get(current.batchId) ?? "ask";
        const overwrite = policy === "replace_all";
        const onProgress = (event: { transferredBytes: number; fileCount: number; totalBytes: number }) => handleTransferProgress(current.id, event.transferredBytes, event.fileCount, event.totalBytes);
        const response = await performTransfer(current, overwrite, targetName, onProgress);
        if (response.status === "transferred") {
          await completeTransferJob(current, response);
          return;
        }
        if (policy === "skip_all") {
          updateTransferJob(current.id, { status: "skipped", finishedAt: Date.now() });
          return;
        }
        if (policy === "replace_all") {
          const repeated = await performTransfer(current, true, targetName, onProgress);
          if (repeated.status === "transferred") {
            await completeTransferJob(current, repeated);
            return;
          }
        }
        if (policy === "keep_all") {
          targetName = copyName(current.name, duplicateIndex++);
          continue;
        }
        updateTransferJob(current.id, { status: "conflict" });
        const choice = await requestQueueConflict(current, response.name, response.isDirectory);
        if (choice === "cancel_batch") {
          cancelTransferBatch(current.batchId);
          updateTransferJob(current.id, { status: "cancelled", finishedAt: Date.now() });
          return;
        }
        if (choice === "skip_once" || choice === "skip_all") {
          if (choice === "skip_all") batchPoliciesRef.current.set(current.batchId, "skip_all");
          updateTransferJob(current.id, { status: "skipped", finishedAt: Date.now() });
          return;
        }
        if (choice === "replace_all") batchPoliciesRef.current.set(current.batchId, "replace_all");
        if (choice === "replace_once" || choice === "replace_all") {
          const replaced = await performTransfer(current, true, targetName, onProgress);
          if (replaced.status === "transferred") {
            await completeTransferJob(current, replaced);
            return;
          }
          continue;
        }
        if (choice === "keep_all") batchPoliciesRef.current.set(current.batchId, "keep_all");
        targetName = copyName(current.name, duplicateIndex++);
        updateTransferJob(current.id, { status: "running" });
      }
    } catch (reason) {
      const cancelled = cancelledBatchesRef.current.has(initialJob.batchId) || errorMessage(reason).includes("TRANSFER_CANCELLED");
      updateTransferJob(initialJob.id, cancelled
        ? { status: "cancelled", error: null, finishedAt: Date.now() }
        : { status: "error", error: errorMessage(reason), finishedAt: Date.now() });
    }
  }

  async function performTransfer(
    job: TransferJob,
    overwrite: boolean,
    targetName: string | null,
    onProgress: (event: { transferredBytes: number; fileCount: number; totalBytes: number }) => void,
  ) {
    if (job.source.kind === "host") {
      return job.destination.kind === "local"
        ? transferSftpToLocal(job.source.hostId, job.source.path, job.destination.path, overwrite, targetName, job.id, onProgress)
        : transferSftpToSftp(job.source.hostId, job.source.path, job.destination.hostId, job.destination.path, overwrite, targetName, job.id, onProgress);
    }
    return job.destination.kind === "local"
      ? copyLocalEntry(job.source.path, job.destination.path, overwrite, targetName, job.id, onProgress)
      : transferLocalToSftp(job.destination.hostId, job.source.path, job.destination.path, overwrite, targetName, job.id, onProgress);
  }

  async function completeTransferJob(job: TransferJob, response: Extract<Awaited<ReturnType<typeof copyLocalEntry>>, { status: "transferred" }>) {
    if (job.operation === "move" && mountedRef.current && !cancelledBatchesRef.current.has(job.batchId)) {
      const sourceDirectory = job.source.kind === "local"
        ? await deleteLocalEntry(job.source.path, job.sourceIsDirectory, true)
        : await deleteSftpEntry(job.source.hostId, job.source.path, job.sourceIsDirectory, true);
      for (const side of paneSides) {
        const pane = panesRef.current[side];
        const matchesSource = job.source.kind === "local"
          ? pane.source.kind === "local"
          : pane.source.kind === "host" && pane.source.hostId === job.source.hostId;
        if (matchesSource && pane.directory?.path === sourceDirectory.path) updatePane(side, { directory: sourceDirectory, selectedPaths: [] });
      }
    }
    updateTransferJob(job.id, {
      status: "completed",
      transferredBytes: response.totalBytes,
      estimatedBytes: Math.max(job.estimatedBytes, response.totalBytes),
      fileCount: response.fileCount,
      finishedAt: Date.now(),
    });
  }

  function requestQueueConflict(job: TransferJob, name: string, isDirectory: boolean): Promise<ConflictChoice> {
    setQueueConflict({ jobId: job.id, name, isDirectory, destination: job.destination.label });
    return new Promise((resolve) => { conflictResolverRef.current = resolve; });
  }

  function resolveQueueConflict(choice: ConflictChoice) {
    const resolve = conflictResolverRef.current;
    conflictResolverRef.current = null;
    setQueueConflict(null);
    resolve?.(choice);
  }

  function cancelTransferBatch(batchId: string) {
    cancelledBatchesRef.current.add(batchId);
    if (conflictResolverRef.current && transferJobsRef.current.some(job => job.batchId === batchId && job.status === "conflict")) resolveQueueConflict("cancel_batch");
    for (const job of transferJobsRef.current.filter((candidate) => candidate.batchId === batchId && candidate.status === "running")) {
      void cancelFileTransfer(job.id).catch(reason => setGlobalError(errorMessage(reason)));
    }
    commitTransferJobs(transferJobsRef.current.map((job) => job.batchId === batchId && job.status === "queued" ? { ...job, status: "cancelled", finishedAt: Date.now() } : job));
    setMessage("Cancelando transferencia…");
  }

  function retryTransferJob(jobId: string) {
    const job = transferJobsRef.current.find((candidate) => candidate.id === jobId);
    if (!job) return;
    cancelledBatchesRef.current.delete(job.batchId);
    updateTransferJob(jobId, { status: "queued", error: null, startedAt: null, finishedAt: null, transferredBytes: 0 });
    setTransferQueueOpen(true);
    void runTransferQueue();
  }

  function toggleTransferQueuePause() {
    const next = !queuePausedRef.current;
    queuePausedRef.current = next;
    setQueuePaused(next);
    setMessage(next ? "La cola se pausará al terminar el elemento actual" : "Cola de transferencias reanudada");
    if (!next) void runTransferQueue();
  }

  async function cleanupFinishedStaging() {
    const roots = new Set(transferJobsRef.current.map((job) => job.stagingRoot).filter((root): root is string => Boolean(root)));
    for (const root of roots) {
      const related = transferJobsRef.current.filter((job) => job.stagingRoot === root);
      if (related.some((job) => job.status === "queued" || job.status === "running" || job.status === "conflict" || job.status === "error")) continue;
      try { await cleanupPreparedDrag(root); } catch { /* La limpieza obsoleta se reintentará al preparar el próximo arrastre. */ }
    }
  }

  async function clearFinishedTransfers() {
    const discardedRoots = new Set(transferJobsRef.current.filter((job) => job.status === "error").map((job) => job.stagingRoot).filter((root): root is string => Boolean(root)));
    for (const root of discardedRoots) {
      if (transferJobsRef.current.some((job) => job.stagingRoot === root && (job.status === "queued" || job.status === "running" || job.status === "conflict"))) continue;
      try { await cleanupPreparedDrag(root); } catch { /* La limpieza obsoleta se repetirá al preparar otro arrastre. */ }
    }
    const active = transferJobsRef.current.filter((job) => job.status === "queued" || job.status === "running" || job.status === "conflict");
    commitTransferJobs(active);
  }

  async function openTransferDestination(job: TransferJob) {
    setTransferQueueOpen(false);
    const destination = job.destination;
    if (destination.kind === "local") {
      const localSide = paneSides.find((side) => panesRef.current[side].source.kind === "local") ?? "left";
      if (panesRef.current[localSide].source.kind !== "local") await changePaneSource(localSide, "local");
      await openPaneDirectory(localSide, destination.path);
      return;
    }
    const connectedSide = paneSides.find((side) => {
      const pane = panesRef.current[side];
      return pane.source.kind === "host" && pane.source.hostId === destination.hostId && pane.status === "connected";
    });
    if (connectedSide) {
      await openPaneDirectory(connectedSide, destination.path);
      return;
    }
    setRightHostBrowserOpen(false);
    await changePaneSource("right", `host:${destination.hostId}`);
    setMessage("Destino preparado · conecta el servidor para abrir la carpeta");
  }

  async function openTransferSource(job: TransferJob) {
    setTransferQueueOpen(false);
    const source = job.source;
    const path = job.sourceIsDirectory
      ? source.path
      : source.kind === "local" ? localParentDirectory(source.path) : remoteParentPath(source.path) ?? "/";
    if (source.kind === "local") {
      const localSide = paneSides.find((side) => panesRef.current[side].source.kind === "local") ?? "left";
      if (panesRef.current[localSide].source.kind !== "local") await changePaneSource(localSide, "local");
      await openPaneDirectory(localSide, path);
      return;
    }
    const connectedSide = paneSides.find((side) => {
      const pane = panesRef.current[side];
      return pane.source.kind === "host" && pane.source.hostId === source.hostId && pane.status === "connected";
    });
    if (connectedSide) {
      await openPaneDirectory(connectedSide, path);
      return;
    }
    setRightHostBrowserOpen(false);
    await changePaneSource("right", `host:${source.hostId}`);
    setMessage("Origen preparado · conecta el servidor para abrir la carpeta");
  }

  function selectPaneEntry(side: PaneSide, entry: PaneEntry, event: React.MouseEvent, orderedEntries?: PaneEntry[]) {
    const pane = panesRef.current[side];
    const result = nextFileSelection(
      (orderedEntries ?? pane.directory?.entries ?? []).map((item) => item.path),
      pane.selectedPaths,
      entry.path,
      selectionAnchorRef.current[side],
      { additive: event.ctrlKey || event.metaKey, range: event.shiftKey },
    );
    selectionAnchorRef.current[side] = result.anchor;
    updatePane(side, { selectedPaths: result.paths });
  }

  function selectVisible(side: PaneSide, entries: PaneEntry[]) {
    updatePane(side, { selectedPaths: entries.map((entry) => entry.path) });
    selectionAnchorRef.current[side] = entries[0]?.path ?? null;
  }

  function clearSelection(side: PaneSide) {
    updatePane(side, { selectedPaths: [] });
    selectionAnchorRef.current[side] = null;
  }

  function enqueuePaneTransfer(
    sourceSide: PaneSide,
    targetSide: PaneSide,
    entries: PaneEntry[],
    operation: "copy" | "move",
    sourceOverride?: PaneSource,
  ) {
    if (entries.length === 0) return;
    const source = sourceOverride ?? panesRef.current[sourceSide].source;
    if (source.kind === "host" && !connectedHostIdsRef.current.has(source.hostId)) {
      updatePane(sourceSide, { error: "Reconecta el servidor de origen antes de transferir." });
      return;
    }
    enqueueTransfers(entries.map((entry) => entry.path), targetSide, {
      side: sourceSide,
      paneSource: source,
      entries,
      stagingRoot: null,
      estimatedBytes: entries.reduce((total, entry) => total + entry.size, 0),
      availableBytes: 0,
    }, operation);
  }

  function copyToClipboard(side: PaneSide, entries: PaneEntry[], mode: "copy" | "move") {
    if (entries.length === 0) return;
    setFileClipboard({ mode, sourceSide: side, source: panesRef.current[side].source, entries });
    setPaneContextMenu(null);
    setMessage(`${entries.length} ${entries.length === 1 ? "elemento" : "elementos"} ${mode === "copy" ? "listo para copiar" : "listo para mover"}`);
  }

  function pasteClipboard(targetSide: PaneSide) {
    if (!fileClipboard) return;
    enqueuePaneTransfer(fileClipboard.sourceSide, targetSide, fileClipboard.entries, fileClipboard.mode, fileClipboard.source);
    if (fileClipboard.mode === "move") setFileClipboard(null);
    setPaneContextMenu(null);
  }

  async function beginNativeDrag(side: PaneSide, entry: PaneEntry) {
    if (busy) return;
    const pane = panesRef.current[side];
    const current = selectedEntries[side];
    const entries = current.some((selected) => selected.path === entry.path) ? current : [entry];
    if (entries.some((selected) => selected.isSymlink)) {
      updatePane(side, { error: "Los enlaces simbólicos no se pueden arrastrar." });
      return;
    }
    if (pane.source.kind === "host" && pane.status !== "connected") {
      updatePane(side, { error: "Conecta el servidor antes de arrastrar sus archivos." });
      return;
    }
    setPaneContextMenu(null);
    setBusyAction("prepare-drag");
    setGlobalError(null);
    updatePane(side, { selectedPaths: entries.map((selected) => selected.path), error: null });
    internalDropHandledRef.current = false;
    internalDragSourceRef.current = { side, paneSource: pane.source, entries, stagingRoot: null, estimatedBytes: entries.reduce((total, selected) => total + selected.size, 0), availableBytes: 0 };
    let preparedStagingRoot: string | null = null;
    try {
      const hostId = pane.source.kind === "host" ? pane.source.hostId : null;
      const prepared = await prepareFileDrag(hostId, entries.map((selected) => selected.path));
      preparedStagingRoot = prepared.stagingRoot;
      internalDragSourceRef.current = { side, paneSource: pane.source, entries, stagingRoot: prepared.stagingRoot, estimatedBytes: prepared.estimatedBytes, availableBytes: prepared.availableBytes };
      await startFileDrag(prepared.paths, prepared.iconPath);
    } catch (reason) {
      internalDragSourceRef.current = null;
      updatePane(side, { error: errorMessage(reason) });
    } finally {
      if (preparedStagingRoot && !internalDropHandledRef.current) {
        try { await cleanupPreparedDrag(preparedStagingRoot); } catch { /* La próxima preparación eliminará staging obsoleto. */ }
      }
      setBusyAction(null);
      window.setTimeout(() => { internalDragSourceRef.current = null; }, 500);
    }
  }

  function openPaneContextMenu(event: React.MouseEvent, side: PaneSide, entry: PaneEntry | null) {
    event.preventDefault();
    event.stopPropagation();
    const current = selectedEntries[side];
    const entries = entry ? current.some((selected) => selected.path === entry.path) ? current : [entry] : [];
    if (entry && entries.length === 1 && current[0]?.path !== entry.path) updatePane(side, { selectedPaths: [entry.path] });
    const height = entry ? 390 : 160;
    setPaneContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 232),
      y: Math.min(event.clientY, window.innerHeight - height),
      side,
      entry,
      entries,
    });
  }

  async function copyEntryPaths(entries: PaneEntry[]) {
    try {
      await writeSystemClipboard(entries.map((entry) => entry.path).join("\n"));
      setMessage(entries.length === 1 ? "Ruta copiada" : `${entries.length} rutas copiadas`);
    } catch {
      setGlobalError("No se pudo copiar la ruta al portapapeles.");
    } finally {
      setPaneContextMenu(null);
    }
  }

  dropHandlerRef.current = (paths, target, source) => enqueueTransfers(paths, target, source);

  async function trustAndReconnect() {
    if (!trustPrompt) return;
    const { side, hostId, path } = trustPrompt;
    setBusyAction("trust");
    try {
      const known = await trustSshHostKey(trustPrompt.verificationHostId ?? hostId, trustPrompt?.challengeId ?? null, trustPrompt.kind === "changed");
      useAppStore.getState().rememberKnownHost(known);
      setTrustPrompt(null);
      await connectHostPane(side, hostId, path);
    } catch (reason) {
      updatePane(side, { status: "error", error: errorMessage(reason) });
      setBusyAction(null);
    }
  }

  function requestDelete(side: PaneSide, entries: PaneEntry[]) {
    if (entries.length === 0) return;
    setConfirmDialog(entries.length === 1
      ? { type: "delete", side, entry: entries[0] }
      : { type: "bulk_delete", side, entries });
  }

  function beginPaneResize(event: React.PointerEvent) {
    event.preventDefault();
    const layout = (event.currentTarget.parentElement as HTMLElement | null)?.getBoundingClientRect();
    if (!layout) return;
    const move = (moveEvent: PointerEvent) => {
      const percent = ((moveEvent.clientX - layout.left) / layout.width) * 100;
      setSplitPercent(Math.max(30, Math.min(70, percent)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  return (
    <>
      <header className="topbar sftp-topbar">
        <div className="section-caption"><FolderOpen size={18} /><strong>Archivos</strong><span>Local y SFTP</span></div>
        <div className="topbar-actions">
          <button className={`button secondary transfer-queue-toggle ${activeTransferCount > 0 ? "active" : ""}`} onClick={() => setTransferQueueOpen((open) => !open)}><ArrowRightLeft size={15} /> Transferencias{activeTransferCount > 0 && <b>{activeTransferCount}</b>}</button>
          <button className="button secondary" disabled={busy} onClick={() => void refreshAll()} title="Actualizar ambos paneles (F5)"><RefreshCw className={busyAction === "refresh-all" ? "spin" : ""} size={15} /> Actualizar</button>
          {primaryHost && <button className="button secondary" onClick={() => onOpenSsh(primaryHost)}><TerminalSquare size={16} /> Abrir SSH</button>}
          {connectedHostCount > 0 && <button className="button subtle danger-text" disabled={busy} onClick={() => void closeConnections()}><Unplug size={16} /> Cerrar conexiones</button>}
        </div>
      </header>

      <section ref={workspaceRef} className="sftp-workspace dual-manager" aria-label="Administrador de archivos" onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setPaneContextMenu(null); }}>
        {globalError && <div className="sftp-inline-error" role="alert"><AlertTriangle size={16} /><span>{globalError}</span><button onClick={() => setGlobalError(null)} aria-label="Cerrar error"><X size={14} /></button></div>}
        <div className="transfer-layout" style={{ gridTemplateColumns: `${splitPercent}fr 6px ${100 - splitPercent}fr` }}>
          {paneSides.map((side) => {
            const pane = panes[side];
            if (side === "right" && rightHostBrowserOpen) {
              const connectedHostId = pane.source.kind === "host" && pane.status === "connected" ? pane.source.hostId : null;
              return <HostBrowserPane
                key="right-host-browser"
                hosts={recentHosts}
                totalHosts={hosts.length}
                activity={hostActivity}
                search={hostBrowserSearch}
                connectedHostId={connectedHostId}
                onSearch={setHostBrowserSearch}
                onSelect={(hostId) => {
                  setHostBrowserSearch("");
                  setRightHostBrowserOpen(false);
                  void changePaneSource("right", `host:${hostId}`);
                }}
              />;
            }
            const selectedHost = sourceHost(pane.source, hostsById);
            const localDirectory = pane.source.kind === "local" ? pane.directory as LocalDirectory | null : null;
            const title = selectedHost?.name ?? "Mi equipo";
            const subtitle = selectedHost ? `${selectedHost.username}@${selectedHost.address}:${selectedHost.port}` : pane.directory?.path ?? "Archivos locales";
            const parentPath = pane.source.kind === "local"
              ? localDirectory?.parentPath ?? null
              : pane.directory ? remoteParentPath(pane.directory.path) : null;
            const disconnected = pane.source.kind === "host" && pane.status !== "connected";
            const paneHostId = pane.source.kind === "host" ? pane.source.hostId : null;
            const paneFavorites = favoriteLocations.filter((favorite) => favorite.sourceKey === paneSourceKey(pane.source));
            const currentFavorite = Boolean(pane.directory && paneFavorites.some((favorite) => favorite.path === pane.directory?.path));
            return <FilePane
              key={side}
              side={side}
              source={pane.source}
              hosts={hostsByRecency}
              title={title}
              subtitle={subtitle}
              icon={pane.source.kind === "local" ? <Monitor size={17} /> : <Server size={17} />}
              directory={pane.directory}
              entries={pane.directory?.entries ?? []}
              selectedPaths={pane.selectedPaths}
              busy={busy}
              loading={busyAction === `${side}:list` || pane.status === "connecting"}
              error={pane.error}
              roots={localDirectory?.roots}
              parentPath={parentPath}
              disconnected={disconnected}
              disconnectedMessage={pane.status === "error" ? "No se pudo abrir esta conexión." : pane.restoredPath ? `Ubicación guardada: ${pane.restoredPath}. Conecta para abrirla.` : "Conecta para explorar sus archivos."}
              connectionStatus={pane.status}
              latencyMs={pane.latencyMs}
              reconnectAttempts={pane.reconnectAttempts}
              canGoBack={paneNavigation[side].back.length > 0}
              canGoForward={paneNavigation[side].forward.length > 0}
              favorites={paneFavorites}
              currentFavorite={currentFavorite}
              onSourceChange={(value) => void changePaneSource(side, value)}
              onBrowseHosts={side === "right" && pane.source.kind === "host" && pane.status === "connected" ? () => { setHostBrowserSearch(""); setRightHostBrowserOpen(true); } : undefined}
              onConnect={paneHostId ? () => void connectHostPane(side, paneHostId, pane.directory?.path ?? pane.restoredPath) : undefined}
              onDisconnect={paneHostId && pane.status !== "disconnected" ? () => void disconnectPane(side) : undefined}
              onBack={() => void navigatePaneHistory(side, "back")}
              onForward={() => void navigatePaneHistory(side, "forward")}
              onToggleFavorite={() => toggleFavorite(side)}
              onOpenFavorite={(path) => void openPaneDirectory(side, path)}
              onSelect={(entry, event, orderedEntries) => selectPaneEntry(side, entry, event, orderedEntries)}
              onSelectPath={(path) => {
                updatePane(side, { selectedPaths: [path] });
                selectionAnchorRef.current[side] = path;
              }}
              onOpen={(entry) => { if (entry.isDirectory) void openPaneDirectory(side, entry.path); else openEditor(side, entry); }}
              onOpenPath={(path) => void openPaneDirectory(side, path)}
              onRefresh={() => void openPaneDirectory(side, pane.directory?.path ?? null, false)}
              onNewFolder={() => setNameDialog({ type: "folder", side })}
              onNewFile={() => setNameDialog({ type: "file", side })}
              onRename={(entry) => setNameDialog({ type: "rename", side, entry })}
              onDeleteSelection={(entries) => requestDelete(side, entries)}
              onCopySelection={(entries) => copyToClipboard(side, entries, "copy")}
              onCutSelection={(entries) => copyToClipboard(side, entries, "move")}
              onPaste={() => pasteClipboard(side)}
              canPaste={Boolean(fileClipboard && pane.directory && pane.status === "connected")}
              onContextMenu={(event, entry) => openPaneContextMenu(event, side, entry)}
              onStartDrag={(entry) => void beginNativeDrag(side, entry)}
              onSelectAll={(entries) => selectVisible(side, entries)}
              onClearSelection={() => clearSelection(side)}
              dropActive={dropTarget === side}
            />;
          })}
          <div className="pane-splitter" role="separator" aria-label="Redimensionar paneles" aria-orientation="vertical" aria-valuemin={30} aria-valuemax={70} aria-valuenow={Math.round(splitPercent)} tabIndex={0} onPointerDown={beginPaneResize} onDoubleClick={() => setSplitPercent(50)} onKeyDown={(event) => { if (event.key === "ArrowLeft") setSplitPercent((value) => Math.max(30, value - 2)); if (event.key === "ArrowRight") setSplitPercent((value) => Math.min(70, value + 2)); }}><i /></div>
        </div>
        <footer className="transfer-statusbar">
          <span><i className={connectedHostCount > 0 ? "online" : ""} /> {connectedHostCount > 0 ? `${connectedHostCount} ${connectedHostCount === 1 ? "servidor conectado" : "servidores conectados"}` : "Selecciona Mi equipo o una conexión en cada panel"}</span>
          <small>{fileClipboard ? <><ClipboardPaste size={12} /> {fileClipboard.entries.length} {fileClipboard.entries.length === 1 ? "elemento" : "elementos"} · {fileClipboard.mode === "move" ? "cortar" : "copiar"} · Ctrl+V para pegar <button onClick={() => setFileClipboard(null)}>Cancelar</button></> : busyAction === "prepare-drag" || busyAction === "drop-transfer" ? <><LoaderCircle className="spin" size={12} /> Preparando transferencia…</> : null}</small>
        </footer>
        {transferQueueOpen && <TransferQueuePanel jobs={transferJobs} paused={queuePaused} onTogglePause={toggleTransferQueuePause} onClose={() => setTransferQueueOpen(false)} onCancelBatch={cancelTransferBatch} onRetry={retryTransferJob} onOpenSource={(job) => void openTransferSource(job)} onOpenDestination={(job) => void openTransferDestination(job)} onClearFinished={clearFinishedTransfers} />}
      </section>

      {message && <div className="toast" role="status" aria-live="polite"><CheckCircle2 size={16} />{message}</div>}
      {paneContextMenu && <PaneFileContextMenu
        menu={paneContextMenu}
        selection={paneContextMenu.entries}
        locationLabel={paneLocationLabel(panes[paneContextMenu.side], hostsById)}
        onClose={() => setPaneContextMenu(null)}
        onOpen={(entry) => { if (entry.isDirectory) void openPaneDirectory(paneContextMenu.side, entry.path); }}
        onEditText={panes[paneContextMenu.side].source.kind === "host" ? entry => openEditor(paneContextMenu.side, entry) : undefined}
        onRename={(entry) => setNameDialog({ type: "rename", side: paneContextMenu.side, entry })}
        onDelete={(entries) => requestDelete(paneContextMenu.side, entries)}
        onCopy={(entries) => copyToClipboard(paneContextMenu.side, entries, "copy")}
        onCut={(entries) => copyToClipboard(paneContextMenu.side, entries, "move")}
        onPaste={() => pasteClipboard(paneContextMenu.side)}
        canPaste={Boolean(fileClipboard && panes[paneContextMenu.side].directory && panes[paneContextMenu.side].status === "connected")}
        onTransferOther={(entries, operation) => enqueuePaneTransfer(paneContextMenu.side, paneContextMenu.side === "left" ? "right" : "left", entries, operation)}
        onCopyPath={(entries) => void copyEntryPaths(entries)}
        onRefresh={() => void openPaneDirectory(paneContextMenu.side, panes[paneContextMenu.side].directory?.path ?? null, false)}
        onNewFolder={() => setNameDialog({ type: "folder", side: paneContextMenu.side })}
        onNewFile={() => setNameDialog({ type: "file", side: paneContextMenu.side })}
        onPermissions={panes[paneContextMenu.side].source.kind === "host" ? (entry) => setPermissionsDialog({ side: paneContextMenu.side, entry }) : undefined}
      />}
      {nameDialog && <FileNameDialog dialog={nameDialog} location={paneLocationLabel(panes[nameDialog.side], hostsById)} busy={busy} onClose={() => setNameDialog(null)} onSubmit={nameDialog.type === "rename" ? renameEntry : createNamedEntry} />}
      {editingFile && <RemoteTextEditor key={`${editingFile.hostId}:${editingFile.path}`} {...editingFile} onClose={() => setEditingFile(null)} onStateChange={state => { editorStateRef.current = state; }} onSaved={() => { const pane = panesRef.current[editingFile.side]; if (pane.source.kind === "host" && pane.source.hostId === editingFile.hostId) void openPaneDirectory(editingFile.side, pane.directory?.path ?? null, false); }} />}
      {permissionsDialog && <FilePermissionsDialog dialog={permissionsDialog} busy={busy} onClose={() => setPermissionsDialog(null)} onSubmit={changePermissions} />}
      {confirmDialog && <FileConfirmDialog
        dialog={confirmDialog}
        location={paneLocationLabel(panes[confirmDialog.side], hostsById)}
        busy={busy}
        onClose={() => setConfirmDialog(null)}
        onConfirm={confirmDialog.type === "delete" ? () => deleteEntry(confirmDialog.side, confirmDialog.entry) : () => deleteEntries(confirmDialog.side, confirmDialog.entries)}
      />}
      {queueConflict && <TransferConflictDialog prompt={queueConflict} onChoose={resolveQueueConflict} />}
      {trustPrompt && <SftpTrustDialog prompt={trustPrompt} busy={busy} onClose={() => setTrustPrompt(null)} onTrust={trustAndReconnect} />}
    </>
  );
}

function TransferQueuePanel({ jobs, paused, onTogglePause, onClose, onCancelBatch, onRetry, onOpenSource, onOpenDestination, onClearFinished }: {
  jobs: TransferJob[];
  paused: boolean;
  onTogglePause: () => void;
  onClose: () => void;
  onCancelBatch: (batchId: string) => void;
  onRetry: (jobId: string) => void;
  onOpenSource: (job: TransferJob) => void;
  onOpenDestination: (job: TransferJob) => void;
  onClearFinished: () => void;
}) {
  const [filter, setFilter] = useState<"all" | "active" | "completed" | "errors">("all");
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const active = jobs.filter((job) => job.status === "queued" || job.status === "running" || job.status === "conflict");
  const completed = jobs.filter((job) => job.status === "completed");
  const errors = jobs.filter((job) => job.status === "error" || job.status === "cancelled");
  const measurable = jobs.filter((job) => job.status !== "skipped" && job.status !== "cancelled");
  const totalBytes = measurable.reduce((total, job) => total + job.transferredBytes, 0);
  const startedTimes = measurable.map((job) => job.startedAt).filter((value): value is number => value !== null);
  const earliestStart = startedTimes.length > 0 ? Math.min(...startedTimes) : null;
  const latestFinish = active.length > 0 ? Date.now() : Math.max(...measurable.map((job) => job.finishedAt ?? 0), 0);
  const totalDuration = earliestStart ? Math.max(1, latestFinish - earliestStart) : 0;
  const speed = totalDuration > 0 ? totalBytes / (totalDuration / 1000) : 0;
  const remainingBytes = active.reduce((total, job) => total + Math.max(0, job.estimatedBytes - job.transferredBytes), 0);
  const eta = speed > 0 && remainingBytes > 0 ? remainingBytes / speed : 0;
  const expectedBytes = measurable.reduce((total, job) => total + Math.max(job.estimatedBytes, job.transferredBytes), 0);
  const allDone = measurable.length > 0 && measurable.every((job) => job.status === "completed" || job.status === "error");
  const progress = expectedBytes > 0 ? Math.min(100, Math.round((totalBytes / expectedBytes) * 100)) : allDone ? 100 : 0;
  const hasStaging = jobs.some((job) => Boolean(job.stagingRoot));
  const canClear = jobs.some((job) => job.status === "completed" || job.status === "skipped" || job.status === "cancelled" || job.status === "error");
  const visibleJobs = [...jobs].reverse().filter((job) => filter === "all"
    || filter === "active" && (job.status === "queued" || job.status === "running" || job.status === "conflict")
    || filter === "completed" && (job.status === "completed" || job.status === "skipped")
    || filter === "errors" && (job.status === "error" || job.status === "cancelled"));
  return <aside className="transfer-queue-panel" aria-label="Cola de transferencias">
    <header><span><ArrowRightLeft size={16} /></span><div><strong>Transferencias</strong><small>{paused && active.length > 0 ? "Cola pausada" : active.length > 0 ? `${active.length} pendientes` : jobs.length > 0 ? "Cola finalizada" : "Sin actividad"}</small></div>{active.length > 0 && <button className="queue-pause" onClick={onTogglePause} title={paused ? "Reanudar cola" : "Pausar después del elemento actual"}>{paused ? <Play size={13} /> : <Pause size={13} />}{paused ? "Reanudar" : "Pausar"}</button>}{canClear && <button onClick={onClearFinished}>Limpiar</button>}<button className="icon-button" onClick={onClose} aria-label="Cerrar transferencias"><X size={16} /></button></header>
    {jobs.length > 0 && <div className="queue-summary"><div><span style={{ width: `${progress}%` }} /></div><small>{progress}%</small><b>{speed > 0 ? `${formatBytes(speed)}/s` : "—"}</b><b>{eta > 0 ? `≈ ${formatDuration(eta)}` : "—"}</b></div>}
    {jobs.length > 0 && <nav className="queue-filters" aria-label="Filtrar transferencias">
      <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>Todas <b>{jobs.length}</b></button>
      <button className={filter === "active" ? "active" : ""} onClick={() => setFilter("active")}>Activas <b>{active.length}</b></button>
      <button className={filter === "completed" ? "active" : ""} onClick={() => setFilter("completed")}>Listas <b>{completed.length}</b></button>
      <button className={filter === "errors" ? "active" : ""} onClick={() => setFilter("errors")}>Errores <b>{errors.length}</b></button>
    </nav>}
    {hasStaging && <div className="queue-staging-note"><ShieldCheck size={15} /><span><strong>Transferencia protegida</strong><small>Zona temporal local, limpieza automática.</small></span></div>}
    <div className="transfer-job-list">
      {jobs.length === 0 ? <div className="queue-empty"><ArrowRightLeft size={23} /><strong>Arrastra archivos entre paneles</strong><small>Aquí verás progreso, velocidad y errores.</small></div> : visibleJobs.length === 0 ? <div className="queue-empty compact"><Search size={21} /><strong>No hay elementos en este filtro</strong><small>Selecciona otra categoría para ver el historial.</small></div> : visibleJobs.map((job) => {
        const duration = job.startedAt ? Math.max(1, (job.finishedAt ?? Date.now()) - job.startedAt) : 0;
        const jobSpeed = job.transferredBytes && duration ? job.transferredBytes / (duration / 1000) : 0;
        const expanded = expandedJobId === job.id;
        return <article key={job.id} className={`transfer-job ${job.status} ${expanded ? "expanded" : ""}`}>
          <span className="transfer-job-icon">{job.status === "completed" ? <CheckCircle2 size={16} /> : job.status === "error" ? <AlertTriangle size={16} /> : job.status === "cancelled" || job.status === "skipped" ? <Ban size={16} /> : <File size={16} />}</span>
          <button className="transfer-job-main" onClick={() => setExpandedJobId(expanded ? null : job.id)} aria-expanded={expanded}><span><strong title={job.name}>{job.name}</strong><small>{transferStatusLabel(job)} · {job.source.label} → {job.destination.label}{job.status === "running" && job.transferredBytes > 0 ? ` · ${formatBytes(job.transferredBytes)}${job.estimatedBytes > 0 ? ` / ${formatBytes(job.estimatedBytes)}` : ""}` : ""}{job.status === "completed" && jobSpeed > 0 ? ` · ${formatBytes(jobSpeed)}/s` : ""}</small>{job.error && <em title={job.error}>{job.error}</em>}{job.status === "running" && (job.estimatedBytes > 0 ? <i className="job-progress"><span style={{ width: `${Math.min(100, (job.transferredBytes / job.estimatedBytes) * 100)}%` }} /></i> : <i className="job-progress-indeterminate" />)}</span>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
          <div className="transfer-job-primary-action">{(job.status === "queued" || job.status === "running" || job.status === "conflict") && <button className="queue-cancel" onClick={() => onCancelBatch(job.batchId)} title="Cancelar lote"><X size={14} /></button>}{job.status === "error" && <button className="queue-retry" onClick={() => onRetry(job.id)} title="Reintentar"><RotateCcw size={14} /></button>}{job.status === "completed" && <button className="queue-open-destination" onClick={() => onOpenDestination(job)} title="Abrir carpeta de destino"><FolderOpen size={14} /></button>}</div>
          {expanded && <div className="transfer-job-details"><dl><div><dt>Acción</dt><dd>{job.operation === "move" ? "Mover" : "Copiar"}</dd></div><div><dt>Tamaño</dt><dd>{formatBytes(Math.max(job.estimatedBytes, job.transferredBytes))}</dd></div><div><dt>Origen</dt><dd title={job.source.path}>{job.source.path}</dd></div><div><dt>Destino</dt><dd title={job.destination.path}>{job.destination.path}</dd></div>{job.error && <div className="full"><dt>Error</dt><dd>{job.error}</dd></div>}</dl><div className="transfer-job-detail-actions"><button onClick={() => onOpenSource(job)}><FolderOpen size={13} /> Abrir origen</button><button onClick={() => onOpenDestination(job)}><FolderOpen size={13} /> Abrir destino</button>{job.status === "error" && <button onClick={() => onRetry(job.id)}><RotateCcw size={13} /> Reintentar</button>}</div></div>}
        </article>;
      })}
    </div>
    {totalBytes > 0 && <footer><span>{formatBytes(totalBytes)} transferidos</span><span>{completed.reduce((total, job) => total + job.fileCount, 0)} archivos</span></footer>}
  </aside>;
}

function TransferConflictDialog({ prompt, onChoose }: { prompt: Exclude<QueueConflictPrompt, null>; onChoose: (choice: ConflictChoice) => void }) {
  const [applyAll, setApplyAll] = useState(false);
  const dialogRef = useDialogFocus<HTMLDivElement>(() => onChoose("cancel_batch"), false);
  return <div className="modal-backdrop" role="presentation"><div ref={dialogRef} className="modal transfer-conflict-modal" role="alertdialog" aria-modal="true" tabIndex={-1}><header className="modal-header"><div className="modal-icon"><Copy size={19} /></div><div><h2>“{prompt.name}” ya existe</h2><p>Destino: {prompt.destination}</p></div></header><div className="modal-body"><label className="apply-all-conflicts"><input type="checkbox" checked={applyAll} onChange={(event) => setApplyAll(event.target.checked)} /><span>Aplicar también a los demás conflictos de este lote</span></label><div className="conflict-action-grid"><button className="button secondary" onClick={() => onChoose(applyAll ? "skip_all" : "skip_once")}><Ban size={15} /><span><strong>Omitir</strong><small>No copiar este elemento</small></span></button><button className="button secondary" onClick={() => onChoose(applyAll ? "keep_all" : "keep_once")}><Copy size={15} /><span><strong>Conservar ambos</strong><small>Crear una copia con otro nombre</small></span></button><button className="button primary" onClick={() => onChoose(applyAll ? "replace_all" : "replace_once")}><RefreshCw size={15} /><span><strong>Reemplazar</strong><small>Sobrescribir el existente</small></span></button></div></div><footer className="modal-footer"><button className="button subtle danger-text" onClick={() => onChoose("cancel_batch")}>Cancelar lote</button></footer></div></div>;
}

interface FilePaneProps {
  side: PaneSide;
  source: PaneSource;
  hosts: Host[];
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  directory: PaneDirectory | null;
  entries: PaneEntry[];
  selectedPaths: string[];
  busy: boolean;
  loading: boolean;
  error: string | null;
  roots?: Array<{ label: string; path: string }>;
  parentPath: string | null;
  disconnected?: boolean;
  disconnectedMessage?: string;
  connectionStatus: ConnectionStatus;
  latencyMs: number | null;
  reconnectAttempts: number;
  canGoBack: boolean;
  canGoForward: boolean;
  favorites: FavoriteLocation[];
  currentFavorite: boolean;
  onSourceChange: (value: string) => void;
  onBrowseHosts?: () => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onBack: () => void;
  onForward: () => void;
  onToggleFavorite: () => void;
  onOpenFavorite: (path: string) => void;
  onSelect: (entry: PaneEntry, event: React.MouseEvent, orderedEntries: PaneEntry[]) => void;
  onSelectPath: (path: string) => void;
  onOpen: (entry: PaneEntry) => void;
  onOpenPath: (path: string) => void;
  onRefresh: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onRename: (entry: PaneEntry) => void;
  onDeleteSelection: (entries: PaneEntry[]) => void;
  onCopySelection: (entries: PaneEntry[]) => void;
  onCutSelection: (entries: PaneEntry[]) => void;
  onPaste: () => void;
  canPaste: boolean;
  onContextMenu: (event: React.MouseEvent, entry: PaneEntry | null) => void;
  onStartDrag: (entry: PaneEntry) => void;
  onSelectAll: (entries: PaneEntry[]) => void;
  onClearSelection: () => void;
  dropActive: boolean;
}

export function FilePane({ side, source, hosts, title, subtitle, icon, directory, entries, selectedPaths, busy, loading, error, roots, parentPath, disconnected, disconnectedMessage, connectionStatus, latencyMs, reconnectAttempts, canGoBack, canGoForward, favorites, currentFavorite, onSourceChange, onBrowseHosts, onConnect, onDisconnect, onBack, onForward, onToggleFavorite, onOpenFavorite, onSelect, onSelectPath, onOpen, onOpenPath, onRefresh, onNewFolder, onNewFile, onRename, onDeleteSelection, onCopySelection, onCutSelection, onPaste, canPaste, onContextMenu, onStartDrag, onSelectAll, onClearSelection, dropActive }: FilePaneProps) {
  const selectedSet = new Set(selectedPaths);
  const selectedEntries = entries.filter((entry) => selectedSet.has(entry.path));
  const [pathValue, setPathValue] = useState(directory?.path ?? "");
  const [searchVisible, setSearchVisible] = useState(false);
  const [search, setSearch] = useState("");
  const [viewSettings, setViewSettings] = useState<PaneViewSettings>(() => restorePaneViewSettings(side));
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(500);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const filteredEntries = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const visible = entries.filter((entry) => (viewSettings.showHidden || !entry.name.startsWith(".")) && (!query || entry.name.toLocaleLowerCase().includes(query)));
    return visible.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      let comparison = 0;
      if (viewSettings.sortKey === "name") comparison = left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
      else if (viewSettings.sortKey === "size") comparison = left.size - right.size;
      else comparison = (Date.parse(left.modifiedAt ?? "") || 0) - (Date.parse(right.modifiedAt ?? "") || 0);
      return viewSettings.sortDirection === "asc" ? comparison : -comparison;
    });
  }, [entries, search, viewSettings.showHidden, viewSettings.sortDirection, viewSettings.sortKey]);
  const virtualWindow = useMemo(() => {
    const rowHeight = FILE_ROW_HEIGHT;
    const headerHeight = 33;
    const relativeScroll = Math.max(0, scrollTop - headerHeight);
    const start = Math.max(0, Math.floor(relativeScroll / rowHeight) - 8);
    const end = Math.min(filteredEntries.length, Math.ceil((relativeScroll + viewportHeight) / rowHeight) + 8);
    return { start, end, top: start * rowHeight, bottom: Math.max(0, (filteredEntries.length - end) * rowHeight) };
  }, [filteredEntries.length, scrollTop, viewportHeight]);
  useEffect(() => { setPathValue(directory?.path ?? ""); }, [directory?.path]);
  useEffect(() => { setSearch(""); setScrollTop(0); }, [directory?.path]);
  useEffect(() => {
    const timeout = window.setTimeout(() => safeStorageSet(`nexora.sftp.view.${side}`, JSON.stringify(viewSettings)), 250);
    return () => window.clearTimeout(timeout);
  }, [side, viewSettings]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const resize = new ResizeObserver(([entry]) => setViewportHeight(entry.contentRect.height));
    resize.observe(viewport);
    return () => resize.disconnect();
  }, []);
  function openFilter() { setSearchVisible(true); window.requestAnimationFrame(() => searchRef.current?.focus()); }
  function closeFilter() { setSearch(""); setSearchVisible(false); window.requestAnimationFrame(() => searchToggleRef.current?.focus()); }
  function changeSort(sortKey: PaneSortKey) {
    setViewSettings((current) => ({ ...current, sortKey, sortDirection: current.sortKey === sortKey && current.sortDirection === "asc" ? "desc" : "asc" }));
  }
  function beginColumnResize(column: ResizableColumn, event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const initial = viewSettings[column];
    const move = (moveEvent: PointerEvent) => setViewSettings((current) => ({ ...current, [column]: clampColumnWidth(column, initial + moveEvent.clientX - startX) }));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }
  function moveKeyboardSelection(offset: number) {
    if (filteredEntries.length === 0) return;
    const currentIndex = filteredEntries.findIndex((entry) => selectedSet.has(entry.path));
    const nextIndex = Math.max(0, Math.min(filteredEntries.length - 1, currentIndex < 0 ? 0 : currentIndex + offset));
    const next = filteredEntries[nextIndex];
    onSelectPath(next.path);
    if (viewportRef.current) viewportRef.current.scrollTop = Math.max(0, nextIndex * FILE_ROW_HEIGHT - viewportHeight / 2);
  }
  return (
    <section
      className={`file-pane ${source.kind === "host" ? "remote" : "local"} ${dropActive ? "drop-active" : ""}`}
      data-file-pane={side}
      data-layout-pane={side}
      style={{ "--file-row-height": `${FILE_ROW_HEIGHT}px`, "--pane-size-column": `${viewSettings.sizeColumn}px`, "--pane-modified-column": `${viewSettings.modifiedColumn}px` } as React.CSSProperties}
      tabIndex={0}
      aria-label={`Panel ${side === "left" ? "izquierdo" : "derecho"}: ${title}`}
      onContextMenu={(event) => onContextMenu(event, null)}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        const button = target.closest("button");
        const editing = Boolean(target.closest("input, textarea, select, [contenteditable='true']") || button && !button.classList.contains("pane-file-row"));
        if (!editing && event.key === "Delete" && selectedEntries.length > 0) { event.preventDefault(); onDeleteSelection(selectedEntries); }
        if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); onSelectAll(filteredEntries); }
        if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); openFilter(); }
        if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && selectedEntries.length > 0) { event.preventDefault(); onCopySelection(selectedEntries); }
        if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x" && selectedEntries.length > 0) { event.preventDefault(); onCutSelection(selectedEntries); }
        if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v" && canPaste) { event.preventDefault(); onPaste(); }
        if (!editing && event.key === "ArrowDown") { event.preventDefault(); moveKeyboardSelection(1); }
        if (!editing && event.key === "ArrowUp") { event.preventDefault(); moveKeyboardSelection(-1); }
        if (!editing && event.key === "Home") { event.preventDefault(); moveKeyboardSelection(-filteredEntries.length); }
        if (!editing && event.key === "End") { event.preventDefault(); moveKeyboardSelection(filteredEntries.length); }
        if (!editing && event.key === "Enter" && selectedEntries.length === 1) { event.preventDefault(); onOpen(selectedEntries[0]); }
        if (!editing && event.key === "F2" && selectedEntries.length === 1) { event.preventDefault(); onRename(selectedEntries[0]); }
        if (!editing && event.key === "Escape") onClearSelection();
      }}
    >
      <header className="file-pane-heading">
        <span>{icon}</span>
        <div><DestinationPicker side={side} source={source} hosts={hosts} disabled={busy} onChange={onSourceChange} /><small title={subtitle}>{subtitle}</small></div>
        {source.kind === "host" && <output className={`pane-connection-state ${connectionStatus}`} title={connectionStatus === "connected" ? `Conexión activa${latencyMs ? ` · ${latencyMs} ms` : ""}` : "Conexión cerrada"}><i />{connectionStatus === "connected" ? latencyMs ? `${latencyMs} ms` : "Conectado" : connectionStatus === "connecting" ? reconnectAttempts > 0 ? `Reconectando ${reconnectAttempts}/3` : "Conectando" : connectionStatus === "error" ? reconnectAttempts > 0 ? `Reintento ${reconnectAttempts}/3` : "Error" : "Desconectado"}</output>}
        {onBrowseHosts && <button type="button" className="pane-browse-hosts" disabled={busy} onClick={onBrowseHosts} aria-label="Volver a conexiones" title="Volver a conexiones"><List size={14} /><span>Conexiones</span></button>}
        {onDisconnect && <button type="button" className="pane-disconnect" disabled={busy} onClick={onDisconnect} aria-label={`Desconectar ${title}`} title="Desconectar solo este panel"><Unplug size={14} /></button>}
        {roots && roots.length > 0 && <select className="pane-root-select" aria-label="Unidad local" value={roots.find((root) => directory && directory.path.toLowerCase().startsWith(root.path.toLowerCase()))?.path ?? roots[0].path} onChange={(event) => onOpenPath(event.target.value)}>{roots.map((root) => <option key={root.path} value={root.path}>{root.label}</option>)}</select>}
      </header>
      <div className="file-pane-toolbar">
        <div className="pane-toolbar-group">
        <button className="icon-button" disabled={busy || !canGoBack} onClick={onBack} title="Atrás" aria-label={`Atrás en ${title}`}><ArrowLeft size={16} /></button>
        <button className="icon-button" disabled={busy || !canGoForward} onClick={onForward} title="Adelante" aria-label={`Adelante en ${title}`}><ArrowRight size={16} /></button>
        <button className="icon-button" disabled={busy || !parentPath} onClick={() => parentPath && onOpenPath(parentPath)} title="Subir un nivel" aria-label={`Subir un nivel en ${title}`}><ArrowUp size={16} /></button>
        </div>
        <form className="pane-path-editor" onSubmit={(event) => { event.preventDefault(); const next = pathValue.trim(); if (next && next !== directory?.path) onOpenPath(next); }}><span>{source.kind === "local" ? <HardDrive size={13} /> : <Server size={13} />}</span><input value={pathValue} disabled={busy || disconnected} onChange={(event) => setPathValue(event.target.value)} onBlur={() => setPathValue(directory?.path ?? "")} aria-label={`Ruta de ${title}`} spellCheck={false} /></form>
        <button ref={searchToggleRef} className={`icon-button ${searchVisible ? "active" : ""}`} disabled={busy || !directory} aria-label={`Filtrar carpeta de ${title}`} title="Filtrar carpeta (Ctrl F)" aria-pressed={searchVisible} onClick={() => searchVisible ? closeFilter() : openFilter()}><Search size={16} /></button>
        <ActionMenu label={`Opciones de archivos de ${title}`} disabled={busy}>
          <button role="menuitem" disabled={!directory} onClick={onRefresh}><RefreshCw className={loading ? "spin" : ""} size={15} />Actualizar</button>
          <button role="menuitem" disabled={!directory || disconnected} onClick={onNewFolder}><FolderPlus size={16} />Nueva carpeta</button>
          <button role="menuitem" disabled={!directory || disconnected} onClick={onNewFile}><File size={15} />Nuevo archivo vacío</button>
          <button role="menuitemcheckbox" aria-checked={viewSettings.showHidden} onClick={() => setViewSettings(current => ({ ...current, showHidden: !current.showHidden }))}>{viewSettings.showHidden ? <Eye size={15} /> : <EyeOff size={15} />}{viewSettings.showHidden ? "Ocultar archivos ocultos" : "Mostrar archivos ocultos"}</button>
          <Disclosure menu title="Ubicaciones favoritas">
            <button role="menuitem" disabled={!directory || disconnected} onClick={onToggleFavorite}><Star size={15} fill={currentFavorite ? "currentColor" : "none"} />{currentFavorite ? "Quitar ubicación actual" : "Guardar ubicación actual"}</button>
            {favorites.map(favorite => <button role="menuitem" key={favorite.id} title={favorite.path} onClick={() => onOpenFavorite(favorite.path)}><Folder size={15} /><span>{favorite.label}</span></button>)}
            {favorites.length === 0 && <p className="menu-empty">No hay rutas guardadas.</p>}
          </Disclosure>
        </ActionMenu>
      </div>
      {searchVisible && <div className="pane-filterbar">
        <label><Search size={13} /><input ref={searchRef} value={search} onChange={event => setSearch(event.target.value)} placeholder="Filtrar esta carpeta…" aria-label={`Filtrar archivos de ${title}`} onKeyDown={event => { if(event.key === "Escape") { event.stopPropagation(); closeFilter(); } }} /><button type="button" onClick={closeFilter} aria-label={`Cerrar filtro de ${title}`}><X size={14} /></button></label>
      </div>}

      <div ref={viewportRef} className="file-pane-content" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} onClick={(event) => { if (!(event.target as HTMLElement).closest(".pane-file-row")) onClearSelection(); }}>
        {disconnected ? (
          <div className="pane-placeholder"><span>{loading ? <LoaderCircle className="spin" size={23} /> : <PlugZap size={23} />}</span><strong>{loading ? "Conectando…" : error ? "No se pudo conectar" : "Listo para conectar"}</strong><p>{disconnectedMessage}</p>{onConnect && !loading && <button className="button primary" onClick={onConnect}>{error ? "Reintentar" : "Conectar"}</button>}</div>
        ) : error ? (
          <div className="pane-placeholder error"><span><AlertTriangle size={22} /></span><strong>No se pudo abrir la carpeta</strong><p>{error}</p><button className="button secondary" onClick={onRefresh}>Reintentar</button></div>
        ) : !directory || loading ? (
          <PaneLoadingSkeleton />
        ) : entries.length === 0 ? (
          <div className="pane-placeholder compact"><FolderOpen size={25} /><strong>Carpeta vacía</strong></div>
        ) : filteredEntries.length === 0 ? (
          <div className="pane-placeholder compact"><Search size={24} /><strong>Sin coincidencias</strong><span>Cambia el filtro o muestra los archivos ocultos.</span></div>
        ) : (
          <div className="pane-file-list" role="grid" aria-label={`Contenido de ${title}`}>
            <div className="pane-file-header" role="row"><button type="button" aria-pressed={viewSettings.sortKey === "name"} onClick={() => changeSort("name")}>Nombre <SortMark active={viewSettings.sortKey === "name"} direction={viewSettings.sortDirection} /></button><button type="button" aria-pressed={viewSettings.sortKey === "size"} onClick={() => changeSort("size")}>Tamaño <SortMark active={viewSettings.sortKey === "size"} direction={viewSettings.sortDirection} /><i onPointerDown={(event) => beginColumnResize("sizeColumn", event)} /></button><button type="button" aria-pressed={viewSettings.sortKey === "modified"} onClick={() => changeSort("modified")}>Modificado <SortMark active={viewSettings.sortKey === "modified"} direction={viewSettings.sortDirection} /><i onPointerDown={(event) => beginColumnResize("modifiedColumn", event)} /></button></div>
            {virtualWindow.top > 0 && <div className="pane-virtual-spacer" style={{ height: virtualWindow.top }} />}
            {filteredEntries.slice(virtualWindow.start, virtualWindow.end).map((entry) => <button
              key={entry.path}
              className={`pane-file-row ${selectedSet.has(entry.path) ? "selected" : ""}`}
              role="row"
              aria-selected={selectedSet.has(entry.path)}
              draggable={!busy && !entry.isSymlink}
              onClick={(event) => onSelect(entry, event, filteredEntries)}
              onDoubleClick={() => onOpen(entry)}
              onContextMenu={(event) => onContextMenu(event, entry)}
              onDragStart={(event) => { event.preventDefault(); onStartDrag(entry); }}
              title={entry.path}
            ><span className="pane-file-name" role="gridcell"><i className={entry.isDirectory ? "folder" : "file"}>{entry.isDirectory ? <Folder size={16} fill="currentColor" /> : entry.isSymlink ? <FileQuestion size={16} /> : <File size={16} />}</i><strong>{entry.name}</strong></span><span role="gridcell">{entry.isDirectory ? "—" : formatBytes(entry.size)}</span><span role="gridcell">{formatDate(entry.modifiedAt)}</span></button>)}
            {virtualWindow.bottom > 0 && <div className="pane-virtual-spacer" style={{ height: virtualWindow.bottom }} />}
          </div>
        )}
      </div>

      <footer className="file-pane-footer">{selectedEntries.length > 0 ? <><strong title={selectedEntries.length === 1 ? selectedEntries[0].name : undefined}>{selectedEntries.length === 1 ? selectedEntries[0].name : `${selectedEntries.length} seleccionados`}</strong>{selectedEntries.length === 1 && <button disabled={busy} onClick={() => onRename(selectedEntries[0])}><Pencil size={13} /> Renombrar</button>}<button className="danger" disabled={busy} onClick={() => onDeleteSelection(selectedEntries)}><Trash2 size={13} /> Eliminar{selectedEntries.length > 1 ? ` (${selectedEntries.length})` : ""}</button></> : <span>{filteredEntries.length === entries.length ? `${entries.length} elementos` : `${filteredEntries.length} de ${entries.length} elementos`}</span>}</footer>
    </section>
  );
}

function PaneLoadingSkeleton() {
  return <div className="pane-skeleton-list" role="status" aria-live="polite" aria-label="Cargando archivos">
    {Array.from({ length: 9 }, (_, index) => <div className="pane-skeleton-row" key={index}><i /><span /><span /><span /></div>)}
  </div>;
}

function SortMark({ active, direction }: { active: boolean; direction: "asc" | "desc" }) {
  return <small className={`pane-sort-mark ${active ? "active" : ""}`}>{active ? direction === "asc" ? "↑" : "↓" : "↕"}</small>;
}

function HostBrowserPane({ hosts, totalHosts, activity, search, connectedHostId, onSearch, onSelect }: {
  hosts: Host[];
  totalHosts: number;
  activity: Record<string, HostActivity>;
  search: string;
  connectedHostId: string | null;
  onSearch: (value: string) => void;
  onSelect: (hostId: string) => void;
}) {
  return <section className="file-pane remote host-browser-pane" data-layout-pane="right" aria-label="Seleccionar conexión para el panel derecho">
    <header className="file-pane-heading host-browser-heading"><span><Server size={17} /></span><div><strong>Conexiones</strong><small>Elige el destino del panel derecho</small></div></header>
    <div className="host-browser-search"><Search size={15} /><input autoFocus value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Buscar por nombre, IP o usuario…" aria-label="Buscar conexión para archivos" />{search && <button type="button" onClick={() => onSearch("")} aria-label="Limpiar búsqueda"><X size={14} /></button>}</div>
    <div className="host-browser-list" role="list" aria-label="Conexiones ordenadas por actividad">
      {hosts.map((host) => {
        const connected = connectedHostId === host.id;
        return <div key={host.id} role="listitem"><button type="button" className={`host-browser-row ${connected ? "connected" : ""}`} onClick={() => onSelect(host.id)}>
          <span className="host-browser-avatar" style={{ background: host.color }}>{host.name.slice(0, 2).toUpperCase()}</span>
          <span className="host-browser-identity"><strong>{host.name}</strong><small>{host.username}@{host.address}:{host.port}</small></span>
          <span className="host-browser-activity">{connected ? <b><i /> Conectado</b> : hostActivityLabel(activity[host.id])}</span>
          <ChevronRight size={15} />
        </button></div>;
      })}
      {hosts.length === 0 && <div className="host-browser-empty"><Search size={22} /><strong>{totalHosts === 0 ? "No hay conexiones guardadas" : "No hay coincidencias"}</strong><small>{totalHosts === 0 ? "Crea un host desde la sección Hosts." : "Prueba con otro nombre, IP o usuario."}</small></div>}
    </div>
    <footer className="file-pane-footer"><span>{hosts.length} de {totalHosts} conexiones</span><small>Más recientes primero</small></footer>
  </section>;
}

function DestinationPicker({ side, source, hosts, disabled, onChange }: {
  side: PaneSide;
  source: PaneSource;
  hosts: Host[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selectedHost = source.kind === "host" ? hosts.find((host) => host.id === source.hostId) : null;
  const label = selectedHost?.name ?? "Mi equipo";

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function choose(value: string) {
    setOpen(false);
    const current = source.kind === "local" ? "local" : `host:${source.hostId}`;
    if (value !== current) onChange(value);
  }

  return <div ref={pickerRef} className={`destination-picker ${open ? "open" : ""}`}>
    <button
      type="button"
      className="destination-trigger"
      aria-label={`Destino del panel ${side === "left" ? "izquierdo" : "derecho"}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => setOpen((current) => !current)}
    ><strong>{label}</strong><ChevronDown size={15} /></button>
    {open && <div className="destination-menu" role="listbox" aria-label="Destinos disponibles">
      <span className="destination-group-label">ESTE DISPOSITIVO</span>
      <button type="button" className={`destination-option ${source.kind === "local" ? "active" : ""}`} role="option" aria-selected={source.kind === "local"} onClick={() => choose("local")}><Monitor size={16} /><span><strong>Mi equipo</strong><small>Archivos locales</small></span>{source.kind === "local" && <Check size={15} />}</button>
      <span className="destination-group-label remote-label">CONEXIONES SSH</span>
      {hosts.map((host) => {
        const active = source.kind === "host" && source.hostId === host.id;
        return <button key={host.id} type="button" className={`destination-option ${active ? "active" : ""}`} role="option" aria-selected={active} onClick={() => choose(`host:${host.id}`)}><Server size={16} /><span><strong>{host.name}</strong><small>{host.username}@{host.address}:{host.port}</small></span>{active && <Check size={15} />}</button>;
      })}
      {hosts.length === 0 && <small className="destination-empty">No hay conexiones guardadas</small>}
    </div>}
  </div>;
}

function PaneFileContextMenu({ menu, selection, locationLabel, onClose, onOpen, onEditText, onRename, onDelete, onCopy, onCut, onPaste, canPaste, onTransferOther, onCopyPath, onRefresh, onNewFolder, onNewFile, onPermissions }: {
  menu: Exclude<PaneContextMenu, null>;
  selection: PaneEntry[];
  locationLabel: string;
  onClose: () => void;
  onOpen: (entry: PaneEntry) => void;
  onEditText?: (entry: PaneEntry) => void;
  onRename: (entry: PaneEntry) => void;
  onDelete: (entries: PaneEntry[]) => void;
  onCopy: (entries: PaneEntry[]) => void;
  onCut: (entries: PaneEntry[]) => void;
  onPaste: () => void;
  canPaste: boolean;
  onTransferOther: (entries: PaneEntry[], operation: "copy" | "move") => void;
  onCopyPath: (entries: PaneEntry[]) => void;
  onRefresh: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onPermissions?: (entry: PaneEntry) => void;
}) {
  const { entry } = menu;
  const selectionCount = selection.length;
  const run = (action: () => void) => { onClose(); action(); };
  return <ContextMenuSurface className="sftp-context-menu" x={menu.x} y={menu.y} onClose={onClose}>
    <div className="context-menu-title">{selectionCount > 1 ? `${selectionCount} SELECCIONADOS` : locationLabel.toUpperCase()}</div>
    {entry ? <>
      {selectionCount === 1 && entry.isDirectory && <button role="menuitem" onClick={() => run(() => onOpen(entry))}><FolderOpen size={15} /><span>Abrir carpeta</span></button>}
      {selectionCount === 1 && !entry.isDirectory && !entry.isSymlink && onEditText && <button role="menuitem" onClick={() => run(() => onEditText(entry))}><File size={15} /><span>Editar texto remoto</span></button>}
      {selectionCount === 1 && <button role="menuitem" onClick={() => run(() => onRename(entry))}><Pencil size={15} /><span>Renombrar</span></button>}
      <button role="menuitem" onClick={() => run(() => onCopy(selection))}><Copy size={15} /><span>Copiar</span><kbd>Ctrl+C</kbd></button>
      <button role="menuitem" onClick={() => run(() => onCut(selection))}><Scissors size={15} /><span>Cortar</span><kbd>Ctrl+X</kbd></button>
      <button role="menuitem" onClick={() => run(() => onTransferOther(selection, "copy"))}><ArrowRightLeft size={15} /><span>Copiar al otro panel</span></button>
      <Disclosure title="Más acciones" menu><button role="menuitem" onClick={() => run(() => onTransferOther(selection, "move"))}><ArrowRightLeft size={15} /><span>Mover al otro panel</span></button><button role="menuitem" onClick={() => onCopyPath(selection)}><Copy size={15} /><span>{selectionCount > 1 ? "Copiar rutas" : "Copiar ruta"}</span></button>{selectionCount === 1 && onPermissions && <button role="menuitem" onClick={() => run(() => onPermissions(entry))}><KeyRound size={15} /><span>Permisos…</span></button>}</Disclosure>
      <div className="context-menu-separator" />
      <button className="context-danger" role="menuitem" onClick={() => run(() => onDelete(selection))}><Trash2 size={15} /><span>Eliminar{selectionCount > 1 ? ` (${selectionCount})` : ""}</span><kbd>Supr</kbd></button>
    </> : <>
      {canPaste && <button role="menuitem" onClick={() => run(onPaste)}><ClipboardPaste size={15} /><span>Pegar aquí</span><kbd>Ctrl+V</kbd></button>}
      <button role="menuitem" onClick={() => run(onNewFolder)}><FolderPlus size={15} /><span>Nueva carpeta</span></button>
      <button role="menuitem" onClick={() => run(onNewFile)}><File size={15} /><span>Nuevo archivo vacío</span></button>
      <button role="menuitem" onClick={() => run(onRefresh)}><RefreshCw size={15} /><span>Actualizar esta vista</span></button>
    </>}
  </ContextMenuSurface>;
}

function FileNameDialog({ dialog, location, busy, onClose, onSubmit }: { dialog: Exclude<NameDialog, null>; location: string; busy: boolean; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(dialog.type === "rename" ? dialog.entry.name : "");
  const [error, setError] = useState("");
  const dialogRef = useDialogFocus<HTMLFormElement>(onClose, busy);
  async function submit(event: React.FormEvent) { event.preventDefault(); if (!name.trim()) return; setError(""); try { await onSubmit(name.trim()); } catch (reason) { setError(errorMessage(reason)); } }
  const creatingFolder = dialog.type === "folder";
  const creatingFile = dialog.type === "file";
  const title = creatingFolder ? "Nueva carpeta" : creatingFile ? "Nuevo archivo vacío" : "Renombrar elemento";
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><form ref={dialogRef} className="modal small-modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onSubmit={(event) => void submit(event)}><header className="modal-header"><div className="modal-icon">{creatingFile ? <File size={19} /> : <FolderPlus size={19} />}</div><div><h2>{title}</h2><p>{location}</p></div><button type="button" className="icon-button modal-close" disabled={busy} onClick={onClose}><X size={18} /></button></header><div className="modal-body"><label className="field"><span>Nombre</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>{error && <div className="form-error">{error}</div>}</div><footer className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancelar</button><button className="button primary" disabled={busy || !name.trim()}>{busy ? "Procesando…" : creatingFolder ? "Crear carpeta" : creatingFile ? "Crear archivo" : "Guardar"}</button></footer></form></div>;
}

function FilePermissionsDialog({ dialog, busy, onClose, onSubmit }: { dialog: Exclude<PermissionsDialog, null>; busy: boolean; onClose: () => void; onSubmit: (mode: number) => Promise<void> }) {
  const initial = "permissions" in dialog.entry ? dialog.entry.permissions.replace(/[^rwx-]/g, "") : "";
  const [mode, setMode] = useState(() => symbolicPermissionsToOctal(initial));
  const [error, setError] = useState("");
  const dialogRef = useDialogFocus<HTMLFormElement>(onClose, busy);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!/^[0-7]{3,4}$/.test(mode)) { setError("Escribe un modo octal válido, por ejemplo 644 o 0755."); return; }
    setError("");
    try { await onSubmit(Number.parseInt(mode, 8)); } catch (reason) { setError(errorMessage(reason)); }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><form ref={dialogRef} className="modal small-modal" role="dialog" aria-modal="true" aria-label="Editar permisos" tabIndex={-1} onSubmit={(event) => void submit(event)}><header className="modal-header"><div className="modal-icon"><KeyRound size={19} /></div><div><h2>Permisos de “{dialog.entry.name}”</h2><p>Modo octal del servidor</p></div><button type="button" className="icon-button modal-close" disabled={busy} onClick={onClose}><X size={18} /></button></header><div className="modal-body"><label className="field"><span>Permisos</span><input autoFocus value={mode} maxLength={4} inputMode="numeric" onChange={(event) => setMode(event.target.value.replace(/[^0-7]/g, ""))} placeholder="0644" /></label><div className="permissions-preview"><code>{mode || "—"}</code><span>{octalPermissionsLabel(mode)}</span></div>{error && <div className="form-error">{error}</div>}</div><footer className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancelar</button><button className="button primary" disabled={busy || !/^[0-7]{3,4}$/.test(mode)}>Guardar permisos</button></footer></form></div>;
}

function FileConfirmDialog({ dialog, location, busy, onClose, onConfirm }: { dialog: Exclude<ConfirmDialog, null>; location: string; busy: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose, busy);
  const bulkDeleting = dialog.type === "bulk_delete";
  const entry = bulkDeleting
    ? { name: `${dialog.entries.length} elementos`, isDirectory: false }
      : dialog.entry;
  const requiresPhrase = bulkDeleting || entry.isDirectory;
  async function confirm() { setError(""); try { await onConfirm(); } catch (reason) { setError(errorMessage(reason)); } }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><div ref={dialogRef} className="modal confirm-modal" role="alertdialog" aria-modal="true" tabIndex={-1}><header className="modal-header"><div className="modal-icon danger"><AlertTriangle size={19} /></div><div><h2>{`Eliminar ${bulkDeleting ? entry.name : `“${entry.name}”`}`}</h2><p>{`Se eliminará de ${location}.`}</p></div><button className="icon-button modal-close" disabled={busy} onClick={onClose}><X size={18} /></button></header><div className="modal-body confirm-copy"><p>{bulkDeleting ? "Los elementos seleccionados y todo el contenido de sus carpetas se eliminarán de forma permanente." : entry.isDirectory ? "La carpeta y todo su contenido se eliminarán de forma permanente." : "Esta acción no se puede deshacer."}</p>{requiresPhrase && <label className="field destructive-confirmation"><span>Escribe ELIMINAR para confirmar</span><input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value.toUpperCase())} placeholder="ELIMINAR" /></label>}{error && <div className="form-error">{error}</div>}</div><footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={onClose}>Cancelar</button><button className="button danger" disabled={busy || (requiresPhrase && confirmation !== "ELIMINAR")} onClick={() => void confirm()}>{busy ? "Procesando…" : `Eliminar${bulkDeleting ? ` (${dialog.entries.length})` : ""}`}</button></footer></div></div>;
}

function SftpTrustDialog({ prompt, busy, onClose, onTrust }: { prompt: Exclude<TrustPrompt, null>; busy: boolean; onClose: () => void; onTrust: () => Promise<void> }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose, busy);
  const changed = prompt.kind === "changed";
  return <div className="modal-backdrop" role="presentation"><div ref={dialogRef} className="modal sftp-trust-modal" role="alertdialog" aria-modal="true" tabIndex={-1}><header className="modal-header"><div className={`modal-icon ${changed ? "danger" : ""}`}>{changed ? <ShieldAlert size={20} /> : <ShieldCheck size={20} />}</div><div><h2>{changed ? "La identidad del servidor cambió" : "Verifica este servidor"}</h2><p>{changed ? "Nexora bloqueó la conexión de archivos." : "Confirma la huella antes de guardar la confianza."}</p></div></header><div className="modal-body"><div className="sftp-trust-target"><Server size={17} /><span><small>Servidor</small><strong>{prompt.address}</strong></span></div><div className="sftp-fingerprint"><span><KeyRound size={14} /> {prompt.algorithm}</span><code>{prompt.fingerprint}</code></div>{changed && <div className="restore-warning"><AlertTriangle size={18} /><div><strong>No continúes sin verificar el cambio</strong><small>La llave del servidor ya no coincide con la que guardaste.</small></div></div>}</div><footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={onClose}>{changed ? "Cerrar" : "Cancelar"}</button>{prompt.challengeId && <button className="button primary" disabled={busy} onClick={() => void onTrust()}>{busy ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />} {changed ? "Reemplazar clave y conectar" : "Confiar y conectar"}</button>}</footer></div></div>;
}

function emptyPane(source: PaneSource): PaneState {
  return { source, directory: null, selectedPaths: [], status: source.kind === "local" ? "connecting" : "disconnected", error: null, latencyMs: null, reconnectAttempts: 0, restoredPath: null };
}

function paneSourceKey(source: PaneSource): string {
  return source.kind === "local" ? "local" : `host:${source.hostId}`;
}

function restoreFavoriteLocations(): FavoriteLocation[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem("nexora.sftp.favorites") ?? "[]") as FavoriteLocation[];
    return Array.isArray(parsed)
      ? parsed.filter((favorite) => favorite && typeof favorite.id === "string" && typeof favorite.sourceKey === "string" && typeof favorite.path === "string" && typeof favorite.label === "string")
      : [];
  } catch {
    return [];
  }
}

function restorePaneViewSettings(side: PaneSide): PaneViewSettings {
  const defaults: PaneViewSettings = { sortKey: "name", sortDirection: "asc", showHidden: false, sizeColumn: 72, modifiedColumn: 110 };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(`nexora.sftp.view.${side}`) ?? "null") as Partial<PaneViewSettings> | null;
    if (!parsed) return defaults;
    return {
      sortKey: parsed.sortKey === "size" || parsed.sortKey === "modified" ? parsed.sortKey : "name",
      sortDirection: parsed.sortDirection === "desc" ? "desc" : "asc",
      showHidden: Boolean(parsed.showHidden),
      sizeColumn: typeof parsed.sizeColumn === "number" ? clampColumnWidth("sizeColumn", parsed.sizeColumn) : defaults.sizeColumn,
      modifiedColumn: typeof parsed.modifiedColumn === "number" ? clampColumnWidth("modifiedColumn", parsed.modifiedColumn) : defaults.modifiedColumn,
    };
  } catch {
    return defaults;
  }
}

function restoreSplitPercent(): number {
  let saved: number;
  try { saved = Number(window.localStorage.getItem("nexora.sftp.split")); } catch { return 50; }
  return Number.isFinite(saved) && saved >= 30 && saved <= 70 ? saved : 50;
}

function restoreTransferJobs(): TransferJob[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem("nexora.sftp.transfers.v1") ?? "[]") as TransferJob[];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-100).filter((job) => job && typeof job.id === "string" && typeof job.sourcePath === "string" && job.destination && typeof job.destination.path === "string").map((job) => {
      const interrupted = job.status === "queued" || job.status === "running" || job.status === "conflict";
      const restored = {
        ...job,
        source: job.source ?? { kind: "local" as const, path: job.sourcePath, label: "Mi equipo" },
        sourceIsDirectory: Boolean(job.sourceIsDirectory),
        operation: job.operation === "move" ? "move" as const : "copy" as const,
      };
      return interrupted
        ? { ...restored, status: "error" as const, error: "Transferencia interrumpida al cerrar la aplicación. Reconecta el destino y pulsa Reintentar.", finishedAt: Date.now() }
        : restored;
    });
  } catch {
    return [];
  }
}

function sourceHost(source: PaneSource, hostsById: Map<string, Host>): Host | null {
  return source.kind === "host" ? hostsById.get(source.hostId) ?? null : null;
}

function paneLocationLabel(pane: PaneState, hostsById: Map<string, Host>): string {
  return pane.source.kind === "local" ? "Mi equipo" : hostsById.get(pane.source.hostId)?.name ?? "Servidor remoto";
}

function hostActivityTime(activity?: HostActivity): number {
  return activity?.lastConnectedAt ? Date.parse(activity.lastConnectedAt) || 0 : 0;
}

function hostActivityLabel(activity?: HostActivity): string {
  if (!activity?.lastConnectedAt) return "Sin conexiones";
  const elapsed = Math.max(0, Date.now() - Date.parse(activity.lastConnectedAt));
  if (elapsed < 60_000) return "Conectado hace un momento";
  if (elapsed < 3_600_000) return `Conectado hace ${Math.floor(elapsed / 60_000)} min`;
  if (elapsed < 86_400_000) return `Conectado hace ${Math.floor(elapsed / 3_600_000)} h`;
  return `Conectado hace ${Math.floor(elapsed / 86_400_000)} d`;
}

function buildRemoteBreadcrumbs(path: string): Array<{ label: string; path: string }> {
  const segments = path.split("/").filter(Boolean);
  return [{ label: "Raíz", path: "/" }, ...segments.map((label, index) => ({ label, path: `/${segments.slice(0, index + 1).join("/")}` }))];
}

function remoteParentPath(path: string): string | null {
  if (path === "/") return null;
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return `/${segments.join("/")}` || "/";
}

function localParentDirectory(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  if (separatorIndex < 0) return normalized;
  if (separatorIndex === 2 && normalized[1] === ":") return `${normalized.slice(0, 2)}\\`;
  return normalized.slice(0, separatorIndex) || normalized;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(1, Math.round(seconds));
  if (rounded < 60) return `${rounded} s`;
  const minutes = Math.floor(rounded / 60);
  const remaining = rounded % 60;
  if (minutes < 60) return remaining > 0 ? `${minutes} min ${remaining} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

function transferStatusLabel(job: TransferJob): string {
  const verb = job.operation === "move" ? "Moviendo" : "Transfiriendo";
  switch (job.status) {
    case "queued": return "En espera";
    case "running": return verb;
    case "conflict": return "Esperando decisión";
    case "completed": return job.operation === "move" ? "Movido" : "Completado";
    case "skipped": return "Omitido";
    case "cancelled": return "Cancelado";
    case "error": return "Falló";
  }
}

function createClientId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function pathName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized;
}

function copyName(name: string, index: number): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name} copia${index > 1 ? ` ${index}` : ""}`;
  return `${name.slice(0, dot)} copia${index > 1 ? ` ${index}` : ""}${name.slice(dot)}`;
}

function symbolicPermissionsToOctal(value: string): string {
  const symbols = value.slice(-9);
  if (symbols.length !== 9) return "0644";
  const digits = [0, 3, 6].map((offset) => {
    let digit = 0;
    if (symbols[offset] === "r") digit += 4;
    if (symbols[offset + 1] === "w") digit += 2;
    if (symbols[offset + 2] === "x" || symbols[offset + 2] === "s" || symbols[offset + 2] === "t") digit += 1;
    return digit;
  });
  return `0${digits.join("")}`;
}

function octalPermissionsLabel(value: string): string {
  if (!/^[0-7]{3,4}$/.test(value)) return "Modo no válido";
  const digits = value.slice(-3).split("").map(Number);
  const parts = digits.map((digit) => `${digit & 4 ? "r" : "-"}${digit & 2 ? "w" : "-"}${digit & 1 ? "x" : "-"}`);
  return parts.join(" ");
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("es", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "No se pudo completar la operación.";
}

function isRecoverableConnectionError(message: string): boolean {
  const normalized = message.toLocaleLowerCase();
  if (["autenticación", "contraseña", "llave privada", "huella", "identidad"].some((term) => normalized.includes(term))) return false;
  return ["sesión sftp", "conexión", "connection", "socket", "timeout", "tiempo de espera", "interrump", "closed", "eof", "canal"].some((term) => normalized.includes(term));
}

function safeStorageSet(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* Optional view/history persistence. */ }
}
