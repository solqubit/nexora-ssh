use crate::{
    AppState, connection_profile,
    models::{KnownHost, TunnelKind, TunnelProfile},
    ssh_engine::{PendingHostKey, register_pending_key},
    ssh_route,
    tunnel_engine::{self, ForwardRequest},
};
use russh::{Channel, client, keys::ssh_key::HashAlg};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU16, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TunnelTrust {
    pub host_id: String,
    pub kind: String,
    pub address: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub challenge_id: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TunnelState {
    pub profile: TunnelProfile,
    pub status: String,
    pub message: Option<String>,
    pub listen_port: Option<u16>,
    pub trust: Option<TunnelTrust>,
    pub last_error: Option<String>,
}
struct Entry {
    generation: Uuid,
    state: TunnelState,
    cancel: Option<watch::Sender<bool>>,
    done: watch::Receiver<bool>,
}
#[derive(Default)]
pub(crate) struct TunnelRuntime {
    entries: Mutex<HashMap<String, Entry>>,
}
impl TunnelRuntime {
    pub fn list(&self) -> Result<Vec<TunnelState>, String> {
        Ok(self
            .entries
            .lock()
            .map_err(|_| "El gestor de túneles está ocupado")?
            .values()
            .map(|entry| entry.state.clone())
            .collect())
    }
    pub fn is_idle(&self) -> Result<bool, String> {
        Ok(self
            .entries
            .lock()
            .map_err(|_| "El gestor de túneles está ocupado")?
            .values()
            .all(|entry| *entry.done.borrow()))
    }
    fn update(&self, id: &str, generation: Uuid, change: impl FnOnce(&mut TunnelState)) {
        if let Ok(mut entries) = self.entries.lock()
            && let Some(entry) = entries.get_mut(id)
            && entry.generation == generation
        {
            change(&mut entry.state);
        }
    }
    fn begin(
        &self,
        profile: TunnelProfile,
    ) -> Result<(Uuid, watch::Receiver<bool>, watch::Sender<bool>), String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "El gestor de túneles está ocupado")?;
        if entries
            .get(&profile.id)
            .is_some_and(|entry| !*entry.done.borrow())
        {
            return Err(
                "El túnel ya está activo o conectando; deténlo antes de volver a iniciarlo".into(),
            );
        }
        if entries
            .values()
            .filter(|entry| !*entry.done.borrow())
            .count()
            >= 32
        {
            return Err("Se permiten hasta 32 túneles activos".into());
        }
        // Bound stopped/error records too. Active entries are never evicted.
        if entries.len() >= 1000 {
            entries.retain(|_, entry| !*entry.done.borrow());
        }
        let generation = Uuid::new_v4();
        let (cancel, cancelled) = watch::channel(false);
        let (done, completed) = watch::channel(false);
        entries.insert(
            profile.id.clone(),
            Entry {
                generation,
                state: TunnelState {
                    profile,
                    status: "connecting".into(),
                    message: Some("Preparando la ruta SSH…".into()),
                    listen_port: None,
                    trust: None,
                    last_error: None,
                },
                cancel: Some(cancel),
                done: completed,
            },
        );
        Ok((generation, cancelled, done))
    }
    pub async fn stop(&self, id: &str) -> Result<(), String> {
        let (generation, completed) = {
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| "El gestor de túneles está ocupado")?;
            let Some(entry) = entries.get_mut(id) else {
                return Ok(());
            };
            if let Some(cancel) = entry.cancel.take() {
                let _ = cancel.send(true);
            }
            entry.state.status = "stopping".into();
            entry.state.message = Some("Cerrando conexiones y escucha…".into());
            entry.state.trust = None;
            (entry.generation, entry.done.clone())
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut completed = completed;
            while !*completed.borrow() {
                completed
                    .changed()
                    .await
                    .map_err(|_| "El cierre del túnel no pudo confirmarse")?;
            }
            Ok::<_, String>(())
        })
        .await
        .map_err(|_| "El túnel está tardando en cerrar; espera antes de iniciarlo de nuevo")??;
        if let Ok(mut entries) = self.entries.lock()
            && let Some(entry) = entries.get_mut(id)
            && entry.generation == generation
            && *entry.done.borrow()
        {
            entry.state.status = "stopped".into();
            entry.state.message = None;
        }
        Ok(())
    }
    pub async fn stop_all(&self) -> Result<(), String> {
        {
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| "El gestor de túneles está ocupado")?;
            // Cancel every accept loop before waiting for the first one to finish.
            for entry in entries.values_mut() {
                if let Some(cancel) = entry.cancel.take() {
                    let _ = cancel.send(true);
                }
            }
        }
        let ids: Vec<_> = self
            .list()?
            .into_iter()
            .map(|entry| entry.profile.id)
            .collect();
        for id in ids {
            self.stop(&id).await?;
        }
        Ok(())
    }
}

pub(crate) fn start(
    id: String,
    keepalive: u64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.ensure_available()?;
    let profile = state
        .database
        .lock()
        .map_err(|_| "La base de datos está ocupada")?
        .load_snapshot()
        .map_err(|error| error.to_string())?
        .productivity
        .tunnels
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or("El perfil de túnel ya no existe")?;
    tunnel_engine::validate(&profile)?;
    let (generation, stop, done) = state.ssh.tunnels.begin(profile.clone())?;
    let route = match connection_profile::load_route(&profile.host_id, &state) {
        Ok(route) => route,
        Err(error) => {
            state.ssh.tunnels.update(&id, generation, |state| {
                state.status = "error".into();
                state.message = Some(error.clone());
            });
            let _ = done.send(true);
            return Err(error);
        }
    };
    tauri::async_runtime::spawn(async move {
        let result = run(
            profile,
            route,
            keepalive,
            app.clone(),
            generation,
            stop.clone(),
        )
        .await;
        let cancelled = *stop.borrow();
        app.state::<AppState>()
            .ssh
            .tunnels
            .update(&id, generation, |state| {
                if cancelled {
                    state.status = "stopped".into();
                    state.message = None;
                    state.trust = None;
                } else if state.trust.is_none() {
                    match result {
                        Ok(()) => {
                            state.status = "stopped".into();
                            state.message = None;
                        }
                        Err(error) => {
                            state.status = "error".into();
                            state.message = Some(error);
                        }
                    }
                }
            });
        let _ = done.send(true);
    });
    Ok(())
}

async fn run(
    profile: TunnelProfile,
    route: Vec<connection_profile::ConnectionMaterial>,
    keepalive: u64,
    app: AppHandle,
    generation: Uuid,
    mut stop: watch::Receiver<bool>,
) -> Result<(), String> {
    let id = profile.id.clone();
    let (incoming, receiver) = mpsc::channel(128);
    let port = Arc::new(AtomicU16::new(profile.listen_port));
    if *stop.borrow() {
        return Ok(());
    }
    let connecting = ssh_route::connect(
        &route,
        keepalive,
        |material| TunnelHandler {
            app: app.clone(),
            id: id.clone(),
            generation,
            host_id: material.0.id.clone(),
            name: material.0.name.clone(),
            endpoint: (material.0.address.clone(), material.0.port),
            known: material.1.clone(),
            incoming: (profile.kind == TunnelKind::Remote && material.0.id == profile.host_id)
                .then(|| incoming.clone()),
            listen_address: profile.listen_address.clone(),
            listen_port: port.clone(),
        },
        |_, message| {
            app.state::<AppState>()
                .ssh
                .tunnels
                .update(&id, generation, |state| state.message = Some(message));
        },
    );
    let connection = tokio::select! {
        biased;
        _ = stop.changed() => return Ok(()),
        result = connecting => result.map_err(|error| error.message)?,
    };
    drop(route);
    let ready_app = app.clone();
    let ready_id = id.clone();
    let report_app = app.clone();
    tunnel_engine::serve(
        Arc::new(connection),
        profile,
        receiver,
        stop,
        move |bound| {
            port.store(bound, Ordering::SeqCst);
            ready_app
                .state::<AppState>()
                .ssh
                .tunnels
                .update(&ready_id, generation, |state| {
                    state.status = "active".into();
                    state.message = None;
                    state.listen_port = Some(bound);
                });
        },
        move |error| {
            report_app
                .state::<AppState>()
                .ssh
                .tunnels
                .update(&id, generation, |state| state.last_error = Some(error));
        },
    )
    .await
}

struct TunnelHandler {
    app: AppHandle,
    id: String,
    generation: Uuid,
    host_id: String,
    name: String,
    endpoint: (String, u16),
    known: Option<KnownHost>,
    incoming: Option<mpsc::Sender<ForwardRequest>>,
    listen_address: String,
    listen_port: Arc<AtomicU16>,
}
impl client::Handler for TunnelHandler {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let public_key = key.to_openssh()?;
        if self
            .known
            .as_ref()
            .is_some_and(|known| known.public_key == public_key)
        {
            return Ok(true);
        }
        let changed = self.known.is_some();
        let algorithm = key.algorithm().to_string();
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let challenge_id = {
            register_pending_key(
                &self.app.state::<AppState>().ssh,
                PendingHostKey {
                    host_id: self.host_id.clone(),
                    algorithm: algorithm.clone(),
                    fingerprint: fingerprint.clone(),
                    public_key,
                    previous_public_key: self.known.as_ref().map(|known| known.public_key.clone()),
                    address: self.endpoint.0.clone(),
                    port: self.endpoint.1,
                    created_at: Instant::now(),
                },
            )
            .ok()
        };
        self.app
            .state::<AppState>()
            .ssh
            .tunnels
            .update(&self.id, self.generation, |state| {
                state.status = if changed { "error" } else { "trust_required" }.into();
                state.message = Some(
                    if changed {
                        "La identidad del servidor cambió; revisa su huella antes de conectar"
                    } else {
                        "Verifica la identidad del servidor para iniciar el túnel"
                    }
                    .into(),
                );
                state.trust = Some(TunnelTrust {
                    host_id: self.host_id.clone(),
                    kind: if changed { "changed" } else { "unknown" }.into(),
                    address: format!("{} · {}:{}", self.name, self.endpoint.0, self.endpoint.1),
                    algorithm,
                    fingerprint,
                    challenge_id,
                });
            });
        Ok(false)
    }
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        address: &str,
        port: u32,
        _: &str,
        _: u32,
        reply: client::ChannelOpenHandle,
        _: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let expected_port = self.listen_port.load(Ordering::SeqCst);
        if address == self.listen_address
            && (expected_port == 0 || port == u32::from(expected_port))
            && let Some(incoming) = &self.incoming
        {
            let _ = incoming.try_send(ForwardRequest { channel, reply });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile(id: &str) -> TunnelProfile {
        TunnelProfile {
            id: id.into(),
            host_id: "host".into(),
            name: "Fixture".into(),
            kind: TunnelKind::Local,
            listen_address: "127.0.0.1".into(),
            listen_port: 0,
            target_address: Some("localhost".into()),
            target_port: Some(80),
            updated_at: "now".into(),
        }
    }
    #[tokio::test]
    async fn stop_waits_for_cleanup_and_a_stale_generation_cannot_replace_a_restarted_tunnel() {
        let runtime = Arc::new(TunnelRuntime::default());
        let (old, mut stop, done) = runtime.begin(profile("one")).unwrap();
        assert!(runtime.begin(profile("one")).is_err());
        assert!(!runtime.is_idle().unwrap());
        let worker = tokio::spawn(async move {
            stop.changed().await.unwrap();
            assert!(*stop.borrow());
            let _ = done.send(true);
        });
        runtime.stop("one").await.unwrap();
        worker.await.unwrap();
        assert!(runtime.is_idle().unwrap());
        assert_eq!(runtime.list().unwrap()[0].status, "stopped");
        let (new, _, completed) = runtime.begin(profile("one")).unwrap();
        runtime.update("one", old, |state| state.status = "error".into());
        assert_eq!(runtime.list().unwrap()[0].status, "connecting");
        runtime.update("one", new, |state| state.status = "active".into());
        assert_eq!(runtime.list().unwrap()[0].status, "active");
        completed.send(true).unwrap();
        runtime.stop_all().await.unwrap();
        assert!(runtime.is_idle().unwrap());
    }
    #[tokio::test]
    async fn stop_all_signals_every_tunnel_before_waiting_and_active_limit_does_not_evict_sessions()
    {
        let runtime = Arc::new(TunnelRuntime::default());
        let mut workers = Vec::new();
        for index in 0..32 {
            let (_, mut stop, done) = runtime.begin(profile(&index.to_string())).unwrap();
            workers.push(tokio::spawn(async move {
                stop.changed().await.unwrap();
                done.send(true).unwrap();
            }));
        }
        assert!(runtime.begin(profile("excess")).is_err());
        assert_eq!(runtime.list().unwrap().len(), 32);
        runtime.stop_all().await.unwrap();
        for worker in workers {
            worker.await.unwrap();
        }
        assert!(runtime.is_idle().unwrap());
        assert!(
            runtime
                .list()
                .unwrap()
                .iter()
                .all(|state| state.status == "stopped")
        );
    }
}
