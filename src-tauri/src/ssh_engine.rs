use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::Utc;
use russh::{
    ChannelMsg, Disconnect,
    client::{self},
    keys::ssh_key::HashAlg,
};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, ipc::Channel};
use tokio::sync::{
    mpsc::{self, Receiver, Sender},
    watch,
};
use uuid::Uuid;

use crate::{AppState, models::KnownHost};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const SESSION_COMMAND_CAPACITY: usize = 256;
const MAX_INPUT_BYTES: usize = 1024 * 1024;
const VERIFY_UNKNOWN: u8 = 1;
const VERIFY_CHANGED: u8 = 2;

#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
pub enum SshEvent {
    Stage {
        phase: String,
        message: String,
    },
    Output {
        data: String,
    },
    Status {
        status: String,
        message: Option<String>,
        retryable: bool,
    },
    HostKey {
        host_id: String,
        kind: String,
        algorithm: String,
        fingerprint: String,
        address: String,
        challenge_id: Option<String>,
    },
}

#[derive(Debug)]
pub enum SessionCommand {
    Input(Vec<u8>),
    Resize(u32, u32),
    Disconnect,
}

#[derive(Debug, Clone)]
pub struct PendingHostKey {
    pub host_id: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub public_key: String,
    pub previous_public_key: Option<String>,
    pub address: String,
    pub port: u16,
    pub created_at: Instant,
}

#[derive(Clone)]
pub struct ActiveSession {
    pub(crate) host_id: Option<String>,
    pub(crate) generation: Uuid,
    pub(crate) sender: Sender<SessionCommand>,
    pub(crate) cancellation: watch::Sender<bool>,
}

#[derive(Default)]
pub struct SshRuntime {
    pub(crate) tunnels: crate::tunnel_runtime::TunnelRuntime,
    pub(crate) temporary: crate::temporary_hosts::TemporaryRuntime,
    pub sessions: Mutex<HashMap<String, ActiveSession>>,
    pub pending_host_keys: Mutex<HashMap<String, PendingHostKey>>,
}

#[allow(clippy::too_many_arguments)]
pub fn start_session(
    session_id: String,
    host_id: String,
    columns: u32,
    rows: u32,
    keepalive_seconds: u64,
    on_event: Channel<SshEvent>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.ensure_available()?;
    if session_id.trim().is_empty() || session_id.len() > 200 {
        return Err("Identificador de sesión no válido".into());
    }

    let (sender, receiver) = mpsc::channel(SESSION_COMMAND_CAPACITY);
    let (cancellation, mut cancelled) = watch::channel(false);
    let generation = Uuid::new_v4();
    {
        let mut sessions = state
            .ssh
            .sessions
            .lock()
            .map_err(|_| "El gestor de sesiones está ocupado".to_string())?;
        state.ensure_available()?;
        if sessions.contains_key(&session_id) {
            return Err("La sesión ya está conectando o conectada".into());
        }
        if sessions.len() >= 100 {
            return Err("Cierra una sesión antes de abrir otra (máximo 100).".into());
        }
        sessions.insert(
            session_id.clone(),
            ActiveSession {
                host_id: Some(host_id.clone()),
                generation,
                sender,
                cancellation,
            },
        );
    }

    let route = match crate::connection_profile::load_route(&host_id, &state) {
        Ok(route) => route,
        Err(error) => {
            if let Ok(mut sessions) = state.ssh.sessions.lock() {
                remove_session_generation(&mut sessions, &session_id, generation);
            }
            return Err(error);
        }
    };

    let task_session_id = session_id.clone();
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let telnet = route.len() == 1 && route[0].0.protocol == "telnet";
        let connection = async {
            if telnet {
                crate::telnet_engine::run(
                    route.into_iter().next().unwrap(),
                    columns,
                    rows,
                    receiver,
                    &on_event,
                )
                .await
            } else {
                run_session(
                    &task_app,
                    route,
                    columns,
                    rows,
                    keepalive_seconds,
                    receiver,
                    &on_event,
                )
                .await
            }
        };
        let result = tokio::select! {
            result = connection => result,
            _ = cancelled.changed() => { send_status(&on_event, "disconnected", Some("Sesión cancelada".into())); Ok(()) }
        };
        if let Err(message) = result {
            send_output(
                &on_event,
                format!("\r\n\x1b[31m{message}\x1b[0m\r\n").as_bytes(),
            );
            send_error(&on_event, message, true);
        }
        if let Ok(mut sessions) = task_app.state::<AppState>().ssh.sessions.lock() {
            remove_session_generation(&mut sessions, &task_session_id, generation);
        }
    });
    Ok(())
}

pub fn write_session(
    session_id: &str,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if data.len() > MAX_INPUT_BYTES {
        return Err("La entrada supera el límite de 1 MB".into());
    }
    send_command(session_id, SessionCommand::Input(data.into_bytes()), state)
}

pub fn resize_session(
    session_id: &str,
    columns: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    send_command(
        session_id,
        SessionCommand::Resize(columns.max(20), rows.max(5)),
        state,
    )
}

pub fn disconnect_session(session_id: &str, state: State<'_, AppState>) -> Result<(), String> {
    let sender = state
        .ssh
        .sessions
        .lock()
        .map_err(|_| "El gestor de sesiones está ocupado".to_string())?
        .remove(session_id);
    if let Some(active) = sender {
        let _ = active.cancellation.send(true);
        let _ = active.sender.try_send(SessionCommand::Disconnect);
    }
    Ok(())
}

pub fn trust_pending_host_key(
    host_id: &str,
    challenge_id: &str,
    replace: bool,
    state: &AppState,
) -> Result<KnownHost, String> {
    let mut database = state
        .database
        .lock()
        .map_err(|_| "La base de datos está ocupada".to_string())?;
    state.ensure_available()?;
    let mut snapshot = database.load_snapshot().map_err(|e| e.to_string())?;
    let pending = state
        .ssh
        .pending_host_keys
        .lock()
        .map_err(|_| "El almacén de huellas está ocupado".to_string())?
        .remove(challenge_id)
        .ok_or_else(|| {
            "No hay una huella pendiente para este host. Vuelve a conectar.".to_string()
        })?;

    if !snapshot.hosts.iter().any(|host| host.id == host_id) {
        return crate::temporary_hosts::trust(host_id, pending, &snapshot, state, replace);
    }
    let host = snapshot
        .hosts
        .iter()
        .find(|host| host.id == host_id)
        .ok_or("El host ya no existe")?;
    let effective = crate::connection_profile::resolve(&snapshot, host)?;
    validate_pending_key(
        &pending,
        host_id,
        &effective.host.address,
        effective.host.port,
    )?;
    validate_replacement(
        &pending,
        snapshot
            .known_hosts
            .iter()
            .find(|known| known.host_id == host_id),
        replace,
    )?;
    let known = KnownHost {
        id: Uuid::new_v4().to_string(),
        host_id: pending.host_id,
        algorithm: pending.algorithm,
        fingerprint: pending.fingerprint,
        public_key: pending.public_key,
        trusted_at: Utc::now().to_rfc3339(),
    };
    snapshot.known_hosts.retain(|item| item.host_id != host_id);
    snapshot.known_hosts.push(known.clone());
    database
        .save_snapshot(&snapshot)
        .map_err(|error| error.to_string())?;
    Ok(known)
}

pub(crate) fn validate_replacement(
    pending: &PendingHostKey,
    current: Option<&KnownHost>,
    replace: bool,
) -> Result<(), String> {
    let current_key = current.map(|known| known.public_key.as_str());
    if current_key != pending.previous_public_key.as_deref() {
        return Err("La huella guardada cambió durante la verificación. Vuelve a conectar.".into());
    }
    if pending.previous_public_key.is_some() && !replace {
        return Err("Confirma el reemplazo de la huella anterior antes de conectar.".into());
    }
    Ok(())
}

pub(crate) fn validate_pending_key(
    pending: &PendingHostKey,
    host_id: &str,
    address: &str,
    port: u16,
) -> Result<(), String> {
    if pending.host_id != host_id
        || pending.address != address
        || pending.port != port
        || pending.created_at.elapsed() > Duration::from_secs(300)
    {
        return Err("La verificación caducó o el servidor cambió. Vuelve a conectar.".into());
    }
    Ok(())
}

pub(crate) fn register_pending_key(
    runtime: &SshRuntime,
    pending: PendingHostKey,
) -> Result<String, String> {
    let mut keys = runtime
        .pending_host_keys
        .lock()
        .map_err(|_| "El almacén de huellas está ocupado".to_string())?;
    keys.retain(|_, key| key.created_at.elapsed() <= Duration::from_secs(300));
    if keys.len() >= 128 {
        return Err("Hay demasiadas verificaciones pendientes".into());
    }
    let challenge = Uuid::new_v4().to_string();
    keys.insert(challenge.clone(), pending);
    Ok(challenge)
}

fn send_command(
    session_id: &str,
    command: SessionCommand,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sender = state
        .ssh
        .sessions
        .lock()
        .map_err(|_| "El gestor de sesiones está ocupado".to_string())?
        .get(session_id)
        .map(|active| active.sender.clone())
        .ok_or_else(|| "La sesión no está conectada".to_string())?;
    sender.try_send(command).map_err(|error| match error {
        mpsc::error::TrySendError::Full(_) => {
            "La sesión SSH está ocupada; intenta de nuevo".to_string()
        }
        mpsc::error::TrySendError::Closed(_) => "La sesión SSH ya terminó".to_string(),
    })
}

pub(crate) fn remove_session_generation(
    sessions: &mut HashMap<String, ActiveSession>,
    session_id: &str,
    generation: Uuid,
) {
    if sessions
        .get(session_id)
        .is_some_and(|active| active.generation == generation)
    {
        sessions.remove(session_id);
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_session(
    app: &AppHandle,
    route: Vec<crate::connection_profile::ConnectionMaterial>,
    columns: u32,
    rows: u32,
    keepalive_seconds: u64,
    mut commands: Receiver<SessionCommand>,
    events: &Channel<SshEvent>,
) -> Result<(), String> {
    let target = route.last().ok_or("La ruta SSH está vacía")?;
    let host = target.0.clone();
    send_status(
        events,
        "connecting",
        Some(format!("Conectando con {}:{}…", host.address, host.port)),
    );
    let verification = Arc::new(AtomicU8::new(0));
    let session = match crate::ssh_route::connect(
        &route,
        keepalive_seconds,
        |material| ClientHandler {
            app: app.clone(),
            host_id: material.0.id.clone(),
            address: format!(
                "{} · {}:{}",
                material.0.name, material.0.address, material.0.port
            ),
            endpoint: (material.0.address.clone(), material.0.port),
            known_host: material.1.clone(),
            events: events.clone(),
            verification: verification.clone(),
        },
        |phase, message| send_stage(events, phase, message),
    )
    .await
    {
        Ok(session) => session,
        Err(error) => {
            match verification.load(Ordering::SeqCst) {
                VERIFY_UNKNOWN => send_status(
                    events,
                    "trust_required",
                    Some("Confirma la identidad del servidor indicado antes de continuar".into()),
                ),
                VERIFY_CHANGED => send_error(
                    events,
                    "La huella de un servidor de la ruta cambió. Se bloqueó la conexión.".into(),
                    false,
                ),
                _ => {
                    send_output(
                        events,
                        format!("\r\n\x1b[31m{}\x1b[0m\r\n", error.message).as_bytes(),
                    );
                    send_error(events, error.message, error.retryable);
                }
            }
            return Ok(());
        }
    };
    drop(route);
    send_stage(events, "terminal", "Solicitando terminal virtual…".into());
    let mut channel = tokio::time::timeout(CONNECT_TIMEOUT, session.channel_open_session())
        .await
        .map_err(|_| "El canal SSH agotó el tiempo de espera".to_string())?
        .map_err(|error| format!("No se pudo abrir el canal SSH: {error}"))?;
    if let Err(message) = open_interactive(&mut channel, columns, rows, events).await {
        let _ = channel.close().await;
        send_error(events, message, false);
        return Ok(());
    }
    send_status(
        events,
        "connected",
        Some(format!("Conectado a {}", host.name)),
    );

    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(SessionCommand::Input(data)) => channel.data(&data[..]).await.map_err(|error| format!("No se pudo escribir en la terminal: {error}"))?,
                Some(SessionCommand::Resize(width, height)) => channel.window_change(width, height, 0, 0).await.map_err(|error| format!("No se pudo redimensionar la terminal: {error}"))?,
                Some(SessionCommand::Disconnect) | None => {
                    let _ = channel.eof().await;
                    let _ = channel.close().await;
                    let _ = session.disconnect(Disconnect::ByApplication, "Desconectado por el usuario", "es").await;
                    send_status(events, "disconnected", Some("Sesión cerrada".into()));
                    return Ok(());
                }
            },
            message = channel.wait() => match message {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => send_output(events, &data),
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    send_status(events, "disconnected", Some(format!("El shell remoto terminó con código {exit_status}")));
                    return Ok(());
                }
                Some(ChannelMsg::Eof) => {
                    // El estado de salida o el cierre pueden llegar después del EOF.
                }
                Some(ChannelMsg::Close) | None => {
                    send_error(events, "El servidor cerró la sesión inesperadamente".into(), true);
                    return Ok(());
                }
                _ => {}
            }
        }
    }
}

pub(crate) async fn open_interactive(
    channel: &mut russh::Channel<client::Msg>,
    columns: u32,
    rows: u32,
    events: &Channel<SshEvent>,
) -> Result<(), String> {
    tokio::time::timeout(
        CONNECT_TIMEOUT,
        channel.request_pty(
            true,
            "xterm-256color",
            columns.clamp(20, 1000),
            rows.clamp(5, 500),
            0,
            0,
            &[],
        ),
    )
    .await
    .map_err(|_| "La solicitud de terminal virtual agotó el tiempo de espera".to_string())?
    .map_err(|error| format!("No se pudo solicitar la terminal virtual: {error}"))?;
    await_request(channel, "terminal virtual", events).await?;
    tokio::time::timeout(CONNECT_TIMEOUT, channel.request_shell(true))
        .await
        .map_err(|_| "La solicitud del shell agotó el tiempo de espera".to_string())?
        .map_err(|error| format!("No se pudo solicitar el shell: {error}"))?;
    await_request(channel, "shell interactivo", events).await
}

async fn await_request(
    channel: &mut russh::Channel<client::Msg>,
    label: &str,
    events: &Channel<SshEvent>,
) -> Result<(), String> {
    tokio::time::timeout(CONNECT_TIMEOUT, async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(()),
                Some(ChannelMsg::Failure) => return Err(format!("El servidor rechazó el {label}. Revisa su configuración antes de volver a conectar.")),
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => send_output(events, &data),
                Some(ChannelMsg::Close | ChannelMsg::Eof | ChannelMsg::ExitStatus { .. }) | None => return Err(format!("El servidor cerró la conexión antes de aceptar el {label}")),
                _ => {}
            }
        }
    }).await.map_err(|_| format!("El servidor no confirmó el {label} dentro del tiempo de espera"))?
}

pub(crate) fn send_stage(events: &Channel<SshEvent>, phase: &str, message: String) {
    let _ = events.send(SshEvent::Stage {
        phase: phase.into(),
        message,
    });
}

struct ClientHandler {
    app: AppHandle,
    host_id: String,
    address: String,
    endpoint: (String, u16),
    known_host: Option<KnownHost>,
    events: Channel<SshEvent>,
    verification: Arc<AtomicU8>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        send_stage(
            &self.events,
            "verification",
            "Verificando la identidad del servidor…".into(),
        );
        let algorithm = server_public_key.algorithm().to_string();
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let public_key = match server_public_key.to_openssh() {
            Ok(key) => key,
            Err(_) => return Ok(false),
        };

        if self
            .known_host
            .as_ref()
            .is_some_and(|known| known.public_key == public_key)
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
        let challenge_id = register_pending_key(
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
        .ok();
        let _ = self.events.send(SshEvent::HostKey {
            host_id: self.host_id.clone(),
            kind: if changed { "changed" } else { "unknown" }.into(),
            algorithm,
            fingerprint,
            address: self.address.clone(),
            challenge_id,
        });
        Ok(false)
    }
}

pub(crate) fn send_output(events: &Channel<SshEvent>, data: &[u8]) {
    let _ = events.send(SshEvent::Output {
        data: STANDARD.encode(data),
    });
}

pub(crate) fn send_status(events: &Channel<SshEvent>, status: &str, message: Option<String>) {
    let _ = events.send(SshEvent::Status {
        status: status.into(),
        message,
        retryable: false,
    });
}

/// Emite un estado de error indicando si la interfaz debería reintentar. Los
/// fallos de credenciales o de identidad NO son reintentables (evita bloqueos);
/// los cortes de red o timeouts sí. La decisión vive en el núcleo, no en el
/// texto del mensaje.
pub(crate) fn send_error(events: &Channel<SshEvent>, message: String, retryable: bool) {
    let _ = events.send(SshEvent::Status {
        status: "error".into(),
        message: Some(message),
        retryable,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn interactive_terminal_waits_for_ack_and_never_executes_commands() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let server = crate::test_server::TestServer::start("fixture").await;
            let mut connection = server.connect().await;
            assert!(
                connection
                    .authenticate_password("test", "fixture-password")
                    .await
                    .unwrap()
                    .success()
            );
            let events = Channel::new(|_| Ok(()));
            let mut plain = connection.channel_open_session().await.unwrap();
            open_interactive(&mut plain, 80, 24, &events).await.unwrap();
            assert!(server.terminal.lock().unwrap().last_exec.is_none());
            plain.close().await.unwrap();
            for (pty, shell, expected) in [
                (true, false, "terminal virtual"),
                (false, true, "shell interactivo"),
            ] {
                {
                    let mut flags = server.terminal.lock().unwrap();
                    flags.reject_pty = pty;
                    flags.reject_shell = shell;
                }
                let mut channel = connection.channel_open_session().await.unwrap();
                let error = open_interactive(&mut channel, 80, 24, &events)
                    .await
                    .unwrap_err();
                assert!(
                    error.contains(expected) && error.contains("rechazó"),
                    "{error}"
                );
                channel.close().await.unwrap();
            }
        })
        .await
        .unwrap();
    }

    #[test]
    fn stale_session_cleanup_does_not_remove_replacement() {
        let session_id = "terminal-1".to_string();
        let old_generation = Uuid::new_v4();
        let new_generation = Uuid::new_v4();
        let (old_sender, _old_receiver) = mpsc::channel(1);
        let (new_sender, _new_receiver) = mpsc::channel(1);
        let mut sessions = HashMap::from([(
            session_id.clone(),
            ActiveSession {
                generation: old_generation,
                host_id: None,
                sender: old_sender,
                cancellation: watch::channel(false).0,
            },
        )]);
        sessions.insert(
            session_id.clone(),
            ActiveSession {
                generation: new_generation,
                host_id: None,
                sender: new_sender,
                cancellation: watch::channel(false).0,
            },
        );

        remove_session_generation(&mut sessions, &session_id, old_generation);

        assert_eq!(
            sessions.get(&session_id).map(|active| active.generation),
            Some(new_generation)
        );
    }

    #[test]
    fn host_key_challenges_are_independent_and_bound_to_endpoint() {
        let runtime = SshRuntime::default();
        let pending = PendingHostKey {
            host_id: "host".into(),
            algorithm: "ssh-ed25519".into(),
            fingerprint: "first".into(),
            public_key: "first".into(),
            previous_public_key: None,
            address: "127.0.0.1".into(),
            port: 22,
            created_at: Instant::now(),
        };
        let first = register_pending_key(&runtime, pending.clone()).unwrap();
        let mut second_key = pending.clone();
        second_key.public_key = "second".into();
        let second = register_pending_key(&runtime, second_key).unwrap();
        assert_ne!(first, second);
        let keys = runtime.pending_host_keys.lock().unwrap();
        assert_eq!(keys[&first].public_key, "first");
        assert_eq!(keys[&second].public_key, "second");
        assert!(validate_pending_key(&pending, "host", "127.0.0.1", 22).is_ok());
        assert!(validate_pending_key(&pending, "other", "127.0.0.1", 22).is_err());
        assert!(validate_pending_key(&pending, "host", "127.0.0.2", 22).is_err());
        assert!(validate_pending_key(&pending, "host", "127.0.0.1", 2222).is_err());
        let mut expired = pending;
        expired.created_at = Instant::now() - Duration::from_secs(301);
        assert!(validate_pending_key(&expired, "host", "127.0.0.1", 22).is_err());
    }

    #[test]
    fn replacement_updates_the_database_once_and_survives_reopening() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("replacement.db");
        let mut database = crate::database::Database::open(&path).unwrap();
        let mut snapshot = database.load_snapshot().unwrap();
        let host: crate::models::Host = serde_json::from_value(serde_json::json!({
            "id":"host", "vaultId":snapshot.vaults[0].id, "groupId":null, "name":"Server", "address":"127.0.0.1", "port":22,
            "username":"operator", "authMethod":"password", "keyPath":null, "favorite":false, "color":"blue", "tags":[], "note":"", "createdAt":"now", "updatedAt":"now"
        })).unwrap();
        snapshot.hosts.push(host);
        snapshot.known_hosts.push(KnownHost {
            id: "old".into(),
            host_id: "host".into(),
            algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:old".into(),
            public_key: "old".into(),
            trusted_at: "now".into(),
        });
        database.save_snapshot(&snapshot).unwrap();
        let state = AppState {
            _instance_lock: std::fs::File::create(directory.path().join("instance.lock")).unwrap(),
            database: Mutex::new(database),
            secrets: Mutex::new(crate::secrets::SecretStore::fixture(None)),
            ssh: Default::default(),
            sftp: Default::default(),
            restoring: std::sync::atomic::AtomicBool::new(false),
            vault_open: std::sync::atomic::AtomicBool::new(true),
        };
        let pending = PendingHostKey {
            host_id: "host".into(),
            algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:new".into(),
            public_key: "new".into(),
            previous_public_key: Some("old".into()),
            address: "127.0.0.1".into(),
            port: 22,
            created_at: Instant::now(),
        };
        let rejected = register_pending_key(&state.ssh, pending.clone()).unwrap();
        assert!(trust_pending_host_key("host", &rejected, false, &state).is_err());
        assert_eq!(
            state.database.lock().unwrap().load_snapshot().unwrap(),
            snapshot
        );
        let challenge = register_pending_key(&state.ssh, pending).unwrap();
        let accepted = trust_pending_host_key("host", &challenge, true, &state).unwrap();
        assert_eq!(accepted.public_key, "new");
        assert!(trust_pending_host_key("host", &challenge, true, &state).is_err());
        drop(state);
        assert_eq!(
            crate::database::Database::open(&path)
                .unwrap()
                .load_snapshot()
                .unwrap()
                .known_hosts,
            vec![accepted]
        );
    }

    #[test]
    fn changed_keys_require_confirmation_and_the_exact_previously_observed_key() {
        let known = KnownHost {
            id: "known".into(),
            host_id: "host".into(),
            algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:old".into(),
            public_key: "old".into(),
            trusted_at: "now".into(),
        };
        let pending = PendingHostKey {
            host_id: "host".into(),
            algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:new".into(),
            public_key: "new".into(),
            previous_public_key: Some("old".into()),
            address: "127.0.0.1".into(),
            port: 22,
            created_at: Instant::now(),
        };
        assert!(validate_replacement(&pending, Some(&known), false).is_err());
        assert!(validate_replacement(&pending, Some(&known), true).is_ok());
        let newer = KnownHost {
            public_key: "concurrent-change".into(),
            ..known
        };
        assert!(validate_replacement(&pending, Some(&newer), true).is_err());
        assert!(validate_replacement(&pending, None, true).is_err());
        let unknown = PendingHostKey {
            previous_public_key: None,
            ..pending
        };
        assert!(validate_replacement(&unknown, Some(&newer), true).is_err());
        assert!(validate_replacement(&unknown, None, false).is_ok());
    }
}
