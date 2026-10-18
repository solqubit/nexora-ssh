use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, LazyLock, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use chrono::{DateTime, Utc};
use russh::{
    Disconnect,
    client::{self},
    keys::ssh_key::HashAlg,
};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Manager, State, ipc::Channel};
use tauri_plugin_dialog::DialogExt;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{Mutex, watch},
};
use uuid::Uuid;

use crate::{
    AppState,
    models::KnownHost,
    path_safety::{local_child, reject_remote_self_copy, reject_symlink, validate_component},
    ssh_engine::PendingHostKey,
};

const OPERATION_TIMEOUT: Duration = Duration::from_secs(45);
const VERIFY_UNKNOWN: u8 = 1;
const VERIFY_CHANGED: u8 = 2;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified_at: Option<String>,
    pub permissions: String,
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpDirectory {
    pub path: String,
    pub entries: Vec<SftpEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRoot {
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBreadcrumb {
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDirectory {
    pub path: String,
    pub parent_path: Option<String>,
    pub roots: Vec<LocalRoot>,
    pub breadcrumbs: Vec<LocalBreadcrumb>,
    pub entries: Vec<LocalEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum SftpConnectResponse {
    Failed {
        message: String,
        retryable: bool,
    },
    Connected {
        directory: SftpDirectory,
    },
    TrustRequired {
        verification_host_id: String,
        algorithm: String,
        fingerprint: String,
        address: String,
        challenge_id: Option<String>,
    },
    HostKeyChanged {
        verification_host_id: String,
        algorithm: String,
        fingerprint: String,
        address: String,
        challenge_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum SftpUploadResponse {
    Cancelled,
    Conflict {
        name: String,
        path: String,
        upload_token: String,
    },
    Uploaded {
        name: String,
        path: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum TransferResponse {
    Conflict {
        name: String,
        target_path: String,
        is_directory: bool,
    },
    Transferred {
        name: String,
        target_path: String,
        file_count: u64,
        total_bytes: u64,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedFileDrag {
    pub paths: Vec<String>,
    pub icon_path: String,
    pub staging_root: Option<String>,
    pub estimated_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgressEvent {
    pub transfer_id: String,
    pub transferred_bytes: u64,
    pub file_count: u64,
    pub total_bytes: u64,
}

static TRANSFER_CANCELLATIONS: LazyLock<StdMutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

struct TransferProgress {
    transfer_id: String,
    cancelled: Arc<AtomicBool>,
    transferred_bytes: AtomicU64,
    file_count: AtomicU64,
    total_bytes: AtomicU64,
    last_emit: StdMutex<Instant>,
    on_progress: Channel<TransferProgressEvent>,
}

impl TransferProgress {
    fn register(
        transfer_id: String,
        on_progress: Channel<TransferProgressEvent>,
    ) -> Result<Self, String> {
        let cancelled = Arc::new(AtomicBool::new(false));
        TRANSFER_CANCELLATIONS
            .lock()
            .map_err(|_| "No se pudo iniciar el control de transferencia".to_string())?
            .insert(transfer_id.clone(), cancelled.clone());
        Ok(Self {
            transfer_id,
            cancelled,
            transferred_bytes: AtomicU64::new(0),
            file_count: AtomicU64::new(0),
            total_bytes: AtomicU64::new(0),
            last_emit: StdMutex::new(Instant::now()),
            on_progress,
        })
    }

    fn ensure_active(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Relaxed) {
            Err("TRANSFER_CANCELLED".into())
        } else {
            Ok(())
        }
    }

    fn add_bytes(&self, bytes: u64) {
        self.transferred_bytes.fetch_add(bytes, Ordering::Relaxed);
        self.emit(false);
    }

    fn set_total(&self, total_bytes: u64) {
        self.total_bytes.store(total_bytes, Ordering::Relaxed);
        self.emit(true);
    }

    fn complete_file(&self) {
        self.file_count.fetch_add(1, Ordering::Relaxed);
        self.emit(true);
    }

    fn emit(&self, force: bool) {
        let Ok(mut last_emit) = self.last_emit.lock() else {
            return;
        };
        if !force && last_emit.elapsed() < Duration::from_millis(90) {
            return;
        }
        *last_emit = Instant::now();
        let _ = self.on_progress.send(TransferProgressEvent {
            transfer_id: self.transfer_id.clone(),
            transferred_bytes: self.transferred_bytes.load(Ordering::Relaxed),
            file_count: self.file_count.load(Ordering::Relaxed),
            total_bytes: self.total_bytes.load(Ordering::Relaxed),
        });
    }
}

impl Drop for TransferProgress {
    fn drop(&mut self) {
        self.emit(true);
        if let Ok(mut transfers) = TRANSFER_CANCELLATIONS.lock() {
            transfers.remove(&self.transfer_id);
        }
    }
}

pub fn cancel_transfer(transfer_id: String) -> Result<(), String> {
    let transfers = TRANSFER_CANCELLATIONS
        .lock()
        .map_err(|_| "No se pudo acceder al control de transferencias".to_string())?;
    if let Some(cancelled) = transfers.get(&transfer_id) {
        cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

pub(crate) fn has_active_transfers() -> Result<bool, String> {
    Ok(!TRANSFER_CANCELLATIONS
        .lock()
        .map_err(|_| "El control de transferencias está ocupado")?
        .is_empty())
}

#[derive(Debug, Clone)]
struct HostKeyPrompt {
    host_id: String,
    algorithm: String,
    fingerprint: String,
    address: String,
    challenge_id: Option<String>,
}

struct ActiveSftpSession {
    connection: crate::ssh_route::RouteConnection<SftpClientHandler>,
    sftp: SftpSession,
    editor_scope: Uuid,
}

struct PendingUpload {
    host_id: String,
    remote_directory: String,
    local_path: std::path::PathBuf,
}

#[derive(Default)]
pub struct SftpRuntime {
    sessions: Mutex<HashMap<String, Arc<Mutex<ActiveSftpSession>>>>,
    pending_uploads: Mutex<HashMap<String, PendingUpload>>,
    connecting: StdMutex<HashMap<String, (Uuid, watch::Sender<bool>)>>,
}

impl SftpRuntime {
    pub(crate) async fn is_idle(&self) -> Result<bool, String> {
        let sessions_empty = self.sessions.lock().await.is_empty();
        Ok(sessions_empty
            && self
                .connecting
                .lock()
                .map_err(|_| "El gestor SFTP está ocupado")?
                .is_empty())
    }
    async fn get(&self, host_id: &str) -> Result<Arc<Mutex<ActiveSftpSession>>, String> {
        self.sessions
            .lock()
            .await
            .get(host_id)
            .cloned()
            .ok_or_else(|| "La sesión SFTP no está conectada".to_string())
    }

    async fn remove(&self, host_id: &str) -> Option<Arc<Mutex<ActiveSftpSession>>> {
        self.sessions.lock().await.remove(host_id)
    }

    async fn clear_pending_for_host(&self, host_id: &str) {
        self.pending_uploads
            .lock()
            .await
            .retain(|_, pending| pending.host_id != host_id);
    }
}

pub async fn list_local(path: Option<String>) -> Result<LocalDirectory, String> {
    let requested = path
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_local_path);
    read_local_directory(absolute_local_path(requested)?).await
}

pub async fn create_local_directory(
    parent_path: String,
    name: String,
) -> Result<LocalDirectory, String> {
    validate_local_name(&name)?;
    let parent = absolute_local_path(PathBuf::from(parent_path))?;
    let target = parent.join(name.trim());
    tokio::fs::create_dir(&target)
        .await
        .map_err(|error| format!("No se pudo crear la carpeta local: {error}"))?;
    read_local_directory(parent).await
}

pub async fn create_local_file(
    parent_path: String,
    name: String,
) -> Result<LocalDirectory, String> {
    validate_local_name(&name)?;
    let parent = absolute_local_path(PathBuf::from(parent_path))?;
    let target = parent.join(name.trim());
    if tokio::fs::try_exists(&target)
        .await
        .map_err(|error| format!("No se pudo comprobar el archivo local: {error}"))?
    {
        return Err("Ya existe un elemento local con ese nombre".into());
    }
    tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .await
        .map_err(|error| format!("No se pudo crear el archivo local: {error}"))?;
    read_local_directory(parent).await
}

pub async fn rename_local(path: String, new_name: String) -> Result<LocalDirectory, String> {
    validate_local_name(&new_name)?;
    let source = absolute_local_path(PathBuf::from(path))?;
    let parent = source
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "No se puede renombrar una raíz del sistema".to_string())?;
    let destination = parent.join(new_name.trim());
    if tokio::fs::try_exists(&destination)
        .await
        .map_err(|error| format!("No se pudo comprobar el destino local: {error}"))?
    {
        return Err("Ya existe un elemento local con ese nombre".into());
    }
    tokio::fs::rename(&source, &destination)
        .await
        .map_err(|error| format!("No se pudo renombrar el elemento local: {error}"))?;
    read_local_directory(parent).await
}

pub async fn delete_local(
    path: String,
    is_directory: bool,
    recursive: bool,
) -> Result<LocalDirectory, String> {
    let target = absolute_local_path(PathBuf::from(path))?;
    let parent = target
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "No se puede eliminar una raíz del sistema".to_string())?;
    if is_directory {
        if recursive {
            tokio::fs::remove_dir_all(&target)
                .await
                .map_err(|error| format!("No se pudo eliminar la carpeta local: {error}"))?;
        } else {
            tokio::fs::remove_dir(&target).await.map_err(|error| {
                format!("No se pudo eliminar la carpeta local. Debe estar vacía: {error}")
            })?;
        }
    } else {
        tokio::fs::remove_file(&target)
            .await
            .map_err(|error| format!("No se pudo eliminar el archivo local: {error}"))?;
    }
    read_local_directory(parent).await
}

async fn read_local_directory(path: PathBuf) -> Result<LocalDirectory, String> {
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("No se pudo abrir la carpeta local: {error}"))?;
    if !metadata.is_dir() {
        return Err("La ruta local no es una carpeta".into());
    }

    let mut reader = tokio::fs::read_dir(&path)
        .await
        .map_err(|error| format!("No se pudo listar la carpeta local: {error}"))?;
    let mut entries = Vec::new();
    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|error| format!("No se pudo leer una entrada local: {error}"))?
    {
        let entry_path = entry.path();
        let file_type = entry
            .file_type()
            .await
            .map_err(|error| format!("No se pudo identificar una entrada local: {error}"))?;
        let metadata = entry
            .metadata()
            .await
            .map_err(|error| format!("No se pudieron leer los metadatos locales: {error}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let modified_at = metadata
            .modified()
            .ok()
            .map(|time| DateTime::<Utc>::from(time).to_rfc3339());
        entries.push(LocalEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            is_directory: metadata.is_dir(),
            is_symlink: file_type.is_symlink(),
            size: metadata.len(),
            modified_at,
        });
    }
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    let parent_path = path
        .parent()
        .filter(|parent| *parent != path)
        .map(|parent| parent.to_string_lossy().into_owned());
    let mut breadcrumb_paths = path
        .ancestors()
        .filter(|ancestor| !ancestor.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    breadcrumb_paths.reverse();
    let breadcrumbs = breadcrumb_paths
        .into_iter()
        .map(|breadcrumb| LocalBreadcrumb {
            label: breadcrumb
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| breadcrumb.to_string_lossy().into_owned()),
            path: breadcrumb.to_string_lossy().into_owned(),
        })
        .collect();

    Ok(LocalDirectory {
        path: path.to_string_lossy().into_owned(),
        parent_path,
        roots: local_roots(),
        breadcrumbs,
        entries,
    })
}

fn default_local_path() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn absolute_local_path(path: PathBuf) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir()
            .map(|current| current.join(path))
            .map_err(|error| format!("No se pudo resolver la ruta local: {error}"))
    }
}

#[cfg(target_os = "windows")]
fn local_roots() -> Vec<LocalRoot> {
    (b'A'..=b'Z')
        .filter_map(|letter| {
            let path = format!("{}:\\", letter as char);
            Path::new(&path).exists().then(|| LocalRoot {
                label: path.clone(),
                path,
            })
        })
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn local_roots() -> Vec<LocalRoot> {
    vec![LocalRoot {
        label: "/".into(),
        path: "/".into(),
    }]
}

#[allow(clippy::too_many_arguments)]
pub async fn connect(
    host_id: String,
    path: Option<String>,
    keepalive_seconds: u64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SftpConnectResponse, String> {
    let generation = Uuid::new_v4();
    let (cancellation, mut cancelled) = watch::channel(false);
    {
        let mut connecting = state
            .sftp
            .connecting
            .lock()
            .map_err(|_| "El gestor SFTP está ocupado")?;
        state.ensure_available()?;
        if connecting.contains_key(&host_id) {
            return Err("Este servidor ya está conectando".into());
        }
        connecting.insert(host_id.clone(), (generation, cancellation));
    }
    let result = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(240), connect_inner(host_id.clone(), path, keepalive_seconds, generation, app, state.clone())) => result.map_err(|_| "La conexión SFTP agotó el tiempo de espera".to_string()).and_then(|result| result),
        _ = cancelled.changed() => Err("La conexión SFTP fue cancelada".into()),
    };
    if let Ok(mut connecting) = state.sftp.connecting.lock()
        && connecting
            .get(&host_id)
            .is_some_and(|(id, _)| *id == generation)
    {
        connecting.remove(&host_id);
    }
    result
}

async fn connect_inner(
    host_id: String,
    path: Option<String>,
    keepalive_seconds: u64,
    generation: Uuid,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SftpConnectResponse, String> {
    let route = crate::connection_profile::load_route(&host_id, &state)?;

    if let Ok(existing) = state.sftp.get(&host_id).await {
        let active = existing.lock().await;
        if let Ok(directory) =
            read_directory(&active.sftp, path.clone().unwrap_or_else(|| ".".into())).await
        {
            state.ensure_available()?;
            if !state
                .sftp
                .connecting
                .lock()
                .map_err(|_| "El gestor SFTP está ocupado")?
                .get(&host_id)
                .is_some_and(|(id, _)| *id == generation)
            {
                return Err("La conexión SFTP fue cancelada".into());
            }
            return Ok(SftpConnectResponse::Connected { directory });
        }
    }
    if let Some(previous) = state.sftp.remove(&host_id).await {
        close_session(previous).await;
    }
    state.sftp.clear_pending_for_host(&host_id).await;

    let verification = Arc::new(AtomicU8::new(0));
    let prompt = Arc::new(StdMutex::new(None));
    let connection = match crate::ssh_route::connect(
        &route,
        keepalive_seconds,
        |material| SftpClientHandler {
            app: app.clone(),
            host_id: material.0.id.clone(),
            address: format!(
                "{} · {}:{}",
                material.0.name, material.0.address, material.0.port
            ),
            endpoint: (material.0.address.clone(), material.0.port),
            known_host: material.1.clone(),
            verification: verification.clone(),
            prompt: prompt.clone(),
        },
        |_, _| {},
    )
    .await
    {
        Ok(connection) => connection,
        Err(error) => {
            let key_prompt = prompt.lock().ok().and_then(|value| value.clone());
            return match (verification.load(Ordering::SeqCst), key_prompt) {
                (VERIFY_UNKNOWN, Some(prompt)) => Ok(SftpConnectResponse::TrustRequired {
                    verification_host_id: prompt.host_id,
                    algorithm: prompt.algorithm,
                    fingerprint: prompt.fingerprint,
                    address: prompt.address,
                    challenge_id: prompt.challenge_id,
                }),
                (VERIFY_CHANGED, Some(prompt)) => Ok(SftpConnectResponse::HostKeyChanged {
                    verification_host_id: prompt.host_id,
                    algorithm: prompt.algorithm,
                    fingerprint: prompt.fingerprint,
                    address: prompt.address,
                    challenge_id: prompt.challenge_id,
                }),
                _ => Ok(SftpConnectResponse::Failed {
                    message: error.message,
                    retryable: error.retryable,
                }),
            };
        }
    };
    drop(route);
    let channel = connection
        .channel_open_session()
        .await
        .map_err(|error| format!("No se pudo abrir el canal SFTP: {error}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| format!("El servidor rechazó el subsistema SFTP: {error}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|error| format!("No se pudo iniciar SFTP: {error}"))?;
    sftp.set_timeout(OPERATION_TIMEOUT.as_secs());
    let requested_path = path
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| ".".into());
    let directory = read_directory(&sftp, requested_path).await?;

    let active = ActiveSftpSession {
        connection,
        sftp,
        editor_scope: Uuid::new_v4(),
    };
    let previous = {
        let mut sessions = state.sftp.sessions.lock().await;
        let connecting = state
            .sftp
            .connecting
            .lock()
            .map_err(|_| "El gestor SFTP está ocupado")?;
        if !connecting
            .get(&host_id)
            .is_some_and(|(id, _)| *id == generation)
            || state.ensure_available().is_err()
        {
            return Err("La conexión SFTP fue cancelada".into());
        }
        sessions.insert(host_id, Arc::new(Mutex::new(active)))
    };
    if let Some(previous) = previous {
        close_session(previous).await;
    }
    Ok(SftpConnectResponse::Connected { directory })
}

pub async fn disconnect(host_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some((_, cancellation)) = state
        .sftp
        .connecting
        .lock()
        .map_err(|_| "El gestor SFTP está ocupado")?
        .remove(&host_id)
    {
        let _ = cancellation.send(true);
    }
    if let Some(active) = state.sftp.remove(&host_id).await {
        close_session(active).await;
    }
    state.sftp.clear_pending_for_host(&host_id).await;
    Ok(())
}

pub async fn list(
    host_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<SftpDirectory, String> {
    let active = state.sftp.get(&host_id).await?;
    let active = active.lock().await;
    read_directory(&active.sftp, path).await
}

pub async fn read_text(
    host_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<crate::remote_editor::RemoteTextDocument, String> {
    let active = state.sftp.get(&host_id).await?;
    let active = active.lock().await;
    crate::remote_editor::open_document(&active.sftp, &path, &active.editor_scope.to_string()).await
}

pub async fn save_text(
    host_id: String,
    path: String,
    expected_revision: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<crate::remote_editor::SaveRemoteTextResponse, String> {
    let active = state.sftp.get(&host_id).await?;
    let active = active.lock().await;
    crate::remote_editor::save_document(
        &active.sftp,
        &path,
        &expected_revision,
        &text,
        &active.editor_scope.to_string(),
    )
    .await
}

pub async fn create_directory(
    host_id: String,
    parent_path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<SftpDirectory, String> {
    validate_name(&name)?;
    let active = state.sftp.get(&host_id).await?;
    let active = active.lock().await;
    let target = join_remote_path(&parent_path, name.trim());
    active
        .sftp
        .create_dir(target)
        .await
        .map_err(|error| format!("No se pudo crear la carpeta: {error}"))?;
    read_directory(&active.sftp, parent_path).await
}

pub async fn create_file(
    host_id: String,
    parent_path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<SftpDirectory, String> {
    validate_name(&name)?;
    let active = state.sftp.get(&host_id).await?;
    let active = active.lock().await;
    let target = join_remote_path(&parent_path, name.trim());
    if active
        .sftp
        .try_exists(target.clone())
        .await
        .map_err(|error| format!("No se pudo comprobar el archivo remoto: {error}"))?
    {
        return Err("Ya existe un elemento remoto con ese nombre".into());
    }
    let mut file = active
        .sftp
        .create(target)
        .await
        .map_err(|error| format!("No se pudo crear el archivo remoto: {error}"))?;
    file.shutdown()
        .await
        .map_err(|error| format!("No se pudo finalizar el archivo remoto: {error}"))?;
    read_directory(&active.sftp, parent_path).await
}

pub async fn rename(
    host_id: String,
    path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<SftpDirectory, String> {
    validate_name(&new_name)?;
    let parent = remote_parent(&path);
    let destination = join_remote_path(&parent, new_name.trim());
    let active = state.sftp.get(&host_id).await?;
    let active = active.lock().await;
    active
        .sftp
        .rename(path, destination)
        .await
        .map_err(|error| format!("No se pudo renombrar el elemento: {error}"))?;
    read_directory(&active.sftp, parent).await
}

pub async fn delete(
    host_id: String,
    path: String,
    is_directory: bool,
    recursive: bool,
    state: State<'_, AppState>,
) -> Result<SftpDirectory, String> {
    if path == "/" || path.trim().is_empty() {
        return Err("No se puede eliminar la raíz remota".into());
    }
    let parent = remote_parent(&path);
    let active = state.sftp.get(&host_id).await?;
    let active = active.lock().await;
    if is_directory {
        if recursive {
            remove_remote_tree(&active.sftp, &path).await?;
        } else {
            active.sftp.remove_dir(path).await.map_err(|error| {
                format!("No se pudo eliminar la carpeta. Debe estar vacía: {error}")
            })?;
        }
    } else {
        active
            .sftp
            .remove_file(path)
            .await
            .map_err(|error| format!("No se pudo eliminar el archivo: {error}"))?;
    }
    read_directory(&active.sftp, parent).await
}

pub async fn chmod(
    host_id: String,
    path: String,
    mode: u32,
    state: State<'_, AppState>,
) -> Result<SftpDirectory, String> {
    if mode > 0o7777 {
        return Err("Los permisos deben estar entre 0000 y 7777".into());
    }
    let parent = remote_parent(&path);
    let active = state.sftp.get(&host_id).await?;
    let active = active.lock().await;
    let mut metadata = active
        .sftp
        .symlink_metadata(path.clone())
        .await
        .map_err(|error| format!("No se pudieron leer los permisos remotos: {error}"))?;
    let file_type = metadata.permissions.unwrap_or_default() & 0o170000;
    metadata.permissions = Some(file_type | mode);
    active
        .sftp
        .set_metadata(path, metadata)
        .await
        .map_err(|error| format!("No se pudieron actualizar los permisos: {error}"))?;
    read_directory(&active.sftp, parent).await
}

#[allow(clippy::too_many_arguments)]
pub async fn transfer_local_to_remote(
    host_id: String,
    local_path: String,
    remote_directory: String,
    overwrite: bool,
    target_name: Option<String>,
    transfer_id: String,
    on_progress: Channel<TransferProgressEvent>,
    state: State<'_, AppState>,
) -> Result<TransferResponse, String> {
    let progress = TransferProgress::register(transfer_id, on_progress)?;
    let source = absolute_local_path(PathBuf::from(local_path))?;
    let source_metadata = tokio::fs::symlink_metadata(&source)
        .await
        .map_err(|error| format!("No se pudo abrir el origen local: {error}"))?;
    if source_metadata.file_type().is_symlink() {
        return Err("La transferencia de enlaces simbólicos no está habilitada".into());
    }
    progress.set_total(local_path_total_size(&source, Some(&progress)).await?);
    let name = if let Some(target_name) = target_name {
        validate_name(&target_name)?;
        target_name.trim().to_string()
    } else {
        source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "El origen local no tiene un nombre válido".to_string())?
            .to_string()
    };
    let target = join_remote_path(&remote_directory, &name);
    let active = state.sftp.get(&host_id).await?;
    let active = active.lock().await;
    let target_exists = active
        .sftp
        .try_exists(target.clone())
        .await
        .map_err(|error| format!("No se pudo comprobar el destino remoto: {error}"))?;
    if target_exists && !overwrite {
        return Ok(TransferResponse::Conflict {
            name,
            target_path: target,
            is_directory: source_metadata.is_dir(),
        });
    }
    if target_exists {
        let target_metadata = active
            .sftp
            .symlink_metadata(target.clone())
            .await
            .map_err(|error| format!("No se pudo revisar el destino remoto: {error}"))?;
        if target_metadata.is_dir() != source_metadata.is_dir() {
            return Err("El destino existente no es del mismo tipo que el origen".into());
        }
    }

    let (file_count, total_bytes) = if source_metadata.is_dir() {
        copy_local_directory_to_remote(&active.sftp, &source, &target, overwrite, Some(&progress))
            .await?
    } else {
        let bytes =
            copy_local_file_to_remote(&active.sftp, &source, &target, overwrite, Some(&progress))
                .await?;
        (1, bytes)
    };
    Ok(TransferResponse::Transferred {
        name,
        target_path: target,
        file_count,
        total_bytes,
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn transfer_remote_to_local(
    host_id: String,
    remote_path: String,
    local_directory: String,
    overwrite: bool,
    target_name: Option<String>,
    transfer_id: String,
    on_progress: Channel<TransferProgressEvent>,
    state: State<'_, AppState>,
) -> Result<TransferResponse, String> {
    let progress = TransferProgress::register(transfer_id, on_progress)?;
    let local_directory = absolute_local_path(PathBuf::from(local_directory))?;
    let name = if let Some(target_name) = target_name {
        validate_local_name(&target_name)?;
        target_name.trim().to_string()
    } else {
        remote_name_owned(&remote_path)
            .ok_or_else(|| "El origen remoto no tiene un nombre válido".to_string())?
    };
    let target = local_child(&local_directory, &name).await?;
    let active = state.sftp.get(&host_id).await?;
    let active = active.lock().await;
    let source_metadata = active
        .sftp
        .symlink_metadata(remote_path.clone())
        .await
        .map_err(|error| format!("No se pudo abrir el origen remoto: {error}"))?;
    if source_metadata.is_symlink() {
        return Err("La transferencia de enlaces simbólicos no está habilitada".into());
    }
    progress.set_total(
        remote_paths_total_size(
            &active.sftp,
            std::slice::from_ref(&remote_path),
            Some(&progress),
        )
        .await?,
    );
    let target_exists = tokio::fs::try_exists(&target)
        .await
        .map_err(|error| format!("No se pudo comprobar el destino local: {error}"))?;
    if target_exists && !overwrite {
        return Ok(TransferResponse::Conflict {
            name,
            target_path: target.to_string_lossy().into_owned(),
            is_directory: source_metadata.is_dir(),
        });
    }
    if target_exists {
        let target_metadata = tokio::fs::metadata(&target)
            .await
            .map_err(|error| format!("No se pudo revisar el destino local: {error}"))?;
        if target_metadata.is_dir() != source_metadata.is_dir() {
            return Err("El destino existente no es del mismo tipo que el origen".into());
        }
    }

    let (file_count, total_bytes) = if source_metadata.is_dir() {
        copy_remote_directory_to_local(
            &active.sftp,
            &remote_path,
            &target,
            overwrite,
            Some(&progress),
        )
        .await?
    } else {
        let bytes = copy_remote_file_to_local(
            &active.sftp,
            &remote_path,
            &target,
            overwrite,
            Some(&progress),
        )
        .await?;
        (1, bytes)
    };
    Ok(TransferResponse::Transferred {
        name,
        target_path: target.to_string_lossy().into_owned(),
        file_count,
        total_bytes,
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn transfer_remote_to_remote(
    source_host_id: String,
    remote_path: String,
    target_host_id: String,
    remote_directory: String,
    overwrite: bool,
    target_name: Option<String>,
    transfer_id: String,
    on_progress: Channel<TransferProgressEvent>,
    state: State<'_, AppState>,
) -> Result<TransferResponse, String> {
    let progress = TransferProgress::register(transfer_id, on_progress)?;
    let same_server = {
        let snapshot = state
            .database
            .lock()
            .map_err(|_| "La base de datos está ocupada".to_string())?
            .load_snapshot()
            .map_err(|e| e.to_string())?;
        let source = snapshot
            .hosts
            .iter()
            .find(|h| h.id == source_host_id)
            .ok_or("El host de origen ya no existe")?;
        let target = snapshot
            .hosts
            .iter()
            .find(|h| h.id == target_host_id)
            .ok_or("El host de destino ya no existe")?;
        let source_key = snapshot
            .known_hosts
            .iter()
            .find(|k| k.host_id == source_host_id);
        let target_key = snapshot
            .known_hosts
            .iter()
            .find(|k| k.host_id == target_host_id);
        source_host_id == target_host_id
            || ((source.address.eq_ignore_ascii_case(&target.address)
                && source.port == target.port)
                || source_key
                    .zip(target_key)
                    .is_some_and(|(a, b)| a.public_key == b.public_key))
    };
    let source_session = state.sftp.get(&source_host_id).await?;
    let target_session = state.sftp.get(&target_host_id).await?;
    if Arc::ptr_eq(&source_session, &target_session) {
        let active = source_session.lock().await;
        return transfer_between_remote_sessions(
            &active.sftp,
            &remote_path,
            &active.sftp,
            &remote_directory,
            same_server,
            overwrite,
            target_name,
            &progress,
        )
        .await;
    }
    if source_host_id <= target_host_id {
        let source = source_session.lock().await;
        let target = target_session.lock().await;
        transfer_between_remote_sessions(
            &source.sftp,
            &remote_path,
            &target.sftp,
            &remote_directory,
            same_server,
            overwrite,
            target_name,
            &progress,
        )
        .await
    } else {
        let target = target_session.lock().await;
        let source = source_session.lock().await;
        transfer_between_remote_sessions(
            &source.sftp,
            &remote_path,
            &target.sftp,
            &remote_directory,
            same_server,
            overwrite,
            target_name,
            &progress,
        )
        .await
    }
}

#[allow(clippy::too_many_arguments)]
async fn transfer_between_remote_sessions(
    source_sftp: &SftpSession,
    source: &str,
    target_sftp: &SftpSession,
    target_directory: &str,
    same_server: bool,
    overwrite: bool,
    target_name: Option<String>,
    progress: &TransferProgress,
) -> Result<TransferResponse, String> {
    let source_metadata = source_sftp
        .symlink_metadata(source.to_string())
        .await
        .map_err(|error| format!("No se pudo abrir el origen remoto: {error}"))?;
    if source_metadata.is_symlink() {
        return Err("La transferencia de enlaces simbólicos no está habilitada".into());
    }
    let name = if let Some(target_name) = target_name {
        validate_name(&target_name)?;
        target_name.trim().to_string()
    } else {
        remote_name_owned(source)
            .ok_or_else(|| "El origen remoto no tiene un nombre válido".to_string())?
    };
    let target = join_remote_path(target_directory, &name);
    if same_server {
        let canonical_source = source_sftp
            .canonicalize(source.to_string())
            .await
            .map_err(|e| format!("No se pudo resolver el origen remoto: {e}"))?;
        let canonical_parent = target_sftp
            .canonicalize(target_directory.to_string())
            .await
            .map_err(|e| format!("No se pudo resolver el destino remoto: {e}"))?;
        reject_remote_self_copy(
            &canonical_source,
            &join_remote_path(&canonical_parent, &name),
            source_metadata.is_dir(),
        )?;
    }
    progress.set_total(
        remote_paths_total_size(
            source_sftp,
            std::slice::from_ref(&source.to_string()),
            Some(progress),
        )
        .await?,
    );
    let target_exists = target_sftp
        .try_exists(target.clone())
        .await
        .map_err(|error| format!("No se pudo comprobar el destino remoto: {error}"))?;
    if target_exists && !overwrite {
        return Ok(TransferResponse::Conflict {
            name,
            target_path: target,
            is_directory: source_metadata.is_dir(),
        });
    }
    if target_exists {
        let target_metadata = target_sftp
            .symlink_metadata(target.clone())
            .await
            .map_err(|error| format!("No se pudo revisar el destino remoto: {error}"))?;
        if target_metadata.is_dir() != source_metadata.is_dir() {
            return Err("El destino existente no es del mismo tipo que el origen".into());
        }
    }
    let (file_count, total_bytes) = if source_metadata.is_dir() {
        copy_remote_directory_to_remote(
            source_sftp,
            source,
            target_sftp,
            &target,
            overwrite,
            Some(progress),
        )
        .await?
    } else {
        let bytes = copy_remote_file_to_remote(
            source_sftp,
            source,
            target_sftp,
            &target,
            overwrite,
            Some(progress),
        )
        .await?;
        (1, bytes)
    };
    Ok(TransferResponse::Transferred {
        name,
        target_path: target,
        file_count,
        total_bytes,
    })
}

#[cfg(test)]
async fn copy_local_to_local(
    local_path: String,
    local_directory: String,
    overwrite: bool,
    target_name: Option<String>,
) -> Result<TransferResponse, String> {
    copy_local_to_local_with_progress(local_path, local_directory, overwrite, target_name, None)
        .await
}

pub async fn copy_local_to_local_tracked(
    local_path: String,
    local_directory: String,
    overwrite: bool,
    target_name: Option<String>,
    transfer_id: String,
    on_progress: Channel<TransferProgressEvent>,
) -> Result<TransferResponse, String> {
    let progress = TransferProgress::register(transfer_id, on_progress)?;
    let source = absolute_local_path(PathBuf::from(&local_path))?;
    progress.set_total(local_path_total_size(&source, Some(&progress)).await?);
    copy_local_to_local_with_progress(
        local_path,
        local_directory,
        overwrite,
        target_name,
        Some(&progress),
    )
    .await
}

async fn copy_local_to_local_with_progress(
    local_path: String,
    local_directory: String,
    overwrite: bool,
    target_name: Option<String>,
    progress: Option<&TransferProgress>,
) -> Result<TransferResponse, String> {
    let source = absolute_local_path(PathBuf::from(local_path))?;
    let destination_directory = absolute_local_path(PathBuf::from(local_directory))?;
    let source_metadata = tokio::fs::symlink_metadata(&source)
        .await
        .map_err(|error| format!("No se pudo abrir el origen local: {error}"))?;
    if source_metadata.file_type().is_symlink() {
        return Err("La copia de enlaces simbólicos no está habilitada".into());
    }
    let name = if let Some(target_name) = target_name {
        validate_local_name(&target_name)?;
        target_name.trim().to_string()
    } else {
        source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "El origen local no tiene un nombre válido".to_string())?
            .to_string()
    };
    let target = local_child(&destination_directory, &name).await?;
    let canonical_source = tokio::fs::canonicalize(&source)
        .await
        .map_err(|error| format!("No se pudo resolver el origen local: {error}"))?;
    let canonical_destination = tokio::fs::canonicalize(&destination_directory)
        .await
        .map_err(|error| format!("No se pudo resolver el destino local: {error}"))?;
    if canonical_source == target || target == source {
        return Err("El elemento ya se encuentra en esa carpeta".into());
    }
    if source_metadata.is_dir() && canonical_destination.starts_with(&canonical_source) {
        return Err("No se puede copiar una carpeta dentro de sí misma".into());
    }
    let target_exists = tokio::fs::try_exists(&target)
        .await
        .map_err(|error| format!("No se pudo comprobar el destino local: {error}"))?;
    if target_exists && !overwrite {
        return Ok(TransferResponse::Conflict {
            name,
            target_path: target.to_string_lossy().into_owned(),
            is_directory: source_metadata.is_dir(),
        });
    }
    if target_exists {
        let target_metadata = tokio::fs::metadata(&target)
            .await
            .map_err(|error| format!("No se pudo revisar el destino local: {error}"))?;
        if target_metadata.is_dir() != source_metadata.is_dir() {
            return Err("El destino existente no es del mismo tipo que el origen".into());
        }
    }
    let (file_count, total_bytes) = if source_metadata.is_dir() {
        copy_local_directory_to_local(&source, &target, overwrite, progress).await?
    } else {
        let bytes = copy_local_file_to_local(&source, &target, overwrite, progress).await?;
        (1, bytes)
    };
    Ok(TransferResponse::Transferred {
        name,
        target_path: target.to_string_lossy().into_owned(),
        file_count,
        total_bytes,
    })
}

pub async fn prepare_file_drag(
    host_id: Option<String>,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<PreparedFileDrag, String> {
    if paths.is_empty() {
        return Err("Selecciona al menos un elemento para arrastrar".into());
    }
    let cache_root = std::env::temp_dir().join("nexora-ssh").join("drag-out");
    tokio::fs::create_dir_all(&cache_root)
        .await
        .map_err(|error| format!("No se pudo preparar el arrastre: {error}"))?;
    cleanup_stale_drag_directories(&cache_root).await;
    let available_bytes = fs2::available_space(&cache_root)
        .map_err(|error| format!("No se pudo comprobar el espacio temporal disponible: {error}"))?;
    let icon_path = cache_root.join("nexora-drag.png");
    if !tokio::fs::try_exists(&icon_path)
        .await
        .map_err(|error| format!("No se pudo comprobar el icono de arrastre: {error}"))?
    {
        tokio::fs::write(&icon_path, include_bytes!("../icons/64x64.png"))
            .await
            .map_err(|error| format!("No se pudo preparar el icono de arrastre: {error}"))?;
    }

    let (prepared_paths, staging_root, estimated_bytes) = if let Some(host_id) = host_id {
        let staging_directory = cache_root.join(Uuid::new_v4().to_string());
        let active = state.sftp.get(&host_id).await?;
        let active = active.lock().await;
        let estimated_bytes = remote_paths_total_size(&active.sftp, &paths, None).await?;
        const SAFETY_MARGIN: u64 = 64 * 1024 * 1024;
        if available_bytes < estimated_bytes.saturating_add(SAFETY_MARGIN) {
            return Err(format!(
                "No hay espacio temporal suficiente. Se requieren aproximadamente {} MB y hay {} MB disponibles",
                estimated_bytes.div_ceil(1024 * 1024),
                available_bytes / (1024 * 1024)
            ));
        }
        tokio::fs::create_dir_all(&staging_directory)
            .await
            .map_err(|error| format!("No se pudo crear la zona temporal: {error}"))?;
        let mut prepared = Vec::with_capacity(paths.len());
        let preparation = async {
            for path in paths {
                let name = remote_name_owned(&path)
                    .ok_or_else(|| "El origen remoto no tiene un nombre válido".to_string())?;
                ensure_safe_remote_name(&name)?;
                let target = local_child(&staging_directory, &name).await?;
                let metadata = active
                    .sftp
                    .symlink_metadata(path.clone())
                    .await
                    .map_err(|error| format!("No se pudo abrir el origen remoto: {error}"))?;
                if metadata.is_symlink() {
                    return Err(
                        "Los enlaces simbólicos no se pueden arrastrar fuera de Nexora".into(),
                    );
                }
                if metadata.is_dir() {
                    copy_remote_directory_to_local(&active.sftp, &path, &target, false, None)
                        .await?;
                } else {
                    copy_remote_file_to_local(&active.sftp, &path, &target, false, None).await?;
                }
                prepared.push(target.to_string_lossy().into_owned());
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = preparation {
            let _ = tokio::fs::remove_dir_all(&staging_directory).await;
            return Err(error);
        }
        (
            prepared,
            Some(staging_directory.to_string_lossy().into_owned()),
            estimated_bytes,
        )
    } else {
        let mut prepared = Vec::with_capacity(paths.len());
        let mut estimated_bytes = 0_u64;
        for path in paths {
            let source = absolute_local_path(PathBuf::from(path))?;
            let metadata = tokio::fs::symlink_metadata(&source)
                .await
                .map_err(|error| format!("No se pudo abrir el elemento local: {error}"))?;
            if metadata.file_type().is_symlink() {
                return Err("Los enlaces simbólicos no se pueden arrastrar fuera de Nexora".into());
            }
            estimated_bytes =
                estimated_bytes.saturating_add(local_path_total_size(&source, None).await?);
            prepared.push(source.to_string_lossy().into_owned());
        }
        (prepared, None, estimated_bytes)
    };

    Ok(PreparedFileDrag {
        paths: prepared_paths,
        icon_path: icon_path.to_string_lossy().into_owned(),
        staging_root,
        estimated_bytes,
        available_bytes,
    })
}

pub async fn cleanup_prepared_drag(staging_root: String) -> Result<(), String> {
    let cache_root = std::env::temp_dir().join("nexora-ssh").join("drag-out");
    let target = PathBuf::from(staging_root);
    if !tokio::fs::try_exists(&target)
        .await
        .map_err(|error| format!("No se pudo comprobar la zona temporal: {error}"))?
    {
        return Ok(());
    }
    let canonical_root = tokio::fs::canonicalize(&cache_root)
        .await
        .map_err(|error| format!("No se pudo validar la raíz temporal: {error}"))?;
    let canonical_target = tokio::fs::canonicalize(&target)
        .await
        .map_err(|error| format!("No se pudo validar la zona temporal: {error}"))?;
    if canonical_target.parent() != Some(canonical_root.as_path()) {
        return Err("La ruta indicada no pertenece a la zona temporal de Nexora".into());
    }
    tokio::fs::remove_dir_all(canonical_target)
        .await
        .map_err(|error| format!("No se pudo limpiar la zona temporal: {error}"))
}

async fn cleanup_stale_drag_directories(cache_root: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(cache_root).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Ok(metadata) = entry.metadata().await else {
            continue;
        };
        if !metadata.is_dir() {
            continue;
        }
        let stale = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|elapsed| elapsed >= Duration::from_secs(24 * 60 * 60));
        if stale {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
}

async fn local_path_total_size(
    path: &Path,
    progress: Option<&TransferProgress>,
) -> Result<u64, String> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|error| format!("No se pudo medir el origen local: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("El origen contiene un enlace simbólico".into());
    }
    if !metadata.is_dir() {
        return Ok(metadata.len());
    }
    let mut total = 0_u64;
    let mut stack = vec![path.to_path_buf()];
    let mut visited = std::collections::HashSet::new();
    while let Some(directory) = stack.pop() {
        if let Some(progress) = progress {
            progress.ensure_active()?;
        }
        if !visited.insert(directory.clone()) || visited.len() > 100_000 {
            return Err("El recorrido de la carpeta excede los límites permitidos".into());
        }
        let mut entries = tokio::fs::read_dir(directory)
            .await
            .map_err(|error| format!("No se pudo medir una carpeta local: {error}"))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| format!("No se pudo medir una entrada local: {error}"))?
        {
            if let Some(progress) = progress {
                progress.ensure_active()?;
            }
            let metadata = tokio::fs::symlink_metadata(entry.path())
                .await
                .map_err(|error| format!("No se pudo medir una entrada local: {error}"))?;
            if metadata.file_type().is_symlink() {
                return Err("La carpeta contiene un enlace simbólico".into());
            }
            if metadata.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Ok(total)
}

async fn read_remote_entries(
    sftp: &SftpSession,
    path: String,
    progress: Option<&TransferProgress>,
) -> Result<Vec<russh_sftp::client::fs::DirEntry>, String> {
    let listing = transfer_io(
        async { sftp.read_dir(path).await.map_err(std::io::Error::other) },
        progress,
    )
    .await?;
    let entries: Vec<_> = listing.take(100_001).collect();
    if entries.len() > 100_000 {
        return Err("La carpeta contiene demasiados elementos".into());
    }
    Ok(entries)
}

async fn remote_paths_total_size(
    sftp: &SftpSession,
    paths: &[String],
    progress: Option<&TransferProgress>,
) -> Result<u64, String> {
    let mut total = 0_u64;
    let mut stack = paths.to_vec();
    let mut visited = std::collections::HashSet::new();
    while let Some(path) = stack.pop() {
        if let Some(progress) = progress {
            progress.ensure_active()?;
        }
        if !visited.insert(path.clone()) || visited.len() > 100_000 {
            return Err("El recorrido remoto excede los límites permitidos".into());
        }
        let metadata = sftp
            .symlink_metadata(path.clone())
            .await
            .map_err(|error| format!("No se pudo medir el origen remoto: {error}"))?;
        if metadata.is_symlink() {
            return Err("Los enlaces simbólicos no se pueden preparar temporalmente".into());
        }
        if metadata.is_dir() {
            let entries = read_remote_entries(sftp, path, progress).await?;
            for entry in entries {
                validate_component(&entry.file_name(), false)?;
                if entry.file_type().is_symlink() {
                    return Err("La carpeta contiene un enlace simbólico".into());
                }
                stack.push(entry.path());
            }
        } else {
            total = total.saturating_add(metadata.len());
        }
    }
    Ok(total)
}

async fn remove_remote_tree(sftp: &SftpSession, root: &str) -> Result<(), String> {
    if root == "/" || root.trim().is_empty() {
        return Err("No se puede eliminar la raíz remota".into());
    }
    let mut stack = vec![(root.to_string(), false)];
    let mut seen = std::collections::HashSet::new();
    while let Some((path, visited)) = stack.pop() {
        let metadata = sftp
            .symlink_metadata(path.clone())
            .await
            .map_err(|error| format!("No se pudo revisar un elemento remoto: {error}"))?;
        if metadata.is_dir() && !metadata.is_symlink() {
            if !visited
                && (sftp
                    .canonicalize(path.clone())
                    .await
                    .map_err(|e| e.to_string())?
                    == "/"
                    || !seen.insert(path.clone())
                    || seen.len() > 100_000)
            {
                return Err("La eliminación contiene una raíz, ciclo o demasiadas carpetas".into());
            }
            if visited {
                sftp.remove_dir(path)
                    .await
                    .map_err(|error| format!("No se pudo eliminar una carpeta remota: {error}"))?;
            } else {
                stack.push((path.clone(), true));
                let entries = read_remote_entries(sftp, path.clone(), None).await?;
                for entry in entries {
                    validate_component(&entry.file_name(), false)?;
                    stack.push((join_remote_path(&path, &entry.file_name()), false));
                }
            }
        } else {
            sftp.remove_file(path)
                .await
                .map_err(|error| format!("No se pudo eliminar un archivo remoto: {error}"))?;
        }
    }
    Ok(())
}

async fn transfer_io<F, T>(operation: F, progress: Option<&TransferProgress>) -> Result<T, String>
where
    F: std::future::Future<Output = std::io::Result<T>>,
{
    tokio::pin!(operation);
    let deadline = tokio::time::sleep(OPERATION_TIMEOUT);
    tokio::pin!(deadline);
    let mut poll = tokio::time::interval(Duration::from_millis(100));
    loop {
        if let Some(progress) = progress {
            progress.ensure_active()?;
        }
        tokio::select! {
            result = &mut operation => return result.map_err(|error| format!("Error durante la transferencia: {error}")),
            _ = &mut deadline => return Err("La transferencia agotó el tiempo de espera".into()),
            _ = poll.tick() => {},
        }
    }
}

async fn copy_stream<R, W>(
    reader: &mut R,
    writer: &mut W,
    progress: Option<&TransferProgress>,
) -> Result<u64, String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buffer = vec![0_u8; 128 * 1024];
    let mut transferred = 0_u64;
    loop {
        if let Some(progress) = progress {
            progress.ensure_active()?;
        }
        let read = transfer_io(reader.read(&mut buffer), progress).await?;
        if read == 0 {
            break;
        }
        transfer_io(writer.write_all(&buffer[..read]), progress).await?;
        transferred = transferred.saturating_add(read as u64);
        if let Some(progress) = progress {
            progress.add_bytes(read as u64);
        }
    }
    Ok(transferred)
}

async fn replace_remote_file(
    sftp: &SftpSession,
    temporary: &str,
    target: &str,
    overwrite: bool,
) -> Result<(), String> {
    let target_exists = sftp
        .try_exists(target.to_string())
        .await
        .map_err(|error| format!("No se pudo comprobar el archivo remoto: {error}"))?;
    if target_exists && !overwrite {
        let _ = sftp.remove_file(temporary.to_string()).await;
        return Err("El destino cambió durante la transferencia; vuelve a intentarlo".into());
    }
    let backup = target_exists.then(|| {
        let name = remote_name_owned(target).unwrap_or_else(|| "archivo".into());
        join_remote_path(
            &remote_parent(target),
            &format!(".{name}.{}.nexora-backup", Uuid::new_v4()),
        )
    });
    if let Some(backup) = &backup {
        sftp.rename(target.to_string(), backup.clone())
            .await
            .map_err(|error| format!("No se pudo proteger el archivo remoto existente: {error}"))?;
    }
    if let Err(error) = sftp.rename(temporary.to_string(), target.to_string()).await {
        if let Some(backup) = &backup {
            let _ = sftp.rename(backup.clone(), target.to_string()).await;
        }
        let _ = sftp.remove_file(temporary.to_string()).await;
        return Err(format!("No se pudo guardar el archivo remoto: {error}"));
    }
    if let Some(backup) = backup {
        let _ = sftp.remove_file(backup).await;
    }
    Ok(())
}

async fn copy_local_directory_to_local(
    source: &Path,
    target: &Path,
    overwrite: bool,
    progress: Option<&TransferProgress>,
) -> Result<(u64, u64), String> {
    reject_symlink(target).await?;
    tokio::fs::create_dir_all(target)
        .await
        .map_err(|error| format!("No se pudo crear la carpeta local: {error}"))?;
    let mut stack = vec![(source.to_path_buf(), target.to_path_buf())];
    let mut file_count = 0;
    let mut total_bytes = 0;
    let mut visited = std::collections::HashSet::new();
    while let Some((source_directory, target_directory)) = stack.pop() {
        if !visited.insert(source_directory.clone())
            || visited.len() > 100_000
            || file_count > 100_000
        {
            return Err("La carpeta cambió o excede los límites de transferencia".into());
        }
        if let Some(progress) = progress {
            progress.ensure_active()?;
        }
        let mut reader = tokio::fs::read_dir(&source_directory)
            .await
            .map_err(|error| format!("No se pudo leer una carpeta local: {error}"))?;
        while let Some(entry) = reader
            .next_entry()
            .await
            .map_err(|error| format!("No se pudo leer una entrada local: {error}"))?
        {
            if let Some(progress) = progress {
                progress.ensure_active()?;
            }
            let file_type = entry
                .file_type()
                .await
                .map_err(|error| format!("No se pudo identificar una entrada local: {error}"))?;
            if file_type.is_symlink() {
                return Err(format!(
                    "La carpeta contiene un enlace simbólico no transferible: {}",
                    entry.file_name().to_string_lossy()
                ));
            }
            let local_target =
                local_child(&target_directory, &entry.file_name().to_string_lossy()).await?;
            if file_type.is_dir() {
                if tokio::fs::try_exists(&local_target)
                    .await
                    .map_err(|error| format!("No se pudo comprobar una carpeta local: {error}"))?
                    && !tokio::fs::metadata(&local_target)
                        .await
                        .map_err(|error| format!("No se pudo revisar una carpeta local: {error}"))?
                        .is_dir()
                {
                    return Err(format!(
                        "El destino local “{}” no es una carpeta",
                        entry.file_name().to_string_lossy()
                    ));
                }
                tokio::fs::create_dir_all(&local_target)
                    .await
                    .map_err(|error| format!("No se pudo crear una carpeta local: {error}"))?;
                stack.push((entry.path(), local_target));
            } else {
                total_bytes +=
                    copy_local_file_to_local(&entry.path(), &local_target, overwrite, progress)
                        .await?;
                file_count += 1;
            }
        }
    }
    Ok((file_count, total_bytes))
}

async fn finish_local_copy(
    file: tokio::fs::File,
    temporary: &Path,
    target: &Path,
    overwrite: bool,
    progress: Option<&TransferProgress>,
) -> Result<(), String> {
    let result = async {
        file.sync_all()
            .await
            .map_err(|error| format!("No se pudo confirmar el archivo local: {error}"))?;
        drop(file);
        reject_symlink(target).await?;
        if let Some(progress) = progress {
            progress.ensure_active()?;
        }
        crate::atomic_file::replace_file(temporary, target, overwrite).map_err(|error| {
            format!("No se pudo guardar el archivo local; el original se conserva: {error}")
        })
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(temporary).await;
    }
    result
}

async fn copy_local_file_to_local(
    source: &Path,
    target: &Path,
    overwrite: bool,
    progress: Option<&TransferProgress>,
) -> Result<u64, String> {
    reject_symlink(target).await?;
    let target_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("archivo");
    let temporary = target.with_file_name(format!(".{target_name}.{}.nexora-part", Uuid::new_v4()));
    let mut source_file = tokio::fs::File::open(source)
        .await
        .map_err(|error| format!("No se pudo abrir el archivo local: {error}"))?;
    let mut target_file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .await
        .map_err(|error| format!("No se pudo crear el archivo local temporal: {error}"))?;
    let bytes = match copy_stream(&mut source_file, &mut target_file, progress).await {
        Ok(bytes) => bytes,
        Err(error) => {
            drop(target_file);
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
    };
    finish_local_copy(target_file, &temporary, target, overwrite, progress).await?;
    if let Some(progress) = progress {
        progress.complete_file();
    }
    Ok(bytes)
}

async fn copy_local_directory_to_remote(
    sftp: &SftpSession,
    source: &Path,
    target: &str,
    overwrite: bool,
    progress: Option<&TransferProgress>,
) -> Result<(u64, u64), String> {
    if !sftp
        .try_exists(target.to_string())
        .await
        .map_err(|error| format!("No se pudo comprobar la carpeta remota: {error}"))?
    {
        sftp.create_dir(target.to_string())
            .await
            .map_err(|error| format!("No se pudo crear la carpeta remota: {error}"))?;
    }
    let mut stack = vec![(source.to_path_buf(), target.to_string())];
    let mut file_count = 0;
    let mut total_bytes = 0;
    let mut visited = std::collections::HashSet::new();
    while let Some((local_directory, remote_directory)) = stack.pop() {
        if !visited.insert(local_directory.clone())
            || visited.len() > 100_000
            || file_count > 100_000
        {
            return Err("La carpeta cambió o excede los límites de transferencia".into());
        }
        if let Some(progress) = progress {
            progress.ensure_active()?;
        }
        let mut reader = tokio::fs::read_dir(&local_directory)
            .await
            .map_err(|error| format!("No se pudo leer una carpeta local: {error}"))?;
        while let Some(entry) = reader
            .next_entry()
            .await
            .map_err(|error| format!("No se pudo leer una entrada local: {error}"))?
        {
            if let Some(progress) = progress {
                progress.ensure_active()?;
            }
            let file_type = entry
                .file_type()
                .await
                .map_err(|error| format!("No se pudo identificar una entrada local: {error}"))?;
            if file_type.is_symlink() {
                return Err(format!(
                    "La carpeta contiene un enlace simbólico no transferible: {}",
                    entry.file_name().to_string_lossy()
                ));
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let remote_target = join_remote_path(&remote_directory, &name);
            if file_type.is_dir() {
                if !sftp
                    .try_exists(remote_target.clone())
                    .await
                    .map_err(|error| format!("No se pudo comprobar una carpeta remota: {error}"))?
                {
                    sftp.create_dir(remote_target.clone())
                        .await
                        .map_err(|error| format!("No se pudo crear una carpeta remota: {error}"))?;
                } else if !sftp
                    .symlink_metadata(remote_target.clone())
                    .await
                    .map_err(|error| format!("No se pudo revisar una carpeta remota: {error}"))?
                    .is_dir()
                {
                    return Err(format!("El destino remoto “{name}” no es una carpeta"));
                }
                stack.push((entry.path(), remote_target));
            } else {
                if sftp
                    .try_exists(remote_target.clone())
                    .await
                    .map_err(|error| format!("No se pudo comprobar un archivo remoto: {error}"))?
                    && sftp
                        .symlink_metadata(remote_target.clone())
                        .await
                        .map_err(|error| format!("No se pudo revisar un archivo remoto: {error}"))?
                        .is_dir()
                {
                    return Err(format!("El destino remoto “{name}” es una carpeta"));
                }
                total_bytes += copy_local_file_to_remote(
                    sftp,
                    &entry.path(),
                    &remote_target,
                    overwrite,
                    progress,
                )
                .await?;
                file_count += 1;
            }
        }
    }
    Ok((file_count, total_bytes))
}

async fn copy_local_file_to_remote(
    sftp: &SftpSession,
    source: &Path,
    target: &str,
    overwrite: bool,
    progress: Option<&TransferProgress>,
) -> Result<u64, String> {
    let mut local = tokio::fs::File::open(source)
        .await
        .map_err(|error| format!("No se pudo abrir un archivo local: {error}"))?;
    let target_name = remote_name_owned(target).unwrap_or_else(|| "archivo".into());
    let temporary = join_remote_path(
        &remote_parent(target),
        &format!(".{target_name}.{}.nexora-part", Uuid::new_v4()),
    );
    let mut remote = sftp
        .create(temporary.clone())
        .await
        .map_err(|error| format!("No se pudo crear un archivo remoto: {error}"))?;
    let bytes = match copy_stream(&mut local, &mut remote, progress).await {
        Ok(bytes) => bytes,
        Err(error) => {
            drop(remote);
            let _ = sftp.remove_file(temporary).await;
            return Err(error);
        }
    };
    remote
        .shutdown()
        .await
        .map_err(|error| format!("No se pudo finalizar el archivo remoto: {error}"))?;
    replace_remote_file(sftp, &temporary, target, overwrite).await?;
    if let Some(progress) = progress {
        progress.complete_file();
    }
    Ok(bytes)
}

async fn copy_remote_directory_to_local(
    sftp: &SftpSession,
    source: &str,
    target: &Path,
    overwrite: bool,
    progress: Option<&TransferProgress>,
) -> Result<(u64, u64), String> {
    reject_symlink(target).await?;
    tokio::fs::create_dir_all(target)
        .await
        .map_err(|error| format!("No se pudo crear la carpeta local: {error}"))?;
    let mut stack = vec![(source.to_string(), target.to_path_buf())];
    let mut file_count = 0;
    let mut total_bytes = 0;
    let mut visited = std::collections::HashSet::new();
    while let Some((remote_directory, local_directory)) = stack.pop() {
        if !visited.insert(remote_directory.clone())
            || visited.len() > 100_000
            || file_count > 100_000
        {
            return Err("La carpeta cambió o excede los límites de transferencia".into());
        }
        if let Some(progress) = progress {
            progress.ensure_active()?;
        }
        let entries = read_remote_entries(sftp, remote_directory, progress).await?;
        for entry in entries {
            if let Some(progress) = progress {
                progress.ensure_active()?;
            }
            if entry.file_type().is_symlink() {
                return Err(format!(
                    "La carpeta contiene un enlace simbólico no transferible: {}",
                    entry.file_name()
                ));
            }
            ensure_safe_remote_name(&entry.file_name())?;
            let local_target = local_child(&local_directory, &entry.file_name()).await?;
            if entry.file_type().is_dir() {
                if tokio::fs::try_exists(&local_target)
                    .await
                    .map_err(|error| format!("No se pudo comprobar una carpeta local: {error}"))?
                    && !tokio::fs::metadata(&local_target)
                        .await
                        .map_err(|error| format!("No se pudo revisar una carpeta local: {error}"))?
                        .is_dir()
                {
                    return Err(format!(
                        "El destino local “{}” no es una carpeta",
                        entry.file_name()
                    ));
                }
                tokio::fs::create_dir_all(&local_target)
                    .await
                    .map_err(|error| format!("No se pudo crear una carpeta local: {error}"))?;
                stack.push((entry.path(), local_target));
            } else {
                if tokio::fs::try_exists(&local_target)
                    .await
                    .map_err(|error| format!("No se pudo comprobar un archivo local: {error}"))?
                    && tokio::fs::metadata(&local_target)
                        .await
                        .map_err(|error| format!("No se pudo revisar un archivo local: {error}"))?
                        .is_dir()
                {
                    return Err(format!(
                        "El destino local “{}” es una carpeta",
                        entry.file_name()
                    ));
                }
                total_bytes += copy_remote_file_to_local(
                    sftp,
                    &entry.path(),
                    &local_target,
                    overwrite,
                    progress,
                )
                .await?;
                file_count += 1;
            }
        }
    }
    Ok((file_count, total_bytes))
}

async fn copy_remote_file_to_local(
    sftp: &SftpSession,
    source: &str,
    target: &Path,
    overwrite: bool,
    progress: Option<&TransferProgress>,
) -> Result<u64, String> {
    reject_symlink(target).await?;
    let target_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("archivo");
    let temporary = target.with_file_name(format!(".{target_name}.{}.nexora-part", Uuid::new_v4()));
    let mut remote = sftp
        .open(source.to_string())
        .await
        .map_err(|error| format!("No se pudo abrir un archivo remoto: {error}"))?;
    let mut local = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .await
        .map_err(|error| format!("No se pudo crear el archivo local temporal: {error}"))?;
    let transferred = match copy_stream(&mut remote, &mut local, progress).await {
        Ok(bytes) => bytes,
        Err(error) => {
            drop(local);
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(format!(
                "La transferencia al equipo se interrumpió: {error}"
            ));
        }
    };
    finish_local_copy(local, &temporary, target, overwrite, progress).await?;
    if let Some(progress) = progress {
        progress.complete_file();
    }
    Ok(transferred)
}

async fn copy_remote_directory_to_remote(
    source_sftp: &SftpSession,
    source: &str,
    target_sftp: &SftpSession,
    target: &str,
    overwrite: bool,
    progress: Option<&TransferProgress>,
) -> Result<(u64, u64), String> {
    if !target_sftp
        .try_exists(target.to_string())
        .await
        .map_err(|error| format!("No se pudo comprobar la carpeta remota: {error}"))?
    {
        target_sftp
            .create_dir(target.to_string())
            .await
            .map_err(|error| format!("No se pudo crear la carpeta remota: {error}"))?;
    }
    let mut stack = vec![(source.to_string(), target.to_string())];
    let mut file_count = 0_u64;
    let mut total_bytes = 0_u64;
    let mut visited = std::collections::HashSet::new();
    while let Some((source_directory, target_directory)) = stack.pop() {
        if !visited.insert(source_directory.clone())
            || visited.len() > 100_000
            || file_count > 100_000
        {
            return Err("La carpeta cambió o excede los límites de transferencia".into());
        }
        if let Some(progress) = progress {
            progress.ensure_active()?;
        }
        let entries = read_remote_entries(source_sftp, source_directory, progress).await?;
        for entry in entries {
            if entry.file_type().is_symlink() {
                return Err(format!(
                    "La carpeta contiene un enlace simbólico no transferible: {}",
                    entry.file_name()
                ));
            }
            ensure_safe_remote_name(&entry.file_name())?;
            let target_path = join_remote_path(&target_directory, &entry.file_name());
            if entry.file_type().is_dir() {
                if !target_sftp
                    .try_exists(target_path.clone())
                    .await
                    .map_err(|error| format!("No se pudo comprobar una carpeta remota: {error}"))?
                {
                    target_sftp
                        .create_dir(target_path.clone())
                        .await
                        .map_err(|error| format!("No se pudo crear una carpeta remota: {error}"))?;
                } else if !target_sftp
                    .symlink_metadata(target_path.clone())
                    .await
                    .map_err(|error| format!("No se pudo revisar una carpeta remota: {error}"))?
                    .is_dir()
                {
                    return Err(format!(
                        "El destino remoto “{}” no es una carpeta",
                        entry.file_name()
                    ));
                }
                stack.push((entry.path(), target_path));
            } else {
                total_bytes = total_bytes.saturating_add(
                    copy_remote_file_to_remote(
                        source_sftp,
                        &entry.path(),
                        target_sftp,
                        &target_path,
                        overwrite,
                        progress,
                    )
                    .await?,
                );
                file_count += 1;
            }
        }
    }
    Ok((file_count, total_bytes))
}

async fn copy_remote_file_to_remote(
    source_sftp: &SftpSession,
    source: &str,
    target_sftp: &SftpSession,
    target: &str,
    overwrite: bool,
    progress: Option<&TransferProgress>,
) -> Result<u64, String> {
    let mut source_file = source_sftp
        .open(source.to_string())
        .await
        .map_err(|error| format!("No se pudo abrir el archivo remoto de origen: {error}"))?;
    let target_name = remote_name_owned(target).unwrap_or_else(|| "archivo".into());
    let temporary = join_remote_path(
        &remote_parent(target),
        &format!(".{target_name}.{}.nexora-part", Uuid::new_v4()),
    );
    let mut target_file = target_sftp
        .create(temporary.clone())
        .await
        .map_err(|error| format!("No se pudo crear el archivo remoto temporal: {error}"))?;
    let bytes = match copy_stream(&mut source_file, &mut target_file, progress).await {
        Ok(bytes) => bytes,
        Err(error) => {
            drop(target_file);
            let _ = target_sftp.remove_file(temporary).await;
            return Err(error);
        }
    };
    target_file
        .shutdown()
        .await
        .map_err(|error| format!("No se pudo finalizar el archivo remoto: {error}"))?;
    replace_remote_file(target_sftp, &temporary, target, overwrite).await?;
    if let Some(progress) = progress {
        progress.complete_file();
    }
    Ok(bytes)
}

pub async fn upload(
    host_id: String,
    remote_directory: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SftpUploadResponse, String> {
    let Some(selection) = app
        .dialog()
        .file()
        .set_title("Subir archivo por SFTP")
        .blocking_pick_file()
    else {
        return Ok(SftpUploadResponse::Cancelled);
    };
    let local_path = selection.into_path().map_err(|error| error.to_string())?;
    let name = local_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "El archivo local no tiene un nombre válido".to_string())?
        .to_string();
    validate_name(&name)?;
    let remote_path = join_remote_path(&remote_directory, &name);
    let active = state.sftp.get(&host_id).await?;
    let active = active.lock().await;
    if active
        .sftp
        .try_exists(remote_path.clone())
        .await
        .map_err(|error| format!("No se pudo comprobar el destino remoto: {error}"))?
    {
        let upload_token = Uuid::new_v4().to_string();
        state.sftp.pending_uploads.lock().await.insert(
            upload_token.clone(),
            PendingUpload {
                host_id,
                remote_directory,
                local_path,
            },
        );
        return Ok(SftpUploadResponse::Conflict {
            name,
            path: remote_path,
            upload_token,
        });
    }

    copy_local_file_to_remote(&active.sftp, &local_path, &remote_path, false, None).await?;
    Ok(SftpUploadResponse::Uploaded {
        name,
        path: remote_path,
    })
}

pub async fn overwrite_upload(
    host_id: String,
    upload_token: String,
    state: State<'_, AppState>,
) -> Result<SftpUploadResponse, String> {
    let pending = state
        .sftp
        .pending_uploads
        .lock()
        .await
        .remove(&upload_token)
        .ok_or_else(|| {
            "La confirmación de subida caducó. Selecciona el archivo de nuevo.".to_string()
        })?;
    if pending.host_id != host_id {
        return Err("La confirmación de subida no pertenece a este host".into());
    }
    let local_path = pending.local_path;
    let name = local_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "El archivo local no tiene un nombre válido".to_string())?
        .to_string();
    validate_name(&name)?;
    let remote_path = join_remote_path(&pending.remote_directory, &name);
    let active = state.sftp.get(&host_id).await?;
    let active = active.lock().await;
    copy_local_file_to_remote(&active.sftp, &local_path, &remote_path, true, None).await?;
    Ok(SftpUploadResponse::Uploaded {
        name,
        path: remote_path,
    })
}

pub async fn download(
    host_id: String,
    remote_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let default_name = remote_name(&remote_path)
        .ok_or_else(|| "La ruta remota no identifica un archivo".to_string())?;
    let Some(selection) = app
        .dialog()
        .file()
        .set_title("Descargar archivo por SFTP")
        .set_file_name(default_name)
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let local_path = selection.into_path().map_err(|error| error.to_string())?;
    let active = state.sftp.get(&host_id).await?;
    let active = active.lock().await;
    copy_remote_file_to_local(&active.sftp, &remote_path, &local_path, true, None).await?;
    Ok(Some(local_path.to_string_lossy().into_owned()))
}

struct SftpClientHandler {
    app: AppHandle,
    host_id: String,
    address: String,
    endpoint: (String, u16),
    known_host: Option<KnownHost>,
    verification: Arc<AtomicU8>,
    prompt: Arc<StdMutex<Option<HostKeyPrompt>>>,
}
impl client::Handler for SftpClientHandler {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let algorithm = server_public_key.algorithm().to_string();
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let public_key = match server_public_key.to_openssh() {
            Ok(key) => key,
            Err(_) => return Ok(false),
        };
        if let Some(known) = &self.known_host
            && known.public_key == public_key
        {
            return Ok(true);
        }
        let changed = self.known_host.is_some();
        self.verification.store(
            if changed {
                VERIFY_CHANGED
            } else {
                VERIFY_UNKNOWN
            },
            Ordering::SeqCst,
        );
        let challenge_id = {
            crate::ssh_engine::register_pending_key(
                &self.app.state::<AppState>().ssh,
                PendingHostKey {
                    host_id: self.host_id.clone(),
                    algorithm: algorithm.clone(),
                    fingerprint: fingerprint.clone(),
                    public_key,
                    previous_public_key: self
                        .known_host
                        .as_ref()
                        .map(|known| known.public_key.clone()),
                    address: self.endpoint.0.clone(),
                    port: self.endpoint.1,
                    created_at: Instant::now(),
                },
            )
            .ok()
        };
        if let Ok(mut prompt) = self.prompt.lock() {
            *prompt = Some(HostKeyPrompt {
                host_id: self.host_id.clone(),
                algorithm,
                fingerprint,
                address: self.address.clone(),
                challenge_id,
            });
        }
        Ok(false)
    }
}
async fn close_session(active: Arc<Mutex<ActiveSftpSession>>) {
    let active = active.lock().await;
    let _ = tokio::time::timeout(Duration::from_secs(3), active.sftp.close()).await;
    let _ = tokio::time::timeout(
        Duration::from_secs(3),
        active
            .connection
            .disconnect(Disconnect::ByApplication, "Sesión cerrada", "es"),
    )
    .await;
}

async fn read_directory(sftp: &SftpSession, path: String) -> Result<SftpDirectory, String> {
    let canonical = sftp
        .canonicalize(path)
        .await
        .map_err(|error| format!("No se pudo abrir la carpeta remota: {error}"))?;
    let mut entries = read_remote_entries(sftp, canonical.clone(), None)
        .await?
        .into_iter()
        .map(|entry| {
            validate_component(&entry.file_name(), false)?;
            let metadata = entry.metadata();
            let modified_at = metadata
                .modified()
                .ok()
                .map(|time| DateTime::<Utc>::from(time).to_rfc3339());
            Ok(SftpEntry {
                name: entry.file_name(),
                path: join_remote_path(&canonical, &entry.file_name()),
                is_directory: entry.file_type().is_dir(),
                is_symlink: entry.file_type().is_symlink(),
                size: metadata.len(),
                modified_at,
                permissions: metadata.permissions().to_string(),
                owner: metadata.user.clone(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(SftpDirectory {
        path: canonical,
        entries,
    })
}

fn validate_name(name: &str) -> Result<(), String> {
    validate_component(name.trim(), false)
}

fn validate_local_name(name: &str) -> Result<(), String> {
    validate_component(name.trim(), cfg!(target_os = "windows"))
}

fn ensure_safe_remote_name(name: &str) -> Result<(), String> {
    validate_component(name, cfg!(target_os = "windows"))
}

fn join_remote_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    }
}

fn remote_parent(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => "/".into(),
        Some(index) => trimmed[..index].to_string(),
        None => ".".into(),
    }
}

fn remote_name(path: &str) -> Option<&str> {
    Path::new(path).file_name().and_then(|value| value.to_str())
}

fn remote_name_owned(path: &str) -> Option<String> {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_remote_paths_without_windows_separators() {
        assert_eq!(join_remote_path("/", "logs"), "/logs");
        assert_eq!(join_remote_path("/var", "logs"), "/var/logs");
        assert_eq!(join_remote_path("/var/", "logs"), "/var/logs");
    }

    #[test]
    fn finds_remote_parent() {
        assert_eq!(remote_parent("/var/log/app.log"), "/var/log");
        assert_eq!(remote_parent("/app.log"), "/");
        assert_eq!(remote_parent("app.log"), ".");
    }

    #[test]
    fn rejects_unsafe_remote_names() {
        assert!(validate_name("").is_err());
        assert!(validate_name("..").is_err());
        assert!(validate_name("folder/name").is_err());
        assert!(validate_name("notes.txt").is_ok());
    }

    #[test]
    fn server_entry_names_reject_path_traversal() {
        // Nombres que un servidor SFTP malicioso podría devolver para escapar
        // del directorio destino elegido por la persona usuaria.
        assert!(ensure_safe_remote_name("").is_err());
        assert!(ensure_safe_remote_name(".").is_err());
        assert!(ensure_safe_remote_name("..").is_err());
        assert!(ensure_safe_remote_name("../etc/passwd").is_err());
        assert!(ensure_safe_remote_name("sub/dir").is_err());
        assert!(ensure_safe_remote_name("..\\windows").is_err());
        assert!(ensure_safe_remote_name("con\0tent").is_err());
        assert!(ensure_safe_remote_name("informe.txt").is_ok());
        assert!(ensure_safe_remote_name(".gitignore").is_ok());
    }

    #[test]
    fn rejects_local_path_separators_in_names() {
        assert!(validate_local_name("folder/name").is_err());
        assert!(validate_local_name("folder\\name").is_err());
        assert!(validate_local_name("..").is_err());
        assert!(validate_local_name("notes.txt").is_ok());
    }

    #[test]
    fn extracts_posix_remote_names_on_windows() {
        assert_eq!(
            remote_name_owned("/home/ubuntu/report.pdf").as_deref(),
            Some("report.pdf")
        );
        assert_eq!(
            remote_name_owned("/home/ubuntu/folder/").as_deref(),
            Some("folder")
        );
        assert_eq!(remote_name_owned("/"), None);
    }

    #[test]
    fn lists_local_files_and_directories() {
        let temporary = tempfile::tempdir().unwrap();
        std::fs::create_dir(temporary.path().join("folder")).unwrap();
        std::fs::write(temporary.path().join("notes.txt"), b"nexora").unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let directory = runtime
            .block_on(read_local_directory(temporary.path().to_path_buf()))
            .unwrap();

        assert_eq!(directory.entries.len(), 2);
        assert!(directory.entries[0].is_directory);
        assert_eq!(directory.entries[0].name, "folder");
        assert_eq!(directory.entries[1].name, "notes.txt");
        assert_eq!(directory.entries[1].size, 6);
    }

    #[test]
    fn copies_local_files_and_folders_without_overwriting_silently() {
        let temporary = tempfile::tempdir().unwrap();
        let source_root = temporary.path().join("source");
        let destination = temporary.path().join("destination");
        std::fs::create_dir_all(source_root.join("folder")).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(source_root.join("notes.txt"), b"nexora").unwrap();
        std::fs::write(source_root.join("folder").join("nested.txt"), b"sftp").unwrap();

        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let file = copy_local_to_local(
                source_root.join("notes.txt").to_string_lossy().into_owned(),
                destination.to_string_lossy().into_owned(),
                false,
                None,
            )
            .await
            .unwrap();
            assert!(matches!(
                file,
                TransferResponse::Transferred {
                    file_count: 1,
                    total_bytes: 6,
                    ..
                }
            ));

            let conflict = copy_local_to_local(
                source_root.join("notes.txt").to_string_lossy().into_owned(),
                destination.to_string_lossy().into_owned(),
                false,
                None,
            )
            .await
            .unwrap();
            assert!(matches!(conflict, TransferResponse::Conflict { .. }));

            let folder = copy_local_to_local(
                source_root.join("folder").to_string_lossy().into_owned(),
                destination.to_string_lossy().into_owned(),
                false,
                None,
            )
            .await
            .unwrap();
            assert!(matches!(
                folder,
                TransferResponse::Transferred {
                    file_count: 1,
                    total_bytes: 4,
                    ..
                }
            ));
        });
        assert_eq!(
            std::fs::read(destination.join("folder").join("nested.txt")).unwrap(),
            b"sftp"
        );
    }

    #[test]
    fn creates_empty_files_and_recursively_deletes_local_folders() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("workspace");
        std::fs::create_dir_all(root.join("nested").join("deeper")).unwrap();
        std::fs::write(root.join("nested").join("deeper").join("data.bin"), b"123").unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let directory =
                create_local_file(root.to_string_lossy().into_owned(), "empty.txt".into())
                    .await
                    .unwrap();
            assert!(
                directory
                    .entries
                    .iter()
                    .any(|entry| entry.name == "empty.txt" && entry.size == 0)
            );
            let updated = delete_local(
                root.join("nested").to_string_lossy().into_owned(),
                true,
                true,
            )
            .await
            .unwrap();
            assert!(!updated.entries.iter().any(|entry| entry.name == "nested"));
        });
    }

    #[tokio::test]
    async fn loopback_sftp_lists_safe_names_and_rejects_traversal() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let server = crate::test_server::TestServer::start("notes.txt").await;
            let (_connection, sftp) = server.sftp().await;
            let directory = read_directory(&sftp, ".".into()).await.unwrap();
            assert_eq!(directory.entries[0].path, "/notes.txt");
            sftp.close().await.unwrap();
            let hostile = crate::test_server::TestServer::start("../escape.txt").await;
            let (_connection, sftp) = hostile.sftp().await;
            assert!(read_directory(&sftp, ".".into()).await.is_err());
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn failed_network_download_preserves_original_and_removes_temporary_file() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let server = crate::test_server::TestServer::start("notes.txt").await;
            let (_connection, sftp) = server.sftp().await;
            let directory = tempfile::tempdir().unwrap();
            let target = directory.path().join("notes.txt");
            tokio::fs::write(&target, b"original").await.unwrap();
            assert!(
                copy_remote_file_to_local(&sftp, "/notes.txt", &target, true, None)
                    .await
                    .is_err()
            );
            assert_eq!(tokio::fs::read(&target).await.unwrap(), b"original");
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn cancelled_local_overwrite_keeps_original_and_cleans_partial_file() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.txt");
        let target = directory.path().join("target.txt");
        tokio::fs::write(&source, b"replacement").await.unwrap();
        tokio::fs::write(&target, b"original").await.unwrap();
        let progress =
            TransferProgress::register(Uuid::new_v4().to_string(), Channel::new(|_| Ok(())))
                .unwrap();
        progress.cancelled.store(true, Ordering::Relaxed);
        assert!(
            copy_local_file_to_local(&source, &target, true, Some(&progress))
                .await
                .is_err()
        );
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"original");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_blocked_reader() {
        let (mut reader, _writer) = tokio::io::duplex(16);
        let progress =
            TransferProgress::register(Uuid::new_v4().to_string(), Channel::new(|_| Ok(())))
                .unwrap();
        let cancellation = progress.cancelled.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancellation.store(true, Ordering::Relaxed);
        });
        let mut sink = tokio::io::sink();
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            copy_stream(&mut reader, &mut sink, Some(&progress)),
        )
        .await
        .unwrap();
        assert_eq!(result.unwrap_err(), "TRANSFER_CANCELLED");
    }
}
