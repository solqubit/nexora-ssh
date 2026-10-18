import { emptyHostDraft } from "../data";
import type { AppSnapshot, Host, TemporaryHost } from "../types";
export const LOCAL_POWERSHELL_ID = "local:powershell";
export function localPowerShellHost(vaultId: string): Host {
  return { ...emptyHostDraft(vaultId), id: LOCAL_POWERSHELL_ID, name: "PowerShell", address: "Este equipo", username: "Local", color: "#7198f5", createdAt: "local", updatedAt: "local" };
}
export function sessionTarget(snapshot: AppSnapshot, hostId?: string, temporaryHosts: TemporaryHost[] = []): Host | undefined {
  return hostId === LOCAL_POWERSHELL_ID ? localPowerShellHost(snapshot.vaults[0]?.id ?? "local") : snapshot.hosts.find(host => host.id === hostId) ?? temporaryHosts.find(item => item.host.id === hostId)?.host;
}
export function sessionSnapshot(snapshot: AppSnapshot, temporaryHosts: TemporaryHost[]): AppSnapshot {
  if (!temporaryHosts.length) return snapshot;
  const temporary = temporaryHosts.filter(item => !snapshot.hosts.some(host => host.id === item.host.id));
  return { ...snapshot, hosts: [...snapshot.hosts, ...temporary.map(item => item.host)], knownHosts: [...snapshot.knownHosts, ...temporary.flatMap(item => item.knownHost ? [item.knownHost] : [])], productivity: { workspaces: [], snippets: [], ...snapshot.productivity, connectionProfiles: [...(snapshot.productivity?.connectionProfiles ?? []), ...temporary.map(item => item.connection)] } };
}
export function connectionTargetLabel(host: Host): string {
  return host.id === LOCAL_POWERSHELL_ID ? "Este equipo · PowerShell" : host.protocol === "telnet" ? `${hostEndpointLabel(host)} · TELNET` : `${host.username || "usuario"}@${hostEndpointLabel(host)}`;
}
export function hostEndpointLabel(host: Pick<Host, "address" | "port">): string {
  const address = host.address.includes(":") && !host.address.startsWith("[") ? `[${host.address}]` : host.address;
  return `${address}:${host.port}`;
}
