import type { AppSnapshot, HostDraft } from "./types";

export const COLORS = ["#8b7cf6", "#2dd4bf", "#60a5fa", "#f59e0b", "#f472b6", "#fb7185"];

export function createId(): string {
  return crypto.randomUUID();
}

export function createInitialSnapshot(): AppSnapshot {
  const now = new Date().toISOString();
  const vaultId = createId();
  const productionId = createId();
  const developmentId = createId();

  return {
    schemaVersion: 1,
    vaults: [
      {
        id: vaultId,
        name: "Mi bóveda",
        description: "Tus accesos SSH, organizados y protegidos.",
        color: COLORS[0],
        createdAt: now,
        updatedAt: now,
      },
    ],
    groups: [
      { id: productionId, vaultId, parentId: null, name: "Producción", sortOrder: 0 },
      { id: developmentId, vaultId, parentId: null, name: "Desarrollo", sortOrder: 1 },
    ],
    hosts: [],
    knownHosts: [],
    productivity: { workspaces: [], snippets: [], identities: [], connectionProfiles: [], groupDefaults: [], tunnels: [] },
  };
}

export function emptyHostDraft(vaultId: string, groupId: string | null = null): HostDraft {
  return {
    vaultId,
    groupId,
    name: "",
    address: "",
    port: 22,
    username: "",
    authMethod: "password",
    keyPath: null,
    favorite: false,
    color: COLORS[1],
    tags: [],
    note: "",
  };
}
