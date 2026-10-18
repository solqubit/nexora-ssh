mod atomic_file;
mod connection_profile;
mod database;
mod local_terminal;
mod models;
mod path_safety;
mod remote_editor;
mod secrets;
mod sftp_engine;
mod ssh_auth;
mod ssh_engine;
mod ssh_route;
mod telnet_engine;
mod temporary_hosts;
#[cfg(test)]
mod test_server;
mod tunnel_engine;
mod tunnel_runtime;
mod vault;

use std::sync::Mutex;

use database::Database;
use models::{AppSnapshot, KnownHost, SecretStatus, SecretUpdate};
use secrets::SecretStore;
use tauri::{AppHandle, Manager, State, ipc::Channel};
use tauri_plugin_opener::OpenerExt;
use thiserror::Error;
use url::Url;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Error de base de datos: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("Error de archivo: {0}")]
    Io(#[from] std::io::Error),
    #[error("Datos no válidos: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Validación: {0}")]
    Validation(String),
    #[error("Cifrado: {0}")]
    Crypto(String),
    #[error("Almacén seguro: {0}")]
    SecretStore(String),
}

pub(crate) struct AppState {
    _instance_lock: std::fs::File,
    pub(crate) database: Mutex<Database>,
    pub(crate) secrets: Mutex<SecretStore>,
    pub(crate) ssh: ssh_engine::SshRuntime,
    pub(crate) sftp: sftp_engine::SftpRuntime,
    restoring: std::sync::atomic::AtomicBool,
    vault_open: std::sync::atomic::AtomicBool,
}

impl AppState {
    pub(crate) fn ensure_available(&self) -> Result<(), String> {
        if !self.vault_open.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Abre una bóveda para continuar".into());
        }
        if self.restoring.load(std::sync::atomic::Ordering::SeqCst) {
            Err("La bóveda está cambiando; espera a que termine".into())
        } else {
            Ok(())
        }
    }
}

struct RestoreGuard<'a>(&'a std::sync::atomic::AtomicBool);
impl Drop for RestoreGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[tauri::command(async)]
fn load_snapshot(state: State<'_, AppState>) -> Result<AppSnapshot, String> {
    state.ensure_available()?;
    state
        .database
        .lock()
        .map_err(|_| "La base de datos está ocupada".to_string())?
        .load_snapshot()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_tunnels(state: State<'_, AppState>) -> Result<Vec<tunnel_runtime::TunnelState>, String> {
    state.ssh.tunnels.list()
}
#[tauri::command]
fn start_tunnel(
    id: String,
    keepalive_seconds: u64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    tunnel_runtime::start(id, keepalive_seconds, app, state)
}
#[tauri::command(async)]
async fn stop_tunnel(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.ssh.tunnels.stop(&id).await
}
#[tauri::command(async)]
async fn stop_all_tunnels(state: State<'_, AppState>) -> Result<(), String> {
    state.ssh.tunnels.stop_all().await
}

fn ensure_current(requested: &AppSnapshot, current: &AppSnapshot) -> Result<(), String> {
    fn normalized(snapshot: &AppSnapshot) -> AppSnapshot {
        let mut value = snapshot.clone();
        value.known_hosts.clear();
        value.vaults.sort_by(|a, b| a.id.cmp(&b.id));
        value.groups.sort_by(|a, b| a.id.cmp(&b.id));
        value.hosts.sort_by(|a, b| a.id.cmp(&b.id));
        value
    }
    if normalized(requested) != normalized(current) {
        return Err(
            "Los datos cambiaron durante la edición. Recarga la bóveda antes de guardar.".into(),
        );
    }
    Ok(())
}

fn commit_profile(
    database: &mut Database,
    store: &mut SecretStore,
    snapshot: &AppSnapshot,
    mut staged: SecretStore,
) -> Result<(), String> {
    let ids = connection_profile::secret_ids(snapshot);
    staged
        .retain_hosts(&ids.iter().map(String::as_str).collect())
        .map_err(|error| error.to_string())?;
    database
        .save_with_secrets(
            snapshot,
            &staged.encrypted_payload().map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    *store = staged;
    Ok(())
}

#[tauri::command(async)]
fn save_snapshot(
    mut snapshot: AppSnapshot,
    expected_snapshot: AppSnapshot,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut database = state
        .database
        .lock()
        .map_err(|_| "La base de datos está ocupada".to_string())?;
    state.ensure_available()?;
    let current = database.load_snapshot().map_err(|e| e.to_string())?;
    ensure_current(&expected_snapshot, &current)?;
    preserve_trusted_host_keys(&mut snapshot, &current);
    let mut store = state
        .secrets
        .lock()
        .map_err(|_| "El almacén seguro está ocupado".to_string())?;
    let staged = store.staged();
    commit_profile(&mut database, &mut store, &snapshot, staged)
}

#[tauri::command(async)]
fn save_host_profile(
    mut snapshot: AppSnapshot,
    expected_snapshot: AppSnapshot,
    host_id: String,
    update: SecretUpdate,
    state: State<'_, AppState>,
) -> Result<SecretStatus, String> {
    if !snapshot.hosts.iter().any(|host| host.id == host_id) {
        return Err("El host no existe en la instantánea".into());
    }
    let mut database = state
        .database
        .lock()
        .map_err(|_| "La base de datos está ocupada".to_string())?;
    state.ensure_available()?;
    let current = database.load_snapshot().map_err(|e| e.to_string())?;
    ensure_current(&expected_snapshot, &current)?;
    preserve_trusted_host_keys(&mut snapshot, &current);
    let mut store = state
        .secrets
        .lock()
        .map_err(|_| "El almacén seguro está ocupado".to_string())?;
    let mut staged = store.staged();
    let status = staged.update(&host_id, update).map_err(|e| e.to_string())?;
    commit_profile(&mut database, &mut store, &snapshot, staged)?;
    Ok(status)
}

#[tauri::command(async)]
fn create_temporary_host(
    host: models::Host,
    connection: models::ConnectionProfile,
    update: SecretUpdate,
    expected_snapshot: AppSnapshot,
    state: State<'_, AppState>,
) -> Result<temporary_hosts::TemporaryHost, String> {
    temporary_hosts::create(host, connection, update, expected_snapshot, &state)
}

#[tauri::command(async)]
fn load_temporary_hosts(
    state: State<'_, AppState>,
) -> Result<Vec<temporary_hosts::TemporaryHost>, String> {
    let _database = state
        .database
        .lock()
        .map_err(|_| "La base de datos está ocupada")?;
    state.ensure_available()?;
    state.ssh.temporary.list()
}

#[tauri::command(async)]
fn promote_temporary_host(
    host_id: String,
    name: String,
    group_id: Option<String>,
    expected_snapshot: AppSnapshot,
    state: State<'_, AppState>,
) -> Result<AppSnapshot, String> {
    temporary_hosts::promote(host_id, name, group_id, expected_snapshot, &state)
}

#[tauri::command(async)]
async fn forget_temporary_host(host_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if temporary_hosts::forget(&host_id, &state)? {
        sftp_engine::disconnect(host_id, state).await?;
    }
    Ok(())
}

#[tauri::command(async)]
fn save_duplicated_host(
    mut snapshot: AppSnapshot,
    expected_snapshot: AppSnapshot,
    source_host_id: String,
    target_host_id: String,
    state: State<'_, AppState>,
) -> Result<SecretStatus, String> {
    if source_host_id == target_host_id
        || !snapshot.hosts.iter().any(|host| host.id == target_host_id)
    {
        return Err("La copia del host no es válida".into());
    }
    let mut database = state
        .database
        .lock()
        .map_err(|_| "La base de datos está ocupada".to_string())?;
    state.ensure_available()?;
    let current = database.load_snapshot().map_err(|e| e.to_string())?;
    ensure_current(&expected_snapshot, &current)?;
    if !current.hosts.iter().any(|host| host.id == source_host_id)
        || current.hosts.iter().any(|host| host.id == target_host_id)
    {
        return Err("El origen o destino de la copia no es válido".into());
    }
    preserve_duplicated_host_key(&mut snapshot, &current, &source_host_id, &target_host_id);
    let mut store = state
        .secrets
        .lock()
        .map_err(|_| "El almacén seguro está ocupado".to_string())?;
    let mut staged = store.staged();
    let status = staged
        .duplicate(&source_host_id, &target_host_id)
        .map_err(|e| e.to_string())?;
    commit_profile(&mut database, &mut store, &snapshot, staged)?;
    Ok(status)
}

fn preserve_duplicated_host_key(
    snapshot: &mut AppSnapshot,
    current: &AppSnapshot,
    source_host_id: &str,
    target_host_id: &str,
) {
    let requested_copy = snapshot
        .known_hosts
        .iter()
        .find(|known| known.host_id == target_host_id)
        .cloned();
    let endpoint_matches = current
        .hosts
        .iter()
        .find(|host| host.id == source_host_id)
        .zip(snapshot.hosts.iter().find(|host| host.id == target_host_id))
        .is_some_and(|(source, target)| {
            connection_profile::resolve(current, source)
                .ok()
                .zip(connection_profile::resolve(snapshot, target).ok())
                .is_some_and(|(source, target)| {
                    source.host.address == target.host.address
                        && source.host.port == target.host.port
                })
        });
    let source_known = current
        .known_hosts
        .iter()
        .find(|known| known.host_id == source_host_id)
        .cloned();

    preserve_trusted_host_keys(snapshot, current);

    let Some(source_known) = source_known.filter(|_| endpoint_matches) else {
        return;
    };
    let duplicated = requested_copy
        .filter(|candidate| {
            candidate.id != source_known.id
                && candidate.algorithm == source_known.algorithm
                && candidate.fingerprint == source_known.fingerprint
                && candidate.public_key == source_known.public_key
                && candidate.trusted_at == source_known.trusted_at
        })
        .unwrap_or_else(|| KnownHost {
            id: Uuid::new_v4().to_string(),
            host_id: target_host_id.to_string(),
            algorithm: source_known.algorithm,
            fingerprint: source_known.fingerprint,
            public_key: source_known.public_key,
            trusted_at: source_known.trusted_at,
        });

    snapshot
        .known_hosts
        .retain(|known| known.host_id != target_host_id);
    snapshot.known_hosts.push(duplicated);
}

fn preserve_trusted_host_keys(snapshot: &mut AppSnapshot, current: &AppSnapshot) {
    // El motor nativo conserva una huella solo mientras el endpoint no cambie.
    let current_endpoints: std::collections::HashMap<&str, (String, u16)> = current
        .hosts
        .iter()
        .filter_map(|host| {
            connection_profile::resolve(current, host)
                .ok()
                .map(|resolved| {
                    (
                        host.id.as_str(),
                        (resolved.host.address, resolved.host.port),
                    )
                })
        })
        .collect();
    let unchanged_endpoint_ids: std::collections::HashSet<&str> = snapshot
        .hosts
        .iter()
        .filter(|host| {
            connection_profile::resolve(snapshot, host)
                .ok()
                .is_some_and(|resolved| {
                    current_endpoints.get(host.id.as_str())
                        == Some(&(resolved.host.address, resolved.host.port))
                })
        })
        .map(|host| host.id.as_str())
        .collect();
    snapshot.known_hosts = current
        .known_hosts
        .iter()
        .filter(|known| unchanged_endpoint_ids.contains(known.host_id.as_str()))
        .cloned()
        .collect();
}

#[tauri::command(async)]
fn get_secret_status(host_id: String, state: State<'_, AppState>) -> Result<SecretStatus, String> {
    Ok(SecretStatus::from(&connection_profile::load_own_secret(
        &host_id, &state,
    )?))
}

#[tauri::command(async)]
fn reveal_host_password(
    host_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    Ok(connection_profile::load_own_secret(&host_id, &state)?
        .password
        .clone())
}

#[tauri::command(async)]
fn save_identity_profile(
    mut snapshot: AppSnapshot,
    expected_snapshot: AppSnapshot,
    identity_id: String,
    update: SecretUpdate,
    state: State<'_, AppState>,
) -> Result<SecretStatus, String> {
    if !snapshot
        .productivity
        .identities
        .iter()
        .any(|identity| identity.id == identity_id)
    {
        return Err("La identidad no existe".into());
    }
    let mut database = state
        .database
        .lock()
        .map_err(|_| "La base de datos está ocupada")?;
    state.ensure_available()?;
    let current = database
        .load_snapshot()
        .map_err(|error| error.to_string())?;
    ensure_current(&expected_snapshot, &current)?;
    preserve_trusted_host_keys(&mut snapshot, &current);
    let mut store = state
        .secrets
        .lock()
        .map_err(|_| "El almacén seguro está ocupado")?;
    let mut staged = store.staged();
    let status = staged
        .update(&format!("identity:{identity_id}"), update)
        .map_err(|error| error.to_string())?;
    commit_profile(&mut database, &mut store, &snapshot, staged)?;
    Ok(status)
}

#[tauri::command(async)]
fn get_identity_status(
    identity_id: String,
    state: State<'_, AppState>,
) -> Result<SecretStatus, String> {
    let database = state
        .database
        .lock()
        .map_err(|_| "La base de datos está ocupada")?;
    state.ensure_available()?;
    let snapshot = database
        .load_snapshot()
        .map_err(|error| error.to_string())?;
    if !snapshot
        .productivity
        .identities
        .iter()
        .any(|identity| identity.id == identity_id)
    {
        return Err("La identidad ya no existe".into());
    }
    state
        .secrets
        .lock()
        .map_err(|_| "El almacén seguro está ocupado")?
        .status(&format!("identity:{identity_id}"))
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn start_ssh_session(
    session_id: String,
    host_id: String,
    columns: u32,
    rows: u32,
    keepalive_seconds: u64,
    on_event: Channel<ssh_engine::SshEvent>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    ssh_engine::start_session(
        session_id,
        host_id,
        columns,
        rows,
        keepalive_seconds,
        on_event,
        app,
        state,
    )
}

#[tauri::command(async)]
fn start_local_session(
    session_id: String,
    columns: u32,
    rows: u32,
    on_event: Channel<ssh_engine::SshEvent>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    local_terminal::start(session_id, columns, rows, on_event, app, state)
}

#[tauri::command]
fn write_ssh_session(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    ssh_engine::write_session(&session_id, data, state)
}

#[tauri::command]
fn resize_ssh_session(
    session_id: String,
    columns: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    ssh_engine::resize_session(&session_id, columns, rows, state)
}

#[tauri::command]
fn disconnect_ssh_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    ssh_engine::disconnect_session(&session_id, state)
}

#[tauri::command(async)]
fn trust_ssh_host_key(
    host_id: String,
    challenge_id: String,
    replace: Option<bool>,
    state: State<'_, AppState>,
) -> Result<KnownHost, String> {
    ssh_engine::trust_pending_host_key(&host_id, &challenge_id, replace.unwrap_or(false), &state)
}

#[tauri::command(async)]
async fn connect_sftp(
    host_id: String,
    path: Option<String>,
    keepalive_seconds: u64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<sftp_engine::SftpConnectResponse, String> {
    sftp_engine::connect(host_id, path, keepalive_seconds, app, state).await
}

#[tauri::command(async)]
async fn disconnect_sftp(host_id: String, state: State<'_, AppState>) -> Result<(), String> {
    sftp_engine::disconnect(host_id, state).await
}

#[tauri::command(async)]
async fn list_sftp_directory(
    host_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<sftp_engine::SftpDirectory, String> {
    sftp_engine::list(host_id, path, state).await
}

#[tauri::command(async)]
async fn read_sftp_text_file(
    host_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<remote_editor::RemoteTextDocument, String> {
    sftp_engine::read_text(host_id, path, state).await
}

#[tauri::command(async)]
async fn save_sftp_text_file(
    host_id: String,
    path: String,
    expected_revision: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<remote_editor::SaveRemoteTextResponse, String> {
    sftp_engine::save_text(host_id, path, expected_revision, text, state).await
}

#[tauri::command(async)]
async fn create_sftp_directory(
    host_id: String,
    parent_path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<sftp_engine::SftpDirectory, String> {
    sftp_engine::create_directory(host_id, parent_path, name, state).await
}

#[tauri::command(async)]
async fn create_sftp_file(
    host_id: String,
    parent_path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<sftp_engine::SftpDirectory, String> {
    sftp_engine::create_file(host_id, parent_path, name, state).await
}

#[tauri::command(async)]
async fn rename_sftp_entry(
    host_id: String,
    path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<sftp_engine::SftpDirectory, String> {
    sftp_engine::rename(host_id, path, new_name, state).await
}

#[tauri::command(async)]
async fn delete_sftp_entry(
    host_id: String,
    path: String,
    is_directory: bool,
    recursive: bool,
    state: State<'_, AppState>,
) -> Result<sftp_engine::SftpDirectory, String> {
    sftp_engine::delete(host_id, path, is_directory, recursive, state).await
}

#[tauri::command(async)]
async fn chmod_sftp_entry(
    host_id: String,
    path: String,
    mode: u32,
    state: State<'_, AppState>,
) -> Result<sftp_engine::SftpDirectory, String> {
    sftp_engine::chmod(host_id, path, mode, state).await
}

#[tauri::command(async)]
async fn upload_sftp_file(
    host_id: String,
    remote_directory: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<sftp_engine::SftpUploadResponse, String> {
    sftp_engine::upload(host_id, remote_directory, app, state).await
}

#[tauri::command(async)]
async fn overwrite_sftp_file(
    host_id: String,
    upload_token: String,
    state: State<'_, AppState>,
) -> Result<sftp_engine::SftpUploadResponse, String> {
    sftp_engine::overwrite_upload(host_id, upload_token, state).await
}

#[tauri::command(async)]
async fn download_sftp_file(
    host_id: String,
    remote_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    sftp_engine::download(host_id, remote_path, app, state).await
}

#[tauri::command(async)]
async fn list_local_directory(path: Option<String>) -> Result<sftp_engine::LocalDirectory, String> {
    sftp_engine::list_local(path).await
}

#[tauri::command(async)]
async fn create_local_directory(
    parent_path: String,
    name: String,
) -> Result<sftp_engine::LocalDirectory, String> {
    sftp_engine::create_local_directory(parent_path, name).await
}

#[tauri::command(async)]
async fn create_local_file(
    parent_path: String,
    name: String,
) -> Result<sftp_engine::LocalDirectory, String> {
    sftp_engine::create_local_file(parent_path, name).await
}

#[tauri::command(async)]
async fn rename_local_entry(
    path: String,
    new_name: String,
) -> Result<sftp_engine::LocalDirectory, String> {
    sftp_engine::rename_local(path, new_name).await
}

#[tauri::command(async)]
async fn delete_local_entry(
    path: String,
    is_directory: bool,
    recursive: bool,
) -> Result<sftp_engine::LocalDirectory, String> {
    sftp_engine::delete_local(path, is_directory, recursive).await
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
async fn transfer_local_to_sftp(
    host_id: String,
    local_path: String,
    remote_directory: String,
    overwrite: bool,
    target_name: Option<String>,
    transfer_id: String,
    on_progress: Channel<sftp_engine::TransferProgressEvent>,
    state: State<'_, AppState>,
) -> Result<sftp_engine::TransferResponse, String> {
    sftp_engine::transfer_local_to_remote(
        host_id,
        local_path,
        remote_directory,
        overwrite,
        target_name,
        transfer_id,
        on_progress,
        state,
    )
    .await
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
async fn transfer_sftp_to_local(
    host_id: String,
    remote_path: String,
    local_directory: String,
    overwrite: bool,
    target_name: Option<String>,
    transfer_id: String,
    on_progress: Channel<sftp_engine::TransferProgressEvent>,
    state: State<'_, AppState>,
) -> Result<sftp_engine::TransferResponse, String> {
    sftp_engine::transfer_remote_to_local(
        host_id,
        remote_path,
        local_directory,
        overwrite,
        target_name,
        transfer_id,
        on_progress,
        state,
    )
    .await
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
async fn transfer_sftp_to_sftp(
    source_host_id: String,
    remote_path: String,
    target_host_id: String,
    remote_directory: String,
    overwrite: bool,
    target_name: Option<String>,
    transfer_id: String,
    on_progress: Channel<sftp_engine::TransferProgressEvent>,
    state: State<'_, AppState>,
) -> Result<sftp_engine::TransferResponse, String> {
    sftp_engine::transfer_remote_to_remote(
        source_host_id,
        remote_path,
        target_host_id,
        remote_directory,
        overwrite,
        target_name,
        transfer_id,
        on_progress,
        state,
    )
    .await
}

#[tauri::command(async)]
async fn copy_local_entry(
    local_path: String,
    local_directory: String,
    overwrite: bool,
    target_name: Option<String>,
    transfer_id: String,
    on_progress: Channel<sftp_engine::TransferProgressEvent>,
) -> Result<sftp_engine::TransferResponse, String> {
    sftp_engine::copy_local_to_local_tracked(
        local_path,
        local_directory,
        overwrite,
        target_name,
        transfer_id,
        on_progress,
    )
    .await
}

#[tauri::command]
fn cancel_file_transfer(transfer_id: String) -> Result<(), String> {
    sftp_engine::cancel_transfer(transfer_id)
}

#[tauri::command(async)]
async fn prepare_file_drag(
    host_id: Option<String>,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<sftp_engine::PreparedFileDrag, String> {
    sftp_engine::prepare_file_drag(host_id, paths, state).await
}

#[tauri::command(async)]
async fn cleanup_prepared_drag(staging_root: String) -> Result<(), String> {
    sftp_engine::cleanup_prepared_drag(staging_root).await
}

#[tauri::command(async)]
async fn start_file_drag(
    paths: Vec<String>,
    icon_path: String,
    app: AppHandle,
    window: tauri::Window,
) -> Result<(), String> {
    if paths.is_empty() {
        return Err("Selecciona al menos un elemento para arrastrar".into());
    }
    let paths = paths
        .into_iter()
        .map(|path| {
            std::fs::canonicalize(path)
                .map_err(|error| format!("No se pudo preparar un elemento para arrastrar: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let icon = std::fs::canonicalize(icon_path)
        .map_err(|error| format!("No se pudo preparar el icono de arrastre: {error}"))?;
    let (sender, receiver) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        #[cfg(target_os = "linux")]
        let result = window
            .gtk_window()
            .map_err(|error| error.to_string())
            .and_then(|gtk_window| {
                drag::start_drag(
                    &gtk_window,
                    drag::DragItem::Files(paths),
                    drag::Image::File(icon),
                    |_, _| {},
                    drag::Options::default(),
                )
                .map_err(|error| error.to_string())
            });
        #[cfg(not(target_os = "linux"))]
        let result = drag::start_drag(
            &window,
            drag::DragItem::Files(paths),
            drag::Image::File(icon),
            |_, _| {},
            drag::Options::default(),
        )
        .map_err(|error| error.to_string());
        let _ = sender.send(result);
    })
    .map_err(|error| format!("No se pudo iniciar el arrastre nativo: {error}"))?;
    receiver
        .recv()
        .map_err(|error| format!("El arrastre nativo se interrumpió: {error}"))?
}

/// Abre un enlace detectado en la salida de la terminal con el navegador del
/// sistema. Solo se permite http/https: un servidor remoto podría imprimir
/// texto con esquemas peligrosos (`file:`, `javascript:`) y el usuario no
/// distingue el destino real antes de hacer clic.
#[tauri::command(async)]
fn open_external_url(url: String, app: AppHandle) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "El enlace no es válido".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Solo se pueden abrir enlaces http o https".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

fn open_app_state(data_dir: &std::path::Path) -> Result<AppState, Box<dyn std::error::Error>> {
    std::fs::create_dir_all(data_dir)?;
    let instance_lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data_dir.join("instance.lock"))?;
    fs2::FileExt::try_lock_exclusive(&instance_lock)
        .map_err(|_| "Nexora ya está abierto en otra instancia")?;
    let database = Database::open(std::path::Path::new(":memory:"))?;
    let mut key = vec![0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut key);
    let secrets = SecretStore::with_key(key, None)?;
    Ok(AppState {
        _instance_lock: instance_lock,
        database: Mutex::new(database),
        secrets: Mutex::new(secrets),
        ssh: ssh_engine::SshRuntime::default(),
        sftp: sftp_engine::SftpRuntime::default(),
        restoring: std::sync::atomic::AtomicBool::new(false),
        vault_open: std::sync::atomic::AtomicBool::new(false),
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            app.manage(open_app_state(&app.path().app_data_dir()?)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_snapshot,
            list_tunnels,
            start_tunnel,
            stop_tunnel,
            stop_all_tunnels,
            save_snapshot,
            save_host_profile,
            create_temporary_host,
            load_temporary_hosts,
            promote_temporary_host,
            forget_temporary_host,
            save_identity_profile,
            get_identity_status,
            save_duplicated_host,
            get_secret_status,
            reveal_host_password,
            start_ssh_session,
            start_local_session,
            write_ssh_session,
            resize_ssh_session,
            disconnect_ssh_session,
            trust_ssh_host_key,
            connect_sftp,
            disconnect_sftp,
            list_sftp_directory,
            read_sftp_text_file,
            save_sftp_text_file,
            create_sftp_directory,
            create_sftp_file,
            rename_sftp_entry,
            delete_sftp_entry,
            chmod_sftp_entry,
            upload_sftp_file,
            overwrite_sftp_file,
            download_sftp_file,
            list_local_directory,
            create_local_directory,
            create_local_file,
            rename_local_entry,
            delete_local_entry,
            transfer_local_to_sftp,
            transfer_sftp_to_local,
            transfer_sftp_to_sftp,
            copy_local_entry,
            cancel_file_transfer,
            prepare_file_drag,
            cleanup_prepared_drag,
            start_file_drag,
            vault::vault_info,
            vault::choose_vault_folder,
            vault::unlock_vault,
            vault::close_vault,
            open_external_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nexora SSH");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ConnectionProfile, GroupDefaults, Host, HostGroup, HostSecret, Identity};

    fn state_fixture(path: &std::path::Path) -> AppState {
        let mut state = open_app_state(path).unwrap();
        let database = Database::open(&path.join("nexora.db")).unwrap();
        let secrets =
            SecretStore::with_key(vec![0x42; 32], database.secret_payload().unwrap()).unwrap();
        state.database = Mutex::new(database);
        state.secrets = Mutex::new(secrets);
        state
            .vault_open
            .store(true, std::sync::atomic::Ordering::SeqCst);
        state
    }

    fn host(id: &str, address: &str) -> Host {
        Host {
            protocol: "ssh".into(),
            id: id.into(),
            vault_id: "vault".into(),
            group_id: None,
            name: id.into(),
            address: address.into(),
            port: 22,
            username: "ubuntu".into(),
            auth_method: "password".into(),
            key_path: None,
            favorite: false,
            color: "#2dd4bf".into(),
            tags: Vec::new(),
            note: String::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    fn known_host(id: &str, host_id: &str) -> KnownHost {
        KnownHost {
            id: id.into(),
            host_id: host_id.into(),
            algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:test".into(),
            public_key: "ssh-ed25519 AAAAtest".into(),
            trusted_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    fn snapshot(hosts: Vec<Host>, known_hosts: Vec<KnownHost>) -> AppSnapshot {
        AppSnapshot {
            schema_version: 1,
            vaults: Vec::new(),
            groups: Vec::new(),
            hosts,
            known_hosts,
            productivity: Default::default(),
        }
    }

    #[test]
    fn old_database_migrates_protocol_and_keeps_telnet_after_reopening() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("protocol.db");
        let mut database = Database::open(&path).unwrap();
        let mut snapshot = database.load_snapshot().unwrap();
        let mut server = host("legacy", "127.0.0.1");
        server.vault_id = snapshot.vaults[0].id.clone();
        snapshot.hosts.push(server);
        database.save_snapshot(&snapshot).unwrap();
        drop(database);
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch("ALTER TABLE hosts DROP COLUMN protocol;")
            .unwrap();
        drop(connection);
        let mut database = Database::open(&path).unwrap();
        let mut migrated = database.load_snapshot().unwrap();
        assert_eq!(migrated.hosts[0].protocol, "ssh");
        migrated.hosts[0].protocol = "telnet".into();
        migrated.hosts[0].port = 23;
        database.save_snapshot(&migrated).unwrap();
        drop(database);
        assert_eq!(
            Database::open(&path).unwrap().load_snapshot().unwrap(),
            migrated
        );
    }

    fn inherited_fixture() -> AppSnapshot {
        let mut server = host("server", "localhost");
        server.group_id = Some("child".into());
        let mut value = snapshot(vec![server], vec![known_host("key", "server")]);
        value.groups = vec![
            HostGroup {
                id: "parent".into(),
                vault_id: "vault".into(),
                parent_id: None,
                name: "Parent".into(),
                sort_order: 0,
            },
            HostGroup {
                id: "child".into(),
                vault_id: "vault".into(),
                parent_id: Some("parent".into()),
                name: "Child".into(),
                sort_order: 1,
            },
        ];
        value.productivity.identities = vec![Identity {
            id: "access".into(),
            vault_id: "vault".into(),
            name: "Access".into(),
            username: "identity-user".into(),
            auth_method: "private_key".into(),
            updated_at: "now".into(),
        }];
        value.productivity.group_defaults = vec![
            GroupDefaults {
                group_id: "parent".into(),
                username: Some("parent-user".into()),
                port: Some(2222),
                identity_id: Some("access".into()),
                keepalive_seconds: Some(15),
            },
            GroupDefaults {
                group_id: "child".into(),
                username: Some("child-user".into()),
                keepalive_seconds: Some(0),
                ..Default::default()
            },
        ];
        value.productivity.connection_profiles = vec![ConnectionProfile {
            host_id: "server".into(),
            inherit_username: true,
            inherit_port: true,
            inherit_identity: true,
            inherit_keepalive: true,
            ..Default::default()
        }];
        value
    }

    #[test]
    fn inherited_profiles_resolve_nearest_values_and_preserve_own_overrides() {
        let mut value = inherited_fixture();
        let resolved = connection_profile::resolve(&value, &value.hosts[0]).unwrap();
        assert_eq!(resolved.host.username, "child-user");
        assert_eq!(resolved.host.port, 2222);
        assert_eq!(resolved.host.auth_method, "private_key");
        assert_eq!(resolved.identity_id.as_deref(), Some("access"));
        assert_eq!(resolved.keepalive_seconds, Some(0));
        value.productivity.connection_profiles[0] = ConnectionProfile {
            host_id: "server".into(),
            keepalive_seconds: Some(60),
            ..Default::default()
        };
        let own = connection_profile::resolve(&value, &value.hosts[0]).unwrap();
        assert_eq!(own.host, value.hosts[0]);
        assert_eq!(own.identity_id, None);
        assert_eq!(own.keepalive_seconds, Some(60));
        value.productivity.connection_profiles.clear();
        assert_eq!(
            connection_profile::resolve(&value, &value.hosts[0])
                .unwrap()
                .host,
            value.hosts[0]
        );
    }

    #[test]
    fn legacy_session_metadata_remains_readable_but_is_never_applied() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tmux-fixture.db");
        let mut database = Database::open(&path).unwrap();
        let mut value = inherited_fixture();
        let mut vault = database.load_snapshot().unwrap().vaults.remove(0);
        vault.id = "vault".into();
        value.vaults.push(vault);
        value.productivity.connection_profiles[0].tmux_session = Some("work_42".into());
        value.productivity.connection_profiles[0].environment = Some("Producción".into());
        database.save_snapshot(&value).unwrap();
        for environment in ["".to_string(), "  ".into(), "x".repeat(61), "a\0b".into()] {
            let mut invalid = value.clone();
            invalid.productivity.connection_profiles[0].environment = Some(environment);
            assert!(database.save_snapshot(&invalid).is_err());
            assert_eq!(database.load_snapshot().unwrap(), value);
        }
        drop(database);
        let restored = Database::open(&path).unwrap().load_snapshot().unwrap();
        assert_eq!(restored, value);
        assert_eq!(
            connection_profile::resolve(&restored, &restored.hosts[0])
                .unwrap()
                .tmux_session
                .as_deref(),
            None
        );
    }

    #[test]
    fn identity_username_fallback_matches_inherited_and_explicit_profiles() {
        let mut value = inherited_fixture();
        value.hosts[0].username.clear();
        value.productivity.group_defaults[1].username = Some(String::new());
        assert_eq!(
            connection_profile::resolve(&value, &value.hosts[0])
                .unwrap()
                .host
                .username,
            "identity-user"
        );
        value.productivity.connection_profiles[0].inherit_username = false;
        assert_eq!(
            connection_profile::resolve(&value, &value.hosts[0])
                .unwrap()
                .host
                .username,
            "identity-user"
        );
        value.productivity.identities.clear();
        assert!(connection_profile::resolve(&value, &value.hosts[0]).is_err());
    }

    #[test]
    fn empty_group_defaults_preserve_all_explicit_host_fallbacks() {
        let mut value = inherited_fixture();
        value.productivity.group_defaults.clear();
        value.productivity.connection_profiles[0].identity_id = Some("access".into());
        value.productivity.connection_profiles[0].keepalive_seconds = Some(60);
        let resolved = connection_profile::resolve(&value, &value.hosts[0]).unwrap();
        assert_eq!(resolved.host.username, "ubuntu");
        assert_eq!(resolved.host.port, 22);
        assert_eq!(resolved.identity_id.as_deref(), Some("access"));
        assert_eq!(resolved.keepalive_seconds, Some(60));
    }

    #[tokio::test]
    async fn shared_encrypted_identity_authenticates_real_loopback_ssh_and_sftp() {
        let server = crate::test_server::TestServer::start("fixture.txt").await;
        let directory = tempfile::tempdir().unwrap();
        let state = state_fixture(directory.path());
        let mut value = state.database.lock().unwrap().load_snapshot().unwrap();
        let vault_id = value.vaults[0].id.clone();
        let mut profile_host = host("server", "127.0.0.1");
        profile_host.vault_id = vault_id.clone();
        profile_host.username.clear();
        profile_host.group_id = Some(value.groups[0].id.clone());
        let group_id = value.groups[0].id.clone();
        value.hosts.push(profile_host);
        value.productivity.identities.push(Identity {
            id: "shared".into(),
            vault_id,
            name: "Access".into(),
            username: "test".into(),
            auth_method: "password".into(),
            updated_at: "now".into(),
        });
        value.productivity.group_defaults.push(GroupDefaults {
            group_id,
            port: Some(server.port),
            identity_id: Some("shared".into()),
            ..Default::default()
        });
        value
            .productivity
            .connection_profiles
            .push(ConnectionProfile {
                host_id: "server".into(),
                inherit_port: true,
                inherit_identity: true,
                ..Default::default()
            });
        {
            let mut database = state.database.lock().unwrap();
            let mut store = state.secrets.lock().unwrap();
            let mut staged = store.staged();
            staged
                .replace(
                    "identity:shared",
                    Some(HostSecret {
                        password: Some("fixture-password".into()),
                        private_key: None,
                        private_key_name: None,
                        key_passphrase: None,
                    }),
                )
                .unwrap();
            commit_profile(&mut database, &mut store, &value, staged).unwrap();
        }
        for _ in 0..2 {
            let (target, _, secret, _, _) =
                connection_profile::load_material("server", &state).unwrap();
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
                    .any(|entry| entry.file_name() == "fixture.txt")
            );
            sftp.close().await.unwrap();
        }
    }

    #[test]
    fn changing_an_inherited_endpoint_invalidates_trust_and_duplicate_trust() {
        let current = inherited_fixture();
        let mut next = current.clone();
        next.productivity.group_defaults[0].port = Some(2223);
        preserve_trusted_host_keys(&mut next, &current);
        assert!(next.known_hosts.is_empty());
        let mut copy = current.clone();
        let mut copied_host = copy.hosts[0].clone();
        copied_host.id = "copy".into();
        copy.hosts.push(copied_host);
        let mut profile = copy.productivity.connection_profiles[0].clone();
        profile.host_id = "copy".into();
        profile.inherit_port = false;
        copy.productivity.connection_profiles.push(profile);
        copy.known_hosts.push(known_host("copy-key", "copy"));
        preserve_duplicated_host_key(&mut copy, &current, "server", "copy");
        assert!(copy.known_hosts.iter().all(|key| key.host_id != "copy"));
    }

    #[test]
    fn shared_identity_ciphertext_survives_reopen_and_failed_commit_without_leaking_to_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let state = state_fixture(directory.path());
        let mut value = state.database.lock().unwrap().load_snapshot().unwrap();
        let vault_id = value.vaults[0].id.clone();
        let mut server = host("server", "localhost");
        server.vault_id = vault_id.clone();
        value.hosts.push(server.clone());
        let mut second = server;
        second.id = "second".into();
        value.hosts.push(second);
        value.productivity.identities = vec![Identity {
            id: "access".into(),
            vault_id,
            name: "Access".into(),
            username: "identity-user".into(),
            auth_method: "password".into(),
            updated_at: "now".into(),
        }];
        value.productivity.connection_profiles = ["server", "second"]
            .map(|id| ConnectionProfile {
                host_id: id.into(),
                identity_id: Some("access".into()),
                ..Default::default()
            })
            .into();
        {
            let mut database = state.database.lock().unwrap();
            let mut store = state.secrets.lock().unwrap();
            let mut staged = store.staged();
            staged
                .replace(
                    "identity:access",
                    Some(HostSecret {
                        password: Some("SHARED_FIXTURE_ONLY".into()),
                        private_key: None,
                        private_key_name: None,
                        key_passphrase: None,
                    }),
                )
                .unwrap();
            commit_profile(&mut database, &mut store, &value, staged).unwrap();
        }
        for id in ["server", "second"] {
            assert_eq!(
                connection_profile::load_material(id, &state)
                    .unwrap()
                    .2
                    .password
                    .as_deref(),
                Some("SHARED_FIXTURE_ONLY")
            );
        }
        assert!(
            connection_profile::load_own_secret("server", &state)
                .unwrap()
                .password
                .is_none()
        );
        assert!(connection_profile::load_own_secret("identity:access", &state).is_err());
        assert!(
            !serde_json::to_string(&value)
                .unwrap()
                .contains("SHARED_FIXTURE_ONLY")
        );
        drop(state);
        let state = state_fixture(directory.path());
        assert_eq!(
            connection_profile::load_material("server", &state)
                .unwrap()
                .2
                .password
                .as_deref(),
            Some("SHARED_FIXTURE_ONLY")
        );
        let connection = rusqlite::Connection::open(directory.path().join("nexora.db")).unwrap();
        connection.execute_batch("CREATE TRIGGER fail_identity BEFORE UPDATE ON productivity BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;").unwrap();
        {
            let mut database = state.database.lock().unwrap();
            let mut store = state.secrets.lock().unwrap();
            let mut staged = store.staged();
            staged
                .replace(
                    "identity:access",
                    Some(HostSecret {
                        password: Some("FAILED_FIXTURE_ONLY".into()),
                        private_key: None,
                        private_key_name: None,
                        key_passphrase: None,
                    }),
                )
                .unwrap();
            value.productivity.identities[0].name = "Failed change".into();
            assert!(commit_profile(&mut database, &mut store, &value, staged).is_err());
            assert_eq!(
                database.load_snapshot().unwrap().productivity.identities[0].name,
                "Access"
            );
        }
        assert_eq!(
            connection_profile::load_material("second", &state)
                .unwrap()
                .2
                .password
                .as_deref(),
            Some("SHARED_FIXTURE_ONLY")
        );
        connection
            .execute_batch("DROP TRIGGER fail_identity;")
            .unwrap();
        value.productivity.identities.clear();
        value.productivity.connection_profiles.clear();
        {
            let mut database = state.database.lock().unwrap();
            let mut store = state.secrets.lock().unwrap();
            let staged = store.staged();
            commit_profile(&mut database, &mut store, &value, staged).unwrap();
        }
        assert!(
            state
                .secrets
                .lock()
                .unwrap()
                .get("identity:access")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn duplicated_host_keeps_trust_for_the_same_endpoint() {
        let source_known = known_host("known-source", "source");
        let requested_copy = known_host("known-copy", "copy");
        let current = snapshot(
            vec![host("source", "server.local")],
            vec![source_known.clone()],
        );
        let mut duplicated = snapshot(
            vec![host("source", "server.local"), host("copy", "server.local")],
            vec![source_known, requested_copy.clone()],
        );

        preserve_duplicated_host_key(&mut duplicated, &current, "source", "copy");

        assert_eq!(duplicated.known_hosts.len(), 2);
        assert_eq!(
            duplicated
                .known_hosts
                .iter()
                .find(|known| known.host_id == "copy"),
            Some(&requested_copy)
        );
    }

    #[test]
    fn duplicated_host_requires_verification_if_the_endpoint_differs() {
        let source_known = known_host("known-source", "source");
        let current = snapshot(
            vec![host("source", "server.local")],
            vec![source_known.clone()],
        );
        let mut duplicated = snapshot(
            vec![host("source", "server.local"), host("copy", "other.local")],
            vec![source_known, known_host("known-copy", "copy")],
        );

        preserve_duplicated_host_key(&mut duplicated, &current, "source", "copy");

        assert_eq!(duplicated.known_hosts.len(), 1);
        assert!(
            duplicated
                .known_hosts
                .iter()
                .all(|known| known.host_id != "copy")
        );
    }

    #[test]
    fn sftp_commands_are_exposed_by_the_tauri_acl() {
        let build_manifest = include_str!("../build.rs");
        let capability = include_str!("../capabilities/default.json");
        for command in [
            "create_temporary_host",
            "load_temporary_hosts",
            "promote_temporary_host",
            "forget_temporary_host",
            "start_local_session",
            "save_identity_profile",
            "get_identity_status",
            "read_sftp_text_file",
            "save_sftp_text_file",
            "connect_sftp",
            "disconnect_sftp",
            "list_sftp_directory",
            "create_sftp_directory",
            "create_sftp_file",
            "rename_sftp_entry",
            "delete_sftp_entry",
            "chmod_sftp_entry",
            "upload_sftp_file",
            "overwrite_sftp_file",
            "download_sftp_file",
            "list_local_directory",
            "create_local_directory",
            "create_local_file",
            "rename_local_entry",
            "delete_local_entry",
            "transfer_local_to_sftp",
            "transfer_sftp_to_local",
            "transfer_sftp_to_sftp",
            "copy_local_entry",
            "cancel_file_transfer",
            "prepare_file_drag",
            "cleanup_prepared_drag",
            "start_file_drag",
        ] {
            assert!(
                build_manifest.contains(&format!("\"{command}\"")),
                "{command} no está declarado en el manifiesto de comandos"
            );
            let permission = format!("\"allow-{}\"", command.replace('_', "-"));
            assert!(
                capability.contains(&permission),
                "{command} no está permitido por la capability principal"
            );
        }
    }

    #[test]
    fn optimistic_guard_rejects_stale_metadata_but_allows_new_trust_and_ordering() {
        let original = snapshot(vec![host("a", "server"), host("b", "other")], vec![]);
        let mut changed = original.clone();
        changed.hosts.reverse();
        changed.known_hosts.push(known_host("key", "a"));
        assert!(ensure_current(&original, &changed).is_ok());
        changed.hosts[0].favorite = true;
        assert!(ensure_current(&original, &changed).is_err());
    }

    #[test]
    fn startup_is_locked_and_creates_no_implicit_vault() {
        let directory = tempfile::tempdir().unwrap();
        let state = open_app_state(directory.path()).unwrap();
        assert!(state.ensure_available().is_err());
        assert!(!directory.path().join("nexora.db").exists());
        assert!(open_app_state(directory.path()).is_err());
    }
}
