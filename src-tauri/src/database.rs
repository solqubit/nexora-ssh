use std::{collections::HashSet, path::Path};

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use uuid::Uuid;

use crate::{
    AppError,
    models::{AppSnapshot, Host, HostGroup, KnownHost, Vault},
};

pub struct Database {
    pub(crate) connection: Connection,
    pub(crate) vault_path: Option<std::path::PathBuf>,
    pub(crate) vault_lock: Option<std::fs::File>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let mut database = Self {
            connection,
            vault_path: None,
            vault_lock: None,
        };
        database.migrate()?;
        database.seed_if_empty()?;
        Ok(database)
    }

    pub(crate) fn migrate(&mut self) -> Result<(), AppError> {
        self.connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS encrypted_secrets (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                payload BLOB NOT NULL
            );

            CREATE TABLE IF NOT EXISTS productivity (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                payload TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS vaults (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                color TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS host_groups (
                id TEXT PRIMARY KEY,
                vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
                parent_id TEXT REFERENCES host_groups(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS hosts (
                id TEXT PRIMARY KEY,
                vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
                group_id TEXT REFERENCES host_groups(id) ON DELETE SET NULL,
                name TEXT NOT NULL,
                address TEXT NOT NULL,
                port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
                username TEXT NOT NULL DEFAULT '',
                auth_method TEXT NOT NULL,
                key_path TEXT,
                favorite INTEGER NOT NULL DEFAULT 0,
                color TEXT NOT NULL,
                tags_json TEXT NOT NULL DEFAULT '[]',
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS known_hosts (
                id TEXT PRIMARY KEY,
                host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
                algorithm TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                public_key TEXT NOT NULL,
                trusted_at TEXT NOT NULL,
                UNIQUE(host_id, algorithm)
            );

            CREATE INDEX IF NOT EXISTS idx_groups_vault ON host_groups(vault_id, sort_order);
            CREATE INDEX IF NOT EXISTS idx_hosts_vault ON hosts(vault_id);
            CREATE INDEX IF NOT EXISTS idx_hosts_group ON hosts(group_id);
            INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));

            UPDATE host_groups
            SET vault_id = (SELECT id FROM vaults ORDER BY created_at, rowid LIMIT 1)
            WHERE vault_id <> (SELECT id FROM vaults ORDER BY created_at, rowid LIMIT 1);
            UPDATE hosts
            SET vault_id = (SELECT id FROM vaults ORDER BY created_at, rowid LIMIT 1)
            WHERE vault_id <> (SELECT id FROM vaults ORDER BY created_at, rowid LIMIT 1);
            DELETE FROM vaults
            WHERE id <> (SELECT id FROM vaults ORDER BY created_at, rowid LIMIT 1);
            UPDATE hosts SET auth_method = 'private_key' WHERE auth_method = 'agent';
            INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'));
            "#,
        )?;
        let has_protocol: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('hosts') WHERE name='protocol')",
            [],
            |row| row.get(0),
        )?;
        if !has_protocol {
            self.connection.execute_batch(
                "ALTER TABLE hosts ADD COLUMN protocol TEXT NOT NULL DEFAULT 'ssh';",
            )?;
        }
        self.connection.execute_batch("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, datetime('now'));")?;
        Ok(())
    }

    fn seed_if_empty(&mut self) -> Result<(), AppError> {
        let count: i64 = self
            .connection
            .query_row("SELECT COUNT(*) FROM vaults", [], |row| row.get(0))?;
        if count > 0 {
            return Ok(());
        }
        let now = Utc::now().to_rfc3339();
        let vault_id = Uuid::new_v4().to_string();
        let snapshot = AppSnapshot {
            schema_version: 1,
            vaults: vec![Vault {
                id: vault_id.clone(),
                name: "Mi bóveda".into(),
                description: "Tus accesos SSH, organizados y protegidos.".into(),
                color: "#8b7cf6".into(),
                created_at: now.clone(),
                updated_at: now,
            }],
            groups: vec![
                HostGroup {
                    id: Uuid::new_v4().to_string(),
                    vault_id: vault_id.clone(),
                    parent_id: None,
                    name: "Producción".into(),
                    sort_order: 0,
                },
                HostGroup {
                    id: Uuid::new_v4().to_string(),
                    vault_id,
                    parent_id: None,
                    name: "Desarrollo".into(),
                    sort_order: 1,
                },
            ],
            hosts: vec![],
            known_hosts: vec![],
            productivity: Default::default(),
        };
        self.save_snapshot(&snapshot)
    }

    pub fn load_snapshot(&self) -> Result<AppSnapshot, AppError> {
        let vaults = query_vaults(&self.connection)?;
        let groups = query_groups(&self.connection)?;
        let hosts = query_hosts(&self.connection)?;
        let known_hosts = query_known_hosts(&self.connection)?;
        let productivity = self
            .connection
            .query_row("SELECT payload FROM productivity WHERE id=1", [], |row| {
                row.get::<_, String>(0)
            })
            .optional()?
            .map(|json| serde_json::from_str(&json))
            .transpose()?
            .unwrap_or_default();
        Ok(AppSnapshot {
            schema_version: 1,
            vaults,
            groups,
            hosts,
            known_hosts,
            productivity,
        })
    }

    pub fn save_snapshot(&mut self, snapshot: &AppSnapshot) -> Result<(), AppError> {
        self.save_snapshot_inner(snapshot, None)
    }

    #[cfg(test)]
    pub fn secret_payload(&self) -> Result<Option<Vec<u8>>, AppError> {
        Ok(self
            .connection
            .query_row(
                "SELECT payload FROM encrypted_secrets WHERE id=1",
                [],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn save_with_secrets(
        &mut self,
        snapshot: &AppSnapshot,
        encrypted: &[u8],
    ) -> Result<(), AppError> {
        self.save_snapshot_inner(snapshot, Some(encrypted))
    }

    fn save_snapshot_inner(
        &mut self,
        snapshot: &AppSnapshot,
        encrypted: Option<&[u8]>,
    ) -> Result<(), AppError> {
        validate_snapshot(snapshot)?;
        let transaction = self.connection.transaction()?;

        for vault in &snapshot.vaults {
            transaction.execute(
                "INSERT INTO vaults(id,name,description,color,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,color=excluded.color,created_at=excluded.created_at,updated_at=excluded.updated_at",
                params![vault.id, vault.name, vault.description, vault.color, vault.created_at, vault.updated_at],
            )?;
        }
        for group in &snapshot.groups {
            transaction.execute(
                "INSERT INTO host_groups(id,vault_id,parent_id,name,sort_order) VALUES (?1,?2,NULL,?3,?4) ON CONFLICT(id) DO UPDATE SET vault_id=excluded.vault_id,parent_id=NULL,name=excluded.name,sort_order=excluded.sort_order",
                params![group.id, group.vault_id, group.name, group.sort_order],
            )?;
        }
        for group in &snapshot.groups {
            transaction.execute(
                "UPDATE host_groups SET parent_id=?1 WHERE id=?2",
                params![group.parent_id, group.id],
            )?;
        }
        for host in &snapshot.hosts {
            transaction.execute(
                "INSERT INTO hosts(id,vault_id,group_id,name,address,port,username,auth_method,key_path,favorite,color,tags_json,note,created_at,updated_at,protocol) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16) ON CONFLICT(id) DO UPDATE SET vault_id=excluded.vault_id,group_id=excluded.group_id,name=excluded.name,address=excluded.address,port=excluded.port,username=excluded.username,auth_method=excluded.auth_method,key_path=excluded.key_path,favorite=excluded.favorite,color=excluded.color,tags_json=excluded.tags_json,note=excluded.note,created_at=excluded.created_at,updated_at=excluded.updated_at,protocol=excluded.protocol",
                params![host.id, host.vault_id, host.group_id, host.name, host.address, host.port, host.username, host.auth_method, host.key_path, host.favorite, host.color, serde_json::to_string(&host.tags)?, host.note, host.created_at, host.updated_at, host.protocol],
            )?;
        }
        // Remove replaced keys within the same transaction before inserting their successors.
        // Otherwise UNIQUE(host_id, algorithm) still refers to the old row during the insert.
        delete_missing(
            &transaction,
            "known_hosts",
            snapshot
                .known_hosts
                .iter()
                .map(|item| item.id.as_str())
                .collect(),
        )?;
        for known in &snapshot.known_hosts {
            transaction.execute(
                "INSERT INTO known_hosts(id,host_id,algorithm,fingerprint,public_key,trusted_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET host_id=excluded.host_id,algorithm=excluded.algorithm,fingerprint=excluded.fingerprint,public_key=excluded.public_key,trusted_at=excluded.trusted_at",
                params![known.id, known.host_id, known.algorithm, known.fingerprint, known.public_key, known.trusted_at],
            )?;
        }
        delete_missing(
            &transaction,
            "hosts",
            snapshot.hosts.iter().map(|item| item.id.as_str()).collect(),
        )?;
        delete_missing(
            &transaction,
            "host_groups",
            snapshot
                .groups
                .iter()
                .map(|item| item.id.as_str())
                .collect(),
        )?;
        delete_missing(
            &transaction,
            "vaults",
            snapshot
                .vaults
                .iter()
                .map(|item| item.id.as_str())
                .collect(),
        )?;
        if let Some(payload) = encrypted {
            transaction.execute("INSERT INTO encrypted_secrets(id,payload) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", [payload])?;
        }
        transaction.execute("INSERT INTO productivity(id,payload) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", [serde_json::to_string(&snapshot.productivity)?])?;
        transaction.commit()?;
        Ok(())
    }
}

pub(crate) fn validate_snapshot(snapshot: &AppSnapshot) -> Result<(), AppError> {
    fn text(value: &str, min: usize, max: usize) -> Result<(), AppError> {
        let count = value.encode_utf16().count();
        if count < min || count > max || value.contains('\0') {
            return Err(AppError::Validation(
                "Un campo no respeta los límites permitidos".into(),
            ));
        }
        Ok(())
    }
    if snapshot.hosts.len() > 10_000
        || snapshot.groups.len() > 10_000
        || snapshot.known_hosts.len() > 10_000
    {
        return Err(AppError::Validation(
            "La bóveda supera el límite de 10000 elementos por colección".into(),
        ));
    }
    let productivity = &snapshot.productivity;
    if productivity.workspaces.len() > 100 || productivity.snippets.len() > 1000 {
        return Err(AppError::Validation(
            "Demasiados espacios o snippets".into(),
        ));
    }
    let mut workspace_ids = HashSet::new();
    for workspace in &productivity.workspaces {
        text(&workspace.id, 1, 200)?;
        text(&workspace.vault_id, 1, 200)?;
        text(&workspace.name, 1, 160)?;
        text(&workspace.updated_at, 1, 80)?;
        if !workspace_ids.insert(&workspace.id)
            || workspace.name.trim().is_empty()
            || !snapshot
                .vaults
                .iter()
                .any(|vault| vault.id == workspace.vault_id)
            || workspace.sessions.is_empty()
            || workspace.sessions.len() > 100
            || workspace.pane_indices.len() > 4
            || !workspace.split_ratio.is_finite()
            || !(20.0..=80.0).contains(&workspace.split_ratio)
            || !["columns", "rows", "grid"].contains(&workspace.layout.as_str())
            || workspace
                .pane_indices
                .iter()
                .any(|index| *index >= workspace.sessions.len())
            || workspace.pane_indices.iter().collect::<HashSet<_>>().len()
                != workspace.pane_indices.len()
        {
            return Err(AppError::Validation("Espacio de trabajo no válido".into()));
        }
        for session in &workspace.sessions {
            text(&session.host_id, 1, 200)?;
            text(&session.title, 1, 160)?;
        }
        if let Some(files) = &workspace.files {
            if !files.split_ratio.is_finite() || !(30.0..=70.0).contains(&files.split_ratio) {
                return Err(AppError::Validation(
                    "Distribución de archivos no válida".into(),
                ));
            }
            for location in [&files.left, &files.right] {
                let path = match location {
                    crate::models::SavedFileLocation::Local { path } => path,
                    crate::models::SavedFileLocation::Host { host_id, path } => {
                        text(host_id, 1, 200)?;
                        if path.as_ref().is_some_and(|path| !path.starts_with('/'))
                            || snapshot.hosts.iter().any(|host| {
                                host.id == *host_id && host.vault_id != workspace.vault_id
                            })
                        {
                            return Err(AppError::Validation("Ubicación remota no válida".into()));
                        }
                        path
                    }
                };
                if let Some(path) = path {
                    text(path, 1, 4096)?;
                }
            }
        }
    }
    let mut snippet_ids = HashSet::new();
    for snippet in &productivity.snippets {
        text(&snippet.id, 1, 200)?;
        text(&snippet.vault_id, 1, 200)?;
        text(&snippet.name, 1, 160)?;
        text(&snippet.category, 0, 160)?;
        text(&snippet.description, 0, 2000)?;
        text(&snippet.command, 1, 32000)?;
        text(&snippet.updated_at, 1, 80)?;
        if !snippet_ids.insert(&snippet.id)
            || snippet.name.trim().is_empty()
            || snippet.command.contains('\u{1b}')
            || snippet
                .shell
                .as_deref()
                .is_some_and(|shell| !["posix", "powershell"].contains(&shell))
            || !snapshot
                .vaults
                .iter()
                .any(|vault| vault.id == snippet.vault_id)
        {
            return Err(AppError::Validation("Snippet no válido".into()));
        }
    }
    if productivity.identities.len() > 1000
        || productivity.connection_profiles.len() > 10000
        || productivity.group_defaults.len() > 10000
    {
        return Err(AppError::Validation(
            "Demasiadas configuraciones de conexión".into(),
        ));
    }
    let host_ids: HashSet<_> = snapshot.hosts.iter().map(|host| host.id.as_str()).collect();
    let group_ids: HashSet<_> = snapshot
        .groups
        .iter()
        .map(|group| group.id.as_str())
        .collect();
    let mut identity_ids = HashSet::new();
    for identity in &productivity.identities {
        text(&identity.id, 1, 200)?;
        text(&identity.vault_id, 1, 200)?;
        text(&identity.name, 1, 160)?;
        text(&identity.username, 0, 256)?;
        text(&identity.updated_at, 1, 80)?;
        if !identity_ids.insert(identity.id.as_str())
            || identity.name.trim().is_empty()
            || !["password", "private_key", "system_agent"].contains(&identity.auth_method.as_str())
            || !snapshot
                .vaults
                .iter()
                .any(|vault| vault.id == identity.vault_id)
        {
            return Err(AppError::Validation("Identidad no válida".into()));
        }
    }
    let mut configured_hosts = HashSet::new();
    if productivity.tunnels.len() > 1000 {
        return Err(AppError::Validation(
            "Se permiten hasta 1000 perfiles de túnel".into(),
        ));
    }
    let mut tunnel_ids = HashSet::new();
    for tunnel in &productivity.tunnels {
        crate::tunnel_engine::validate(tunnel).map_err(AppError::Validation)?;
        if !host_ids.contains(tunnel.host_id.as_str()) || !tunnel_ids.insert(&tunnel.id) {
            return Err(AppError::Validation(
                "El túnel contiene un host inexistente o un identificador duplicado".into(),
            ));
        }
    }
    for profile in &productivity.connection_profiles {
        text(&profile.host_id, 1, 200)?;
        if let Some(id) = &profile.jump_host_id {
            text(id, 1, 200)?;
        }
        crate::connection_profile::route_ids(snapshot, &profile.host_id)
            .map_err(AppError::Validation)?;

        if let Some(environment) = &profile.environment {
            text(environment, 1, 60)?;
            if environment.trim().is_empty() {
                return Err(AppError::Validation(
                    "El entorno no puede estar vacío".into(),
                ));
            }
        }
        if profile
            .identity_id
            .as_deref()
            .is_some_and(|id| !identity_ids.contains(id))
            || !host_ids.contains(profile.host_id.as_str())
            || !configured_hosts.insert(&profile.host_id)
            || profile.keepalive_seconds.is_some_and(|value| value > 300)
        {
            return Err(AppError::Validation("Perfil de conexión no válido".into()));
        }
    }
    let mut configured_groups = HashSet::new();
    for defaults in &productivity.group_defaults {
        text(&defaults.group_id, 1, 200)?;
        if let Some(username) = &defaults.username {
            text(username, 0, 256)?;
        }
        if defaults
            .identity_id
            .as_deref()
            .is_some_and(|id| !identity_ids.contains(id))
            || !group_ids.contains(defaults.group_id.as_str())
            || !configured_groups.insert(&defaults.group_id)
            || defaults.keepalive_seconds.is_some_and(|value| value > 300)
            || defaults.port == Some(0)
        {
            return Err(AppError::Validation(
                "Configuración de grupo no válida".into(),
            ));
        }
    }
    for vault in &snapshot.vaults {
        text(&vault.id, 1, 200)?;
        text(&vault.name, 1, 160)?;
        text(&vault.description, 0, 4096)?;
        text(&vault.color, 1, 64)?;
        text(&vault.created_at, 1, 100)?;
        text(&vault.updated_at, 1, 100)?;
        if vault.name.trim().is_empty() {
            return Err(AppError::Validation("La bóveda necesita un nombre".into()));
        }
    }
    for group in &snapshot.groups {
        text(&group.id, 1, 200)?;
        text(&group.vault_id, 1, 200)?;
        text(&group.name, 1, 160)?;
        if let Some(id) = &group.parent_id {
            text(id, 1, 200)?;
        }
        if group.sort_order.unsigned_abs() > 9_007_199_254_740_991 {
            return Err(AppError::Validation("Orden de grupo fuera de rango".into()));
        }
    }
    for host in &snapshot.hosts {
        if host.id.starts_with("identity:") {
            return Err(AppError::Validation(
                "Identificador de host reservado".into(),
            ));
        }
        text(&host.id, 1, 200)?;
        text(&host.vault_id, 1, 200)?;
        text(&host.name, 1, 160)?;
        text(&host.address, 1, 512)?;
        text(&host.username, 0, 256)?;
        text(&host.note, 0, 65_536)?;
        text(&host.color, 1, 64)?;
        text(&host.created_at, 1, 100)?;
        text(&host.updated_at, 1, 100)?;
        if let Some(id) = &host.group_id {
            text(id, 1, 200)?;
        }
        if let Some(path) = &host.key_path {
            text(path, 0, 1024)?;
        }
        if host.tags.len() > 100 {
            return Err(AppError::Validation(
                "Un host contiene más de 100 etiquetas".into(),
            ));
        }
        for tag in &host.tags {
            text(tag, 0, 160)?;
        }
    }
    let mut known_ids = HashSet::new();
    let mut known_pairs = HashSet::new();
    for known in &snapshot.known_hosts {
        text(&known.id, 1, 200)?;
        text(&known.host_id, 1, 200)?;
        text(&known.algorithm, 1, 160)?;
        text(&known.fingerprint, 1, 512)?;
        text(&known.public_key, 1, 65_536)?;
        text(&known.trusted_at, 1, 100)?;
        if !known_ids.insert(&known.id) || !known_pairs.insert((&known.host_id, &known.algorithm)) {
            return Err(AppError::Validation("Hay huellas duplicadas".into()));
        }
    }
    if snapshot.schema_version != 1 {
        return Err(AppError::Validation(
            "Versión de datos no compatible".into(),
        ));
    }
    if snapshot.vaults.len() != 1 {
        return Err(AppError::Validation(
            "Nexora debe contener exactamente una bóveda".into(),
        ));
    }
    let vault_ids: HashSet<&str> = snapshot
        .vaults
        .iter()
        .map(|vault| vault.id.as_str())
        .collect();
    if vault_ids.len() != snapshot.vaults.len() {
        return Err(AppError::Validation(
            "Hay bóvedas con identificadores duplicados".into(),
        ));
    }
    let group_ids: HashSet<&str> = snapshot
        .groups
        .iter()
        .map(|group| group.id.as_str())
        .collect();
    if group_ids.len() != snapshot.groups.len() {
        return Err(AppError::Validation(
            "Hay grupos con identificadores duplicados".into(),
        ));
    }
    for group in &snapshot.groups {
        if group.name.trim().is_empty() {
            return Err(AppError::Validation(
                "Cada grupo necesita un nombre válido".into(),
            ));
        }
        if !vault_ids.contains(group.vault_id.as_str()) {
            return Err(AppError::Validation(
                "Un grupo referencia una bóveda inexistente".into(),
            ));
        }
        if group
            .parent_id
            .as_deref()
            .is_some_and(|parent| parent == group.id || !group_ids.contains(parent))
        {
            return Err(AppError::Validation(
                "La jerarquía de grupos no es válida".into(),
            ));
        }
    }
    let host_ids: HashSet<&str> = snapshot.hosts.iter().map(|host| host.id.as_str()).collect();
    if host_ids.len() != snapshot.hosts.len() {
        return Err(AppError::Validation(
            "Hay hosts con identificadores duplicados".into(),
        ));
    }
    for host in &snapshot.hosts {
        if host.name.trim().is_empty() || host.address.trim().is_empty() {
            return Err(AppError::Validation(
                "Cada host necesita nombre y dirección".into(),
            ));
        }
        if host.port == 0 {
            return Err(AppError::Validation(
                "El puerto debe estar entre 1 y 65535".into(),
            ));
        }
        if !vault_ids.contains(host.vault_id.as_str()) {
            return Err(AppError::Validation(
                "Un host referencia una bóveda inexistente".into(),
            ));
        }
        if host
            .group_id
            .as_deref()
            .is_some_and(|group| !group_ids.contains(group))
        {
            return Err(AppError::Validation(
                "Un host referencia un grupo inexistente".into(),
            ));
        }
        if !matches!(host.protocol.as_str(), "ssh" | "telnet") {
            return Err(AppError::Validation("Protocolo no compatible".into()));
        }
        if !matches!(
            host.auth_method.as_str(),
            "password" | "private_key" | "system_agent"
        ) {
            return Err(AppError::Validation(
                "Método de autenticación no compatible".into(),
            ));
        }
        if host.id == "local:powershell" {
            return Err(AppError::Validation(
                "El identificador de la terminal local está reservado".into(),
            ));
        }
    }
    let known_ids: HashSet<&str> = snapshot
        .known_hosts
        .iter()
        .map(|known| known.id.as_str())
        .collect();
    if known_ids.len() != snapshot.known_hosts.len() {
        return Err(AppError::Validation(
            "Hay huellas con identificadores duplicados".into(),
        ));
    }
    if snapshot
        .known_hosts
        .iter()
        .any(|known| !host_ids.contains(known.host_id.as_str()))
    {
        return Err(AppError::Validation(
            "Una huella referencia un host inexistente".into(),
        ));
    }
    for group in &snapshot.groups {
        if let Some(parent_id) = group.parent_id.as_deref() {
            let parent = snapshot
                .groups
                .iter()
                .find(|candidate| candidate.id == parent_id)
                .expect("validado arriba");
            if parent.vault_id != group.vault_id {
                return Err(AppError::Validation(
                    "Un grupo no puede depender de otra bóveda".into(),
                ));
            }
        }
        let mut visited = HashSet::new();
        let mut current = Some(group.id.as_str());
        while let Some(group_id) = current {
            if !visited.insert(group_id) {
                return Err(AppError::Validation(
                    "La jerarquía de grupos contiene un ciclo".into(),
                ));
            }
            current = snapshot
                .groups
                .iter()
                .find(|candidate| candidate.id == group_id)
                .and_then(|candidate| candidate.parent_id.as_deref());
        }
    }
    Ok(())
}

fn delete_missing(
    transaction: &Transaction<'_>,
    table: &str,
    desired_ids: HashSet<&str>,
) -> Result<(), AppError> {
    let mut statement = transaction.prepare(&format!("SELECT id FROM {table}"))?;
    let existing = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for id in existing {
        if !desired_ids.contains(id.as_str()) {
            transaction.execute(&format!("DELETE FROM {table} WHERE id=?1"), [id])?;
        }
    }
    Ok(())
}

fn query_vaults(connection: &Connection) -> Result<Vec<Vault>, AppError> {
    let mut statement = connection.prepare(
        "SELECT id,name,description,color,created_at,updated_at FROM vaults ORDER BY created_at",
    )?;
    Ok(statement
        .query_map([], |row| {
            Ok(Vault {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                color: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

fn query_groups(connection: &Connection) -> Result<Vec<HostGroup>, AppError> {
    let mut statement = connection.prepare("SELECT id,vault_id,parent_id,name,sort_order FROM host_groups ORDER BY vault_id,sort_order")?;
    Ok(statement
        .query_map([], |row| {
            Ok(HostGroup {
                id: row.get(0)?,
                vault_id: row.get(1)?,
                parent_id: row.get(2)?,
                name: row.get(3)?,
                sort_order: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

fn query_hosts(connection: &Connection) -> Result<Vec<Host>, AppError> {
    let mut statement = connection.prepare("SELECT id,vault_id,group_id,name,address,port,username,auth_method,key_path,favorite,color,tags_json,note,created_at,updated_at,protocol FROM hosts ORDER BY favorite DESC,name")?;
    Ok(statement
        .query_map([], |row| {
            let tags_json: String = row.get(11)?;
            Ok(Host {
                protocol: row.get(15)?,
                id: row.get(0)?,
                vault_id: row.get(1)?,
                group_id: row.get(2)?,
                name: row.get(3)?,
                address: row.get(4)?,
                port: row.get(5)?,
                username: row.get(6)?,
                auth_method: row.get(7)?,
                key_path: row.get(8)?,
                favorite: row.get(9)?,
                color: row.get(10)?,
                tags: serde_json::from_str(&tags_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        11,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?,
                note: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

fn query_known_hosts(connection: &Connection) -> Result<Vec<KnownHost>, AppError> {
    let mut statement = connection.prepare("SELECT id,host_id,algorithm,fingerprint,public_key,trusted_at FROM known_hosts ORDER BY trusted_at")?;
    Ok(statement
        .query_map([], |row| {
            Ok(KnownHost {
                id: row.get(0)?,
                host_id: row.get(1)?,
                algorithm: row.get(2)?,
                fingerprint: row.get(3)?,
                public_key: row.get(4)?,
                trusted_at: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_updates_preserve_existing_rows_and_remove_deleted_data() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nexora.db");
        let mut database = Database::open(&path).unwrap();
        let mut snapshot = database.load_snapshot().unwrap();
        let vault_id = snapshot.vaults[0].id.clone();
        let row_before: i64 = database
            .connection
            .query_row("SELECT rowid FROM vaults WHERE id=?1", [&vault_id], |row| {
                row.get(0)
            })
            .unwrap();
        snapshot.vaults[0].name = "Bóveda actualizada".into();
        snapshot.groups.clear();

        database.save_snapshot(&snapshot).unwrap();

        let row_after: i64 = database
            .connection
            .query_row("SELECT rowid FROM vaults WHERE id=?1", [&vault_id], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(row_before, row_after);
        assert_eq!(
            database.load_snapshot().unwrap().vaults[0].name,
            "Bóveda actualizada"
        );
        assert_eq!(
            database
                .connection
                .query_row("SELECT COUNT(*) FROM host_groups", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn snapshot_validation_rejects_cross_vault_group_references() {
        let directory = tempfile::tempdir().unwrap();
        let mut database = Database::open(&directory.path().join("nexora.db")).unwrap();
        let mut snapshot = database.load_snapshot().unwrap();
        snapshot.vaults.push(Vault {
            id: "vault-other".into(),
            name: "Otra".into(),
            description: String::new(),
            color: "#fff".into(),
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        });
        snapshot.groups[0].parent_id = Some(snapshot.groups[1].id.clone());
        snapshot.groups[1].vault_id = "vault-other".into();

        assert!(matches!(
            database.save_snapshot(&snapshot),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn metadata_and_ciphertext_roll_back_together_and_survive_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("atomic.db");
        let mut db = Database::open(&path).unwrap();
        let original = db.load_snapshot().unwrap();
        db.save_with_secrets(&original, b"old-encrypted").unwrap();
        db.connection.execute_batch("CREATE TRIGGER fail_secret BEFORE UPDATE ON encrypted_secrets BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;").unwrap();
        let mut edited = original.clone();
        edited.vaults[0].name = "Must not persist".into();
        assert!(db.save_with_secrets(&edited, b"new-encrypted").is_err());
        assert_eq!(db.load_snapshot().unwrap(), original);
        assert_eq!(db.secret_payload().unwrap().unwrap(), b"old-encrypted");
        db.connection
            .execute_batch("DROP TRIGGER fail_secret;")
            .unwrap();
        db.save_with_secrets(&edited, b"new-encrypted").unwrap();
        drop(db);
        let reopened = Database::open(&path).unwrap();
        assert_eq!(reopened.load_snapshot().unwrap(), edited);
        assert_eq!(
            reopened.secret_payload().unwrap().unwrap(),
            b"new-encrypted"
        );
    }

    #[test]
    fn invalid_fields_are_rejected_before_metadata_or_ciphertext_changes() {
        let directory = tempfile::tempdir().unwrap();
        let mut db = Database::open(&directory.path().join("validation.db")).unwrap();
        let original = db.load_snapshot().unwrap();
        db.save_with_secrets(&original, b"original").unwrap();
        let mut invalid = original.clone();
        invalid.vaults[0].description = "x".repeat(4097);
        assert!(db.save_with_secrets(&invalid, b"invalid").is_err());
        invalid = original.clone();
        invalid.groups[0].name = "x".repeat(161);
        assert!(db.save_with_secrets(&invalid, b"invalid").is_err());
        invalid.groups[0].name = "emoji".into();
        invalid.groups[0].sort_order = 9_007_199_254_740_992;
        assert!(db.save_with_secrets(&invalid, b"invalid").is_err());
        assert_eq!(db.load_snapshot().unwrap(), original);
        assert_eq!(db.secret_payload().unwrap().unwrap(), b"original");
        invalid = original;
        invalid.groups[0].name = "😀".repeat(80);
        assert!(validate_snapshot(&invalid).is_ok());
        invalid.groups[0].name.push('x');
        assert!(validate_snapshot(&invalid).is_err());
    }

    #[test]
    fn productivity_failure_rolls_back_profiles_and_ciphertext_and_reopens_durably() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.db");
        let mut db = Database::open(&path).unwrap();
        let original = db.load_snapshot().unwrap();
        db.save_with_secrets(&original, b"old").unwrap();
        let mut edited = original.clone();
        edited.vaults[0].name = "Changed".into();
        edited.productivity.snippets.push(crate::models::Snippet {
            id: "snippet".into(),
            vault_id: original.vaults[0].id.clone(),
            name: "Uptime".into(),
            category: String::new(),
            description: String::new(),
            command: "uptime".into(),
            updated_at: "now".into(),
            shell: None,
        });
        db.connection.execute_batch("CREATE TRIGGER fail_productivity BEFORE UPDATE ON productivity BEGIN SELECT RAISE(ABORT, 'disk failure'); END;").unwrap();
        assert!(db.save_with_secrets(&edited, b"new").is_err());
        assert_eq!(db.load_snapshot().unwrap(), original);
        assert_eq!(db.secret_payload().unwrap().unwrap(), b"old");
        db.connection
            .execute_batch("DROP TRIGGER fail_productivity;")
            .unwrap();
        db.save_with_secrets(&edited, b"new").unwrap();
        drop(db);
        let reopened = Database::open(&path).unwrap();
        assert_eq!(reopened.load_snapshot().unwrap(), edited);
        let mut invalid = edited;
        invalid.productivity.snippets[0].name = " ".into();
        assert!(validate_snapshot(&invalid).is_err());
    }
}
