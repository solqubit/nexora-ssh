import { z } from "zod";
const text = (min: number, max: number) => z.string().min(min).max(max).refine(value => !value.includes("\0"));
const id = text(1, 200);
const remotePath = text(1, 4096).refine(value => value.startsWith("/"), "La ruta remota debe ser absoluta").nullable();
export const fileLocationSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("local"), path: text(1, 4096).nullable() }).strict(), z.object({ kind: z.literal("host"), hostId: id, path: remotePath }).strict()]);
export const fileLayoutSchema = z.object({ left: fileLocationSchema, right: fileLocationSchema, splitRatio: z.number().min(30).max(70) }).strict();
export const identitySchema = z.object({ id, vaultId: id, name: text(1, 160).refine(value => Boolean(value.trim())), username: text(0, 256), authMethod: z.enum(["password", "private_key", "system_agent"]), updatedAt: text(1, 80) }).strict();
const keepalive = z.number().int().min(0).max(300).nullable();
export const connectionProfileSchema = z.object({ hostId: id, identityId: id.nullable(), inheritUsername: z.boolean(), inheritPort: z.boolean(), inheritIdentity: z.boolean(), inheritKeepalive: z.boolean(), keepaliveSeconds: keepalive, jumpHostId: id.nullable().optional(), environment: text(1, 60).refine(value => Boolean(value.trim())).nullable().optional(), tmuxSession: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/, "Usa de 1 a 80 letras, números, guiones o guiones bajos; comienza con letra o número").nullable().optional() }).strict();
export const groupDefaultsSchema = z.object({ groupId: id, username: text(0, 256).nullable(), port: z.number().int().min(1).max(65535).nullable(), identityId: id.nullable(), keepaliveSeconds: keepalive }).strict();
export function tunnelListenIsLoopback(address: string): boolean {
  if (/^127\./.test(address)) return true;
  try { return new URL(`http://[${address}]/`).hostname === "[::1]"; } catch { return false; }
}
const tunnelText = (min: number, max: number) => text(min, max).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const tunnelProfileSchema = z.object({ id: tunnelText(1, 200), hostId: tunnelText(1, 200), name: tunnelText(1, 160).refine(value => Boolean(value.trim())), kind: z.enum(["local", "remote", "socks"]), listenAddress: z.union([z.ipv4(), z.ipv6()]), listenPort: z.number().int().min(0).max(65535), targetAddress: tunnelText(1, 253).refine(value => !/\s/.test(value)).nullable(), targetPort: z.number().int().min(1).max(65535).nullable(), updatedAt: tunnelText(1, 80) }).strict().superRefine((profile, context) => {
  if (profile.kind === "socks") {
    if (!tunnelListenIsLoopback(profile.listenAddress)) context.addIssue({ code: "custom", message: "El proxy SOCKS sin contraseña solo puede escuchar en loopback", path: ["listenAddress"] });
    if (profile.targetAddress !== null || profile.targetPort !== null) context.addIssue({ code: "custom", message: "SOCKS no utiliza un destino fijo" });
  } else if (!profile.targetAddress || profile.targetPort === null) context.addIssue({ code: "custom", message: "Configura la dirección y el puerto de destino" });
});
export const tunnelStateSchema = z.object({ profile: tunnelProfileSchema, status: z.enum(["connecting", "active", "stopping", "stopped", "trust_required", "error"]), message: z.string().nullable(), listenPort: z.number().int().min(1).max(65535).nullable(), lastError: z.string().nullable(), trust: z.object({ hostId: id, kind: z.enum(["unknown", "changed"]), address: z.string(), algorithm: z.string(), fingerprint: z.string(), challengeId: id.nullable() }).strict().nullable() }).strict();
export const workspaceSchema = z.object({
  id, name: text(1, 160).refine(value => Boolean(value.trim())), vaultId: id,
  sessions: z.array(z.object({ hostId: id, title: text(1, 160), pinned: z.boolean() }).strict()).min(1).max(100),
  paneIndices: z.array(z.number().int().nonnegative()).max(4), layout: z.enum(["columns", "rows", "grid"]), splitRatio: z.number().min(20).max(80), updatedAt: text(1, 80),
  files: fileLayoutSchema.nullable().optional(),
}).strict().refine(value => new Set(value.paneIndices).size === value.paneIndices.length && value.paneIndices.every(index => index < value.sessions.length), "Distribución inválida");
export const snippetSchema = z.object({ id, vaultId: id, name: text(1, 160).refine(value => Boolean(value.trim())), category: text(0, 160), description: text(0, 2000), shell: z.enum(["posix", "powershell"]).optional(), command: text(1, 32000).refine(value => !value.includes("\x1b"), "El comando contiene escapes de terminal"), updatedAt: text(1, 80) }).strict();
export const productivitySchema = z.object({ workspaces: z.array(workspaceSchema).max(100), snippets: z.array(snippetSchema).max(1000), identities: z.array(identitySchema).max(1000).default([]), connectionProfiles: z.array(connectionProfileSchema).max(10000).default([]), groupDefaults: z.array(groupDefaultsSchema).max(10000).default([]), tunnels: z.array(tunnelProfileSchema).max(1000).default([]) }).strict().refine(value => new Set(value.workspaces.map(item => item.id)).size === value.workspaces.length && new Set(value.snippets.map(item => item.id)).size === value.snippets.length && new Set(value.identities.map(item => item.id)).size === value.identities.length && new Set(value.connectionProfiles.map(item => item.hostId)).size === value.connectionProfiles.length && new Set(value.groupDefaults.map(item => item.groupId)).size === value.groupDefaults.length && new Set(value.tunnels.map(item => item.id)).size === value.tunnels.length, "Hay identificadores duplicados");
