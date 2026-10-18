export type AuthMethod = "password" | "private_key" | "system_agent";
export type SessionStatus = "connecting" | "connected" | "disconnected" | "trust_required" | "error";

export interface Vault {
  id: string;
  name: string;
  description: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface HostGroup {
  id: string;
  vaultId: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
}

export interface Host {
  protocol?: "ssh" | "telnet";
  id: string;
  vaultId: string;
  groupId: string | null;
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keyPath: string | null;
  favorite: boolean;
  color: string;
  tags: string[];
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnownHost {
  id: string;
  hostId: string;
  algorithm: string;
  fingerprint: string;
  publicKey: string;
  trustedAt: string;
}

export interface AppSnapshot {
  schemaVersion: number;
  vaults: Vault[];
  groups: HostGroup[];
  hosts: Host[];
  knownHosts: KnownHost[];
  productivity?: ProductivityData;
}

export interface Identity { id: string; vaultId: string; name: string; username: string; authMethod: AuthMethod; updatedAt: string }
export interface ConnectionProfile { hostId: string; identityId: string | null; inheritUsername: boolean; inheritPort: boolean; inheritIdentity: boolean; inheritKeepalive: boolean; keepaliveSeconds: number | null; tmuxSession?: string | null; environment?: string | null; jumpHostId?: string | null }
export interface GroupDefaults { groupId: string; username: string | null; port: number | null; identityId: string | null; keepaliveSeconds: number | null }
export interface TemporaryHost { host: Host; connection: ConnectionProfile; knownHost: KnownHost | null }
export interface ProductivityData { workspaces: SavedWorkspace[]; snippets: Snippet[]; identities?: Identity[]; connectionProfiles?: ConnectionProfile[]; groupDefaults?: GroupDefaults[]; tunnels?: TunnelProfile[] }
export interface TunnelProfile { id: string; hostId: string; name: string; kind: "local" | "remote" | "socks"; listenAddress: string; listenPort: number; targetAddress: string | null; targetPort: number | null; updatedAt: string }
export interface TunnelState { profile: TunnelProfile; status: "connecting" | "active" | "stopping" | "stopped" | "trust_required" | "error"; message: string | null; listenPort: number | null; lastError: string | null; trust: { hostId: string; kind: "unknown" | "changed"; address: string; algorithm: string; fingerprint: string; challengeId: string | null } | null }

export interface SessionTab {
  id: string;
  hostId: string;
  title: string;
  status: SessionStatus;
  autoConnect?: boolean;
  pinned?: boolean;
  unread?: boolean;
}

export type TerminalLayout = "columns" | "rows" | "grid";
export type SavedFileLocation = { kind: "local"; path: string | null } | { kind: "host"; hostId: string; path: string | null };
export interface SavedFileLayout { left: SavedFileLocation; right: SavedFileLocation; splitRatio: number }
export interface SavedWorkspace {
  id: string;
  name: string;
  vaultId: string;
  sessions: { hostId: string; title: string; pinned: boolean }[];
  paneIndices: number[];
  layout: TerminalLayout;
  splitRatio: number;
  updatedAt: string;
  files?: SavedFileLayout | null;
}

export interface Snippet {
  id: string;
  vaultId: string;
  name: string;
  category: string;
  description: string;
  command: string;
  updatedAt: string;
  shell?: "posix" | "powershell";
}

export interface HostActivity {
  hostId: string;
  lastAttemptAt: string;
  lastConnectedAt: string | null;
  lastResult: "success" | "error" | null;
  lastMessage: string | null;
  connectionCount: number;
}

export interface HostDraft {
  protocol?: "ssh" | "telnet";
  id?: string;
  vaultId: string;
  groupId: string | null;
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keyPath: string | null;
  favorite: boolean;
  color: string;
  tags: string[];
  note: string;
}

export interface SecretStatus {
  hasPassword: boolean;
  hasPrivateKey: boolean;
  privateKeyName: string | null;
  hasKeyPassphrase: boolean;
}

export interface SecretUpdate {
  password: string | null;
  privateKey: string | null;
  privateKeyName: string | null;
  keyPassphrase: string | null;
  clearPassword: boolean;
  clearPrivateKey: boolean;
}

export type SshEvent =
  | { event: "stage"; data: { phase: "network" | "verification" | "authentication" | "terminal"; message: string } }
  | { event: "output"; data: { data: string } }
  | { event: "status"; data: { status: SessionStatus; message: string | null; retryable?: boolean } }
  | { event: "hostKey"; data: { hostId?: string; kind: "unknown" | "changed"; algorithm: string; fingerprint: string; address: string; challengeId: string | null } };

export interface SftpEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: string | null;
  permissions: string;
  owner: string | null;
}

export interface SftpDirectory {
  path: string;
  entries: SftpEntry[];
}

export interface RemoteTextDocument { path: string; text: string; revision: string }
export type SaveRemoteTextResponse = { status: "saved"; document: RemoteTextDocument; warning: string | null } | { status: "conflict"; document: RemoteTextDocument };

export type SftpConnectResponse =
  | { status: "failed"; message: string; retryable: boolean }
  | { status: "connected"; directory: SftpDirectory }
  | { status: "trust_required"; verificationHostId?: string; algorithm: string; fingerprint: string; address: string; challengeId: string | null }
  | { status: "host_key_changed"; verificationHostId?: string; algorithm: string; fingerprint: string; address: string; challengeId: string | null };

export type SftpUploadResponse =
  | { status: "cancelled" }
  | { status: "conflict"; name: string; path: string; uploadToken: string }
  | { status: "uploaded"; name: string; path: string };

export interface LocalEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: string | null;
}

export interface LocalRoot {
  label: string;
  path: string;
}

export interface LocalBreadcrumb {
  label: string;
  path: string;
}

export interface LocalDirectory {
  path: string;
  parentPath: string | null;
  roots: LocalRoot[];
  breadcrumbs: LocalBreadcrumb[];
  entries: LocalEntry[];
}

export type TransferResponse =
  | { status: "conflict"; name: string; targetPath: string; isDirectory: boolean }
  | { status: "transferred"; name: string; targetPath: string; fileCount: number; totalBytes: number };

export interface TransferProgressEvent {
  transferId: string;
  transferredBytes: number;
  fileCount: number;
  totalBytes: number;
}

export interface PreparedFileDrag {
  paths: string[];
  iconPath: string;
  stagingRoot: string | null;
  estimatedBytes: number;
  availableBytes: number;
}
