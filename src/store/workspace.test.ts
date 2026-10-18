// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../lib/desktop", () => ({ loadSnapshot: vi.fn(), persistSnapshot: vi.fn(), persistDuplicatedHost: vi.fn(), persistHostProfile: vi.fn(), importVault: vi.fn(), disconnectSshSession: vi.fn() }));
import { useAppStore } from "./appStore";
import { createInitialSnapshot, emptyHostDraft } from "../data";
import type { Host } from "../types";
import { LOCAL_POWERSHELL_ID, localPowerShellHost } from "../lib/sessionTarget";
let host: Host;
beforeEach(() => {
  localStorage.clear(); const snapshot = createInitialSnapshot();
  host = { ...emptyHostDraft(snapshot.vaults[0].id), id: "test-host", name: "Server", address: "localhost", username: "test", createdAt: "now", updatedAt: "now" }; snapshot.hosts.push(host);
  useAppStore.setState({ snapshot, selectedVaultId: snapshot.vaults[0].id, tabs: [], activeTabId: null, paneIds: [], terminalLayout: "columns", splitRatio: 50, maximizedPaneId: null });
});
it("splits without replacing the first session and preserves panes when focus changes", () => {
  const store = useAppStore.getState(); store.openSession(host); const first = useAppStore.getState().activeTabId!;
  store.splitSession(host, "rows"); const second = useAppStore.getState().activeTabId!;
  expect(useAppStore.getState().paneIds).toEqual([first, second]);
  store.setActiveTab(first); expect(useAppStore.getState().paneIds).toEqual([first, second]);
  store.reorderPanes(first, second); expect(useAppStore.getState().paneIds).toEqual([second, first]);
  store.closeSession(first); expect(useAppStore.getState().activeTabId).toBe(second); expect(useAppStore.getState().paneIds).toEqual([second]);
});

it("rejects a fifth pane and does not mutate existing sessions", () => {
  const store = useAppStore.getState(); store.openSession(host); for (let i = 0; i < 3; i++) store.splitSession(host, "grid");
  expect(() => store.splitSession(host, "grid")).toThrow(); expect(useAppStore.getState().tabs).toHaveLength(4);
});

it("does not cross the pinned boundary during reordering and clears unread on focus", () => {
  const store = useAppStore.getState(); store.openSession(host); const first = useAppStore.getState().activeTabId!; store.openSession(host, true); const second = useAppStore.getState().activeTabId!;
  store.togglePin(second); store.reorderTabs(second, first); expect(useAppStore.getState().tabs[0].id).toBe(second);
  store.markSessionOutput(first); expect(useAppStore.getState().tabs.find(tab => tab.id === first)?.unread).toBe(true);
  store.setActiveTab(first); expect(useAppStore.getState().tabs.find(tab => tab.id === first)?.unread).toBe(false);
});
