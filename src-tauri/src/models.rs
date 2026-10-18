use serde::{Deserialize, Serialize};

fn default_protocol() -> String {
    "ssh".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub id: String,
    pub name: String,
    pub description: String,
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGroup {
    pub id: String,
    pub vault_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub sort_order: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    #[serde(default = "default_protocol")]
    pub protocol: String,
    pub id: String,
    pub vault_id: String,
    pub group_id: Option<String>,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub key_path: Option<String>,
    pub favorite: bool,
    pub color: String,
    pub tags: Vec<String>,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub id: String,
    pub host_id: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub public_key: String,
    pub trusted_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub schema_version: u32,
    pub vaults: Vec<Vault>,
    pub groups: Vec<HostGroup>,
    pub hosts: Vec<Host>,
    pub known_hosts: Vec<KnownHost>,
    #[serde(default)]
    pub productivity: ProductivityData,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductivityData {
    pub workspaces: Vec<SavedWorkspace>,
    pub snippets: Vec<Snippet>,
    #[serde(default)]
    pub identities: Vec<Identity>,
    #[serde(default)]
    pub connection_profiles: Vec<ConnectionProfile>,
    #[serde(default)]
    pub group_defaults: Vec<GroupDefaults>,
    #[serde(default)]
    pub tunnels: Vec<TunnelProfile>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TunnelKind {
    Local,
    Remote,
    Socks,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TunnelProfile {
    pub id: String,
    pub host_id: String,
    pub name: String,
    pub kind: TunnelKind,
    pub listen_address: String,
    pub listen_port: u16,
    pub target_address: Option<String>,
    pub target_port: Option<u16>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub id: String,
    pub vault_id: String,
    pub name: String,
    pub username: String,
    pub auth_method: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionProfile {
    pub host_id: String,
    pub identity_id: Option<String>,
    pub inherit_username: bool,
    pub inherit_port: bool,
    pub inherit_identity: bool,
    pub inherit_keepalive: bool,
    pub keepalive_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmux_session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_host_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupDefaults {
    pub group_id: String,
    pub username: Option<String>,
    pub port: Option<u16>,
    pub identity_id: Option<String>,
    pub keepalive_seconds: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSession {
    pub host_id: String,
    pub title: String,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SavedFileLocation {
    Local {
        path: Option<String>,
    },
    Host {
        host_id: String,
        path: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedFileLayout {
    pub left: SavedFileLocation,
    pub right: SavedFileLocation,
    pub split_ratio: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedWorkspace {
    pub id: String,
    pub name: String,
    pub vault_id: String,
    pub sessions: Vec<WorkspaceSession>,
    pub pane_indices: Vec<usize>,
    pub layout: String,
    pub split_ratio: f64,
    pub updated_at: String,
    #[serde(default)]
    pub files: Option<SavedFileLayout>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snippet {
    pub id: String,
    pub vault_id: String,
    pub name: String,
    pub category: String,
    pub description: String,
    pub command: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
}

#[derive(
    Debug, Clone, Default, Serialize, Deserialize, zeroize::Zeroize, zeroize::ZeroizeOnDrop,
)]
#[serde(rename_all = "camelCase")]
pub struct HostSecret {
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub private_key_name: Option<String>,
    pub key_passphrase: Option<String>,
}

impl HostSecret {
    pub fn is_empty(&self) -> bool {
        self.password.as_deref().is_none_or(str::is_empty)
            && self.private_key.as_deref().is_none_or(str::is_empty)
            && self.key_passphrase.as_deref().is_none_or(str::is_empty)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    pub has_password: bool,
    pub has_private_key: bool,
    pub private_key_name: Option<String>,
    pub has_key_passphrase: bool,
}

impl From<&HostSecret> for SecretStatus {
    fn from(secret: &HostSecret) -> Self {
        Self {
            has_password: secret
                .password
                .as_deref()
                .is_some_and(|value| !value.is_empty()),
            has_private_key: secret
                .private_key
                .as_deref()
                .is_some_and(|value| !value.is_empty()),
            private_key_name: secret.private_key_name.clone(),
            has_key_passphrase: secret
                .key_passphrase
                .as_deref()
                .is_some_and(|value| !value.is_empty()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretUpdate {
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub private_key_name: Option<String>,
    pub key_passphrase: Option<String>,
    pub clear_password: bool,
    pub clear_private_key: bool,
}
