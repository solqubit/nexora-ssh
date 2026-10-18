import type { AppSnapshot, Host } from "../types";

export function connectionRoute(snapshot: AppSnapshot, hostId: string): Host[] {
  const target = snapshot.hosts.find(host => host.id === hostId);
  if (!target) throw new Error("El destino SSH ya no existe.");
  let current: string | null = hostId;
  const route: Host[] = [], visited = new Set<string>();
  while (current) {
    if (visited.has(current)) throw new Error("La ruta de salto contiene un ciclo.");
    if (route.length >= 9) throw new Error("La ruta admite hasta ocho hosts de salto.");
    const hop = snapshot.hosts.find(host => host.id === current);
    if (!hop) throw new Error("Un host de salto ya no existe; revisa la configuración del destino.");
    if (hop.vaultId !== target.vaultId) throw new Error("Los hosts de salto deben pertenecer a la misma bóveda.");
    visited.add(current); route.push(hop);
    current = snapshot.productivity?.connectionProfiles?.find(profile => profile.hostId === current)?.jumpHostId ?? null;
  }
  return route.reverse();
}

export function assertHostsRemovable(snapshot: AppSnapshot, ids: string[]): void {
  const dependencies = snapshot.productivity?.connectionProfiles?.filter(profile => profile.jumpHostId && ids.includes(profile.jumpHostId) && !ids.includes(profile.hostId)) ?? [];
  if (dependencies.length) throw new Error(`Reconfigura el host de salto de ${dependencies.map(profile => snapshot.hosts.find(host => host.id === profile.hostId)?.name ?? profile.hostId).join(", ")} antes de eliminarlo.`);
}
