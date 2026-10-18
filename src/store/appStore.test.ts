// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialSnapshot, emptyHostDraft } from "../data";
import type { AppSnapshot, SecretUpdate } from "../types";
import { emptyConnectionProfile } from "../lib/connectionProfile";

const native = vi.hoisted(() => ({
  loadSnapshot: vi.fn(), persistSnapshot: vi.fn(), persistHostProfile: vi.fn(),
  persistDuplicatedHost: vi.fn(), persistIdentityProfile: vi.fn(), importVault: vi.fn(), disconnectSshSession: vi.fn(),
  loadTemporaryHosts: vi.fn(), createTemporaryHost: vi.fn(), promoteTemporaryHost: vi.fn(), forgetTemporaryHost: vi.fn(),
  stopAllTunnels: vi.fn(),
}));
vi.mock("../lib/desktop", () => native);
import { useAppStore } from "./appStore";

let disk: AppSnapshot;
const secrets: SecretUpdate = { password: "fixture", privateKey: null, privateKeyName: null, keyPassphrase: null, clearPassword: false, clearPrivateKey: false };
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); disk = createInitialSnapshot();
  useAppStore.setState({ snapshot: disk, temporaryHosts: [], selectedVaultId: disk.vaults[0].id, selectedGroupId: null, selectedHostId: null, tabs: [], paneIds: [], activeTabId: null, hostActivity: {}, search: "", ready: true });
  native.loadTemporaryHosts.mockResolvedValue([]);
  native.loadSnapshot.mockImplementation(async () => structuredClone(disk));
  native.persistSnapshot.mockImplementation(async (snapshot: AppSnapshot, expected: AppSnapshot) => {
    expect(expected).toEqual(disk);
    await Promise.resolve(); disk = structuredClone(snapshot);
  });
  native.persistHostProfile.mockImplementation(async (snapshot: AppSnapshot, _id: string, _secret: SecretUpdate, expected: AppSnapshot) => {
    expect(expected).toEqual(disk);
    await Promise.resolve(); disk = structuredClone(snapshot);
  });
  native.disconnectSshSession.mockResolvedValue(undefined);
  native.persistDuplicatedHost.mockImplementation(async (snapshot: AppSnapshot, _source: string, _target: string, expected: AppSnapshot) => { expect(expected).toEqual(disk); disk = structuredClone(snapshot); });
  native.persistIdentityProfile.mockImplementation(async (snapshot: AppSnapshot, _id: string, _update: SecretUpdate, expected: AppSnapshot) => { expect(expected).toEqual(disk); disk = structuredClone(snapshot); });
});

describe("serialized profile mutations", () => {
  it("protects jump dependencies before persistence and permits deleting the whole chain", async () => {
    disk.hosts = ["Gateway", "Target"].map(id => ({ ...emptyHostDraft(disk.vaults[0].id), id, name: id, address: "localhost", username: "test", createdAt: "now", updatedAt: "now" }));
    disk.productivity!.connectionProfiles = [{ ...emptyConnectionProfile("Target"), jumpHostId: "Gateway" }];
    useAppStore.setState({ snapshot: structuredClone(disk) });
    await expect(useAppStore.getState().deleteHost("Gateway")).rejects.toThrow("Target");
    expect(native.persistSnapshot).not.toHaveBeenCalled(); expect(native.disconnectSshSession).not.toHaveBeenCalled();
    expect(useAppStore.getState().snapshot.hosts).toHaveLength(2);
    await useAppStore.getState().deleteHosts(["Gateway", "Target"]);
    expect(disk.hosts).toHaveLength(0); expect(disk.productivity!.connectionProfiles).toHaveLength(0);
  });
  it("retains both concurrently created groups", async () => {
    await Promise.all([useAppStore.getState().addGroup("First"), useAppStore.getState().addGroup("Second")]);
    expect(disk.groups.map(group => group.name)).toContain("First");
    expect(disk.groups.map(group => group.name)).toContain("Second");
    expect(useAppStore.getState().snapshot).toEqual(disk);
  });
  it("retains a host saved concurrently with a group", async () => {
    const draft = { ...emptyHostDraft(disk.vaults[0].id), name: "Server", address: "localhost", username: "test" };
    await Promise.all([useAppStore.getState().upsertHost(draft, secrets), useAppStore.getState().addGroup("Concurrent")]);
    expect(disk.hosts).toHaveLength(1); expect(disk.groups.at(-1)?.name).toBe("Concurrent");
  });
  it("commits a reusable identity and host binding atomically and copies configuration during duplication", async () => {
    const store = useAppStore.getState();
    await store.upsertIdentity({ id: "access", vaultId: disk.vaults[0].id, name: "Access", username: "shared", authMethod: "password", updatedAt: "now" }, secrets);
    const profile = { identityId: "access", inheritUsername: true, inheritPort: true, inheritIdentity: false, inheritKeepalive: true, keepaliveSeconds: null };
    const host = await store.upsertHost({ ...emptyHostDraft(disk.vaults[0].id, disk.groups[0].id), name: "Server", address: "localhost" }, secrets, profile);
    expect(native.persistHostProfile.mock.calls[0][0].productivity.connectionProfiles).toEqual([{ ...profile, hostId: host.id }]);
    const duplicated = await store.duplicateHost(host.id);
    expect(disk.productivity?.connectionProfiles?.find(value => value.hostId === duplicated.id)).toEqual({ ...profile, hostId: duplicated.id });
    await store.deleteHost(host.id);
    expect(disk.productivity?.connectionProfiles?.some(value => value.hostId === host.id)).toBe(false);
    expect(disk.productivity?.identities?.[0].id).toBe("access");
  });
  it("recovers the mutation queue after a persistence failure", async () => {
    const original = structuredClone(disk);
    native.persistSnapshot.mockRejectedValueOnce(new Error("Disk failure"));
    await expect(useAppStore.getState().addGroup("Failed")).rejects.toThrow("Disk failure");
    expect(useAppStore.getState().snapshot).toEqual(original);
    await useAppStore.getState().addGroup("Recovered");
    expect(disk.groups.some(group => group.name === "Recovered")).toBe(true);
    expect(disk.groups.some(group => group.name === "Failed")).toBe(false);
  });

});
