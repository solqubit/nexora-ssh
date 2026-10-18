use crate::{AppError, AppState, RestoreGuard, database::Database, secrets::SecretStore};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use rand::{RngCore, rngs::OsRng};
use rusqlite::{Connection, OpenFlags, params};
use serde::Serialize;
use std::{
    fs::{File, OpenOptions},
    path::Path,
    sync::atomic::Ordering,
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;

const APPLICATION_ID: i32 = 0x4e585241;
const SCHEMA: i32 = 3;
const FORMAT: i32 = 1;
const FILENAME: &str = "boveda.nexora";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub folder: String,
    pub name: String,
}

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}
fn derive(password: &str, salt: &[u8]) -> Result<Zeroizing<Vec<u8>>, AppError> {
    if password.len() > 1024 {
        return Err(invalid("La contraseña es demasiado larga"));
    }
    let mut key = Zeroizing::new(vec![0u8; 32]);
    let params = Params::new(65536, 3, 1, Some(32)).map_err(|e| AppError::Crypto(e.to_string()))?;
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    Ok(key)
}
fn lock_folder(folder: &Path) -> Result<File, AppError> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(folder.join(".nexora.lock"))?;
    fs2::FileExt::try_lock_exclusive(&lock)
        .map_err(|_| invalid("Esta bóveda ya está abierta en otra instancia"))?;
    Ok(lock)
}
fn decode(value: String, length: usize) -> Result<Vec<u8>, AppError> {
    if value.len() > 128 {
        return Err(invalid("Cabecera de bóveda inválida"));
    }
    let bytes = B64
        .decode(value)
        .map_err(|_| invalid("Cabecera de bóveda inválida"))?;
    if bytes.len() != length {
        return Err(invalid("Cabecera de bóveda inválida"));
    }
    Ok(bytes)
}
fn aad(id: &str) -> String {
    format!("nexora-vault:{FORMAT}:{id}")
}

pub fn create(
    folder: &Path,
    name: &str,
    password: &str,
) -> Result<(Database, SecretStore), AppError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(invalid("Escribe un nombre de hasta 100 caracteres"));
    }
    if password.chars().count() < 10 {
        return Err(invalid(
            "Utiliza una contraseña maestra de al menos 10 caracteres",
        ));
    }
    if !folder.is_dir() {
        return Err(invalid("Selecciona una carpeta existente para la bóveda"));
    }
    let folder = folder.canonicalize()?;
    let lock = lock_folder(&folder)?;
    let path = folder.join(FILENAME);
    // Reserve exclusively. Creating a vault must never overwrite an existing file.
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    let result = (|| {
        let mut database = Database::open(&path)?;
        let mut salt = [0u8; 16];
        let mut nonce = [0u8; 24];
        let mut master = Zeroizing::new(vec![0u8; 32]);
        OsRng.fill_bytes(&mut salt);
        OsRng.fill_bytes(&mut nonce);
        OsRng.fill_bytes(&mut master);
        let derived = derive(password, &salt)?;
        let mut snapshot = database.load_snapshot()?;
        snapshot.vaults[0].name = name.into();
        let id = &snapshot.vaults[0].id;
        let wrapped = XChaCha20Poly1305::new_from_slice(&derived)
            .map_err(|_| invalid("Clave inválida"))?
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &master,
                    aad: aad(id).as_bytes(),
                },
            )
            .map_err(|_| invalid("No se pudo proteger la bóveda"))?;
        let secrets = SecretStore::with_key(master.to_vec(), None)?;
        database.connection.execute_batch("CREATE TABLE vault_header (id INTEGER PRIMARY KEY CHECK(id=1), format INTEGER NOT NULL, vault_id TEXT NOT NULL, salt TEXT NOT NULL, nonce TEXT NOT NULL, wrapped_key TEXT NOT NULL);")?;
        database.connection.execute(
            "INSERT INTO vault_header VALUES (1,?1,?2,?3,?4,?5)",
            params![
                FORMAT,
                id,
                B64.encode(salt),
                B64.encode(nonce),
                B64.encode(wrapped)
            ],
        )?;
        database
            .connection
            .pragma_update(None, "application_id", APPLICATION_ID)?;
        database
            .connection
            .pragma_update(None, "user_version", SCHEMA)?;
        database.save_with_secrets(&snapshot, &secrets.encrypted_payload()?)?;
        database.vault_path = Some(path.clone());
        database.vault_lock = Some(lock);
        Ok((database, secrets))
    })();
    if result.is_err() {
        // Only files belonging to the new, exclusively reserved database are removed.
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(folder.join(format!("{FILENAME}{suffix}")));
        }
    }
    result
}

pub fn open(folder: &Path, password: &str) -> Result<(Database, SecretStore), AppError> {
    let folder = folder.canonicalize()?;
    let lock = lock_folder(&folder)?;
    let path = folder.join(FILENAME);
    let read = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let app_id: i32 = read.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if app_id != APPLICATION_ID {
        return Err(invalid(
            "La carpeta no contiene una bóveda de Nexora compatible",
        ));
    }
    let schema: i32 = read.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let (format, id, salt, nonce, wrapped): (i32, String, String, String, String) = read
        .query_row(
            "SELECT format,vault_id,salt,nonce,wrapped_key FROM vault_header WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
    if format != FORMAT || schema > SCHEMA {
        return Err(invalid(
            "Esta bóveda requiere una versión más reciente de Nexora. Actualiza la aplicación",
        ));
    }
    if schema < 1 || id.len() > 200 {
        return Err(invalid("Formato de bóveda inválido"));
    }
    let salt = decode(salt, 16)?;
    let nonce = decode(nonce, 24)?;
    let wrapped = decode(wrapped, 48)?;
    let key = derive(password, &salt)?;
    let master = Zeroizing::new(
        XChaCha20Poly1305::new_from_slice(&key)
            .map_err(|_| invalid("Clave inválida"))?
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &wrapped,
                    aad: aad(&id).as_bytes(),
                },
            )
            .map_err(|_| invalid("Contraseña incorrecta o bóveda dañada"))?,
    );
    let payload = read.query_row(
        "SELECT payload FROM encrypted_secrets WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    let secrets = SecretStore::with_key(master.to_vec(), Some(payload))?;
    drop(read);
    // Read-only validation precedes any migration or journal-mode changes.
    if schema < SCHEMA {
        let source = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let backup_path = folder.join(format!(
            "boveda-antes-v{schema}-{}.bak",
            uuid::Uuid::new_v4()
        ));
        let mut target = Connection::open(&backup_path)?;
        let backup = rusqlite::backup::Backup::new(&source, &mut target)?;
        backup.run_to_completion(128, std::time::Duration::from_millis(10), None)?;
    }
    let mut database = Database::open(&path)?;
    let snapshot = database.load_snapshot()?;
    if snapshot.vaults.len() != 1 || snapshot.vaults[0].id != id {
        return Err(invalid("Identidad de bóveda inválida"));
    }
    crate::database::validate_snapshot(&snapshot)?;
    database
        .connection
        .pragma_update(None, "user_version", SCHEMA)?;
    database.vault_path = Some(path);
    database.vault_lock = Some(lock);
    Ok((database, secrets))
}

#[tauri::command(async)]
pub fn choose_vault_folder(app: AppHandle) -> Result<Option<String>, String> {
    app.dialog()
        .file()
        .set_title("Seleccionar carpeta de bóveda")
        .blocking_pick_folder()
        .map(|selection| {
            selection
                .into_path()
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|e| e.to_string())
        })
        .transpose()
}
#[tauri::command(async)]
pub fn vault_info(state: State<'_, AppState>) -> Result<Option<VaultInfo>, String> {
    let database = state
        .database
        .lock()
        .map_err(|_| "La bóveda está ocupada")?;
    info(&database).map_err(|e| e.to_string())
}
fn info(database: &Database) -> Result<Option<VaultInfo>, AppError> {
    let Some(path) = &database.vault_path else {
        return Ok(None);
    };
    Ok(Some(VaultInfo {
        folder: path
            .parent()
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .into_owned(),
        name: database.load_snapshot()?.vaults[0].name.clone(),
    }))
}
#[tauri::command(async)]
pub fn unlock_vault(
    folder: String,
    name: Option<String>,
    password: String,
    state: State<'_, AppState>,
) -> Result<VaultInfo, String> {
    let password = Zeroizing::new(password);
    state
        .restoring
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "Ya hay un cambio de bóveda en curso")?;
    let _guard = RestoreGuard(&state.restoring);
    let mut database = state
        .database
        .lock()
        .map_err(|_| "La bóveda está ocupada")?;
    if state.vault_open.load(Ordering::SeqCst) {
        return Err("Cierra la bóveda actual antes de abrir otra".into());
    }
    let (next, secrets) = if let Some(name) = name {
        create(Path::new(&folder), &name, &password)
    } else {
        open(Path::new(&folder), &password)
    }
    .map_err(|e| e.to_string())?;
    let details = info(&next)
        .map_err(|e| e.to_string())?
        .ok_or("No se pudo abrir la bóveda")?;
    *state
        .secrets
        .lock()
        .map_err(|_| "El almacén está ocupado")? = secrets;
    *database = next;
    state.vault_open.store(true, Ordering::SeqCst);
    Ok(details)
}
#[tauri::command(async)]
pub async fn close_vault(state: State<'_, AppState>) -> Result<(), String> {
    close_storage(&state).await
}

async fn close_storage(state: &AppState) -> Result<(), String> {
    state
        .restoring
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "Ya hay un cambio de bóveda en curso")?;
    let _guard = RestoreGuard(&state.restoring);
    if !state
        .ssh
        .sessions
        .lock()
        .map_err(|_| "El gestor SSH está ocupado")?
        .is_empty()
        || !state.sftp.is_idle().await?
        || !state.ssh.tunnels.is_idle()?
        || crate::sftp_engine::has_active_transfers()?
    {
        return Err("Cierra las conexiones y termina las operaciones de archivos antes de cambiar de bóveda".into());
    }
    let mut database = state
        .database
        .lock()
        .map_err(|_| "La bóveda está ocupada")?;
    database
        .connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|e| e.to_string())?;
    let idle = Database::open(Path::new(":memory:")).map_err(|e| e.to_string())?;
    let mut key = vec![0u8; 32];
    OsRng.fill_bytes(&mut key);
    *state
        .secrets
        .lock()
        .map_err(|_| "El almacén está ocupado")? =
        SecretStore::with_key(key, None).map_err(|e| e.to_string())?;
    state.ssh.temporary.clear()?;
    state
        .ssh
        .pending_host_keys
        .lock()
        .map_err(|_| "El almacén de huellas está ocupado")?
        .clear();
    *database = idle;
    state.vault_open.store(false, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const PASSWORD: &str = "fixture-master-password";
    #[tokio::test]
    async fn closing_locks_the_application_clears_secrets_and_releases_the_vault() {
        let app_dir = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let state = crate::open_app_state(app_dir.path()).unwrap();
        let (mut database, mut secrets) = create(folder.path(), "Personal", PASSWORD).unwrap();
        add_host(&mut database, &mut secrets);
        *state.database.lock().unwrap() = database;
        *state.secrets.lock().unwrap() = secrets;
        state.vault_open.store(true, Ordering::SeqCst);
        assert!(state.ensure_available().is_ok());
        close_storage(&state).await.unwrap();
        assert!(state.ensure_available().is_err());
        assert!(info(&state.database.lock().unwrap()).unwrap().is_none());
        assert!(
            state
                .secrets
                .lock()
                .unwrap()
                .get("fixture-host")
                .unwrap()
                .is_none()
        );
        assert!(
            open(folder.path(), PASSWORD)
                .unwrap()
                .1
                .get("fixture-host")
                .unwrap()
                .is_some()
        );
    }
    fn add_host(database: &mut Database, secrets: &mut SecretStore) {
        let mut snapshot = database.load_snapshot().unwrap();
        let host: crate::models::Host = serde_json::from_value(serde_json::json!({
            "id":"fixture-host","vaultId":snapshot.vaults[0].id,"groupId":null,"name":"Router","protocol":"telnet",
            "address":"192.0.2.10","port":23,"username":"test","authMethod":"password","keyPath":null,
            "favorite":false,"color":"#2dd4bf","tags":[],"note":"","createdAt":"now","updatedAt":"now"
        })).unwrap();
        snapshot.hosts.push(host);
        secrets.replace("fixture-host",Some(crate::models::HostSecret { password:Some("private-fixture-password".into()), private_key:Some("-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-secret-key\n-----END OPENSSH PRIVATE KEY-----".into()),private_key_name:Some("id_fixture".into()),key_passphrase:Some("private-fixture-passphrase".into()) })).unwrap();
        database
            .save_with_secrets(&snapshot, &secrets.encrypted_payload().unwrap())
            .unwrap();
    }
    #[test]
    fn credentials_are_portable_encrypted_and_every_saved_change_survives_reopening() {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let (mut database, mut secrets) = create(source.path(), "Trabajo", PASSWORD).unwrap();
        add_host(&mut database, &mut secrets);
        drop(database);
        drop(secrets);
        std::fs::copy(
            source.path().join(FILENAME),
            destination.path().join(FILENAME),
        )
        .unwrap();
        let bytes = std::fs::read(destination.path().join(FILENAME)).unwrap();
        for marker in [
            "private-fixture-password",
            "fixture-secret-key",
            "private-fixture-passphrase",
            PASSWORD,
        ] {
            assert!(!String::from_utf8_lossy(&bytes).contains(marker));
        }
        let (mut reopened, store) = open(destination.path(), PASSWORD).unwrap();
        assert_eq!(reopened.load_snapshot().unwrap().vaults[0].name, "Trabajo");
        assert_eq!(
            store
                .get("fixture-host")
                .unwrap()
                .unwrap()
                .password
                .as_deref(),
            Some("private-fixture-password")
        );
        let mut edited = reopened.load_snapshot().unwrap();
        edited.hosts[0].port = 2323;
        reopened
            .save_with_secrets(&edited, &store.encrypted_payload().unwrap())
            .unwrap();
        drop(reopened);
        drop(store);
        let (mut reopened, mut store) = open(destination.path(), PASSWORD).unwrap();
        assert_eq!(reopened.load_snapshot().unwrap().hosts[0].port, 2323);
        let mut removed = reopened.load_snapshot().unwrap();
        removed.hosts.clear();
        store
            .retain_hosts(&std::collections::HashSet::new())
            .unwrap();
        reopened
            .save_with_secrets(&removed, &store.encrypted_payload().unwrap())
            .unwrap();
        drop(reopened);
        drop(store);
        let (reopened, store) = open(destination.path(), PASSWORD).unwrap();
        assert!(reopened.load_snapshot().unwrap().hosts.is_empty());
        assert!(store.get("fixture-host").unwrap().is_none());
    }
    #[test]
    fn wrong_password_and_future_versions_leave_the_database_unchanged() {
        let folder = tempfile::tempdir().unwrap();
        let (database, store) = create(folder.path(), "Personal", PASSWORD).unwrap();
        drop(database);
        drop(store);
        let path = folder.path().join(FILENAME);
        let original = std::fs::read(&path).unwrap();
        assert!(open(folder.path(), "incorrect-password").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "user_version", SCHEMA + 1)
            .unwrap();
        drop(connection);
        let future = std::fs::read(&path).unwrap();
        assert!(
            open(folder.path(), PASSWORD)
                .err()
                .unwrap()
                .to_string()
                .contains("Actualiza")
        );
        assert_eq!(std::fs::read(&path).unwrap(), future);
    }
    #[test]
    fn create_never_overwrites_and_exclusive_lock_prevents_another_writer() {
        let folder = tempfile::tempdir().unwrap();
        let (database, store) = create(folder.path(), "Personal", PASSWORD).unwrap();
        assert!(open(folder.path(), PASSWORD).is_err());
        assert!(create(folder.path(), "Otra", PASSWORD).is_err());
        drop(database);
        drop(store);
        let original = std::fs::read(folder.path().join(FILENAME)).unwrap();
        assert!(create(folder.path(), "Otra", PASSWORD).is_err());
        assert_eq!(
            std::fs::read(folder.path().join(FILENAME)).unwrap(),
            original
        );
    }
    #[test]
    fn migration_makes_a_consistent_backup_and_keeps_credentials() {
        let folder = tempfile::tempdir().unwrap();
        let (mut database, mut secrets) = create(folder.path(), "Personal", PASSWORD).unwrap();
        add_host(&mut database, &mut secrets);
        database
            .connection
            .pragma_update(None, "user_version", 2)
            .unwrap();
        drop(database);
        drop(secrets);
        let (database, secrets) = open(folder.path(), PASSWORD).unwrap();
        assert!(secrets.get("fixture-host").unwrap().is_some());
        let backup = std::fs::read_dir(folder.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.extension().is_some_and(|e| e == "bak"))
            .unwrap();
        let read = Connection::open(backup).unwrap();
        let count: i64 = read
            .query_row("SELECT count(*) FROM hosts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            database
                .connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i32>(0))
                .unwrap(),
            SCHEMA
        );
    }
    #[test]
    fn independent_vaults_do_not_share_credentials_and_invalid_creation_writes_no_database() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        assert!(create(first.path(), "First", "short").is_err());
        assert!(!first.path().join(FILENAME).exists());
        let (mut database, mut secrets) = create(first.path(), "First", PASSWORD).unwrap();
        add_host(&mut database, &mut secrets);
        drop(database);
        drop(secrets);
        let (other, store) = create(second.path(), "Second", "different-password").unwrap();
        assert!(other.load_snapshot().unwrap().hosts.is_empty());
        assert!(store.get("fixture-host").unwrap().is_none());
        drop(other);
        drop(store);
        assert!(open(second.path(), PASSWORD).is_err());
        assert!(
            open(first.path(), PASSWORD)
                .unwrap()
                .1
                .get("fixture-host")
                .unwrap()
                .is_some()
        );
    }
}
