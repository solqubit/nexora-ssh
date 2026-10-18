// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "./appStore";
import * as desktop from "../lib/desktop";
import { emptyHostDraft } from "../data";
import { emptyConnectionProfile } from "../lib/connectionProfile";
import { sessionSnapshot, sessionTarget } from "../lib/sessionTarget";
import type { SecretUpdate } from "../types";
const secret: SecretUpdate = { password: "temporary-sensitive-password", privateKey: null, privateKeyName: null, keyPassphrase: null, clearPassword: false, clearPrivateKey: false };
beforeEach(async () => { localStorage.clear(); await useAppStore.getState().initialize(); useAppStore.setState({ tabs: [], paneIds: [], activeTabId: null, temporaryHosts: [], hostActivity: {} }); });
afterEach(async () => { vi.restoreAllMocks(); for (const item of useAppStore.getState().temporaryHosts) await useAppStore.getState().forgetTemporaryConnection(item.host.id); });
async function quick() { const store = useAppStore.getState(); return store.createTemporaryConnection({ ...emptyHostDraft(store.snapshot.vaults[0].id), name: "Quick fixture", address: "localhost", username: "test" }, secret, emptyConnectionProfile("draft")); }
const storage = () => Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index)!) ?? "").join("\n");
it("keeps temporary metadata and credentials out of durable tabs, activity and workspaces", async () => {
  const baseline = useAppStore.getState().snapshot, host = await quick(), state = useAppStore.getState();
  expect(state.snapshot).toEqual(baseline); expect(state.tabs[0].hostId).toBe(host.id); expect(state.tabs[0].autoConnect).toBe(true);
  expect(sessionTarget(baseline, host.id, state.temporaryHosts)).toEqual(host);
  expect(sessionSnapshot(baseline, state.temporaryHosts).hosts).toHaveLength(baseline.hosts.length + 1);
  state.recordHostActivity(host.id, "success", "Connected");
  expect(storage()).not.toContain(host.id); expect(storage()).not.toContain(secret.password);
  state.closeSession(state.tabs[0].id);
  expect(useAppStore.getState().temporaryHosts).toHaveLength(1);
  await useAppStore.getState().initialize();
  expect(useAppStore.getState().temporaryHosts[0].host.id).toBe(host.id); expect(useAppStore.getState().tabs).toHaveLength(0);
});
it("saves without reconnecting, retains failure state and persists only after promotion succeeds", async () => {
  const host = await quick(), state = useAppStore.getState(), tabId = state.tabs[0].id;
  state.setSessionStatus(tabId, "connected"); state.recordHostActivity(host.id, "success", "Connected");
  const spy = vi.spyOn(desktop, "promoteTemporaryHost").mockRejectedValueOnce(new Error("Fixture save failure"));
  await expect(state.saveTemporaryConnection(host.id, "Saved", null)).rejects.toThrow("Fixture save failure");
  expect(useAppStore.getState().temporaryHosts).toHaveLength(1); expect(useAppStore.getState().tabs[0].status).toBe("connected"); expect(storage()).not.toContain(host.id);
  spy.mockRestore(); await state.saveTemporaryConnection(host.id, "Saved", null);
  const saved = useAppStore.getState(); expect(saved.temporaryHosts).toHaveLength(0); expect(saved.snapshot.hosts.find(item => item.id === host.id)?.name).toBe("Saved"); expect(saved.tabs[0]).toMatchObject({ id: tabId, hostId: host.id, status: "connected" });
  expect(storage()).toContain(host.id); expect(storage()).not.toContain(secret.password);
  await saved.initialize(); expect(useAppStore.getState().tabs[0]).toMatchObject({ id: tabId, status: "disconnected", autoConnect: false });
});
it("forgets every matching tab while retaining other temporary sessions and refuses forgetting a saved host", async () => {
  const first = await quick(), second = await quick(); useAppStore.getState().openSession(first, true);
  await useAppStore.getState().forgetTemporaryConnection(first.id);
  expect(useAppStore.getState().tabs).toHaveLength(1); expect(useAppStore.getState().tabs[0].hostId).toBe(second.id);
  expect(useAppStore.getState().temporaryHosts.map(item => item.host.id)).toEqual([second.id]);
  await expect(useAppStore.getState().forgetTemporaryConnection("saved-host")).rejects.toThrow("ya no existe");
});
