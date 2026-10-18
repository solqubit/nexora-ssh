import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  BookOpen,
  KeyRound,
  Network,
  Pin,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  CopyPlus,
  Folder,
  FolderOpen,
  FolderInput,
  FolderMinus,
  FolderPlus,
  GripVertical,
  HardDrive,
  LayoutGrid,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Star,
  TerminalSquare,
  Trash2,
  UserRound,
  X,
  XCircle,
} from "lucide-react";
import { emptyHostDraft } from "./data";
import { copyToClipboard, disconnectSshSession } from "./lib/desktop";
import { loadPreferences, savePreferences, matchesShortcut, type AppPreferences } from "./lib/preferences";
import { useAppStore } from "./store/appStore";
import type { Host, HostActivity, HostDraft, HostGroup, SecretUpdate, SessionTab } from "./types";
import { HostModal } from "./components/HostModal";
import { SaveTemporaryHostDialog } from "./components/SaveTemporaryHostDialog";
import { HostInspector } from "./components/HostInspector";
import { PreferencesPanel } from "./components/PreferencesPanel";
import { ContextMenuSurface } from "./components/ContextMenuSurface";
import { Disclosure } from "./components/Disclosure";
import { useDialogFocus } from "./hooks/useDialogFocus";
import { useTabOverflow } from "./hooks/useTabOverflow";
import { TerminalDeck, TerminalTools } from "./components/TerminalDeck";
import { CommandPalette, type PaletteItem } from "./components/CommandPalette";
import { ProductivityPanel, SnippetRunner } from "./components/ProductivityPanel";
import { useProductivityStore } from "./store/productivityStore";
import { parseQuickTarget } from "./lib/quickConnect";
import { assertHostsRemovable } from "./lib/sshRoute";
import { LOCAL_POWERSHELL_ID, localPowerShellHost, sessionTarget, sessionSnapshot, connectionTargetLabel, hostEndpointLabel } from "./lib/sessionTarget";
import { emptyConnectionProfile, resolveConnectionProfile } from "./lib/connectionProfile";
import { HostFilters } from "./components/HostFilters";
import { filterKey, matchesHostLabels, uniqueLabels } from "./lib/hostFilters";
import type { SftpWorkspaceHandle } from "./components/SftpWorkspace";
import type { Snippet, ConnectionProfile } from "./types";

const SftpWorkspace = lazy(() => import("./components/SftpWorkspace").then(module => ({ default: module.SftpWorkspace })));
const TunnelManager = lazy(() => import("./components/TunnelManager").then(module => ({ default: module.TunnelManager })));
const IdentityManager = lazy(() => import("./components/IdentityManager").then(module => ({ default: module.IdentityManager })));

type DialogState =
  | { type: "none" }
  | { type: "host"; initialDraft?: Partial<HostDraft>; quick?: boolean; host?: Host }
  | { type: "saveTemporary"; hostId: string }
  | { type: "group" }
  | { type: "renameGroup"; group: HostGroup }
  | { type: "renameTab"; tab: SessionTab }
  | { type: "addPane" }
  ;

interface AppContextMenuState {
  x: number;
  y: number;
  hostId: string | null;
  groupId: string | null;
  tabId: string | null;
}

type HostFilter = "all" | "favorites" | "recent" | "ungrouped";
type AppSection = "hosts" | "sftp" | "snippets" | "identities" | "tunnels";
type ConfirmationState =
  | { type: "forgetTemporary"; host: Host }
  | { type: "deleteHost"; host: Host }
  | { type: "deleteGroup"; group: HostGroup; hostCount: number }
  | { type: "closeSession"; tab: SessionTab }
  | { type: "discardEditorChanges"; nextHostId: string | null; nextSection?: AppSection; nextSftpHostId?: string; nextFilter?: HostFilter; nextGroupId?: string | null }
  | null;

function App({ onCloseVault }: { onCloseVault?: () => Promise<void> }) {
  const store = useAppStore();
  const productivity = useProductivityStore();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [runningSnippet, setRunningSnippet] = useState<Snippet | null>(null);
  const deferredActionRef = useRef<(() => void) | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ type: "none" });
  const [preferences, setPreferences] = useState<AppPreferences>(() => loadPreferences());
  const [toast, setToast] = useState<string | { text: string; tone: "error" } | null>(null);
  const [contextMenu, setContextMenu] = useState<AppContextMenuState | null>(null);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [sessionPickerSearch, setSessionPickerSearch] = useState("");
  const [hostFilter, setHostFilter] = useState<HostFilter>("all");
  const [environmentFilter, setEnvironmentFilter] = useState<string | null>(null);
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<ConfirmationState>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<AppSection>("hosts");
  const [sftpHostId, setSftpHostId] = useState<string | null>(null);
  const sftpRef = useRef<SftpWorkspaceHandle>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [dragPointer, setDragPointer] = useState<{ x: number; y: number } | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [inspectorRevision, setInspectorRevision] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const tabsScrollRef = useRef<HTMLDivElement>(null);
  const tabOverflow = useTabOverflow(tabsScrollRef, `${store.ready}:${activeSection}:${store.tabs.length}`, preferences.reduceMotion);
  const groupDragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null);
  const groupDragMovedRef = useRef(false);

  const updatePreferences = (changes: Partial<AppPreferences>) => setPreferences((current) => {
    const next = { ...current, ...changes };
    savePreferences(next);
    return next;
  });

  useEffect(() => {
    document.documentElement.dataset.uiScale = preferences.uiScale;
    document.documentElement.dataset.reduceMotion = preferences.reduceMotion ? "true" : "false";
  }, [preferences.reduceMotion, preferences.uiScale]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    const apply = () => { document.documentElement.dataset.theme = preferences.interfaceTheme === "system" ? media?.matches ? "light" : "dark" : preferences.interfaceTheme; };
    apply(); media?.addEventListener("change", apply);
    return () => media?.removeEventListener("change", apply);
  }, [preferences.interfaceTheme]);

  useEffect(() => {
    if (!editorDirty) return;
    const protectChanges = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protectChanges);
    return () => window.removeEventListener("beforeunload", protectChanges);
  }, [editorDirty]);

  useEffect(() => { void store.initialize(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!store.activeTabId) return;
    document.getElementById(`session-tab-${store.activeTabId}`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [store.activeTabId, store.tabs.length]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    const closeMenu = () => {
      setContextMenu(null);
      setSessionPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") closeMenu(); };
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, []);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!store.ready || document.querySelector('[aria-modal="true"]') || event.repeat) return;
      const legacyPalette = !store.activeTabId && activeSection === "hosts" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k";
      if (matchesShortcut(event, preferences.shortcuts.palette) || legacyPalette) { event.preventDefault(); setPaletteOpen(true); }
      else if (matchesShortcut(event, preferences.shortcuts.newSession)) { event.preventDefault(); withCleanEditor(() => { setActiveSection("hosts"); setSessionPickerOpen(true); }); }
      else if (matchesShortcut(event, preferences.shortcuts.split)) { event.preventDefault(); withCleanEditor(() => setDialog({ type: "addPane" })); }
      else if (matchesShortcut(event, preferences.shortcuts.closeSession)) { const tab = useAppStore.getState().tabs.find(item => item.id === useAppStore.getState().activeTabId); if (tab) { event.preventDefault(); requestCloseSession(tab); } }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [preferences.shortcuts, store.ready, store.activeTabId, activeSection, editorDirty, editorSaving]);

  const vault = store.snapshot.vaults[0];
  const groups = useMemo(() => store.snapshot.groups
    .filter((group) => group.vaultId === vault?.id)
    .sort((a, b) => a.sortOrder - b.sortOrder), [store.snapshot.groups, vault?.id]);
  const vaultHosts = useMemo(() => store.snapshot.hosts.filter((host) => host.vaultId === vault?.id), [store.snapshot.hosts, vault?.id]);
  const connectionSnapshot = useMemo(() => sessionSnapshot(store.snapshot, store.temporaryHosts), [store.snapshot, store.temporaryHosts]);
  const connectionHosts = useMemo(() => connectionSnapshot.hosts.filter(host => host.vaultId === vault?.id).map(host => resolveConnectionProfile(connectionSnapshot, host, preferences.keepaliveSeconds).host), [connectionSnapshot, vault?.id, preferences.keepaliveSeconds]);
  const resolvedVaultHosts = useMemo(() => vaultHosts.map(host => resolveConnectionProfile(store.snapshot, host, preferences.keepaliveSeconds).host), [vaultHosts, store.snapshot, preferences.keepaliveSeconds]);
  const environmentByHost = useMemo(() => new Map((store.snapshot.productivity?.connectionProfiles ?? []).map(profile => [profile.hostId, profile.environment?.trim() ?? ""])), [store.snapshot.productivity?.connectionProfiles]);
  const availableTags = useMemo(() => uniqueLabels(vaultHosts.flatMap(host => host.tags)), [vaultHosts]);
  const availableEnvironments = useMemo(() => uniqueLabels(vaultHosts.map(host => environmentByHost.get(host.id) ?? "")), [vaultHosts, environmentByHost]);
  const ungroupedCount = useMemo(() => vaultHosts.filter((host) => host.groupId === null).length, [vaultHosts]);
  const query = store.search.trim().toLowerCase();
  const visibleHosts = useMemo(() => {
    const filtered = vaultHosts.filter((host) => {
      if (store.selectedGroupId && host.groupId !== store.selectedGroupId) return false;
      if (hostFilter === "favorites" && !host.favorite) return false;
      if (hostFilter === "recent" && !store.hostActivity[host.id]) return false;
      if (hostFilter === "ungrouped" && host.groupId !== null) return false;
      if (!matchesHostLabels(host, environmentByHost.get(host.id) ?? "", environmentFilter, tagFilters)) return false;
      if (!query) return true;
      return [host.name, host.address, host.username, environmentByHost.get(host.id) ?? "", resolvedVaultHosts.find(value => value.id === host.id)?.username ?? "", ...host.tags].some((value) => value.toLowerCase().includes(query));
    });
    return filtered.sort((a, b) => {
      if (hostFilter === "recent" || preferences.hostSortMode === "recent") return activityTime(store.hostActivity[b.id]) - activityTime(store.hostActivity[a.id]) || a.name.localeCompare(b.name);
      if (preferences.hostSortMode === "favorites") return Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name);
      if (preferences.hostSortMode === "created") return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      return a.name.localeCompare(b.name);
    });
  }, [hostFilter, preferences.hostSortMode, query, store.hostActivity, store.selectedGroupId, vaultHosts, resolvedVaultHosts, environmentByHost, environmentFilter, tagFilters]);
  const selectedHost = store.snapshot.hosts.find((host) => host.id === store.selectedHostId);
  const activeTab = store.tabs.find((tab) => tab.id === store.activeTabId);
  const activeTabHost = sessionTarget(store.snapshot, activeTab?.hostId, store.temporaryHosts);
  const sftpHost = connectionHosts.find((host) => host.id === sftpHostId) ?? null;
  const sessionPickerHosts = useMemo(() => {
    const pickerQuery = sessionPickerSearch.trim().toLowerCase();
    return connectionHosts
      .filter((host) => !pickerQuery || [host.name, host.address, host.username].some((value) => value.toLowerCase().includes(pickerQuery)))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  }, [sessionPickerSearch, connectionHosts]);

  if (!store.ready) {
    return <div className="splash"><div className="brand-mark large"><TerminalSquare size={25} /></div><span>Nexora</span><div className="splash-loader" /></div>;
  }
  if (store.initializationError || !vault) {
    return (
      <main className="fatal-error" role="alert">
        <span><AlertTriangle size={26} /></span>
        <h1>No se pudieron abrir tus datos</h1>
        <p>{store.initializationError ?? "No se encontró una bóveda válida."}</p>
        <button className="button primary" onClick={() => void store.initialize()}><RefreshCw size={16} /> Reintentar</button>
        {onCloseVault && <button className="button secondary" onClick={() => void onCloseVault()}><FolderOpen size={16} /> Cambiar bóveda</button>}
      </main>
    );
  }

  async function saveHost(draft: HostDraft, secrets: SecretUpdate, connectAfter = false, connection?: Omit<ConnectionProfile, "hostId">, temporary = false) {
    if (temporary) {
      await store.createTemporaryConnection(draft, secrets, connection ?? emptyConnectionProfile("draft"));
      setActiveSection("hosts"); setToast("Conexión temporal preparada · puedes guardarla desde la terminal");
      return;
    }
    const previous = draft.id ? store.snapshot.hosts.find(item => item.id === draft.id) : undefined;
    const host = await store.upsertHost(draft, secrets, connection);
    if (previous && previous.groupId !== host.groupId) { setHostFilter("all"); store.selectGroup(host.groupId); store.selectHost(host.id); }
    if (connectAfter) { setActiveSection("hosts"); store.openSession(host); }
    setToast(draft.id ? "Host actualizado" : "Host creado y guardado");
  }

  function withCleanEditor(action: () => void | Promise<void>) {
    if (editorSaving) return;
    const run = () => { try { void Promise.resolve(action()).catch(reason => setToast({ text: reason instanceof Error ? reason.message : String(reason), tone: "error" })); } catch (reason) { setToast({ text: reason instanceof Error ? reason.message : String(reason), tone: "error" }); } };
    if (editorDirty) { deferredActionRef.current = run; setConfirmation({ type: "discardEditorChanges", nextHostId: null }); return; }
    run();
  }
  function quickConnect(input: string) {
    try { const target = parseQuickTarget(input); setPaletteOpen(false); withCleanEditor(() => setDialog({ type: "host", quick: true, initialDraft: { ...target, name: target.address } })); }
    catch (reason) { setToast({ text: reason instanceof Error ? reason.message : String(reason), tone: "error" }); }
  }
  function openSessionFiles(id?: string) {
    if (connectionHosts.find(host => host.id === id)?.protocol === "telnet") return;
    withCleanEditor(async () => {
      if (id === LOCAL_POWERSHELL_ID) {
        if (!sftpRef.current) throw new Error("El gestor de archivos se está preparando.");
        await sftpRef.current.restore({ left: { kind: "local", path: null }, right: { kind: "local", path: null }, splitRatio: 50 });
        requestActiveSection("sftp");
      } else requestActiveSection("sftp", id);
    });
  }
  const paletteItems: PaletteItem[] = [
    { id: "local-powershell", label: "Abrir PowerShell local", detail: "Terminal de este equipo", category: "Acción", run: () => withCleanEditor(() => { store.openSession(localPowerShellHost(vault.id), true); setActiveSection("hosts"); }) },
    ...resolvedVaultHosts.map(host => ({ id: `host-${host.id}`, label: host.name, detail: connectionTargetLabel(host), category: "Host", keywords: host.tags.join(" "), run: () => withCleanEditor(() => { setActiveSection("hosts"); store.openSession(host); }) })),
    ...store.temporaryHosts.map(item => ({ id: `temporary-${item.host.id}`, label: item.host.name, detail: "Conexión temporal · sin guardar", category: "Temporal", keywords: `${item.host.address} ${item.host.username}`, run: () => withCleanEditor(() => { setActiveSection("hosts"); store.openSession(item.host); }) })),
    ...store.tabs.map(tab => ({ id: `session-${tab.id}`, label: tab.title, detail: statusLabel(tab.status), category: "Sesión", run: () => withCleanEditor(() => { setActiveSection("hosts"); store.setActiveTab(tab.id); }) })),
    ...productivity.snippets.filter(item => item.vaultId === vault.id).map(snippet => ({ id: `snippet-${snippet.id}`, label: snippet.name, detail: snippet.description || snippet.category, category: "Snippet", run: () => setRunningSnippet(snippet) })),
    { id: "new-host", label: "Nuevo host", detail: "Guardar un acceso SSH o Telnet", category: "Acción", run: () => withCleanEditor(() => setDialog({ type: "host" })) },
    { id: "files", label: "Abrir archivos", detail: activeTab?.hostId === LOCAL_POWERSHELL_ID ? "Archivos de este equipo" : "SFTP del servidor activo", category: "Acción", run: () => openSessionFiles(activeTabHost?.id) },
    { id: "split", label: "Dividir terminal", detail: "Añadir otra terminal", category: "Acción", run: () => setDialog({ type: "addPane" }) },
    { id: "preferences", label: "Preferencias", detail: "Personalizar Nexora", category: "Acción", run: () => setPreferencesOpen(true) },
  ];

  function openContextMenu(event: React.MouseEvent) {
    event.preventDefault();
    const target = event.target as HTMLElement;
    const contextualElement = target.closest<HTMLElement>("[data-app-context]");
    const hostId = contextualElement?.dataset.appContext === "host" ? contextualElement.dataset.hostId ?? null : null;
    const groupId = contextualElement?.dataset.appContext === "group" ? contextualElement.dataset.groupId ?? null : null;
    const tabId = contextualElement?.dataset.appContext === "tab" ? contextualElement.dataset.tabId ?? null : null;
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 230),
      y: Math.min(event.clientY, window.innerHeight - (hostId ? 340 : groupId ? 245 : tabId ? 230 : 235)),
      hostId,
      groupId,
      tabId,
    });
  }

  function openGroupMenu(event: React.MouseEvent<HTMLButtonElement>, groupId: string) {
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    setContextMenu({
      x: Math.min(bounds.right + 6, window.innerWidth - 230),
      y: Math.min(bounds.top, window.innerHeight - 245),
      hostId: null,
      groupId,
      tabId: null,
    });
  }

  async function copyHostTarget(host: Host) {
    setContextMenu(null);
    try {
      const effective = resolveConnectionProfile(store.snapshot, host, preferences.keepaliveSeconds).host;
      await copyToClipboard(effective.protocol === "telnet" ? hostEndpointLabel(effective) : `ssh -p ${effective.port} ${effective.username}@${effective.address}`);
      setToast(effective.protocol === "telnet" ? "Dirección Telnet copiada" : "Comando SSH copiado");
    } catch {
      setToast({ text: "No se pudo copiar al portapapeles", tone: "error" });
    }
  }

  function showAllHosts() {
    requestHostNavigation("all", null);
  }

  function showFavorites() {
    requestHostNavigation("favorites", null);
  }

  function showRecent() {
    requestHostNavigation("recent", null);
  }

  function showUngrouped() {
    requestHostNavigation("ungrouped", null);
  }

  function showGroup(groupId: string) {
    requestHostNavigation("all", groupId);
  }

  function requestHostNavigation(filter: HostFilter, groupId: string | null) {
    if (editorSaving) return;
    if (editorDirty) {
      setConfirmation({ type: "discardEditorChanges", nextHostId: null, nextFilter: filter, nextGroupId: groupId });
      return;
    }
    setHostFilter(filter);
    store.selectGroup(groupId);
  }

  function reportAction(promise: Promise<unknown>) {
    void promise.catch((reason) => setToast({ text: reason instanceof Error ? reason.message : String(reason), tone: "error" }));
  }

  function requestHostSelection(nextHostId: string | null) {
    if (editorSaving) return;
    if (editorDirty && nextHostId !== store.selectedHostId) {
      setConfirmation({ type: "discardEditorChanges", nextHostId });
      return;
    }
    store.selectHost(nextHostId);
  }

  function requestActiveSection(nextSection: AppSection, nextSftpHostId?: string) {
    if (editorSaving) return;
    if (editorDirty && nextSection !== activeSection) {
      setConfirmation({ type: "discardEditorChanges", nextHostId: store.selectedHostId, nextSection, nextSftpHostId });
      return;
    }
    if (nextSftpHostId) setSftpHostId(nextSftpHostId);
    setActiveSection(nextSection);
  }

  async function closeSession(tab: SessionTab) {
    await disconnectSshSession(tab.id);
    store.closeSession(tab.id);
    setConfirmation(null);
  }

  async function closeOtherSessions(tab: SessionTab) {
    const otherTabs = store.tabs.filter((candidate) => candidate.id !== tab.id);
    await Promise.all(otherTabs.map((candidate) => disconnectSshSession(candidate.id).catch(() => undefined)));
    store.closeOtherSessions(tab.id);
    setContextMenu(null);
    setToast(`${otherTabs.length} ${otherTabs.length === 1 ? "sesión cerrada" : "sesiones cerradas"}`);
  }

  function reconnectSession(tab: SessionTab) {
    store.setActiveTab(tab.id);
    setContextMenu(null);
    window.setTimeout(() => window.dispatchEvent(new CustomEvent("nexora:reconnect-session", { detail: { sessionId: tab.id } })), 0);
  }

  function requestCloseSession(tab: SessionTab) {
    if (["connected", "connecting", "trust_required"].includes(tab.status)) {
      setConfirmation({ type: "closeSession", tab });
      return;
    }
    void closeSession(tab);
  }

  function navigateSessionTabs(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (currentIndex < 0 || tabs.length === 0) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[nextIndex]?.focus();
    tabs[nextIndex]?.click();
  }

  async function deleteHost(host: Host) {
    assertHostsRemovable(sessionSnapshot(store.snapshot, store.temporaryHosts), [host.id]);
    const sessions = store.tabs.filter((tab) => tab.hostId === host.id);
    await Promise.all(sessions.map((tab) => disconnectSshSession(tab.id).catch(() => undefined)));
    await store.deleteHost(host.id);
    setConfirmation(null);
    setToast("Host eliminado");
  }

  async function duplicateHost(host: Host) {
    setContextMenu(null);
    try {
      const duplicated = await store.duplicateHost(host.id);
      setToast(`Host duplicado como “${duplicated.name}”`);
    } catch (error) {
      setToast({ text: error instanceof Error ? error.message : "No se pudo duplicar el host", tone: "error" });
    }
  }

  async function deleteGroup(group: HostGroup) {
    await store.deleteGroup(group.id);
    setConfirmation(null);
    setToast("Grupo eliminado; sus hosts quedaron sin grupo");
  }

  async function dropOnGroup(event: React.DragEvent, groupId: string) {
    event.preventDefault();
    setDragOverGroupId(null);
    const hostId = event.dataTransfer.getData("application/x-nexora-host");
    const sourceGroupId = event.dataTransfer.getData("application/x-nexora-group");
    if (hostId) {
      await store.moveHosts([hostId], groupId);
      setToast("Host movido");
      return;
    }
    if (sourceGroupId) {
      await store.reorderGroup(sourceGroupId, groupId);
      setToast("Orden de grupos actualizado");
    }
  }

  function groupUnderPointer(clientX: number, clientY: number): string | null {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    return el?.closest<HTMLElement>("[data-group-id]")?.dataset.groupId ?? null;
  }

  function startGroupDrag(event: React.PointerEvent, groupId: string) {
    if (event.button !== 0) return;
    groupDragRef.current = { id: groupId, startX: event.clientX, startY: event.clientY, moved: false };
    groupDragMovedRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveGroupDrag(event: React.PointerEvent) {
    const drag = groupDragRef.current;
    if (!drag) return;
    if (!drag.moved) {
      if (Math.abs(event.clientX - drag.startX) < 5 && Math.abs(event.clientY - drag.startY) < 5) return;
      drag.moved = true;
      groupDragMovedRef.current = true;
      setDraggingGroupId(drag.id);
    }
    setDragPointer({ x: event.clientX, y: event.clientY });
    const target = groupUnderPointer(event.clientX, event.clientY);
    setDragOverGroupId(target && target !== drag.id ? target : null);
  }

  function endGroupDrag(event: React.PointerEvent) {
    const drag = groupDragRef.current;
    groupDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDraggingGroupId(null);
    setDragOverGroupId(null);
    setDragPointer(null);
    if (!drag?.moved) return;
    const target = groupUnderPointer(event.clientX, event.clientY);
    if (target && target !== drag.id) reportAction(store.reorderGroup(drag.id, target).then(() => setToast("Orden de grupos actualizado")));
  }

  function cancelGroupDrag() {
    groupDragRef.current = null;
    setDraggingGroupId(null);
    setDragOverGroupId(null);
    setDragPointer(null);
  }

  return (
    <div
      className={`app-shell ${preferences.sidebarCollapsed || activeSection !== "hosts" ? "sidebar-collapsed" : ""}`}
      style={{ "--sidebar-width": `${preferences.sidebarWidth}px` } as React.CSSProperties}
      onContextMenu={openContextMenu}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest(".app-context-menu")) setContextMenu(null);
        if (!target.closest(".session-picker-wrap")) setSessionPickerOpen(false);
      }}
    >
      <aside className="rail">
        <div className="brand-mark"><TerminalSquare size={20} /></div>
        <nav className="rail-nav" aria-label="Navegación principal">
          <button className={`rail-button ${activeSection === "hosts" ? "active" : ""}`} title="Hosts" onClick={() => requestActiveSection("hosts")}><HardDrive size={19} /><span>Hosts</span></button>
          <button className={`rail-button ${activeSection === "sftp" ? "active" : ""}`} title="Administrador de archivos" onClick={() => requestActiveSection("sftp")}><FolderInput size={19} /><span>Archivos</span></button>

          <button className={`rail-button ${activeSection === "snippets" ? "active" : ""}`} title="Snippets" onClick={() => requestActiveSection("snippets")}><BookOpen size={19} /><span>Snippets</span></button>
          <button className={`rail-button ${activeSection === "identities" ? "active" : ""}`} title="Identidades" onClick={() => requestActiveSection("identities")}><KeyRound size={19} /><span>Identidades</span></button>
          <button className={`rail-button ${activeSection === "tunnels" ? "active" : ""}`} title="Túneles SSH" onClick={() => requestActiveSection("tunnels")}><Network size={19} /><span>Túneles</span></button>
        </nav>
        <div className="rail-bottom">
          <button className="rail-button" title={`Paleta de comandos (${preferences.shortcuts.palette})`} onClick={() => setPaletteOpen(true)}><Search size={19} /><span>Buscar</span></button>
          <button className={`rail-button ${preferencesOpen ? "active" : ""}`} title="Preferencias" onClick={() => setPreferencesOpen(true)}><Settings size={19} /><span>Ajustes</span></button>
        </div>
      </aside>

      <aside className="sidebar">
        <div className="sidebar-resizer" role="separator" aria-label="Ajustar ancho del panel lateral" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={420} aria-valuenow={preferences.sidebarWidth} tabIndex={0} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const left = event.currentTarget.parentElement!.getBoundingClientRect().left; updatePreferences({ sidebarWidth: Math.max(220, Math.min(420, event.clientX - left)) }); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); updatePreferences({ sidebarWidth: Math.max(220, Math.min(420, preferences.sidebarWidth + (event.key === "ArrowLeft" ? -10 : 10))) }); } }} />
        <header className="workspace-header">
          <span className="workspace-symbol" style={{ "--workspace-color": vault.color } as React.CSSProperties} title="Datos y secretos almacenados localmente">{activeSection === "sftp" ? <FolderOpen size={17} /> : <Boxes size={17} />}</span>
          <span className="workspace-identity"><strong>{vault.name}</strong></span>
        </header>

        {activeSection === "hosts" && <nav className="host-navigation">
          <button className={`nav-row ${hostFilter === "all" && store.selectedGroupId === null ? "active" : ""}`} onClick={showAllHosts}>
            <LayoutGrid size={16} /><span>Todos los hosts</span>{vaultHosts.length > 0 && <b>{vaultHosts.length}</b>}
          </button>
          <button className={`nav-row ${hostFilter === "favorites" ? "active" : ""}`} onClick={showFavorites}>
            <Star size={16} /><span>Favoritos</span>{vaultHosts.some(host => host.favorite) && <b>{vaultHosts.filter(host => host.favorite).length}</b>}
          </button>
          <button className={`nav-row ${hostFilter === "recent" ? "active" : ""}`} onClick={showRecent}>
            <Clock3 size={16} /><span>Recientes</span>{vaultHosts.some(host => store.hostActivity[host.id]) && <b>{vaultHosts.filter(host => store.hostActivity[host.id]).length}</b>}
          </button>
          {ungroupedCount > 0 && (
            <button className={`nav-row ${hostFilter === "ungrouped" ? "active" : ""}`} onClick={showUngrouped}>
              <FolderMinus size={16} /><span>Sin grupo</span><b>{ungroupedCount}</b>
            </button>
          )}

          <div className="nav-section-title"><button onClick={() => setDialog({ type: "group" })} aria-label="Crear grupo"><FolderPlus size={15} /><span>Nuevo grupo</span></button></div>
          {groups.map((group) => {
            const count = vaultHosts.filter((host) => host.groupId === group.id).length;
            return (
              <div
                key={group.id}
                className={`group-row-shell ${draggingGroupId === group.id ? "is-dragging" : ""} ${dragOverGroupId === group.id ? "drag-over" : ""}`}
                data-app-context="group"
                data-group-id={group.id}
                onDragOver={(event) => { if ([...event.dataTransfer.types].some((type) => type === "application/x-nexora-host")) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDragOverGroupId(group.id); } }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOverGroupId(null); }}
                onDrop={(event) => void dropOnGroup(event, group.id)}
              >
                <div
                  className={`nav-row group-row ${hostFilter === "all" && store.selectedGroupId === group.id ? "active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onPointerDown={(event) => startGroupDrag(event, group.id)}
                  onPointerMove={moveGroupDrag}
                  onPointerUp={endGroupDrag}
                  onPointerCancel={cancelGroupDrag}
                  onClick={() => { if (groupDragMovedRef.current) { groupDragMovedRef.current = false; return; } showGroup(group.id); }}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); showGroup(group.id); } }}
                >
                  <GripVertical className="group-drag-handle" size={14} /><Folder size={16} /><span>{group.name}</span>{count > 0 && <b>{count}</b>}
                </div>
                <button className="group-row-menu" aria-label={`Opciones de ${group.name}`} title="Opciones del grupo" onClick={(event) => openGroupMenu(event, group.id)}><MoreHorizontal size={15} /></button>
              </div>
            );
          })}
        </nav>}

        <div className="sidebar-footer">
          <div className="sidebar-actions">
            {onCloseVault && <button onClick={() => withCleanEditor(onCloseVault)}><FolderOpen size={15} /> Cambiar bóveda</button>}
          </div>
        </div>
      </aside>

      <main className="main-area">
        <div className={`sftp-section ${activeSection !== "sftp" ? "section-hidden" : ""}`}>
          <Suspense fallback={<div className="productivity-empty" role="status">Abriendo archivos…</div>}><SftpWorkspace
            ref={sftpRef}
            key={vault.id}
            host={sftpHost}
            hosts={connectionHosts.filter(host => host.protocol !== "telnet")}
            hostActivity={store.hostActivity}
            keepaliveSeconds={preferences.keepaliveSeconds}
            onRecordHostActivity={store.recordHostActivity}
            onOpenSsh={(host) => { setActiveSection("hosts"); store.openSession(host, true); }}
          /></Suspense>
        </div>
        <div className={`ssh-section ${activeSection !== "hosts" ? "section-hidden" : ""}`}>
        <header className={`topbar ${activeTabHost ? "terminal-topbar" : ""}`}>
          <button className="icon-button sidebar-toggle" onClick={() => updatePreferences({ sidebarCollapsed: !preferences.sidebarCollapsed })} title={preferences.sidebarCollapsed ? "Expandir panel lateral" : "Contraer panel lateral"} aria-label={preferences.sidebarCollapsed ? "Expandir panel" : "Contraer panel"} aria-expanded={!preferences.sidebarCollapsed}><PanelLeftClose size={18} /></button>
          {activeTabHost && <div className="terminal-context"><strong>{vault.name}</strong><span>· {store.tabs.length} {store.tabs.length === 1 ? "sesión" : "sesiones"}</span></div>}
          {!activeTabHost && <label className="topbar-search">
            <Search size={15} />
            <input ref={searchInputRef} aria-label="Buscar hosts" value={store.search} onChange={(event) => store.setSearch(event.target.value)} placeholder="Buscar hosts o escribir usuario@servidor…" onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing && (store.search.includes("@") || store.search.startsWith("ssh ") || visibleHosts.length === 0)) { event.preventDefault(); quickConnect(store.search); } }} />
            <button className="palette-trigger" title="Paleta de comandos" aria-label="Abrir paleta de comandos" onClick={() => setPaletteOpen(true)}><kbd>{preferences.shortcuts.palette.replaceAll("+", " ")}</kbd></button>
          </label>}
          <div className="topbar-actions">
            <button className="button primary" onClick={() => withCleanEditor(() => setDialog({ type: "host" }))}><Plus size={17} /> Nuevo host</button>
          </div>
        </header>

        {store.tabs.length > 0 && (
          <div className="tabs-bar">
            {(tabOverflow.before || tabOverflow.after) && <button className="tab-scroll-button" aria-label="Ver pestañas anteriores" title="Ver pestañas anteriores" disabled={!tabOverflow.before} onClick={() => tabOverflow.scroll(-1)}><ChevronLeft size={15} /></button>}
            <div ref={tabsScrollRef} className="tabs-scroll" role="tablist" aria-label="Sesiones de terminal" onScroll={tabOverflow.measure} onKeyDown={navigateSessionTabs}>
              <button id="home-tab" role="tab" aria-selected={!activeTab} aria-controls="workspace-panel" tabIndex={!activeTab ? 0 : -1} className={`session-tab home-tab ${!activeTab ? "active" : ""}`} onClick={() => store.setActiveTab(null)}><LayoutGrid size={14} /><span className="session-tab-title">Inicio</span></button>
              {store.tabs.map((tab) => (
                <div key={tab.id} className={`session-tab-shell ${tab.unread ? "has-activity" : ""}`} data-app-context="tab" data-tab-id={tab.id} draggable onDragStart={event => event.dataTransfer.setData("application/x-nexora-tab", tab.id)} onDragOver={event => { if (event.dataTransfer.types.includes("application/x-nexora-tab")) event.preventDefault(); }} onDrop={event => { const source = event.dataTransfer.getData("application/x-nexora-tab"); if (source) { event.preventDefault(); store.reorderTabs(source, tab.id); } }}>
                  <button
                    id={`session-tab-${tab.id}`}
                    role="tab"
                    aria-selected={store.activeTabId === tab.id}
                    aria-controls={`terminal-panel-${tab.id}`}
                    tabIndex={store.activeTabId === tab.id ? 0 : -1}
                    className={`session-tab ${store.activeTabId === tab.id ? "active" : ""}`}
                    title={`${tab.title} · ${statusLabel(tab.status)} · clic derecho para más opciones`}
                    onClick={() => withCleanEditor(() => store.setActiveTab(tab.id))}
                  >
                    <i className={`status-dot ${tab.status}`} />{tab.pinned && <Pin size={12} />}<span className="session-tab-title">{tab.title}</span>{tab.unread && <span className="tab-activity" aria-label="Actividad nueva" />}
                  </button>
                  <button className="tab-close" type="button" aria-label={`Cerrar ${tab.title}`} title={`Cerrar ${tab.title}`} onClick={(event) => { event.stopPropagation(); requestCloseSession(tab); }}><X size={13} /></button>
                </div>
              ))}
            </div>
            {(tabOverflow.before || tabOverflow.after) && <button className="tab-scroll-button" aria-label="Ver pestañas siguientes" title="Ver pestañas siguientes" disabled={!tabOverflow.after} onClick={() => tabOverflow.scroll(1)}><ChevronRight size={15} /></button>}
            <div className="session-picker-wrap">
              <button
                className={`tab-add ${sessionPickerOpen ? "active" : ""}`}
                title="Abrir otra terminal"
                aria-label="Abrir otra terminal"
                aria-expanded={sessionPickerOpen}
                onClick={() => {
                  setSessionPickerSearch("");
                  setSessionPickerOpen((open) => !open);
                }}
              ><Plus size={15} /></button>
              {sessionPickerOpen && (
                <div className="session-picker">
                  <header><span><TerminalSquare size={15} /></span><div><strong>Nueva terminal</strong><small>Host SSH, Telnet o PowerShell de este equipo</small></div></header>
                  <label className="session-picker-search"><Search size={14} /><input autoFocus value={sessionPickerSearch} onChange={(event) => setSessionPickerSearch(event.target.value)} placeholder="Buscar conexión…" /></label>
                  <div className="session-picker-list">
                    <button onClick={() => withCleanEditor(() => { store.openSession(localPowerShellHost(vault.id), true); setSessionPickerOpen(false); })}><span className="session-picker-avatar" style={{ background: "#7198f5" }}><TerminalSquare size={18} /></span><span className="session-picker-host"><strong>PowerShell local</strong><small>Terminal de este equipo</small></span><ChevronRight size={14} /></button>
                    {sessionPickerHosts.map((host) => (
                      <button key={host.id} onClick={() => withCleanEditor(() => { store.openSession(host, true); setSessionPickerOpen(false); })}>
                        <span className="session-picker-avatar" style={{ background: host.color }}>{host.name.slice(0, 2).toUpperCase()}</span>
                        <span className="session-picker-host"><strong>{host.name}</strong><small>{connectionTargetLabel(host)}</small></span>
                        {host.favorite && <Star size={12} fill="currentColor" />}
                        <ChevronRight size={14} />
                      </button>
                    ))}
                    {sessionPickerHosts.length === 0 && <p>No hay conexiones que coincidan.</p>}
                  </div>
                </div>
              )}
            </div>
            {activeTabHost && activeSection === "hosts" && <TerminalTools filesAvailable={activeTabHost.protocol !== "telnet"} onFiles={openSessionFiles} onAddPane={() => setDialog({ type: "addPane" })} />}
          </div>
        )}

        <TerminalDeck visible={Boolean(activeTabHost) && activeSection === "hosts"} preferences={preferences} onPreferencesChange={updatePreferences} onSaveTemporary={hostId => setDialog({ type: "saveTemporary", hostId })} onForgetTemporary={host => setConfirmation({ type: "forgetTemporary", host })} />

        {!activeTabHost && (
          <section id="workspace-panel" role="tabpanel" aria-labelledby="home-tab" className={`content-area ${selectedHost ? "details-open" : ""}`}>
            <div className="workspace-main">
              <div className="content-heading">
                <h1>{hostFilter === "favorites" ? "Favoritos" : hostFilter === "recent" ? "Hosts recientes" : hostFilter === "ungrouped" ? "Hosts sin grupo" : store.selectedGroupId ? groups.find((group) => group.id === store.selectedGroupId)?.name : "Tus conexiones"}</h1>
                <p>{visibleHosts.length === 0 ? "No hay conexiones visibles con los filtros actuales." : `${visibleHosts.length} ${visibleHosts.length === 1 ? "host disponible" : "hosts disponibles"}`}</p>
              </div>

              {vaultHosts.length > 0 && <HostFilters environments={availableEnvironments} tags={availableTags} environment={environmentFilter} selectedTags={tagFilters} onEnvironment={setEnvironmentFilter} onTags={setTagFilters} />}
              {store.temporaryHosts.length > 0 && <section className="temporary-connections" aria-label="Conexiones temporales"><h2>Conexiones temporales</h2><p>Disponibles hasta cerrar Nexora. Guárdalas para volver otro día.</p>{store.temporaryHosts.map(({ host }) => <div key={host.id}><button className="temporary-target" onClick={() => store.openSession(host)}><TerminalSquare size={16} /><span><strong>{host.name}</strong><small>{connectionTargetLabel(connectionHosts.find(item => item.id === host.id) ?? host)}</small></span></button><button className="button secondary" aria-label={`Guardar host ${host.name}`} onClick={() => setDialog({ type: "saveTemporary", hostId: host.id })}>Guardar host</button><button className="icon-button" aria-label={`Olvidar ${host.name}`} onClick={() => setConfirmation({ type: "forgetTemporary", host })}><Trash2 size={15} /></button></div>)}</section>}
              {visibleHosts.length === 0 ? (
                vaultHosts.length === 0
                  ? <EmptyState onNewHost={() => withCleanEditor(() => setDialog({ type: "host" }))} />
                  : <FilteredEmptyState favoriteOnly={hostFilter === "favorites"} recentOnly={hostFilter === "recent"} searching={Boolean(query) || environmentFilter !== null || tagFilters.length > 0} onClear={() => { store.setSearch(""); setEnvironmentFilter(null); setTagFilters([]); showAllHosts(); }} />
              ) : (
                <div className="host-layout">
                <div className={`host-grid ${preferences.hostViewMode}`}>
                  {visibleHosts.map((host) => (
                    <HostCard
                      key={host.id}
                      host={resolvedVaultHosts.find(value => value.id === host.id) ?? host}
                      environment={environmentByHost.get(host.id) ?? ""}
                      selected={host.id === store.selectedHostId}
                      preferences={preferences}
                      onSelect={() => requestHostSelection(host.id)}
                      onOpen={() => withCleanEditor(() => store.openSession(host))}
                      onFavorite={() => reportAction(store.toggleFavorite(host.id))}
                      onTag={tag => setTagFilters(current => current.some(item => filterKey(item) === filterKey(tag)) ? current : [...current, tag])}
                    />
                  ))}
                </div>
                </div>
              )}
            </div>
            {selectedHost && (
              <HostInspector
                key={`${selectedHost.id}:${inspectorRevision}`}
                host={selectedHost}
                groups={groups}
                onClose={() => requestHostSelection(null)}
                onOpen={() => store.openSession(selectedHost)}
                defaultKeepalive={preferences.keepaliveSeconds}
                onDirtyChange={setEditorDirty}
                onBusyChange={setEditorSaving}
                onDiscard={() => { setEditorDirty(false); setInspectorRevision(value => value + 1); }}
                onSave={async (draft, secrets, connectAfter, connection) => { await saveHost(draft, secrets, connectAfter, connection); setInspectorRevision(value => value + 1); }}
                onDuplicate={() => withCleanEditor(() => duplicateHost(selectedHost))}
                onDelete={() => withCleanEditor(() => setConfirmation({ type: "deleteHost", host: selectedHost }))}
              />
            )}
          </section>
        )}
        </div>
        {activeSection === "snippets" && <ProductivityPanel vaultId={vault.id} onUseSnippet={setRunningSnippet} />}
        {activeSection === "identities" && <Suspense fallback={<div className="productivity-empty" role="status">Preparando identidades…</div>}><IdentityManager vaultId={vault.id} /></Suspense>}
        {activeSection === "tunnels" && <Suspense fallback={<p className="field-help">Preparando túneles…</p>}><TunnelManager vaultId={vault.id} keepaliveSeconds={preferences.keepaliveSeconds} /></Suspense>}
      </main>

      {paletteOpen && <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} onQuickConnect={quickConnect} />}
      {runningSnippet && <SnippetRunner snippet={runningSnippet} onClose={() => setRunningSnippet(null)} />}
      {dialog.type === "renameTab" && <SimpleNameDialog title="Renombrar pestaña" description="Este nombre identifica la sesión, sin cambiar el host." label="Nombre de la pestaña" placeholder="Logs, Base de datos…" initialValue={dialog.tab.title} onClose={() => setDialog({ type: "none" })} onSave={async name => { store.renameTab(dialog.tab.id, name); setDialog({ type: "none" }); }} />}
      {dialog.type === "addPane" && <PaneHostPicker hosts={[localPowerShellHost(vault.id), ...connectionHosts]} onClose={() => setDialog({ type: "none" })} onChoose={host => withCleanEditor(() => { store.splitSession(host, store.terminalLayout); setActiveSection("hosts"); setDialog({ type: "none" }); })} />}
      {dialog.type === "host" && <HostModal key={dialog.host?.id ?? "new"} host={dialog.host} vaultId={vault.id} selectedGroupId={store.selectedGroupId} groups={groups} quick={dialog.quick} initialDraft={dialog.initialDraft} defaultKeepalive={preferences.keepaliveSeconds} onDirtyChange={setEditorDirty} onClose={() => setDialog({ type: "none" })} onSave={saveHost} />}
      {dialog.type === "saveTemporary" && (() => { const temporary = store.temporaryHosts.find(item => item.host.id === dialog.hostId); return temporary ? <SaveTemporaryHostDialog host={temporary.host} groups={groups} onClose={() => setDialog({ type: "none" })} onSave={async (name, groupId) => { await store.saveTemporaryConnection(temporary.host.id, name, groupId); setDialog({ type: "none" }); setToast("Host guardado · las sesiones abiertas se conservan"); }} /> : null; })()}
      {dialog.type === "group" && <SimpleNameDialog title="Nuevo grupo" description="Organiza los hosts de esta bóveda." label="Nombre del grupo" placeholder="Clientes, Producción, Laboratorio…" onClose={() => setDialog({ type: "none" })} onSave={async (name) => { await store.addGroup(name); setDialog({ type: "none" }); setToast("Grupo creado"); }} />}
      {dialog.type === "renameGroup" && <SimpleNameDialog title="Renombrar grupo" description="El nuevo nombre se actualizará en toda la bóveda." label="Nombre del grupo" placeholder="Nombre del grupo" initialValue={dialog.group.name} submitLabel="Guardar nombre" onClose={() => setDialog({ type: "none" })} onSave={async (name) => { await store.renameGroup(dialog.group.id, name); setDialog({ type: "none" }); setToast("Grupo renombrado"); }} />}
      {contextMenu && (() => {
        const contextualHost = contextMenu.hostId ? store.snapshot.hosts.find((host) => host.id === contextMenu.hostId) : null;
        const contextualGroup = contextMenu.groupId ? store.snapshot.groups.find((group) => group.id === contextMenu.groupId) : null;
        const contextualTab = contextMenu.tabId ? store.tabs.find((tab) => tab.id === contextMenu.tabId) : null;
        const contextualTabHost = contextualTab ? sessionTarget(store.snapshot, contextualTab.hostId, store.temporaryHosts) : null;
        return (
          <ContextMenuSurface x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
            {contextualHost ? (
              <>
                <div className="context-menu-heading"><span style={{ background: contextualHost.color }}>{contextualHost.name.slice(0, 2).toUpperCase()}</span><div><strong>{contextualHost.name}</strong><small>{contextualHost.username}@{contextualHost.address}:{contextualHost.port}</small></div></div>
                <div className="context-menu-separator" />
                <button role="menuitem" onClick={() => { setContextMenu(null); withCleanEditor(() => store.openSession(contextualHost)); }}><TerminalSquare size={15} /><span>Conectar</span><kbd>Enter</kbd></button>
                {contextualHost.protocol !== "telnet" && <button role="menuitem" onClick={() => { setContextMenu(null); requestActiveSection("sftp", contextualHost.id); }}><FolderInput size={15} /><span>Explorar archivos</span></button>}
                <button role="menuitem" onClick={() => { setContextMenu(null); requestHostSelection(contextualHost.id); }}><Pencil size={15} /><span>Editar host</span></button>
                <button role="menuitem" onClick={() => { setContextMenu(null); requestHostSelection(contextualHost.id); }}><HardDrive size={15} /><span>Detalles</span></button>
                <button role="menuitem" onClick={() => { setContextMenu(null); reportAction(store.toggleFavorite(contextualHost.id)); }}><Star size={15} fill={contextualHost.favorite ? "currentColor" : "none"} /><span>{contextualHost.favorite ? "Quitar de favoritos" : "Añadir a favoritos"}</span></button>
                <div className="context-menu-separator" />
                <Disclosure title="Más acciones" menu><button role="menuitem" onClick={() => void duplicateHost(contextualHost)}><CopyPlus size={15} /><span>Duplicar host</span></button><button role="menuitem" onClick={() => void copyHostTarget(contextualHost)}><Copy size={15} /><span>{contextualHost.protocol === "telnet" ? "Copiar dirección Telnet" : "Copiar comando SSH"}</span></button></Disclosure>
                <button className="context-danger" role="menuitem" onClick={() => { setContextMenu(null); setConfirmation({ type: "deleteHost", host: contextualHost }); }}><Trash2 size={15} /><span>Eliminar host</span></button>
              </>
            ) : contextualTab && contextualTabHost ? (
              <>
                <div className="context-menu-heading"><span style={{ background: contextualTabHost.color }}>{contextualTabHost.name.slice(0, 2).toUpperCase()}</span><div><strong>{contextualTab.title}</strong><small>{statusLabel(contextualTab.status)}</small></div></div>
                <div className="context-menu-separator" />
                <button role="menuitem" onClick={() => reconnectSession(contextualTab)}><RefreshCw size={15} /><span>Reconectar</span></button>
                <button role="menuitem" onClick={() => { setContextMenu(null); store.openSession(contextualTabHost, true); }}><CopyPlus size={15} /><span>Duplicar sesión</span></button>
                <button role="menuitem" onClick={() => { setContextMenu(null); store.togglePin(contextualTab.id); }}><Pin size={15} /><span>{contextualTab.pinned ? "Desfijar pestaña" : "Fijar pestaña"}</span></button>
                <button role="menuitem" onClick={() => { setContextMenu(null); setDialog({ type: "renameTab", tab: contextualTab }); }}><Pencil size={15} /><span>Renombrar pestaña</span></button>
                <div className="context-menu-separator" />
                <button role="menuitem" onClick={() => { setContextMenu(null); requestCloseSession(contextualTab); }}><X size={15} /><span>Cerrar pestaña</span></button>
                <button role="menuitem" disabled={store.tabs.length <= 1} onClick={() => void closeOtherSessions(contextualTab)}><XCircle size={15} /><span>Cerrar las demás</span></button>
              </>
            ) : contextualGroup ? (
              <>
                <div className="context-menu-heading group-heading"><span><Folder size={15} /></span><div><strong>{contextualGroup.name}</strong><small>{vaultHosts.filter((host) => host.groupId === contextualGroup.id).length} hosts</small></div></div>
                <div className="context-menu-separator" />
                <button role="menuitem" onClick={() => { setContextMenu(null); showGroup(contextualGroup.id); }}><Folder size={15} /><span>Abrir grupo</span></button>
                <button role="menuitem" onClick={() => { setContextMenu(null); showGroup(contextualGroup.id); setDialog({ type: "host" }); }}><Plus size={15} /><span>Nuevo host aquí</span></button>
                <button role="menuitem" onClick={() => { setContextMenu(null); setDialog({ type: "renameGroup", group: contextualGroup }); }}><Pencil size={15} /><span>Renombrar grupo</span></button>
                <div className="context-menu-separator" />
                <button className="context-danger" role="menuitem" onClick={() => { setContextMenu(null); setConfirmation({ type: "deleteGroup", group: contextualGroup, hostCount: vaultHosts.filter((host) => host.groupId === contextualGroup.id).length }); }}><Trash2 size={15} /><span>Eliminar grupo</span></button>
              </>
            ) : (
              <>
                <div className="context-menu-title">NEXORA SSH</div>
                <button role="menuitem" onClick={() => { setContextMenu(null); setDialog({ type: "host" }); }}><Plus size={15} /><span>Nuevo host</span></button>
                <button role="menuitem" onClick={() => { setContextMenu(null); setDialog({ type: "group" }); }}><FolderPlus size={15} /><span>Nuevo grupo</span></button>
                <div className="context-menu-separator" />
                <button role="menuitem" onClick={() => { setContextMenu(null); updatePreferences({ sidebarCollapsed: !preferences.sidebarCollapsed }); }}><PanelLeftClose size={15} /><span>{preferences.sidebarCollapsed ? "Mostrar panel lateral" : "Ocultar panel lateral"}</span></button>
              </>
            )}
          </ContextMenuSurface>
        );
      })()}
      {confirmation?.type === "forgetTemporary" && <ConfirmDialog title="Olvidar conexión temporal" description={`Se cerrarán las terminales y SFTP de “${confirmation.host.name}” y se olvidarán sus credenciales temporales.`} confirmLabel="Olvidar conexión" danger onClose={() => setConfirmation(null)} onConfirm={async () => { const hostId = confirmation.host.id; if (!sftpRef.current) throw new Error("El gestor de archivos se está preparando. Inténtalo de nuevo."); await sftpRef.current.detachHost(hostId); await store.forgetTemporaryConnection(hostId); if (sftpHostId === hostId) setSftpHostId(null); setConfirmation(null); setToast("Conexión temporal olvidada"); }} />}
      {confirmation?.type === "deleteHost" && (
        <ConfirmDialog
          title="Eliminar host"
          description={`Se eliminará “${confirmation.host.name}” y se cerrarán sus sesiones abiertas. Esta acción no se puede deshacer.`}
          confirmLabel="Eliminar host"
          danger
          onClose={() => setConfirmation(null)}
          onConfirm={() => deleteHost(confirmation.host)}
        />
      )}
      {confirmation?.type === "deleteGroup" && (
        <ConfirmDialog
          title="Eliminar grupo"
          description={confirmation.hostCount > 0
            ? `Se eliminará “${confirmation.group.name}”. Sus ${confirmation.hostCount} ${confirmation.hostCount === 1 ? "host quedará" : "hosts quedarán"} disponibles en “Sin grupo”.`
            : `Se eliminará el grupo vacío “${confirmation.group.name}”. Esta acción no se puede deshacer.`}
          confirmLabel="Eliminar grupo"
          danger
          onClose={() => setConfirmation(null)}
          onConfirm={() => deleteGroup(confirmation.group)}
        />
      )}
      {confirmation?.type === "closeSession" && (
        <ConfirmDialog
          title="Cerrar sesión activa"
          description={confirmation.tab.hostId === LOCAL_POWERSHELL_ID ? `Se cerrará “${confirmation.tab.title}” y se terminará PowerShell en este equipo.` : `La conexión “${confirmation.tab.title}” sigue activa. El shell remoto se desconectará antes de cerrar la pestaña.`}
          confirmLabel="Desconectar y cerrar"
          onClose={() => setConfirmation(null)}
          onConfirm={() => closeSession(confirmation.tab)}
        />
      )}
      {confirmation?.type === "discardEditorChanges" && (
        <ConfirmDialog
          title="Descartar cambios"
          description="Hay cambios del host que todavía no se han guardado. Si continúas, se perderán."
          confirmLabel="Descartar cambios"
          onClose={() => { deferredActionRef.current = null; setConfirmation(null); }}
          onConfirm={async () => {
            const nextHostId = confirmation.nextHostId;
            const nextSection = confirmation.nextSection;
            const nextSftpHostId = confirmation.nextSftpHostId;
            setEditorDirty(false);
            setInspectorRevision(value => value + 1);
            setConfirmation(null);
            store.selectHost(nextHostId);
            if (confirmation.nextFilter) {
              setHostFilter(confirmation.nextFilter);
              store.selectGroup(confirmation.nextGroupId ?? null);
            }
            if (nextSftpHostId) setSftpHostId(nextSftpHostId);
            if (nextSection) setActiveSection(nextSection);
            setDialog({ type: "none" });
            const deferred = deferredActionRef.current; deferredActionRef.current = null;
            deferred?.();
          }}
        />
      )}
      {preferencesOpen && <PreferencesPanel preferences={preferences} onChange={updatePreferences} onClose={() => setPreferencesOpen(false)} />}
      {toast && (() => { const t = typeof toast === "string" ? { text: toast, tone: "ok" as const } : toast; return <div className={`toast ${t.tone === "error" ? "error" : ""}`} role="status" aria-live="polite">{t.tone === "error" ? <AlertTriangle size={17} /> : <ShieldCheck size={17} />}{t.text}</div>; })()}
      {draggingGroupId && dragPointer && (() => { const dragged = groups.find((group) => group.id === draggingGroupId); if (!dragged) return null; return <div className="group-drag-ghost" style={{ left: dragPointer.x + 14, top: dragPointer.y + 10 }}><GripVertical size={13} /><Folder size={15} /><span>{dragged.name}</span></div>; })()}
    </div>
  );
}

function PaneHostPicker({ hosts, onClose, onChoose }: { hosts: Host[]; onClose: () => void; onChoose: (host: Host) => void }) {
  const ref = useDialogFocus<HTMLDivElement>(onClose);
  const [query, setQuery] = useState("");
  const filtered = hosts.filter(host => `${host.name} ${host.address} ${host.username}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="modal-backdrop"><div ref={ref} className="modal pane-picker" role="dialog" aria-modal="true" aria-label="Añadir terminal" tabIndex={-1}><header className="modal-header"><TerminalSquare size={20} /><div><h2>Añadir terminal</h2><p>Selecciona un host SSH, Telnet o PowerShell local.</p></div><button className="icon-button" aria-label="Cerrar selector" onClick={onClose}><X size={18} /></button></header><div className="modal-body"><label className="field"><span>Buscar servidor</span><input autoFocus value={query} onChange={event => setQuery(event.target.value)} /></label><div className="pane-picker-list">{filtered.map(host => <button key={host.id} onClick={() => onChoose(host)}><span style={{ background: host.color }}>{host.name.slice(0, 2).toUpperCase()}</span><div><strong>{host.name}</strong><small>{connectionTargetLabel(host)}</small></div><Plus size={16} /></button>)}{!filtered.length && <p>No hay hosts disponibles.</p>}</div></div></div></div>;
}

function HostCard({ host, environment, selected, preferences, onSelect, onOpen, onFavorite, onTag }: { host: Host; environment: string; selected: boolean; preferences: AppPreferences; onSelect: () => void; onOpen: () => void; onFavorite: () => void; onTag: (tag: string) => void }) {
  return (
    <article
      className={`host-card ${selected ? "selected" : ""}`}
      role="group"
      tabIndex={0}
      aria-label={`Host ${host.name}${environment ? ` · ${environment}` : ""}, ${host.username || "sin usuario"} en ${host.address}:${host.port}. Pulsa Enter para conectar.`}
      data-app-context="host"
      data-host-id={host.id}
      draggable
      onDragStart={(event) => { event.dataTransfer.setData("application/x-nexora-host", host.id); event.dataTransfer.effectAllowed = "move"; }}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" && !event.repeat && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onOpen();
        } else if (event.key === " ") {
          event.preventDefault(); onSelect();
        }
      }}
    >
      <div className="host-card-main">
        <span className="host-avatar" style={{ background: host.color }}>{host.name.slice(0, 2).toUpperCase()}</span>
        <div className="host-card-body"><h3 title={host.name}>{host.name}</h3></div>{host.protocol === "telnet" && <span className="host-protocol-badge">TELNET</span>}
      </div>
      {preferences.showAddress && <p className="host-card-address" title={connectionTargetLabel(host)}>{host.address.includes(":") ? `[${host.address}]` : host.address}:{host.port}</p>}
      <div className="host-card-bottom">
        {preferences.showUsername && <div className="host-card-meta"><UserRound size={13} aria-hidden="true" /><small title={host.username || "Sin usuario"}>{host.username || "Sin usuario"}</small></div>}
        <div className="host-card-actions">
          <button className={host.favorite ? "favorite active" : "favorite"} title={host.favorite ? "Quitar de favoritos" : "Añadir a favoritos"} aria-label={host.favorite ? "Quitar de favoritos" : "Añadir a favoritos"} onClick={(event) => { event.stopPropagation(); onFavorite(); }}><Star size={13} fill={host.favorite ? "currentColor" : "none"} /></button>
          <button className="card-connect" title={`Conectar con ${host.name}`} aria-label={`Conectar con ${host.name}`} onClick={(event) => { event.stopPropagation(); onOpen(); }}><TerminalSquare size={14} /><span>Conectar</span></button>
        </div>
      </div>
      {(environment || host.tags.length > 0) && <div className="host-card-labels" style={{ "--host-color": host.color } as React.CSSProperties}>
        {environment && <span className="environment-badge" title={`Entorno: ${environment}`}>{environment}</span>}
        {uniqueLabels(host.tags).slice(0, 4).map(tag => <button key={tag} title={`Filtrar por ${tag}`} onClick={event => { event.stopPropagation(); onTag(tag); }}>{tag}</button>)}
        {uniqueLabels(host.tags).length > 4 && <span title="Todas las etiquetas están disponibles en el filtro">+{uniqueLabels(host.tags).length - 4}</span>}
      </div>}
    </article>
  );
}

function EmptyState({ onNewHost }: { onNewHost: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-visual"><span><TerminalSquare size={34} /></span></div>
      <h2>Crea tu primer host</h2>
      <p>Añade una conexión con su dirección, usuario y método de autenticación.</p>
      <div className="empty-actions"><button className="button primary" onClick={onNewHost}><Plus size={17} /> Crear un host</button></div>
    </div>
  );
}

function FilteredEmptyState({ favoriteOnly, recentOnly, searching, onClear }: { favoriteOnly: boolean; recentOnly: boolean; searching: boolean; onClear: () => void }) {
  return (
    <div className="filtered-empty-state">
      <span><Search size={22} /></span>
      <h2>{searching ? "No encontramos coincidencias" : favoriteOnly ? "Aún no tienes favoritos" : recentOnly ? "Todavía no hay actividad" : "Este grupo está vacío"}</h2>
      <p>{searching ? "Prueba con otro nombre, usuario o dirección IP." : favoriteOnly ? "Marca una conexión con la estrella para tenerla a mano." : recentOnly ? "Los hosts aparecerán aquí tras el primer intento de conexión." : "Aún no hay hosts en este grupo."}</p>
      <button className="button secondary" onClick={onClear}>Ver todos los hosts</button>
    </div>
  );
}

function activityTime(activity?: HostActivity): number {
  return activity ? Date.parse(activity.lastAttemptAt) || 0 : 0;
}

function statusLabel(status: SessionTab["status"]): string {
  if (status === "connected") return "Conectado";
  if (status === "connecting") return "Conectando";
  if (status === "trust_required") return "Verificación requerida";
  if (status === "error") return "Error de conexión";
  return "Desconectado";
}

function ConfirmDialog({ title, description, confirmLabel, danger = false, onClose, onConfirm }: { title: string; description: string; confirmLabel: string; danger?: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose, busy);

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo completar la acción.");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div ref={dialogRef} className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" tabIndex={-1}>
        <header className="modal-header">
          <div className={`modal-icon ${danger ? "danger" : ""}`}><AlertTriangle size={19} /></div>
          <div><h2 id="confirm-title">{title}</h2></div>
          <button type="button" className="icon-button modal-close" onClick={onClose} disabled={busy} aria-label="Cerrar"><X size={18} /></button>
        </header>
        <div className="modal-body confirm-copy"><p>{description}</p>{error && <div className="form-error">{error}</div>}</div>
        <footer className="modal-footer"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancelar</button><button type="button" className={`button ${danger ? "danger" : "primary"}`} onClick={() => void confirm()} disabled={busy}>{danger && <Trash2 size={15} />}{busy ? "Procesando…" : confirmLabel}</button></footer>
      </div>
    </div>
  );
}

function SimpleNameDialog({ title, description, label, placeholder, initialValue = "", submitLabel = "Guardar", onClose, onSave }: { title: string; description: string; label: string; placeholder: string; initialValue?: string; submitLabel?: string; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useDialogFocus<HTMLFormElement>(onClose, busy);
  const submitting = useRef(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try { await onSave(name.trim()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => !busy && event.target === event.currentTarget && onClose()}><form ref={dialogRef} className="modal small-modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onSubmit={submit}><header className="modal-header"><div className="modal-icon"><FolderPlus size={19} /></div><div><h2>{title}</h2><p>{description}</p></div><button type="button" disabled={busy} className="icon-button modal-close" onClick={onClose} aria-label="Cerrar"><X size={18} /></button></header><div className="modal-body"><label className="field"><span>{label}</span><input autoFocus maxLength={160} disabled={busy} value={name} onChange={(event) => setName(event.target.value)} placeholder={placeholder} /></label>{error && <p className="form-error" role="alert">{error}</p>}</div><footer className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancelar</button><button className="button primary" disabled={busy || !name.trim()}>{busy ? "Guardando…" : submitLabel}</button></footer></form></div>;
}

export default App;
