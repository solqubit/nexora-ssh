import { expect, it } from "vitest";
import { createInitialSnapshot, emptyHostDraft } from "../data";
import { emptyConnectionProfile } from "./connectionProfile";
import { connectionRoute, assertHostsRemovable } from "./sshRoute";
import { parseAppSnapshot } from "./validation";
function fixture() {
  const snapshot = createInitialSnapshot();
  snapshot.hosts = ["gateway", "middle", "target"].map(id => ({ ...emptyHostDraft(snapshot.vaults[0].id), id, name: id, address: `${id}.example`, username: "test", createdAt: "now", updatedAt: "now" }));
  snapshot.productivity!.connectionProfiles = [{ ...emptyConnectionProfile("target"), jumpHostId: "middle" }, { ...emptyConnectionProfile("middle"), jumpHostId: "gateway" }];
  return snapshot;
}
it("resolves nested routes and preserves optional legacy direct profiles", () => {
  const snapshot = fixture(); expect(connectionRoute(snapshot, "target").map(host => host.id)).toEqual(["gateway", "middle", "target"]);
  expect(connectionRoute(snapshot, "gateway").map(host => host.id)).toEqual(["gateway"]);
  expect(parseAppSnapshot(snapshot).productivity?.connectionProfiles).toEqual(snapshot.productivity?.connectionProfiles);
});
it.each(["target", "middle", "deleted"])("rejects cyclic or dangling jump references before saving: %s", parent => {
  const snapshot = fixture(); snapshot.productivity!.connectionProfiles![1].jumpHostId = parent;
  expect(() => parseAppSnapshot(snapshot)).toThrow();
});
it("rejects excessive depth and different vaults and protects dependencies before deletion", () => {
  const snapshot = fixture(); expect(() => assertHostsRemovable(snapshot, ["gateway"])).toThrow("middle");
  expect(() => assertHostsRemovable(snapshot, ["gateway", "middle", "target"])).not.toThrow();
  snapshot.hosts[0].vaultId = "another-vault"; expect(() => connectionRoute(snapshot, "target")).toThrow("misma bóveda");
  snapshot.hosts = Array.from({ length: 10 }, (_, index) => ({ ...snapshot.hosts[1], id: String(index) }));
  snapshot.productivity!.connectionProfiles = snapshot.hosts.map((host, index) => ({ ...emptyConnectionProfile(host.id), jumpHostId: index ? String(index - 1) : null }));
  expect(() => connectionRoute(snapshot, "9")).toThrow("ocho"); expect(connectionRoute(snapshot, "8")).toHaveLength(9);
});
