import { z } from "zod";
import { LOCAL_POWERSHELL_ID } from "./sessionTarget";
import type { AppSnapshot } from "../types";
import { productivitySchema, connectionProfileSchema } from "./productivityValidation";
import { connectionRoute } from "./sshRoute";

const text = (min: number, max: number) => z.string().min(min).max(max).refine(value => !value.includes("\0"), "No se permiten caracteres nulos");
const id = text(1, 200);
const timestamp = text(1, 100);

const vaultSchema = z.object({
  id,
  name: text(1, 160).refine(value => Boolean(value.trim()), "El nombre es obligatorio"),
  description: text(0, 4_096),
  color: text(1, 64),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

const groupSchema = z.object({
  id,
  vaultId: id,
  parentId: id.nullable(),
  name: text(1, 160).refine(value => Boolean(value.trim()), "El nombre es obligatorio"),
  sortOrder: z.number().int(),
}).strict();

const hostSchema = z.object({
  protocol: z.enum(["ssh", "telnet"]).default("ssh"),
  id,
  vaultId: id,
  groupId: id.nullable(),
  name: text(1, 160).refine(value => Boolean(value.trim()), "El nombre es obligatorio"),
  address: text(1, 512).refine(value => Boolean(value.trim()), "La dirección es obligatoria"),
  port: z.number().int().min(1).max(65_535),
  username: text(0, 256),
  authMethod: z.enum(["password", "private_key", "system_agent"]),
  keyPath: text(0, 1_024).nullable(),
  favorite: z.boolean(),
  color: text(1, 64),
  tags: z.array(text(0, 160)).max(100),
  note: text(0, 65_536),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

const knownHostSchema = z.object({
  id,
  hostId: id,
  algorithm: text(1, 160),
  fingerprint: text(1, 512),
  publicKey: text(1, 65_536),
  trustedAt: timestamp,
}).strict();

export const temporaryHostSchema = z.object({ host: hostSchema, connection: connectionProfileSchema, knownHost: knownHostSchema.nullable() }).strict()
  .refine(value => value.host.id === value.connection.hostId && (!value.knownHost || value.knownHost.hostId === value.host.id), "Referencias de conexión temporal no válidas");

export const appSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  vaults: z.array(vaultSchema).length(1),
  groups: z.array(groupSchema).max(10_000),
  hosts: z.array(hostSchema).max(10_000),
  knownHosts: z.array(knownHostSchema).max(10_000),
  productivity: productivitySchema.default({ workspaces: [], snippets: [], identities: [], connectionProfiles: [], groupDefaults: [], tunnels: [] }),
}).strict().superRefine((snapshot, context) => {
  const vaultIds = new Set(snapshot.vaults.map((vault) => vault.id));
  if ([...snapshot.productivity.workspaces, ...snapshot.productivity.snippets, ...snapshot.productivity.identities].some(item => !vaultIds.has(item.vaultId))) context.addIssue({ code: "custom", message: "Un elemento pertenece a otra bóveda" });
  const groupIds = new Set(snapshot.groups.map((group) => group.id));
  const groupsById = new Map(snapshot.groups.map((group) => [group.id, group]));
  const hostIds = new Set(snapshot.hosts.map((host) => host.id));
  if (snapshot.productivity.tunnels.some(profile => !hostIds.has(profile.hostId))) context.addIssue({ code: "custom", message: "El túnel contiene un host inexistente" });
  if (hostIds.has(LOCAL_POWERSHELL_ID)) context.addIssue({ code: "custom", message: "El identificador de la terminal local está reservado" });
  for (const workspace of snapshot.productivity.workspaces) {
    if (!workspace.files) continue;
    for (const location of [workspace.files.left, workspace.files.right]) {
      if (location.kind === "host" && snapshot.hosts.some(host => host.id === location.hostId && host.vaultId !== workspace.vaultId)) context.addIssue({ code: "custom", message: "Una ubicación SFTP pertenece a otra bóveda" });
    }
  }
  const identityIds = new Set(snapshot.productivity.identities.map(item => item.id));
  for (const profile of snapshot.productivity.connectionProfiles) {
    try { connectionRoute(snapshot, profile.hostId); }
    catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) }); }
  }
  if (snapshot.hosts.some(host => host.id.startsWith("identity:")) || snapshot.productivity.connectionProfiles.some(profile => !hostIds.has(profile.hostId) || profile.identityId !== null && !identityIds.has(profile.identityId)) || snapshot.productivity.groupDefaults.some(group => !groupIds.has(group.groupId) || group.identityId !== null && !identityIds.has(group.identityId))) context.addIssue({ code: "custom", message: "La configuración de conexión contiene referencias inválidas" });
  if (vaultIds.size !== snapshot.vaults.length || groupIds.size !== snapshot.groups.length || hostIds.size !== snapshot.hosts.length) {
    context.addIssue({ code: "custom", message: "Hay identificadores duplicados" });
  }
  for (const group of snapshot.groups) {
    if (!vaultIds.has(group.vaultId) || (group.parentId !== null && (!groupIds.has(group.parentId) || group.parentId === group.id))) {
      context.addIssue({ code: "custom", message: `El grupo ${group.name} contiene referencias inválidas` });
    }
    const visited = new Set<string>();
    let current: string | null = group.id;
    while (current !== null) {
      if (visited.has(current)) {
        context.addIssue({ code: "custom", message: "La jerarquía de grupos contiene un ciclo" });
        break;
      }
      visited.add(current);
      current = groupsById.get(current)?.parentId ?? null;
    }
  }
  for (const host of snapshot.hosts) {
    if (!vaultIds.has(host.vaultId) || (host.groupId !== null && !groupIds.has(host.groupId))) {
      context.addIssue({ code: "custom", message: `El host ${host.name} contiene referencias inválidas` });
    }
  }
  const knownIds = new Set(snapshot.knownHosts.map(known => known.id));
  const knownPairs = new Set(snapshot.knownHosts.map(known => JSON.stringify([known.hostId, known.algorithm])));
  if (knownIds.size !== snapshot.knownHosts.length || knownPairs.size !== snapshot.knownHosts.length) context.addIssue({ code: "custom", message: "Hay huellas duplicadas" });
  if (snapshot.knownHosts.some((known) => !hostIds.has(known.hostId))) {
    context.addIssue({ code: "custom", message: "Una huella no pertenece a un host válido" });
  }
});

export function parseAppSnapshot(value: unknown): AppSnapshot {
  const result = appSnapshotSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Los datos guardados no son válidos: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
