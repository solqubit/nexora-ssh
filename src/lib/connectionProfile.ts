import type { AppSnapshot, ConnectionProfile, GroupDefaults, Host } from "../types";
export const emptyConnectionProfile = (hostId: string): ConnectionProfile => ({ hostId, identityId: null, inheritUsername: false, inheritPort: false, inheritIdentity: false, inheritKeepalive: false, keepaliveSeconds: null });
export function resolveConnectionProfile(snapshot: AppSnapshot, host: Host, defaultKeepalive = 30) {
  const data = snapshot.productivity;
  const profile = data?.connectionProfiles?.find(item => item.hostId === host.id) ?? emptyConnectionProfile(host.id);
  const inherited: GroupDefaults = { groupId: host.groupId ?? "", username: null, port: null, identityId: null, keepaliveSeconds: null };
  const seen = new Set<string>(); let groupId = host.groupId;
  while (groupId && !seen.has(groupId)) {
    seen.add(groupId); const value = data?.groupDefaults?.find(item => item.groupId === groupId);
    if (value) { inherited.username ??= value.username; inherited.port ??= value.port; inherited.identityId ??= value.identityId; inherited.keepaliveSeconds ??= value.keepaliveSeconds; }
    groupId = snapshot.groups.find(group => group.id === groupId)?.parentId ?? null;
  }
  const identityId = profile.inheritIdentity ? inherited.identityId ?? profile.identityId : profile.identityId;
  const identity = host.protocol === "telnet" ? undefined : data?.identities?.find(item => item.id === identityId);
  const username = profile.inheritUsername ? inherited.username ?? host.username : host.username;
  return { host: { ...host, username: username || identity?.username || "", port: profile.inheritPort ? inherited.port ?? host.port : host.port, authMethod: identity?.authMethod ?? host.authMethod }, identity, profile, inherited, keepaliveSeconds: profile.inheritKeepalive ? inherited.keepaliveSeconds ?? profile.keepaliveSeconds ?? defaultKeepalive : profile.keepaliveSeconds ?? defaultKeepalive };
}
