import { expect, it } from "vitest";
import { createInitialSnapshot, emptyHostDraft } from "../data";
import { emptyConnectionProfile, resolveConnectionProfile } from "./connectionProfile";
import { parseAppSnapshot } from "./validation";
import { connectionProfileSchema } from "./productivityValidation";
import type { Host } from "../types";

it("accepts legacy profiles and preserves tmux while rejecting unsafe session names", () => {
  const profile = emptyConnectionProfile("host");
  expect(connectionProfileSchema.parse(profile).tmuxSession).toBeUndefined();
  expect(connectionProfileSchema.parse({ ...profile, tmuxSession: "work_42-prod" }).tmuxSession).toBe("work_42-prod");
  for (const name of ["", "-d", "name;id", "$(id)", "a.b", "a:b", "x".repeat(81)]) expect(() => connectionProfileSchema.parse({ ...profile, tmuxSession: name })).toThrow();
});

function fixture() {
  const snapshot = createInitialSnapshot(); const vaultId = snapshot.vaults[0].id;
  const parent = snapshot.groups[0], child = snapshot.groups[1]; child.parentId = parent.id;
  const host: Host = { ...emptyHostDraft(vaultId, child.id), id: "server", name: "Server", address: "localhost", username: "own-user", createdAt: "now", updatedAt: "now" };
  snapshot.hosts.push(host);
  snapshot.productivity!.identities = [{ id: "identity", name: "Shared key", vaultId, username: "identity-user", authMethod: "private_key", updatedAt: "now" }];
  snapshot.productivity!.groupDefaults = [{ groupId: parent.id, username: "parent-user", port: 2222, identityId: "identity", keepaliveSeconds: 15 }, { groupId: child.id, username: "child-user", port: null, identityId: null, keepaliveSeconds: 0 }];
  snapshot.productivity!.connectionProfiles = [{ ...emptyConnectionProfile(host.id), inheritUsername: true, inheritPort: true, inheritIdentity: true, inheritKeepalive: true }];
  return { snapshot, host };
}
it("resolves each inherited field from the nearest defined group and preserves disabled keepalive", () => {
  const { snapshot, host } = fixture(); const result = resolveConnectionProfile(parseAppSnapshot(snapshot), host);
  expect(result.host).toMatchObject({ username: "child-user", port: 2222, authMethod: "private_key" }); expect(result.identity?.id).toBe("identity"); expect(result.keepaliveSeconds).toBe(0);
  expect(host).toMatchObject({ username: "own-user", port: 22, authMethod: "password" });
});
it("preserves own overrides and ignores group defaults for older unconfigured hosts", () => {
  const { snapshot, host } = fixture(); snapshot.productivity!.connectionProfiles = [{ ...emptyConnectionProfile(host.id), keepaliveSeconds: 60 }];
  const overridden = resolveConnectionProfile(snapshot, host); expect(overridden.host).toEqual(host); expect(overridden.identity).toBeUndefined(); expect(overridden.keepaliveSeconds).toBe(60);
  snapshot.productivity!.connectionProfiles = []; expect(resolveConnectionProfile(snapshot, host, 45).host).toEqual(host); expect(resolveConnectionProfile(snapshot, host, 45).keepaliveSeconds).toBe(45);
});
it("uses the identity username when the host or inherited username is empty", () => {
  const { snapshot, host } = fixture(); host.username = "";
  snapshot.productivity!.connectionProfiles = [{ ...emptyConnectionProfile(host.id), identityId: "identity" }];
  expect(resolveConnectionProfile(snapshot, host).host.username).toBe("identity-user");
  snapshot.productivity!.connectionProfiles[0].inheritUsername = true;
  snapshot.productivity!.groupDefaults![1].username = "";
  expect(resolveConnectionProfile(snapshot, host).host.username).toBe("identity-user");
});
it("rejects deleted identity references and duplicate host configuration before saving", () => {
  const { snapshot } = fixture(); snapshot.productivity!.identities = [];
  expect(() => parseAppSnapshot(snapshot)).toThrow(/referencias inválidas/);
  const next = fixture().snapshot; next.productivity!.connectionProfiles!.push({ ...next.productivity!.connectionProfiles![0] });
  expect(() => parseAppSnapshot(next)).toThrow();
});
it("falls back to the host's own values when its group has no defaults", () => {
  const { snapshot, host } = fixture(); snapshot.productivity!.groupDefaults = [];
  Object.assign(snapshot.productivity!.connectionProfiles![0], { identityId: "identity", keepaliveSeconds: 60 });
  const result = resolveConnectionProfile(snapshot, host);
  expect(result.host.username).toBe("own-user"); expect(result.host.port).toBe(22); expect(result.identity?.id).toBe("identity"); expect(result.keepaliveSeconds).toBe(60);
});
