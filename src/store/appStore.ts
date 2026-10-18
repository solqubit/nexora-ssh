import { create } from "zustand";
import { createId, createInitialSnapshot } from "../data";
import { loadSnapshot, loadTemporaryHosts, persistDuplicatedHost, persistHostProfile, persistSnapshot, persistIdentityProfile, disconnectSshSession, createTemporaryHost, promoteTemporaryHost, forgetTemporaryHost } from "../lib/desktop";
import { LOCAL_POWERSHELL_ID, sessionSnapshot } from "../lib/sessionTarget";
import { assertHostsRemovable } from "../lib/sshRoute";
import type { AppSnapshot, Host, HostActivity, HostDraft, HostGroup, KnownHost, SecretUpdate, SessionStatus, SessionTab, TerminalLayout, SavedWorkspace, ProductivityData, Identity, ConnectionProfile, SavedFileLayout, TemporaryHost } from "../types";

interface AppStore {
  snapshot: AppSnapshot;
  temporaryHosts: TemporaryHost[];
  createTemporaryConnection: (draft: HostDraft, secrets: SecretUpdate, connection: Omit<ConnectionProfile, "hostId">) => Promise<Host>;
  saveTemporaryConnection: (hostId: string, name: string, groupId: string | null) => Promise<void>;
  forgetTemporaryConnection: (hostId: string) => Promise<void>;
  ready: boolean;
  initializationError: string | null;
  selectedVaultId: string | null;
  selectedGroupId: string | null;
  selectedHostId: string | null;
  search: string;
  tabs: SessionTab[];
  activeTabId: string | null;
  paneIds: string[];
  terminalLayout: TerminalLayout;
  splitRatio: number;
  maximizedPaneId: string | null;
  hostActivity: Record<string, HostActivity>;
  initialize: () => Promise<void>;
  replaceSnapshot: (snapshot: AppSnapshot) => void;
  updateProductivity: (mutation: (value: ProductivityData) => ProductivityData) => Promise<void>;
  upsertIdentity: (identity: Identity, secrets: SecretUpdate) => Promise<void>;
  setSearch: (value: string) => void;
  selectGroup: (id: string | null) => void;
  selectHost: (id: string | null) => void;
  upsertHost: (draft: HostDraft, secrets: SecretUpdate, connection?: Omit<ConnectionProfile, "hostId">) => Promise<Host>;
  duplicateHost: (id: string) => Promise<Host>;
  deleteHost: (id: string) => Promise<void>;
  deleteHosts: (ids: string[]) => Promise<void>;
  moveHosts: (ids: string[], groupId: string | null) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  addGroup: (name: string) => Promise<HostGroup>;
  renameGroup: (id: string, name: string) => Promise<void>;
  reorderGroup: (sourceId: string, targetId: string) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  openSession: (host: Host, forceNew?: boolean) => void;
  closeSession: (tabId: string) => void;
  closeOtherSessions: (tabId: string) => void;
  setActiveTab: (tabId: string | null) => void;
  setSessionStatus: (tabId: string, status: SessionStatus) => void;
  splitSession: (host: Host, layout: TerminalLayout) => void;
  setTerminalLayout: (layout: TerminalLayout) => void;
  setSplitRatio: (ratio: number) => void;
  maximizePane: (id: string | null) => void;
  reorderPanes: (sourceId: string, targetId: string) => void;
  reorderTabs: (sourceId: string, targetId: string) => void;
  renameTab: (id: string, title: string) => void;
  togglePin: (id: string) => void;
  markSessionOutput: (id: string, seen?: boolean) => void;
  recordHostActivity: (hostId: string, result: "attempt" | "success" | "error", message?: string | null) => void;
  rememberKnownHost: (knownHost: KnownHost) => void;
}

let mutationTail: Promise<unknown> = Promise.resolve();
export function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation);
  mutationTail = result.catch(() => undefined);
  return result;
}
async function save(snapshot: AppSnapshot, expected: AppSnapshot): Promise<AppSnapshot> {
  if (snapshot.productivity) snapshot = { ...snapshot, productivity: { ...snapshot.productivity, connectionProfiles: snapshot.productivity.connectionProfiles?.filter(profile => snapshot.hosts.some(host => host.id === profile.hostId)), groupDefaults: snapshot.productivity.groupDefaults?.filter(defaults => snapshot.groups.some(group => group.id === defaults.groupId)), tunnels: snapshot.productivity.tunnels?.filter(profile => snapshot.hosts.some(host => host.id === profile.hostId)) } };
  await persistSnapshot(snapshot, expected);
  return loadSnapshot();
}

const SESSION_STORAGE_KEY = "nexora.session-tabs.v1";
const ACTIVITY_STORAGE_KEY = "nexora.host-activity.v1";

function persistSessionTabs(tabs: SessionTab[], activeTabId: string | null): void {
  try {
    const { paneIds, terminalLayout, splitRatio } = useAppStore.getState();
    const savedIds = new Set(useAppStore.getState().snapshot.hosts.map(host => host.id)); savedIds.add(LOCAL_POWERSHELL_ID);
    const savedTabs = tabs.filter(tab => savedIds.has(tab.hostId));
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ tabs: savedTabs, activeTabId: savedTabs.some(tab => tab.id === activeTabId) ? activeTabId : null, paneIds: paneIds.filter(id => savedTabs.some(tab => tab.id === id)), terminalLayout, splitRatio }));
  } catch {
    // La restauración de pestañas es auxiliar y no debe impedir el uso de SSH.
  }
}

function restoreSessionTabs(snapshot: AppSnapshot): { tabs: SessionTab[]; activeTabId: string | null; paneIds: string[]; terminalLayout: TerminalLayout; splitRatio: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? "{}") as { tabs?: SessionTab[]; activeTabId?: string | null; paneIds?: string[]; terminalLayout?: TerminalLayout; splitRatio?: number };
    const validHostIds = new Set(snapshot.hosts.map((host) => host.id));
    validHostIds.add(LOCAL_POWERSHELL_ID);
    const ids = new Set<string>();
    const tabs = (saved.tabs ?? []).slice(0, 100)
      .filter((tab) => typeof tab.id === "string" && !ids.has(tab.id) && validHostIds.has(tab.hostId) && Boolean(ids.add(tab.id)))
      .map((tab) => ({ id: tab.id, hostId: tab.hostId, title: typeof tab.title === "string" ? tab.title.slice(0, 160) : "Sesión", pinned: tab.pinned === true, status: "disconnected" as SessionStatus, autoConnect: false }));
    const activeTabId = tabs.some((tab) => tab.id === saved.activeTabId) ? saved.activeTabId ?? null : tabs.at(-1)?.id ?? null;
    const paneIds = Array.from(new Set(saved.paneIds ?? [])).filter(id => tabs.some(tab => tab.id === id)).slice(0, 4);
    if (activeTabId && !paneIds.includes(activeTabId)) { paneIds.length = 0; paneIds.push(activeTabId); }
    return { tabs, activeTabId, paneIds: activeTabId ? paneIds : [], terminalLayout: saved.terminalLayout === "rows" || saved.terminalLayout === "grid" ? saved.terminalLayout : "columns", splitRatio: Math.max(20, Math.min(80, Number(saved.splitRatio) || 50)) };
  } catch {
    return { tabs: [], activeTabId: null, paneIds: [], terminalLayout: "columns", splitRatio: 50 };
  }
}

function restoreHostActivity(snapshot: AppSnapshot): Record<string, HostActivity> {
  try {
    const saved = JSON.parse(localStorage.getItem(ACTIVITY_STORAGE_KEY) ?? "{}") as Record<string, HostActivity>;
    const validHostIds = new Set(snapshot.hosts.map((host) => host.id));
    return Object.fromEntries(Object.entries(saved).filter(([hostId]) => validHostIds.has(hostId)));
  } catch {
    return {};
  }
}

function persistHostActivity(activity: Record<string, HostActivity>): void {
  try {
    const savedIds = new Set(useAppStore.getState().snapshot.hosts.map(host => host.id));
    localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(Object.fromEntries(Object.entries(activity).filter(([id]) => savedIds.has(id)))));
  } catch {
    // El historial local es auxiliar y no debe bloquear la aplicación.
  }
}

export const useAppStore = create<AppStore>((set, get) => ({
  snapshot: createInitialSnapshot(),
  temporaryHosts: [],
  ready: false,
  initializationError: null,
  selectedVaultId: null,
  selectedGroupId: null,
  selectedHostId: null,
  search: "",
  tabs: [],
  activeTabId: null,
  paneIds: [],
  terminalLayout: "columns",
  splitRatio: 50,
  maximizedPaneId: null,
  hostActivity: {},

  initialize: async () => {
    set({ ready: false, initializationError: null });
    try {
      const snapshot = await loadSnapshot();
      const temporaryHosts = await loadTemporaryHosts();
      const restored = restoreSessionTabs(snapshot);
      set({ snapshot, temporaryHosts, ready: true, initializationError: null, selectedVaultId: snapshot.vaults[0]?.id ?? null, hostActivity: restoreHostActivity(snapshot), ...restored });
    } catch (reason) {
      const initializationError = reason instanceof Error ? reason.message : String(reason);
      set({ ready: true, initializationError });
    }
  },

  replaceSnapshot: (snapshot) => {
    set({ temporaryHosts: [] });
    set({ snapshot, ready: true, initializationError: null, selectedVaultId: snapshot.vaults[0]?.id ?? null, selectedGroupId: null, selectedHostId: null, tabs: [], activeTabId: null, paneIds: [], maximizedPaneId: null, hostActivity: {}, search: "" });
    persistSessionTabs([], null);
    persistHostActivity({});
  },
  setSearch: (search) => set({ search }),
  updateProductivity: mutation => enqueueMutation(async () => {
    const current = get().snapshot;
    const snapshot = { ...current, productivity: mutation(current.productivity ?? { workspaces: [], snippets: [] }) };
    const committed = await save(snapshot, current); set({ snapshot: committed });
  }),
  upsertIdentity: (identity, update) => enqueueMutation(async () => {
    const current = get().snapshot;
    const productivity = current.productivity ?? { workspaces: [], snippets: [] };
    const snapshot = { ...current, productivity: { ...productivity, identities: [...(productivity.identities ?? []).filter(item => item.id !== identity.id), identity] } };
    await persistIdentityProfile(snapshot, identity.id, update, current); set({ snapshot: await loadSnapshot() });
  }),
  selectGroup: (selectedGroupId) => set({ selectedGroupId, selectedHostId: null }),
  selectHost: (selectedHostId) => set({ selectedHostId }),

  upsertHost: async (draft, secrets, connection) => enqueueMutation(async () => {
    const now = new Date().toISOString();
    const current = get().snapshot;
    const existing = draft.id ? current.hosts.find((host) => host.id === draft.id) : undefined;
    const host: Host = {
      ...draft,
      id: existing?.id ?? createId(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const hosts = existing
      ? current.hosts.map((item) => item.id === host.id ? host : item)
      : [...current.hosts, host];
    const productivity = current.productivity ?? { workspaces: [], snippets: [] };
    const snapshot = { ...current, hosts, ...(connection ? { productivity: { ...productivity, connectionProfiles: [...(productivity.connectionProfiles ?? []).filter(profile => profile.hostId !== host.id), { ...connection, hostId: host.id }] } } : {}) };
    await persistHostProfile(snapshot, host.id, secrets, current);
    const committed = await loadSnapshot();
    set({ snapshot: committed, selectedHostId: host.id });
    return host;
  }),
  createTemporaryConnection: (draft, secrets, connection) => enqueueMutation(async () => {
    if (get().tabs.length >= 100) throw new Error("Cierra una sesión antes de abrir otra (máximo 100).");
    const now = new Date().toISOString(), host: Host = { ...draft, id: createId(), createdAt: now, updatedAt: now };
    const temporary = await createTemporaryHost(host, { ...connection, hostId: host.id }, secrets, get().snapshot);
    if (get().tabs.length >= 100) { await forgetTemporaryHost(temporary.host.id); throw new Error("Cierra una sesión antes de abrir otra (máximo 100)."); }
    set({ temporaryHosts: [...get().temporaryHosts, temporary] });
    get().openSession(temporary.host, true);
    return temporary.host;
  }),
  saveTemporaryConnection: (hostId, name, groupId) => enqueueMutation(async () => {
    if (!get().temporaryHosts.some(item => item.host.id === hostId)) throw new Error("La conexión temporal ya no existe.");
    const snapshot = await promoteTemporaryHost(hostId, name, groupId, get().snapshot);
    set({ snapshot, temporaryHosts: get().temporaryHosts.filter(item => item.host.id !== hostId) });
    persistSessionTabs(get().tabs, get().activeTabId); persistHostActivity(get().hostActivity);
  }),
  forgetTemporaryConnection: hostId => enqueueMutation(async () => {
    if (!get().temporaryHosts.some(item => item.host.id === hostId)) throw new Error("La conexión temporal ya no existe.");
    await forgetTemporaryHost(hostId);
    for (const tab of get().tabs.filter(tab => tab.hostId === hostId)) get().closeSession(tab.id);
    const activity = { ...get().hostActivity }; delete activity[hostId];
    set({ temporaryHosts: get().temporaryHosts.filter(item => item.host.id !== hostId), hostActivity: activity });
  }),
  duplicateHost: async (id) => enqueueMutation(async () => {
    const current = get().snapshot;
    const source = current.hosts.find((host) => host.id === id);
    if (!source) throw new Error("No se encontró el host que deseas duplicar.");

    const baseName = `${source.name} copia`;
    const usedNames = new Set(current.hosts
      .filter((host) => host.vaultId === source.vaultId)
      .map((host) => host.name.trim().toLocaleLowerCase()));
    let name = baseName;
    let suffix = 2;
    while (usedNames.has(name.toLocaleLowerCase())) {
      name = `${baseName} ${suffix}`;
      suffix += 1;
    }

    const now = new Date().toISOString();
    const host: Host = {
      ...source,
      id: createId(),
      name,
      createdAt: now,
      updatedAt: now,
    };
    const sourceKnownHost = current.knownHosts.find((known) => known.hostId === source.id);
    const duplicatedKnownHost = sourceKnownHost
      ? { ...sourceKnownHost, id: createId(), hostId: host.id }
      : null;
    const snapshot = {
      ...current,
      hosts: [...current.hosts, host],
      knownHosts: duplicatedKnownHost ? [...current.knownHosts, duplicatedKnownHost] : current.knownHosts,
      ...(current.productivity ? { productivity: { ...current.productivity, connectionProfiles: [...(current.productivity.connectionProfiles ?? []), ...(current.productivity.connectionProfiles?.filter(profile => profile.hostId === source.id).map(profile => ({ ...profile, hostId: host.id })) ?? [])] } } : {}),
    };
    await persistDuplicatedHost(snapshot, source.id, host.id, current);
    const committed = await loadSnapshot();
    set({ snapshot: committed, selectedHostId: host.id });
    return host;
  }),
  deleteHost: async (id) => {
    await get().deleteHosts([id]);
  },

  deleteHosts: async (ids) => enqueueMutation(async () => {
    assertHostsRemovable(sessionSnapshot(get().snapshot, get().temporaryHosts), ids);
    const idSet = new Set(ids);
    const current = get().snapshot;
    const snapshot = {
      ...current,
      hosts: current.hosts.filter((host) => !idSet.has(host.id)),
      knownHosts: current.knownHosts.filter((known) => !idSet.has(known.hostId)),
    };
    const hostActivity = Object.fromEntries(Object.entries(get().hostActivity).filter(([hostId]) => !idSet.has(hostId)));
    const committed = await save(snapshot, current);
    const tabs = get().tabs.filter((tab) => !idSet.has(tab.hostId));
    const activeTabId = tabs.some((tab) => tab.id === get().activeTabId) ? get().activeTabId : tabs.at(-1)?.id ?? null;
    const paneIds = get().paneIds.filter(id => tabs.some(tab => tab.id === id));
    if (activeTabId && !paneIds.length) paneIds.push(activeTabId);
    set({ snapshot: committed, selectedHostId: idSet.has(get().selectedHostId ?? "") ? null : get().selectedHostId, tabs, activeTabId, paneIds, maximizedPaneId: null, hostActivity });
    persistSessionTabs(tabs, activeTabId);
    persistHostActivity(hostActivity);
  }),
  moveHosts: async (ids, groupId) => enqueueMutation(async () => {
    const idSet = new Set(ids);
    const current = get().snapshot;
    const now = new Date().toISOString();
    const snapshot = {
      ...current,
      hosts: current.hosts.map((host) => idSet.has(host.id) ? { ...host, groupId, updatedAt: now } : host),
    };
    const committed = await save(snapshot, current);
    set({ snapshot: committed });
  }),
  toggleFavorite: async (id) => enqueueMutation(async () => {
    const current = get().snapshot;
    const snapshot = {
      ...current,
      hosts: current.hosts.map((host) => host.id === id ? { ...host, favorite: !host.favorite } : host),
    };
    const committed = await save(snapshot, current);
    set({ snapshot: committed });
  }),
  addGroup: async (name) => enqueueMutation(async () => {
    const current = get().snapshot;
    const vaultId = get().selectedVaultId ?? current.vaults[0].id;
    const group: HostGroup = {
      id: createId(),
      vaultId,
      parentId: null,
      name,
      sortOrder: current.groups.filter((item) => item.vaultId === vaultId).length,
    };
    const snapshot = { ...current, groups: [...current.groups, group] };
    const committed = await save(snapshot, current);
    set({ snapshot: committed, selectedGroupId: group.id });
    return group;
  }),
  renameGroup: async (id, name) => enqueueMutation(async () => {
    const current = get().snapshot;
    const snapshot = { ...current, groups: current.groups.map((group) => group.id === id ? { ...group, name: name.trim() } : group) };
    const committed = await save(snapshot, current);
    set({ snapshot: committed });
  }),
  reorderGroup: async (sourceId, targetId) => enqueueMutation(async () => {
    if (sourceId === targetId) return;
    const current = get().snapshot;
    const source = current.groups.find((group) => group.id === sourceId);
    const target = current.groups.find((group) => group.id === targetId);
    if (!source || !target || source.vaultId !== target.vaultId) return;
    const ordered = current.groups.filter((group) => group.vaultId === source.vaultId).sort((a, b) => a.sortOrder - b.sortOrder);
    const sourceIndex = ordered.findIndex((group) => group.id === sourceId);
    const targetIndex = ordered.findIndex((group) => group.id === targetId);
    const [moved] = ordered.splice(sourceIndex, 1);
    ordered.splice(targetIndex, 0, moved);
    const orderById = new Map(ordered.map((group, index) => [group.id, index]));
    const snapshot = {
      ...current,
      groups: current.groups.map((group) => orderById.has(group.id) ? { ...group, sortOrder: orderById.get(group.id)! } : group),
    };
    const committed = await save(snapshot, current);
    set({ snapshot: committed });
  }),
  deleteGroup: async (id) => enqueueMutation(async () => {
    const current = get().snapshot;
    const group = current.groups.find((item) => item.id === id);
    if (!group) return;
    const remainingGroups = current.groups
      .filter((item) => item.id !== id)
      .map((item) => item.parentId === id ? { ...item, parentId: group.parentId } : item);
    const groups = remainingGroups.map((item) => item.vaultId === group.vaultId
      ? { ...item, sortOrder: remainingGroups.filter((candidate) => candidate.vaultId === group.vaultId && candidate.sortOrder < item.sortOrder).length }
      : item);
    const snapshot = {
      ...current,
      groups,
      hosts: current.hosts.map((host) => host.groupId === id ? { ...host, groupId: group.parentId, updatedAt: new Date().toISOString() } : host),
    };
    const committed = await save(snapshot, current);
    set({
      snapshot: committed,
      selectedGroupId: get().selectedGroupId === id ? group.parentId : get().selectedGroupId,
      selectedHostId: null,
    });
  }),
  openSession: (host, forceNew = false) => {
    const tabs = get().tabs;
    const existing = tabs.find((tab) => tab.hostId === host.id);
    if (existing && !forceNew) {
      get().setActiveTab(existing.id);
      return;
    }
    const usedTitles = new Set(tabs.filter((tab) => tab.hostId === host.id).map((tab) => tab.title));
    let title = host.name;
    if (usedTitles.has(title)) {
      let suffix = 2;
      while (usedTitles.has(`${host.name} ${suffix}`)) suffix += 1;
      title = `${host.name} ${suffix}`;
    }
    const tab: SessionTab = {
      id: createId(),
      hostId: host.id,
      title,
      status: "disconnected",
      autoConnect: true,
    };
    const nextTabs = [...tabs, tab];
    if (tabs.length >= 100) throw new Error("Cierra una sesión antes de abrir otra (máximo 100).");
    set({ tabs: nextTabs, activeTabId: tab.id, paneIds: [tab.id], maximizedPaneId: null });
    persistSessionTabs(nextTabs, tab.id);
  },

  closeSession: (tabId) => {
    const tabs = get().tabs.filter((tab) => tab.id !== tabId);
    const panes = get().paneIds.filter(id => id !== tabId);
    const activeTabId = get().activeTabId === tabId ? panes[0] ?? tabs.at(-1)?.id ?? null : get().activeTabId;
    set({ tabs, activeTabId, paneIds: activeTabId ? panes.length ? panes : [activeTabId] : [], maximizedPaneId: null });
    persistSessionTabs(tabs, activeTabId);
  },
  closeOtherSessions: (tabId) => {
    const tabs = get().tabs.filter((tab) => tab.id === tabId);
    const activeTabId = tabs[0]?.id ?? null;
    set({ tabs, activeTabId, paneIds: activeTabId ? [activeTabId] : [], maximizedPaneId: null });
    persistSessionTabs(tabs, activeTabId);
  },
  setActiveTab: (activeTabId) => {
    if (activeTabId && !get().tabs.some(tab => tab.id === activeTabId)) return;
    set({ activeTabId, paneIds: activeTabId ? get().paneIds.includes(activeTabId) ? get().paneIds : [activeTabId] : [], maximizedPaneId: null, tabs: get().tabs.map(tab => tab.id === activeTabId ? { ...tab, unread: false } : tab) });
    persistSessionTabs(get().tabs, activeTabId);
  },
  splitSession: (host, layout) => {
    const panes = get().paneIds;
    if (panes.length >= 4) throw new Error("Puedes ver hasta cuatro terminales a la vez.");
    get().openSession(host, true);
    const id = get().activeTabId!;
    set({ paneIds: [...panes, id], terminalLayout: layout, maximizedPaneId: null });
    persistSessionTabs(get().tabs, id);
  },
  setTerminalLayout: (terminalLayout) => { set({ terminalLayout }); persistSessionTabs(get().tabs, get().activeTabId); },
  setSplitRatio: (ratio) => { set({ splitRatio: Math.max(20, Math.min(80, ratio)) }); persistSessionTabs(get().tabs, get().activeTabId); },
  maximizePane: (maximizedPaneId) => set({ maximizedPaneId }),
  reorderPanes: (sourceId, targetId) => {
    const paneIds = [...get().paneIds];
    const a = paneIds.indexOf(sourceId), b = paneIds.indexOf(targetId);
    if (a < 0 || b < 0 || a === b) return;
    [paneIds[a], paneIds[b]] = [paneIds[b], paneIds[a]];
    set({ paneIds }); persistSessionTabs(get().tabs, get().activeTabId);
  },
  reorderTabs: (sourceId, targetId) => {
    const tabs = [...get().tabs];
    const a = tabs.findIndex(tab => tab.id === sourceId), b = tabs.findIndex(tab => tab.id === targetId);
    if (a < 0 || b < 0 || a === b || Boolean(tabs[a].pinned) !== Boolean(tabs[b].pinned)) return;
    const [tab] = tabs.splice(a, 1); tabs.splice(b, 0, tab);
    set({ tabs }); persistSessionTabs(tabs, get().activeTabId);
  },
  renameTab: (id, title) => {
    const clean = title.trim(); if (!clean || clean.length > 160) throw new Error("El nombre debe tener entre 1 y 160 caracteres.");
    const tabs = get().tabs.map(tab => tab.id === id ? { ...tab, title: clean } : tab);
    set({ tabs }); persistSessionTabs(tabs, get().activeTabId);
  },
  togglePin: (id) => {
    const tabs = get().tabs.map(tab => tab.id === id ? { ...tab, pinned: !tab.pinned } : tab).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
    set({ tabs }); persistSessionTabs(tabs, get().activeTabId);
  },
  markSessionOutput: (id, seen = true) => { if (!seen || get().activeTabId !== id) { const tab = get().tabs.find(item => item.id === id); if (tab && !tab.unread) set({ tabs: get().tabs.map(item => item.id === id ? { ...item, unread: true } : item) }); } },
  setSessionStatus: (tabId, status) => set({ tabs: get().tabs.map((tab) => tab.id === tabId ? { ...tab, status } : tab) }),
  recordHostActivity: (hostId, result, message = null) => {
    const now = new Date().toISOString();
    const previous = get().hostActivity[hostId];
    const activity: HostActivity = {
      hostId,
      lastAttemptAt: now,
      lastConnectedAt: result === "success" ? now : previous?.lastConnectedAt ?? null,
      lastResult: result === "attempt" ? previous?.lastResult ?? null : result,
      lastMessage: result === "attempt" ? previous?.lastMessage ?? null : message,
      connectionCount: (previous?.connectionCount ?? 0) + (result === "success" ? 1 : 0),
    };
    const hostActivity = { ...get().hostActivity, [hostId]: activity };
    set({ hostActivity });
    persistHostActivity(hostActivity);
  },
  rememberKnownHost: (knownHost) => {
    if (get().temporaryHosts.some(item => item.host.id === knownHost.hostId)) {
      set({ temporaryHosts: get().temporaryHosts.map(item => item.host.id === knownHost.hostId ? { ...item, knownHost } : item) }); return;
    }
    set({
    snapshot: {
      ...get().snapshot,
      knownHosts: [...get().snapshot.knownHosts.filter((known) => known.hostId !== knownHost.hostId), knownHost],
    },
    });
  },
}));
