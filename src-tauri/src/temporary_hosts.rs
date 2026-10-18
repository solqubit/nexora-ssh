use crate::{
    AppState, connection_profile, database,
    models::{AppSnapshot, ConnectionProfile, Host, HostSecret, KnownHost, SecretUpdate},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TemporaryHost {
    pub host: Host,
    pub connection: ConnectionProfile,
    pub known_host: Option<KnownHost>,
}

#[derive(Clone)]
struct Entry {
    view: TemporaryHost,
    secret: HostSecret,
    known_endpoint: Option<(String, u16)>,
}

#[derive(Default)]
pub(crate) struct TemporaryRuntime {
    entries: Mutex<HashMap<String, Entry>>,
}
impl TemporaryRuntime {
    pub(crate) fn list(&self) -> Result<Vec<TemporaryHost>, String> {
        let mut values: Vec<_> = self
            .entries
            .lock()
            .map_err(|_| "Las conexiones temporales están ocupadas")?
            .values()
            .map(|entry| entry.view.clone())
            .collect();
        values.sort_by(|a, b| a.host.created_at.cmp(&b.host.created_at));
        Ok(values)
    }
    pub(crate) fn clear(&self) -> Result<(), String> {
        self.entries
            .lock()
            .map_err(|_| "Las conexiones temporales están ocupadas")?
            .clear();
        Ok(())
    }
}

fn augmented(snapshot: &AppSnapshot, entry: &Entry) -> AppSnapshot {
    let mut snapshot = snapshot.clone();
    snapshot.hosts.push(entry.view.host.clone());
    snapshot
        .productivity
        .connection_profiles
        .push(entry.view.connection.clone());
    snapshot
}

pub(crate) fn create(
    mut host: Host,
    mut connection: ConnectionProfile,
    update: SecretUpdate,
    expected: AppSnapshot,
    state: &AppState,
) -> Result<TemporaryHost, String> {
    let database = state
        .database
        .lock()
        .map_err(|_| "La base de datos está ocupada")?;
    state.ensure_available()?;
    let snapshot = database
        .load_snapshot()
        .map_err(|error| error.to_string())?;
    crate::ensure_current(&expected, &snapshot)?;
    // El identificador y las fechas se asignan en el núcleo, no desde la WebView.
    host.id = Uuid::new_v4().to_string();
    host.created_at = Utc::now().to_rfc3339();
    host.updated_at.clone_from(&host.created_at);
    host.key_path = None;
    connection.host_id.clone_from(&host.id);
    let mut entries = state
        .ssh
        .temporary
        .entries
        .lock()
        .map_err(|_| "Las conexiones temporales están ocupadas")?;
    if entries.len() >= 100 {
        return Err(
            "Hay 100 conexiones temporales; guarda u olvida alguna antes de crear otra.".into(),
        );
    }
    if update
        .password
        .as_ref()
        .is_some_and(|value| value.len() > 32768)
        || update
            .private_key
            .as_ref()
            .is_some_and(|value| value.len() > 512 * 1024)
        || update
            .key_passphrase
            .as_ref()
            .is_some_and(|value| value.len() > 32768)
        || update
            .private_key_name
            .as_ref()
            .is_some_and(|value| value.len() > 512)
    {
        return Err("Las credenciales temporales superan el límite permitido".into());
    }
    let mut staged = state
        .secrets
        .lock()
        .map_err(|_| "El almacén seguro está ocupado")?
        .staged();
    staged
        .update(&host.id, update)
        .map_err(|error| error.to_string())?;
    let secret = staged
        .get(&host.id)
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    let view = TemporaryHost {
        host,
        connection,
        known_host: None,
    };
    let entry = Entry {
        view: view.clone(),
        secret,
        known_endpoint: None,
    };
    let augmented = augmented(&snapshot, &entry);
    database::validate_snapshot(&augmented).map_err(|error| error.to_string())?;
    let effective = connection_profile::resolve(&augmented, &view.host)?;
    if effective.host.protocol == "ssh" && effective.host.username.trim().is_empty() {
        return Err("Escribe el usuario SSH para conectar".into());
    }
    // Ninguna escritura en SQLite o en el almacén persistente ocurre aquí.
    entries.insert(view.host.id.clone(), entry);
    Ok(view)
}

pub(crate) fn material(
    host_id: &str,
    snapshot: &AppSnapshot,
    state: &AppState,
) -> Result<connection_profile::ConnectionMaterial, String> {
    let entry = state
        .ssh
        .temporary
        .entries
        .lock()
        .map_err(|_| "Las conexiones temporales están ocupadas")?
        .get(host_id)
        .cloned()
        .ok_or("El host ya no existe o la conexión temporal fue olvidada")?;
    let effective = connection_profile::resolve(&augmented(snapshot, &entry), &entry.view.host)?;
    let secret = match &effective.identity_id {
        Some(id) => state
            .secrets
            .lock()
            .map_err(|_| "El almacén seguro está ocupado")?
            .get(&format!("identity:{id}"))
            .map_err(|error| error.to_string())?
            .unwrap_or_default(),
        None => entry.secret.clone(),
    };
    let known = (entry.known_endpoint.as_ref()
        == Some(&(effective.host.address.clone(), effective.host.port)))
    .then(|| entry.view.known_host.clone())
    .flatten();
    Ok((
        effective.host,
        known,
        secret,
        effective.keepalive_seconds,
        effective.tmux_session,
    ))
}

pub(crate) fn trust(
    host_id: &str,
    pending: crate::ssh_engine::PendingHostKey,
    snapshot: &AppSnapshot,
    state: &AppState,
    replace: bool,
) -> Result<KnownHost, String> {
    let mut entries = state
        .ssh
        .temporary
        .entries
        .lock()
        .map_err(|_| "Las conexiones temporales están ocupadas")?;
    let entry = entries
        .get_mut(host_id)
        .ok_or("La conexión temporal ya no existe")?;
    let effective = connection_profile::resolve(&augmented(snapshot, entry), &entry.view.host)?;
    crate::ssh_engine::validate_pending_key(
        &pending,
        host_id,
        &effective.host.address,
        effective.host.port,
    )?;
    let endpoint = (effective.host.address, effective.host.port);
    let current = if entry.known_endpoint.as_ref() == Some(&endpoint) {
        entry.view.known_host.as_ref()
    } else {
        None
    };
    crate::ssh_engine::validate_replacement(&pending, current, replace)?;
    let known = KnownHost {
        id: Uuid::new_v4().to_string(),
        host_id: host_id.into(),
        algorithm: pending.algorithm,
        fingerprint: pending.fingerprint,
        public_key: pending.public_key,
        trusted_at: Utc::now().to_rfc3339(),
    };
    entry.view.known_host = Some(known.clone());
    entry.known_endpoint = Some(endpoint);
    Ok(known)
}

pub(crate) fn promote(
    host_id: String,
    name: String,
    group_id: Option<String>,
    expected: AppSnapshot,
    state: &AppState,
) -> Result<AppSnapshot, String> {
    let mut database = state
        .database
        .lock()
        .map_err(|_| "La base de datos está ocupada")?;
    state.ensure_available()?;
    let mut snapshot = database
        .load_snapshot()
        .map_err(|error| error.to_string())?;
    crate::ensure_current(&expected, &snapshot)?;
    let mut entries = state
        .ssh
        .temporary
        .entries
        .lock()
        .map_err(|_| "Las conexiones temporales están ocupadas")?;
    let entry = entries
        .get(&host_id)
        .ok_or("La conexión temporal ya no existe")?;
    if snapshot.hosts.iter().any(|host| host.id == host_id) {
        return Err("El host ya fue guardado. Recarga sus datos.".into());
    }
    let mut host = entry.view.host.clone();
    host.name = name.trim().into();
    host.group_id = group_id;
    host.updated_at = Utc::now().to_rfc3339();
    snapshot.hosts.push(host.clone());
    snapshot
        .productivity
        .connection_profiles
        .push(entry.view.connection.clone());
    database::validate_snapshot(&snapshot).map_err(|error| error.to_string())?;
    let effective = connection_profile::resolve(&snapshot, &host)?;
    if effective.host.protocol == "ssh" && effective.host.username.trim().is_empty() {
        return Err("El grupo elegido no aporta un usuario SSH. Conserva el grupo actual o configura su usuario antes de guardar.".into());
    }
    if effective.host.protocol == "ssh"
        && effective.identity_id.is_none()
        && ((effective.host.auth_method == "password"
            && entry.secret.password.as_deref().is_none_or(str::is_empty))
            || (effective.host.auth_method == "private_key"
                && entry
                    .secret
                    .private_key
                    .as_deref()
                    .is_none_or(str::is_empty)))
    {
        return Err("Este acceso usa una identidad heredada y no tiene credenciales propias. Conserva un grupo que aporte esa identidad antes de guardar.".into());
    }
    if entry.known_endpoint.as_ref() == Some(&(effective.host.address, effective.host.port))
        && let Some(known) = &entry.view.known_host
    {
        snapshot.known_hosts.push(known.clone());
    }
    let mut store = state
        .secrets
        .lock()
        .map_err(|_| "El almacén seguro está ocupado")?;
    let mut staged = store.staged();
    // Transfiere el secreto dentro del núcleo y en la misma transacción del perfil.
    staged
        .replace(&host_id, Some(entry.secret.clone()))
        .map_err(|error| error.to_string())?;
    crate::commit_profile(&mut database, &mut store, &snapshot, staged)?;
    entries.remove(&host_id);
    Ok(snapshot)
}

pub(crate) fn forget(host_id: &str, state: &AppState) -> Result<bool, String> {
    let _database = state
        .database
        .lock()
        .map_err(|_| "La base de datos está ocupada")?;
    state.ensure_available()?;
    let removed = state
        .ssh
        .temporary
        .entries
        .lock()
        .map_err(|_| "Las conexiones temporales están ocupadas")?
        .remove(host_id)
        .is_some();
    if removed {
        let mut sessions = state
            .ssh
            .sessions
            .lock()
            .map_err(|_| "El gestor SSH está ocupado")?;
        sessions.retain(|_, active| {
            if active.host_id.as_deref() == Some(host_id) {
                let _ = active.cancellation.send(true);
                false
            } else {
                true
            }
        });
        state
            .ssh
            .pending_host_keys
            .lock()
            .map_err(|_| "El almacén de huellas está ocupado")?
            .retain(|_, pending| pending.host_id != host_id);
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::{GroupDefaults, Identity},
        secrets::SecretStore,
        ssh_engine::{ActiveSession, PendingHostKey},
    };
    use std::{
        path::Path,
        sync::atomic::AtomicBool,
        time::{Duration, Instant},
    };
    use tokio::sync::{mpsc, watch};

    fn fixture(path: &Path) -> AppState {
        AppState {
            _instance_lock: std::fs::File::create(path.join("fixture.lock")).unwrap(),
            database: Mutex::new(database::Database::open(&path.join("fixture.db")).unwrap()),
            secrets: Mutex::new(SecretStore::fixture(None)),
            ssh: Default::default(),
            sftp: Default::default(),
            restoring: AtomicBool::new(false),
            vault_open: AtomicBool::new(true),
        }
    }
    fn snapshot(state: &AppState) -> AppSnapshot {
        state.database.lock().unwrap().load_snapshot().unwrap()
    }
    fn host(snapshot: &AppSnapshot) -> Host {
        Host {
            protocol: "ssh".into(),
            id: "untrusted-web-id".into(),
            vault_id: snapshot.vaults[0].id.clone(),
            group_id: None,
            name: "Quick".into(),
            address: "127.0.0.1".into(),
            port: 22,
            username: "test".into(),
            auth_method: "password".into(),
            key_path: None,
            favorite: false,
            color: "#7198f5".into(),
            tags: vec![],
            note: String::new(),
            created_at: "untrusted-date".into(),
            updated_at: "untrusted-date".into(),
        }
    }
    fn update(password: Option<&str>) -> SecretUpdate {
        SecretUpdate {
            password: password.map(str::to_string),
            private_key: None,
            private_key_name: None,
            key_passphrase: None,
            clear_password: false,
            clear_private_key: false,
        }
    }
    fn pending(view: &TemporaryHost, port: u16, key: &str) -> PendingHostKey {
        PendingHostKey {
            host_id: view.host.id.clone(),
            algorithm: "ssh-ed25519".into(),
            fingerprint: format!("SHA256:{key}"),
            public_key: key.into(),
            previous_public_key: None,
            address: view.host.address.clone(),
            port,
            created_at: Instant::now(),
        }
    }
    fn create_own(state: &AppState) -> TemporaryHost {
        let base = snapshot(state);
        create(
            host(&base),
            ConnectionProfile::default(),
            update(Some("fixture-password")),
            base,
            state,
        )
        .unwrap()
    }
    #[test]
    fn temporary_destination_resolves_saved_jump_routes_before_and_after_promotion() {
        let directory = tempfile::tempdir().unwrap();
        let state = fixture(directory.path());
        let mut base = snapshot(&state);
        let mut gateway = host(&base);
        gateway.id = "gateway".into();
        gateway.name = "Gateway".into();
        base.hosts.push(gateway);
        state.database.lock().unwrap().save_snapshot(&base).unwrap();
        let view = create(
            host(&base),
            ConnectionProfile {
                jump_host_id: Some("gateway".into()),
                ..Default::default()
            },
            update(Some("fixture-password")),
            base.clone(),
            &state,
        )
        .unwrap();
        let route = crate::connection_profile::load_route(&view.host.id, &state).unwrap();
        assert_eq!(
            route
                .iter()
                .map(|item| item.0.id.as_str())
                .collect::<Vec<_>>(),
            vec!["gateway", view.host.id.as_str()]
        );
        assert_eq!(snapshot(&state), base);
        let unknown = create(
            host(&base),
            ConnectionProfile {
                jump_host_id: Some("deleted".into()),
                ..Default::default()
            },
            update(Some("fixture-password")),
            base.clone(),
            &state,
        );
        assert!(unknown.is_err());
        let temporary_parent = create(
            host(&base),
            ConnectionProfile {
                jump_host_id: Some(view.host.id.clone()),
                ..Default::default()
            },
            update(Some("fixture-password")),
            base.clone(),
            &state,
        );
        assert!(temporary_parent.is_err());
        promote(
            view.host.id.clone(),
            "Saved target".into(),
            None,
            base,
            &state,
        )
        .unwrap();
        assert_eq!(
            crate::connection_profile::load_route(&view.host.id, &state)
                .unwrap()
                .iter()
                .map(|item| item.0.id.clone())
                .collect::<Vec<_>>(),
            vec!["gateway".to_string(), view.host.id]
        );
    }
    #[test]
    fn creation_and_trust_remain_in_memory_and_forgetting_only_cancels_its_sessions() {
        let directory = tempfile::tempdir().unwrap();
        let state = fixture(directory.path());
        let base = snapshot(&state);
        let payload = state.secrets.lock().unwrap().encrypted_payload().unwrap();
        let view = create_own(&state);
        let other = create_own(&state);
        assert_ne!(view.host.id, "untrusted-web-id");
        assert_ne!(view.host.created_at, "untrusted-date");
        let response = serde_json::to_string(&state.ssh.temporary.list().unwrap()).unwrap();
        assert!(!response.contains("fixture-password") && !response.contains("privateKey"));
        trust(
            &view.host.id,
            pending(&view, 22, "key"),
            &base,
            &state,
            false,
        )
        .unwrap();
        assert!(material(&view.host.id, &base, &state).unwrap().1.is_some());
        assert!(crate::connection_profile::load_own_secret(&view.host.id, &state).is_err());
        let mut cancel_watchers = Vec::new();
        for (id, target) in [
            ("mine", Some(view.host.id.clone())),
            ("other", Some(other.host.id.clone())),
            ("powershell", None),
        ] {
            let (sender, _receiver) = mpsc::channel(1);
            let (cancellation, cancelled) = watch::channel(false);
            state.ssh.sessions.lock().unwrap().insert(
                id.into(),
                ActiveSession {
                    host_id: target,
                    generation: Uuid::new_v4(),
                    sender,
                    cancellation,
                },
            );
            cancel_watchers.push(cancelled);
        }
        state
            .ssh
            .pending_host_keys
            .lock()
            .unwrap()
            .insert("challenge".into(), pending(&view, 22, "key"));
        assert!(forget(&view.host.id, &state).unwrap());
        assert!(*cancel_watchers[0].borrow());
        assert!(!*cancel_watchers[1].borrow() && !*cancel_watchers[2].borrow());
        assert_eq!(state.ssh.sessions.lock().unwrap().len(), 2);
        assert!(state.ssh.pending_host_keys.lock().unwrap().is_empty());
        assert!(material(&view.host.id, &base, &state).is_err());
        assert!(!forget(&view.host.id, &state).unwrap());
        assert_eq!(snapshot(&state), base);
        assert!(
            state
                .database
                .lock()
                .unwrap()
                .secret_payload()
                .unwrap()
                .is_none()
        );
        assert_eq!(
            state.secrets.lock().unwrap().encrypted_payload().unwrap(),
            payload
        );
    }
    #[test]
    fn promotion_rolls_back_metadata_and_credentials_then_saves_and_reopens_same_id() {
        let directory = tempfile::tempdir().unwrap();
        let state = fixture(directory.path());
        let mut base = snapshot(&state);
        let mut existing = host(&base);
        existing.id = "existing".into();
        base.hosts.push(existing);
        {
            let mut db = state.database.lock().unwrap();
            let mut secrets = state.secrets.lock().unwrap();
            let mut staged = secrets.staged();
            staged
                .update("existing", update(Some("existing-password")))
                .unwrap();
            crate::commit_profile(&mut db, &mut secrets, &base, staged).unwrap();
        }
        let old_payload = state.database.lock().unwrap().secret_payload().unwrap();
        let view = create_own(&state);
        let trusted = trust(
            &view.host.id,
            pending(&view, 22, "key"),
            &base,
            &state,
            false,
        )
        .unwrap();
        assert!(
            promote(
                view.host.id.clone(),
                String::new(),
                None,
                base.clone(),
                &state
            )
            .is_err()
        );
        let mut stale = base.clone();
        stale.hosts[0].name = "old".into();
        assert!(promote(view.host.id.clone(), "Saved".into(), None, stale, &state).is_err());
        let connection = rusqlite::Connection::open(directory.path().join("fixture.db")).unwrap();
        connection.execute_batch("CREATE TRIGGER fail_quick BEFORE INSERT ON hosts BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;").unwrap();
        assert!(
            promote(
                view.host.id.clone(),
                "Saved".into(),
                None,
                base.clone(),
                &state
            )
            .is_err()
        );
        assert_eq!(snapshot(&state), base);
        assert_eq!(
            state.database.lock().unwrap().secret_payload().unwrap(),
            old_payload
        );
        assert_eq!(
            material(&view.host.id, &base, &state)
                .unwrap()
                .2
                .password
                .as_deref(),
            Some("fixture-password")
        );
        assert!(
            state
                .secrets
                .lock()
                .unwrap()
                .get(&view.host.id)
                .unwrap()
                .is_none()
        );
        connection
            .execute_batch("DROP TRIGGER fail_quick;")
            .unwrap();
        let (sender, _receiver) = mpsc::channel(1);
        let (cancellation, cancelled) = watch::channel(false);
        let generation = Uuid::new_v4();
        state.ssh.sessions.lock().unwrap().insert(
            "open".into(),
            ActiveSession {
                host_id: Some(view.host.id.clone()),
                generation,
                sender,
                cancellation,
            },
        );
        let saved = promote(view.host.id.clone(), "  Saved  ".into(), None, base, &state).unwrap();
        assert_eq!(saved.hosts[1].id, view.host.id);
        assert_eq!(saved.hosts[1].name, "Saved");
        assert_eq!(saved.known_hosts, vec![trusted]);
        assert!(state.ssh.temporary.list().unwrap().is_empty());
        assert_eq!(
            state.ssh.sessions.lock().unwrap()["open"].generation,
            generation
        );
        assert!(!*cancelled.borrow());
        let db = database::Database::open(&directory.path().join("fixture.db")).unwrap();
        assert_eq!(db.load_snapshot().unwrap(), saved);
        let ciphertext = db.secret_payload().unwrap().unwrap();
        assert!(!String::from_utf8_lossy(&ciphertext).contains("fixture-password"));
        let reopened = SecretStore::fixture(Some(ciphertext));
        assert_eq!(
            reopened
                .get(&view.host.id)
                .unwrap()
                .unwrap()
                .password
                .as_deref(),
            Some("fixture-password")
        );
        assert_eq!(
            reopened
                .get("existing")
                .unwrap()
                .unwrap()
                .password
                .as_deref(),
            Some("existing-password")
        );
    }
    #[test]
    fn inherited_endpoint_and_challenge_binding_survive_save_without_trusting_another_port() {
        let directory = tempfile::tempdir().unwrap();
        let state = fixture(directory.path());
        let mut base = snapshot(&state);
        let group = base.groups[0].id.clone();
        base.productivity.group_defaults.push(GroupDefaults {
            group_id: group.clone(),
            port: Some(2222),
            ..Default::default()
        });
        state.database.lock().unwrap().save_snapshot(&base).unwrap();
        let mut target = host(&base);
        target.group_id = Some(group);
        let view = create(
            target,
            ConnectionProfile {
                inherit_port: true,
                ..Default::default()
            },
            update(Some("fixture-password")),
            base.clone(),
            &state,
        )
        .unwrap();
        assert!(
            trust(
                &view.host.id,
                pending(&view, 22, "key"),
                &base,
                &state,
                false
            )
            .is_err()
        );
        let mut expired = pending(&view, 2222, "key");
        expired.created_at = Instant::now() - Duration::from_secs(301);
        assert!(trust(&view.host.id, expired, &base, &state, false).is_err());
        trust(
            &view.host.id,
            pending(&view, 2222, "key"),
            &base,
            &state,
            false,
        )
        .unwrap();
        assert!(
            trust(
                &view.host.id,
                pending(&view, 2222, "changed"),
                &base,
                &state,
                false
            )
            .is_err()
        );
        let mut changed = base.clone();
        changed.productivity.group_defaults[0].port = Some(2223);
        state
            .database
            .lock()
            .unwrap()
            .save_snapshot(&changed)
            .unwrap();
        let material = material(&view.host.id, &changed, &state).unwrap();
        assert_eq!(material.0.port, 2223);
        assert!(material.1.is_none());
        let saved = promote(view.host.id.clone(), "Saved".into(), None, changed, &state).unwrap();
        assert!(saved.known_hosts.is_empty());
    }
    #[tokio::test]
    async fn temporary_identity_authenticates_loopback_ssh_and_sftp_before_and_after_save() {
        let server = crate::test_server::TestServer::start("quick.txt").await;
        let directory = tempfile::tempdir().unwrap();
        let state = fixture(directory.path());
        let mut base = snapshot(&state);
        base.productivity.identities.push(Identity {
            id: "shared".into(),
            vault_id: base.vaults[0].id.clone(),
            name: "Fixture access".into(),
            username: "test".into(),
            auth_method: "password".into(),
            updated_at: "now".into(),
        });
        {
            let mut db = state.database.lock().unwrap();
            let mut secrets = state.secrets.lock().unwrap();
            let mut staged = secrets.staged();
            staged
                .update("identity:shared", update(Some("fixture-password")))
                .unwrap();
            crate::commit_profile(&mut db, &mut secrets, &base, staged).unwrap();
        }
        let mut target = host(&base);
        target.port = server.port;
        target.username.clear();
        let view = create(
            target,
            ConnectionProfile {
                identity_id: Some("shared".into()),
                ..Default::default()
            },
            update(None),
            base.clone(),
            &state,
        )
        .unwrap();
        trust(
            &view.host.id,
            pending(&view, server.port, &server.public_key),
            &base,
            &state,
            false,
        )
        .unwrap();
        for pass in 0..2 {
            let (target, known, secret, _, _) =
                crate::connection_profile::load_material(&view.host.id, &state).unwrap();
            assert_eq!(known.unwrap().public_key, server.public_key);
            let mut client = russh::client::connect(
                std::sync::Arc::new(russh::client::Config::default()),
                (target.address.clone(), target.port),
                crate::test_server::PinnedKey(server.public_key.clone()),
            )
            .await
            .unwrap();
            crate::ssh_auth::authenticate(&mut client, &target, &secret)
                .await
                .unwrap();
            let channel = client.channel_open_session().await.unwrap();
            channel.request_subsystem(true, "sftp").await.unwrap();
            let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
                .await
                .unwrap();
            sftp.set_timeout(3);
            assert!(
                sftp.read_dir("/")
                    .await
                    .unwrap()
                    .any(|entry| entry.file_name() == "quick.txt")
            );
            sftp.close().await.unwrap();
            if pass == 0 {
                promote(
                    view.host.id.clone(),
                    "Saved quick".into(),
                    None,
                    base.clone(),
                    &state,
                )
                .unwrap();
            }
        }
    }
    #[test]
    fn changing_group_cannot_promote_an_unusable_inherited_access() {
        let directory = tempfile::tempdir().unwrap();
        let state = fixture(directory.path());
        let mut base = snapshot(&state);
        let group = base.groups[0].id.clone();
        base.productivity.identities.push(Identity {
            id: "inherited".into(),
            vault_id: base.vaults[0].id.clone(),
            name: "Shared".into(),
            username: "test".into(),
            auth_method: "password".into(),
            updated_at: "now".into(),
        });
        base.productivity.group_defaults.push(GroupDefaults {
            group_id: group.clone(),
            identity_id: Some("inherited".into()),
            ..Default::default()
        });
        {
            let mut db = state.database.lock().unwrap();
            let mut secrets = state.secrets.lock().unwrap();
            let mut staged = secrets.staged();
            staged
                .update("identity:inherited", update(Some("fixture-password")))
                .unwrap();
            crate::commit_profile(&mut db, &mut secrets, &base, staged).unwrap();
        }
        for own_username in ["", "own"] {
            let mut target = host(&base);
            target.group_id = Some(group.clone());
            target.username = own_username.into();
            let view = create(
                target,
                ConnectionProfile {
                    inherit_identity: true,
                    ..Default::default()
                },
                update(None),
                base.clone(),
                &state,
            )
            .unwrap();
            let error = promote(
                view.host.id.clone(),
                "Saved".into(),
                None,
                base.clone(),
                &state,
            )
            .unwrap_err();
            assert!(
                error.contains(if own_username.is_empty() {
                    "usuario SSH"
                } else {
                    "credenciales propias"
                }),
                "{error}"
            );
            assert_eq!(snapshot(&state), base);
            assert!(
                material(&view.host.id, &base, &state)
                    .unwrap()
                    .2
                    .password
                    .is_some()
            );
        }
        assert_eq!(state.ssh.temporary.list().unwrap().len(), 2);
    }
    #[test]
    fn rejects_oversized_credentials_and_caps_memory_without_writing_profiles() {
        let directory = tempfile::tempdir().unwrap();
        let state = fixture(directory.path());
        let base = snapshot(&state);
        assert!(
            create(
                host(&base),
                ConnectionProfile::default(),
                update(Some(&"x".repeat(32769))),
                base.clone(),
                &state
            )
            .is_err()
        );
        assert!(state.ssh.temporary.list().unwrap().is_empty());
        for _ in 0..100 {
            create_own(&state);
        }
        assert!(
            create(
                host(&base),
                ConnectionProfile::default(),
                update(Some("fixture")),
                base.clone(),
                &state
            )
            .is_err()
        );
        assert_eq!(state.ssh.temporary.list().unwrap().len(), 100);
        assert_eq!(snapshot(&state), base);
    }
}
