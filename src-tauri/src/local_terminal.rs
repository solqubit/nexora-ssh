use crate::{
    AppState,
    ssh_engine::{
        ActiveSession, SessionCommand, SshEvent, remove_session_generation, send_error,
        send_output, send_status,
    },
};
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io::{Read, Write};
use tauri::{AppHandle, Manager, State, ipc::Channel};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

struct LocalProcess {
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}
impl Drop for LocalProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}
struct KillOnDrop(Option<Box<dyn ChildKiller + Send + Sync>>);
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if let Some(killer) = &mut self.0 {
            let _ = killer.kill();
        }
    }
}
enum Output {
    Data(Vec<u8>),
    Closed,
    Error(String),
}

fn size(columns: u32, rows: u32) -> PtySize {
    PtySize {
        cols: columns.clamp(20, 1000) as u16,
        rows: rows.clamp(5, 500) as u16,
        pixel_width: 0,
        pixel_height: 0,
    }
}
fn shell_command() -> Result<CommandBuilder, String> {
    #[cfg(windows)]
    {
        let root =
            std::env::var_os("SystemRoot").ok_or("No se pudo localizar Windows PowerShell")?;
        let path =
            std::path::PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        if !path.is_file() {
            return Err("Windows PowerShell no está instalado en su ubicación del sistema".into());
        }
        let mut command = CommandBuilder::new(path);
        command.args(["-NoLogo", "-NoProfile"]);
        if let Some(home) = std::env::var_os("USERPROFILE") {
            command.cwd(home);
        }
        command.env("TERM", "xterm-256color");
        Ok(command)
    }
    #[cfg(not(windows))]
    {
        Err("La terminal PowerShell local de esta versión está disponible en Windows".into())
    }
}

fn open_process(columns: u32, rows: u32) -> Result<(LocalProcess, Box<dyn Read + Send>), String> {
    let command = shell_command()?;
    let pair = native_pty_system()
        .openpty(size(columns, rows))
        .map_err(|error| format!("No se pudo abrir la terminal local: {error}"))?;
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("No se pudo iniciar PowerShell: {error}"))?;
    let mut guard = KillOnDrop(Some(child.clone_killer()));
    drop(pair.slave);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("No se pudo leer la terminal local: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("No se pudo escribir en la terminal local: {error}"))?;
    // The process owns the kill guard after all fallible setup operations complete.
    guard.0.take();
    Ok((
        LocalProcess {
            child,
            master: pair.master,
            writer,
        },
        reader,
    ))
}

pub(crate) fn start(
    session_id: String,
    columns: u32,
    rows: u32,
    on_event: Channel<SshEvent>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.ensure_available()?;
    if session_id.is_empty() || session_id.len() > 200 {
        return Err("Identificador de sesión no válido".into());
    }
    let (sender, commands) = mpsc::channel(256);
    let (cancellation, cancelled) = watch::channel(false);
    let generation = Uuid::new_v4();
    {
        let mut sessions = state
            .ssh
            .sessions
            .lock()
            .map_err(|_| "El gestor de sesiones está ocupado")?;
        state.ensure_available()?;
        if sessions.contains_key(&session_id) {
            return Err("La sesión ya está abierta".into());
        }
        if sessions.len() >= 100 {
            return Err("Cierra una sesión antes de abrir otra".into());
        }
        sessions.insert(
            session_id.clone(),
            ActiveSession {
                host_id: None,
                generation,
                sender,
                cancellation,
            },
        );
    }
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run(columns, rows, commands, cancelled, &on_event).await {
            send_error(&on_event, error, false);
        }
        if let Ok(mut sessions) = app.state::<AppState>().ssh.sessions.lock() {
            remove_session_generation(&mut sessions, &session_id, generation);
        }
    });
    Ok(())
}

async fn run(
    columns: u32,
    rows: u32,
    mut commands: mpsc::Receiver<SessionCommand>,
    mut cancelled: watch::Receiver<bool>,
    events: &Channel<SshEvent>,
) -> Result<(), String> {
    send_status(
        events,
        "connecting",
        Some("Abriendo PowerShell local…".into()),
    );
    if *cancelled.borrow() {
        send_status(
            events,
            "disconnected",
            Some("Terminal local cancelada".into()),
        );
        return Ok(());
    }
    let (mut process, mut reader) =
        tokio::task::spawn_blocking(move || open_process(columns, rows))
            .await
            .map_err(|error| error.to_string())??;
    let _kill = KillOnDrop(Some(process.child.clone_killer()));
    if *cancelled.borrow() {
        send_status(
            events,
            "disconnected",
            Some("Terminal local cancelada".into()),
        );
        return Ok(());
    }
    let (output, mut messages) = mpsc::channel(32);
    let read_output = output.clone();
    tokio::task::spawn_blocking(move || {
        let mut buffer = [0u8; 8192];
        loop {
            let value = match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = read_output.blocking_send(Output::Closed);
                    break;
                }
                Ok(length) => Output::Data(buffer[..length].to_vec()),
                Err(error) => {
                    let _ = read_output.blocking_send(Output::Error(format!(
                        "Se interrumpió la lectura de la terminal local: {error}"
                    )));
                    break;
                }
            };
            if read_output.blocking_send(value).is_err() {
                break;
            }
        }
    });
    tokio::task::spawn_blocking(move || {
        while let Some(command) = commands.blocking_recv() {
            let result = match command {
                SessionCommand::Input(data) => process
                    .writer
                    .write_all(&data)
                    .and_then(|_| process.writer.flush())
                    .map_err(|error| error.to_string()),
                SessionCommand::Resize(columns, rows) => process
                    .master
                    .resize(size(columns, rows))
                    .map_err(|error| error.to_string()),
                SessionCommand::Disconnect => break,
            };
            if let Err(error) = result {
                let _ = output.blocking_send(Output::Error(format!(
                    "La terminal local no pudo completar la operación: {error}"
                )));
                break;
            }
        }
    });
    send_status(
        events,
        "connected",
        Some("PowerShell local · este equipo".into()),
    );
    loop {
        tokio::select! {
            _ = cancelled.changed() => { send_status(events, "disconnected", Some("Terminal local cerrada".into())); return Ok(()); },
            message = messages.recv() => match message {
                Some(Output::Data(data)) => send_output(events, &data),
                Some(Output::Error(error)) => return Err(error),
                Some(Output::Closed) | None => { send_status(events, "disconnected", Some("PowerShell terminó".into())); return Ok(()); }
            }
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use std::time::Duration;
    use tauri::ipc::InvokeResponseBody;

    #[tokio::test]
    async fn powershell_pty_executes_input_resizes_and_cancels_cleanly() {
        tokio::time::timeout(Duration::from_secs(15), async {
            let (sender, commands) = mpsc::channel(16);
            let (cancel, cancelled) = watch::channel(false);
            let (output, mut received) = mpsc::unbounded_channel();
            let events = Channel::<SshEvent>::new(move |body| {
                if let InvokeResponseBody::Json(json) = body { let _ = output.send(serde_json::from_str::<serde_json::Value>(&json).unwrap()); }
                Ok(())
            });
            let runner = tokio::spawn(async move { run(80, 24, commands, cancelled, &events).await });
            while let Some(event) = received.recv().await {
                if event["event"] == "status" && event["data"]["status"] == "connected" { break; }
                assert_ne!(event["data"]["status"], "error", "{event}");
            }
            sender.send(SessionCommand::Resize(50, 19)).await.unwrap();
            sender.send(SessionCommand::Input(b"Write-Output ('NEXORA_' + 'LOCAL_OK'); Write-Output ('{0}x{1}' -f [Console]::WindowWidth,[Console]::WindowHeight)\r".to_vec())).await.unwrap();
            let mut text = String::new();
            while !(text.contains("NEXORA_LOCAL_OK") && text.contains("50x19")) {
                let event = received.recv().await.expect("missing terminal output");
                assert_ne!(event["data"]["status"], "error", "{event}");
                if event["event"] == "output" {
                    let bytes = STANDARD.decode(event["data"]["data"].as_str().unwrap()).unwrap();
                    if bytes.windows(4).any(|value| value == b"\x1b[6n") { sender.send(SessionCommand::Input(b"\x1b[1;1R".to_vec())).await.unwrap(); }
                    text.push_str(&String::from_utf8_lossy(&bytes));
                }
            }
            cancel.send(true).unwrap();
            runner.await.unwrap().unwrap();
            drop(sender);
        }).await.unwrap();
    }

    #[tokio::test]
    async fn independent_kill_guard_terminates_the_exact_child_process() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let (mut process, reader) = tokio::task::spawn_blocking(|| open_process(80, 24))
                .await
                .unwrap()
                .unwrap();
            let killer = KillOnDrop(Some(process.child.clone_killer()));
            assert!(process.child.process_id().is_some());
            let read = tokio::task::spawn_blocking(move || {
                let mut reader = reader;
                let mut buffer = [0; 8192];
                while reader.read(&mut buffer).is_ok_and(|length| length > 0) {}
            });
            drop(killer);
            while process.child.try_wait().unwrap().is_none() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            drop(process);
            read.await.unwrap();
        })
        .await
        .unwrap();
    }
}
