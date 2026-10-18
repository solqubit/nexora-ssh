import { Channel, invoke } from "@tauri-apps/api/core";
import { createInitialSnapshot, createId } from "../data";
import { connectionProfileSchema, tunnelStateSchema } from "./productivityValidation";
import type { TunnelState } from "../types";
import type { Host, ConnectionProfile, TemporaryHost } from "../types";
import { parseAppSnapshot, temporaryHostSchema } from "./validation";
import type { AppSnapshot, KnownHost, LocalDirectory, PreparedFileDrag, SecretStatus, SecretUpdate, SftpConnectResponse, SftpDirectory, SftpUploadResponse, SshEvent, TransferProgressEvent, TransferResponse, RemoteTextDocument, SaveRemoteTextResponse } from "../types";

const WEB_STORAGE_KEY = "nexora.snapshot.v1";

export interface VaultInfo { folder: string; name: string }
export async function vaultInfo(): Promise<VaultInfo | null> {
  return isTauri() ? invoke("vault_info") : null;
}
export async function chooseVaultFolder(): Promise<string | null> {
  if (!isTauri()) throw new Error("Selecciona la carpeta desde la aplicación de escritorio. Esta es una vista previa web.");
  return invoke("choose_vault_folder");
}
export async function unlockVault(folder: string, name: string | null, password: string): Promise<VaultInfo> {
  if (!isTauri()) throw new Error("Las bóvedas por carpeta requieren la aplicación de escritorio.");
  return invoke("unlock_vault", { folder, name, password });
}
export async function closeVault(): Promise<void> { if (isTauri()) await invoke("close_vault"); }

const VAULT_VIEWS_KEY = "nexora.vault-views.v1";
let activeViewFolder: string | null = null;
export function persistVaultViewState(): void {
  if (!activeViewFolder) return;
  try {
    const saved = JSON.parse(localStorage.getItem(VAULT_VIEWS_KEY) ?? "{}") as Record<string, Record<string, string>>;
    saved[activeViewFolder] = Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith("nexora.") && !key.startsWith("nexora.preferences") && key !== VAULT_VIEWS_KEY && key !== WEB_STORAGE_KEY).map(key => [key, localStorage.getItem(key)!]));
    localStorage.setItem(VAULT_VIEWS_KEY, JSON.stringify(saved));
  } catch { /* Optional UI state must never prevent closing a vault. */ }
}
export function restoreVaultViewState(folder: string): void {
  if (activeViewFolder === folder) return;
  clearVaultViewState();
  try {
    const saved = JSON.parse(localStorage.getItem(VAULT_VIEWS_KEY) ?? "{}") as Record<string, Record<string, string>>;
    for (const [key, value] of Object.entries(saved[folder] ?? {})) if (key.startsWith("nexora.") && key !== VAULT_VIEWS_KEY && key !== WEB_STORAGE_KEY && !key.startsWith("nexora.preferences") && typeof value === "string") localStorage.setItem(key, value);
  } catch { /* A corrupt UI cache does not affect the native vault. */ }
  activeViewFolder = folder;
}
export function clearVaultViewState(): void {
  persistVaultViewState(); activeViewFolder = null;
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("nexora.") && !key.startsWith("nexora.preferences") && key !== VAULT_VIEWS_KEY) localStorage.removeItem(key);
  }
  webSecretStatuses.clear(); webTemporaryHosts.clear();
}
const webSecretStatuses = new Map<string, SecretStatus>();
const webTemporaryHosts = new Map<string, TemporaryHost>();

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function readWebSnapshot(): AppSnapshot {
  const saved = localStorage.getItem(WEB_STORAGE_KEY);
  if (!saved) return createInitialSnapshot();
  try {
    return parseAppSnapshot(JSON.parse(saved));
  } catch {
    return createInitialSnapshot();
  }
}

export async function loadSnapshot(): Promise<AppSnapshot> {
  if (!isTauri()) return readWebSnapshot();
  return parseAppSnapshot(await invoke<unknown>("load_snapshot"));
}
export async function listTunnels(): Promise<TunnelState[]> { return isTauri() ? tunnelStateSchema.array().max(1000).parse(await invoke("list_tunnels")) : []; }
export async function startTunnel(id: string, keepaliveSeconds: number): Promise<void> {
  if (!isTauri()) throw new Error("Los túneles SSH requieren la aplicación de escritorio Nexora.");
  await invoke("start_tunnel", { id, keepaliveSeconds });
}
export async function stopTunnel(id: string): Promise<void> { if (isTauri()) await invoke("stop_tunnel", { id }); }
export async function stopAllTunnels(): Promise<void> { if (isTauri()) await invoke("stop_all_tunnels"); }

export async function loadTemporaryHosts(): Promise<TemporaryHost[]> {
  if (!isTauri()) return [...webTemporaryHosts.values()];
  return temporaryHostSchema.array().max(100).parse(await invoke<unknown>("load_temporary_hosts"));
}

export async function persistSnapshot(snapshot: AppSnapshot, expectedSnapshot: AppSnapshot): Promise<void> {
  if (!isTauri()) {
    localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(parseAppSnapshot(snapshot)));
    return;
  }
  for (const profile of expectedSnapshot.productivity?.tunnels ?? []) {
    const next = snapshot.productivity?.tunnels?.find(item => item.id === profile.id);
    if (JSON.stringify(next) !== JSON.stringify(profile) || !snapshot.hosts.some(host => host.id === profile.hostId)) await stopTunnel(profile.id);
  }
  await invoke("save_snapshot", { snapshot, expectedSnapshot });
}

export async function persistHostProfile(snapshot: AppSnapshot, hostId: string, update: SecretUpdate, expectedSnapshot: AppSnapshot): Promise<SecretStatus> {
  if (!isTauri()) {
    localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(parseAppSnapshot(snapshot)));
    return updateWebSecretStatus(hostId, update);
  }
  return invoke<SecretStatus>("save_host_profile", { snapshot, hostId, update, expectedSnapshot });
}

export async function createTemporaryHost(host: Host, connection: ConnectionProfile, update: SecretUpdate, expectedSnapshot: AppSnapshot): Promise<TemporaryHost> {
  if (!isTauri()) {
    if (webTemporaryHosts.size >= 100) throw new Error("Guarda u olvida una conexión temporal antes de crear otra.");
    const temporary = { host: { ...host, id: createId() }, connection, knownHost: null };
    temporary.connection = { ...connectionProfileSchema.parse(connection), hostId: temporary.host.id };
    parseAppSnapshot({ ...expectedSnapshot, hosts: [...expectedSnapshot.hosts, temporary.host], productivity: { workspaces: [], snippets: [], ...expectedSnapshot.productivity, connectionProfiles: [...(expectedSnapshot.productivity?.connectionProfiles ?? []), temporary.connection] } });
    await updateWebSecretStatus(temporary.host.id, update);
    webTemporaryHosts.set(temporary.host.id, temporary); return temporary;
  }
  return temporaryHostSchema.parse(await invoke<unknown>("create_temporary_host", { host, connection, update, expectedSnapshot }));
}

export async function promoteTemporaryHost(hostId: string, name: string, groupId: string | null, expectedSnapshot: AppSnapshot): Promise<AppSnapshot> {
  if (!isTauri()) {
    const temporary = webTemporaryHosts.get(hostId); if (!temporary) throw new Error("La conexión temporal ya no existe.");
    const snapshot = parseAppSnapshot({ ...expectedSnapshot, hosts: [...expectedSnapshot.hosts, { ...temporary.host, name: name.trim(), groupId, updatedAt: new Date().toISOString() }], productivity: { workspaces: [], snippets: [], ...expectedSnapshot.productivity, connectionProfiles: [...(expectedSnapshot.productivity?.connectionProfiles ?? []), temporary.connection] } });
    await persistSnapshot(snapshot, expectedSnapshot); webTemporaryHosts.delete(hostId); return snapshot;
  }
  return parseAppSnapshot(await invoke<unknown>("promote_temporary_host", { hostId, name, groupId, expectedSnapshot }));
}

export async function forgetTemporaryHost(hostId: string): Promise<void> {
  if (!isTauri()) { if (webTemporaryHosts.delete(hostId)) webSecretStatuses.delete(hostId); return; }
  await invoke("forget_temporary_host", { hostId });
}

export async function persistDuplicatedHost(snapshot: AppSnapshot, sourceHostId: string, targetHostId: string, expectedSnapshot: AppSnapshot): Promise<SecretStatus> {
  if (!isTauri()) {
    localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(parseAppSnapshot(snapshot)));
    return duplicateWebSecretStatus(sourceHostId, targetHostId);
  }
  return invoke<SecretStatus>("save_duplicated_host", { snapshot, sourceHostId, targetHostId, expectedSnapshot });
}

export async function getSecretStatus(hostId: string): Promise<SecretStatus> {
  if (!isTauri()) return webSecretStatuses.get(hostId) ?? { hasPassword: false, hasPrivateKey: false, privateKeyName: null, hasKeyPassphrase: false };
  return invoke<SecretStatus>("get_secret_status", { hostId });
}

export async function getIdentityStatus(identityId: string): Promise<SecretStatus> {
  if (!isTauri()) return webSecretStatuses.get(`identity:${identityId}`) ?? { hasPassword: false, hasPrivateKey: false, privateKeyName: null, hasKeyPassphrase: false };
  return invoke<SecretStatus>("get_identity_status", { identityId });
}
export async function persistIdentityProfile(snapshot: AppSnapshot, identityId: string, update: SecretUpdate, expectedSnapshot: AppSnapshot): Promise<SecretStatus> {
  if (!isTauri()) { localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(parseAppSnapshot(snapshot))); return updateWebSecretStatus(`identity:${identityId}`, update); }
  return invoke<SecretStatus>("save_identity_profile", { snapshot, identityId, update, expectedSnapshot });
}

export async function revealHostPassword(hostId: string): Promise<string | null> {
  if (!isTauri()) throw new Error("La contraseña solo puede revelarse en la aplicación de escritorio.");
  return invoke<string | null>("reveal_host_password", { hostId });
}

async function updateWebSecretStatus(hostId: string, update: SecretUpdate): Promise<SecretStatus> {
  const previous = await getSecretStatus(hostId);
  const next: SecretStatus = {
    hasPassword: Boolean(update.password) || (!update.clearPassword && previous.hasPassword),
    hasPrivateKey: Boolean(update.privateKey) || (!update.clearPrivateKey && previous.hasPrivateKey),
    privateKeyName: update.privateKey ? update.privateKeyName : update.clearPrivateKey ? null : previous.privateKeyName,
    hasKeyPassphrase: Boolean(update.keyPassphrase) || (!update.clearPrivateKey && previous.hasKeyPassphrase),
  };
  webSecretStatuses.set(hostId, next);
  return next;
}

async function duplicateWebSecretStatus(sourceHostId: string, targetHostId: string): Promise<SecretStatus> {
  const status = await getSecretStatus(sourceHostId);
  webSecretStatuses.set(targetHostId, { ...status });
  return status;
}

export async function startSshSession(
  sessionId: string,
  hostId: string,
  columns: number,
  rows: number,
  keepaliveSeconds: number,
  onEvent: (event: SshEvent) => void,
): Promise<void> {
  if (!isTauri()) throw new Error("Las conexiones SSH reales están disponibles en la aplicación de escritorio.");
  const channel = new Channel<SshEvent>();
  channel.onmessage = onEvent;
  await invoke("start_ssh_session", { sessionId, hostId, columns, rows, keepaliveSeconds, onEvent: channel });
}

export async function writeSshSession(sessionId: string, data: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("write_ssh_session", { sessionId, data });
}

export async function resizeSshSession(sessionId: string, columns: number, rows: number): Promise<void> {
  if (!isTauri()) return;
  await invoke("resize_ssh_session", { sessionId, columns, rows });
}

export async function startLocalSession(sessionId: string, columns: number, rows: number, onEvent: (event: SshEvent) => void): Promise<void> {
  if (!isTauri()) throw new Error("PowerShell local está disponible en la aplicación de escritorio.");
  const channel = new Channel<SshEvent>(); channel.onmessage = onEvent;
  await invoke("start_local_session", { sessionId, columns, rows, onEvent: channel });
}

export async function disconnectSshSession(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("disconnect_ssh_session", { sessionId });
}

export async function trustSshHostKey(hostId: string, challengeId: string | null, replace = false): Promise<KnownHost> {
  if (!isTauri()) throw new Error("La verificación de huellas requiere la aplicación de escritorio.");
  if (!challengeId) throw new Error("La verificación caducó. Vuelve a conectar.");
  return invoke<KnownHost>("trust_ssh_host_key", { hostId, challengeId, replace });
}

function requireDesktopSftp(): void {
  if (!isTauri()) throw new Error("SFTP está disponible en la aplicación de escritorio.");
}

export async function connectSftp(hostId: string, path: string | null, keepaliveSeconds: number): Promise<SftpConnectResponse> {
  requireDesktopSftp();
  return invoke<SftpConnectResponse>("connect_sftp", { hostId, path, keepaliveSeconds });
}

export async function disconnectSftp(hostId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("disconnect_sftp", { hostId });
}

export async function listSftpDirectory(hostId: string, path: string): Promise<SftpDirectory> {
  requireDesktopSftp();
  return invoke<SftpDirectory>("list_sftp_directory", { hostId, path });
}

export async function readSftpTextFile(hostId: string, path: string): Promise<RemoteTextDocument> {
  requireDesktopSftp(); return invoke("read_sftp_text_file", { hostId, path });
}
export async function saveSftpTextFile(hostId: string, path: string, expectedRevision: string, text: string): Promise<SaveRemoteTextResponse> {
  requireDesktopSftp(); return invoke("save_sftp_text_file", { hostId, path, expectedRevision, text });
}

export async function createSftpDirectory(hostId: string, parentPath: string, name: string): Promise<SftpDirectory> {
  requireDesktopSftp();
  return invoke<SftpDirectory>("create_sftp_directory", { hostId, parentPath, name });
}

export async function createSftpFile(hostId: string, parentPath: string, name: string): Promise<SftpDirectory> {
  requireDesktopSftp();
  return invoke<SftpDirectory>("create_sftp_file", { hostId, parentPath, name });
}

export async function renameSftpEntry(hostId: string, path: string, newName: string): Promise<SftpDirectory> {
  requireDesktopSftp();
  return invoke<SftpDirectory>("rename_sftp_entry", { hostId, path, newName });
}

export async function deleteSftpEntry(hostId: string, path: string, isDirectory: boolean, recursive = false): Promise<SftpDirectory> {
  requireDesktopSftp();
  return invoke<SftpDirectory>("delete_sftp_entry", { hostId, path, isDirectory, recursive });
}

export async function chmodSftpEntry(hostId: string, path: string, mode: number): Promise<SftpDirectory> {
  requireDesktopSftp();
  return invoke<SftpDirectory>("chmod_sftp_entry", { hostId, path, mode });
}

export async function uploadSftpFile(hostId: string, remoteDirectory: string): Promise<SftpUploadResponse> {
  requireDesktopSftp();
  return invoke<SftpUploadResponse>("upload_sftp_file", { hostId, remoteDirectory });
}

export async function overwriteSftpFile(hostId: string, uploadToken: string): Promise<SftpUploadResponse> {
  requireDesktopSftp();
  return invoke<SftpUploadResponse>("overwrite_sftp_file", { hostId, uploadToken });
}

export async function downloadSftpFile(hostId: string, remotePath: string): Promise<string | null> {
  requireDesktopSftp();
  return invoke<string | null>("download_sftp_file", { hostId, remotePath });
}

export async function listLocalDirectory(path: string | null = null): Promise<LocalDirectory> {
  requireDesktopSftp();
  return invoke<LocalDirectory>("list_local_directory", { path });
}

export async function createLocalDirectory(parentPath: string, name: string): Promise<LocalDirectory> {
  requireDesktopSftp();
  return invoke<LocalDirectory>("create_local_directory", { parentPath, name });
}

export async function createLocalFile(parentPath: string, name: string): Promise<LocalDirectory> {
  requireDesktopSftp();
  return invoke<LocalDirectory>("create_local_file", { parentPath, name });
}

export async function renameLocalEntry(path: string, newName: string): Promise<LocalDirectory> {
  requireDesktopSftp();
  return invoke<LocalDirectory>("rename_local_entry", { path, newName });
}

export async function deleteLocalEntry(path: string, isDirectory: boolean, recursive = false): Promise<LocalDirectory> {
  requireDesktopSftp();
  return invoke<LocalDirectory>("delete_local_entry", { path, isDirectory, recursive });
}

function transferProgressChannel(onProgress: (event: TransferProgressEvent) => void): Channel<TransferProgressEvent> {
  const channel = new Channel<TransferProgressEvent>();
  channel.onmessage = onProgress;
  return channel;
}

export async function transferLocalToSftp(hostId: string, localPath: string, remoteDirectory: string, overwrite: boolean, targetName: string | null, transferId: string, onProgress: (event: TransferProgressEvent) => void): Promise<TransferResponse> {
  requireDesktopSftp();
  return invoke<TransferResponse>("transfer_local_to_sftp", { hostId, localPath, remoteDirectory, overwrite, targetName, transferId, onProgress: transferProgressChannel(onProgress) });
}

export async function transferSftpToLocal(hostId: string, remotePath: string, localDirectory: string, overwrite: boolean, targetName: string | null, transferId: string, onProgress: (event: TransferProgressEvent) => void): Promise<TransferResponse> {
  requireDesktopSftp();
  return invoke<TransferResponse>("transfer_sftp_to_local", { hostId, remotePath, localDirectory, overwrite, targetName, transferId, onProgress: transferProgressChannel(onProgress) });
}

export async function transferSftpToSftp(sourceHostId: string, remotePath: string, targetHostId: string, remoteDirectory: string, overwrite: boolean, targetName: string | null, transferId: string, onProgress: (event: TransferProgressEvent) => void): Promise<TransferResponse> {
  requireDesktopSftp();
  return invoke<TransferResponse>("transfer_sftp_to_sftp", { sourceHostId, remotePath, targetHostId, remoteDirectory, overwrite, targetName, transferId, onProgress: transferProgressChannel(onProgress) });
}

export async function copyLocalEntry(localPath: string, localDirectory: string, overwrite: boolean, targetName: string | null, transferId: string, onProgress: (event: TransferProgressEvent) => void): Promise<TransferResponse> {
  requireDesktopSftp();
  return invoke<TransferResponse>("copy_local_entry", { localPath, localDirectory, overwrite, targetName, transferId, onProgress: transferProgressChannel(onProgress) });
}

export async function cancelFileTransfer(transferId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("cancel_file_transfer", { transferId });
}

export async function prepareFileDrag(hostId: string | null, paths: string[]): Promise<PreparedFileDrag> {
  requireDesktopSftp();
  return invoke<PreparedFileDrag>("prepare_file_drag", { hostId, paths });
}

export async function cleanupPreparedDrag(stagingRoot: string): Promise<void> {
  requireDesktopSftp();
  await invoke("cleanup_prepared_drag", { stagingRoot });
}

export async function startFileDrag(paths: string[], iconPath: string): Promise<void> {
  requireDesktopSftp();
  await invoke("start_file_drag", { paths, iconPath });
}

/**
 * El portapapeles pasa por el plugin nativo: `navigator.clipboard` haría que
 * WebView2 pidiera permiso como si fuera una página web.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (!isTauri()) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
  await writeText(text);
}

export async function readFromClipboard(): Promise<string> {
  if (!isTauri()) return navigator.clipboard.readText();
  const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
  return (await readText()) ?? "";
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("open_external_url", { url });
}
