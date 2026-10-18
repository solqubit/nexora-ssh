//! Telnet terminal transport. Credentials stay in the native process.
use crate::{
    connection_profile::ConnectionMaterial,
    ssh_engine::{SessionCommand, SshEvent, send_output, send_stage, send_status},
};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc::Receiver,
};

const IAC: u8 = 255;
const WILL: u8 = 251;
const WONT: u8 = 252;
const DO: u8 = 253;
const DONT: u8 = 254;
const SB: u8 = 250;
const SE: u8 = 240;
const BINARY: u8 = 0;
const ECHO: u8 = 1;
const SGA: u8 = 3;
const TTYPE: u8 = 24;
const NAWS: u8 = 31;

#[derive(Default)]
enum ParseState {
    #[default]
    Data,
    Command,
    Option(u8),
    Sub,
    SubCommand,
}

struct Telnet {
    state: ParseState,
    sub: Vec<u8>,
    local: [bool; 256],
    remote: [bool; 256],
    columns: u32,
    rows: u32,
    pending_cr: bool,
}
impl Telnet {
    fn new(columns: u32, rows: u32) -> Self {
        Self {
            state: ParseState::Data,
            sub: Vec::new(),
            local: [false; 256],
            remote: [false; 256],
            columns,
            rows,
            pending_cr: false,
        }
    }
    fn window_size(&self) -> Vec<u8> {
        let mut reply = vec![IAC, SB, NAWS];
        let data = [
            self.columns.clamp(1, 65535) as u16,
            self.rows.clamp(1, 65535) as u16,
        ];
        for byte in data.into_iter().flat_map(u16::to_be_bytes) {
            reply.push(byte);
            if byte == IAC {
                reply.push(IAC);
            }
        }
        reply.extend([IAC, SE]);
        reply
    }
    fn receive(&mut self, input: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut output = Vec::new();
        let mut reply = Vec::new();
        for &byte in input {
            match self.state {
                ParseState::Data if byte == IAC => self.state = ParseState::Command,
                ParseState::Data => {
                    if !(self.pending_cr && byte == 0 && !self.remote[BINARY as usize]) {
                        output.push(byte);
                    }
                    self.pending_cr = byte == b'\r';
                }
                ParseState::Command => match byte {
                    IAC => {
                        output.push(IAC);
                        self.state = ParseState::Data;
                    }
                    WILL | WONT | DO | DONT => self.state = ParseState::Option(byte),
                    SB => {
                        self.sub.clear();
                        self.state = ParseState::Sub;
                    }
                    _ => self.state = ParseState::Data,
                },
                ParseState::Option(command) => {
                    let index = byte as usize;
                    match command {
                        WILL => {
                            if [BINARY, ECHO, SGA].contains(&byte) {
                                if !self.remote[index] {
                                    reply.extend([IAC, DO, byte]);
                                    self.remote[index] = true;
                                }
                            } else {
                                reply.extend([IAC, DONT, byte]);
                            }
                        }
                        WONT if self.remote[index] => {
                            reply.extend([IAC, DONT, byte]);
                            self.remote[index] = false;
                        }
                        DO => {
                            if [BINARY, SGA, TTYPE, NAWS].contains(&byte) {
                                if !self.local[index] {
                                    reply.extend([IAC, WILL, byte]);
                                    self.local[index] = true;
                                    if byte == NAWS {
                                        reply.extend(self.window_size());
                                    }
                                }
                            } else {
                                reply.extend([IAC, WONT, byte]);
                            }
                        }
                        DONT if self.local[index] => {
                            reply.extend([IAC, WONT, byte]);
                            self.local[index] = false;
                        }
                        _ => {}
                    }
                    self.state = ParseState::Data;
                }
                ParseState::Sub => {
                    if byte == IAC {
                        self.state = ParseState::SubCommand;
                    } else if self.sub.len() < 4096 {
                        self.sub.push(byte);
                    }
                }
                ParseState::SubCommand => {
                    if byte == SE {
                        if self.local[TTYPE as usize] && self.sub == [TTYPE, 1] {
                            reply.extend([IAC, SB, TTYPE, 0]);
                            reply.extend(b"VT100");
                            reply.extend([IAC, SE]);
                        }
                        self.sub.clear();
                        self.state = ParseState::Data;
                    } else {
                        if byte == IAC && self.sub.len() < 4096 {
                            self.sub.push(IAC);
                        }
                        self.state = ParseState::Sub;
                    }
                }
            }
        }
        (output, reply)
    }
    fn input(&self, input: &[u8]) -> Vec<u8> {
        let mut result = Vec::new();
        for (index, &byte) in input.iter().enumerate() {
            result.push(byte);
            if byte == IAC {
                result.push(IAC);
            }
            if byte == b'\r' && !self.local[BINARY as usize] && input.get(index + 1) != Some(&b'\n')
            {
                result.push(b'\n');
            }
        }
        result
    }
}

struct Login {
    prompt: String,
    username_sent: bool,
    password_sent: bool,
    password_prompt: bool,
}
impl Login {
    fn new() -> Self {
        Self {
            prompt: String::new(),
            username_sent: false,
            password_sent: false,
            password_prompt: false,
        }
    }
    fn receive(
        &mut self,
        output: &[u8],
        username: &str,
        password: Option<&str>,
    ) -> Option<Vec<u8>> {
        self.prompt
            .push_str(&String::from_utf8_lossy(output).to_lowercase());
        if self.prompt.len() > 4096 {
            self.prompt = self
                .prompt
                .chars()
                .rev()
                .take(2048)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
        }
        let line = self.prompt.rsplit(['\r', '\n']).next().unwrap_or("").trim();
        if !line.ends_with(':') && !line.ends_with('>') {
            return None;
        }
        let password_prompt = ["password", "contraseña", "passcode"]
            .iter()
            .any(|word| line.contains(word));
        self.password_prompt = password_prompt;
        let login_prompt = ["login", "username", "user name", "usuario"]
            .iter()
            .any(|word| line.contains(word));
        let value = if password_prompt && !self.password_sent {
            let value = password
                .filter(|value| !value.is_empty() && !value.contains(['\r', '\n', '\0']))?;
            self.password_sent = true;
            value
        } else if login_prompt
            && !self.username_sent
            && !username.is_empty()
            && !username.contains(['\r', '\n', '\0'])
        {
            self.username_sent = true;
            username
        } else {
            return None;
        };
        self.prompt.clear();
        self.password_prompt = false;
        Some(format!("{value}\r").into_bytes())
    }
}

pub(crate) async fn run(
    material: ConnectionMaterial,
    columns: u32,
    rows: u32,
    mut commands: Receiver<SessionCommand>,
    events: &Channel<SshEvent>,
) -> Result<(), String> {
    let (host, _, secret, _, _) = material;
    send_stage(
        events,
        "network",
        format!("Conectando por Telnet con {}:{}…", host.address, host.port),
    );
    let mut stream = tokio::time::timeout(
        Duration::from_secs(12),
        TcpStream::connect((host.address.as_str(), host.port)),
    )
    .await
    .map_err(|_| "La conexión Telnet agotó el tiempo de espera".to_string())?
    .map_err(|error| format!("No se pudo conectar por Telnet: {error}"))?;
    let mut telnet = Telnet::new(columns, rows);
    let mut login = Login::new();
    let mut buffer = [0; 16384];
    send_status(events, "connected", Some("Conexión Telnet abierta".into()));
    loop {
        tokio::select! {
            read = stream.read(&mut buffer) => {
                let size = read.map_err(|error| format!("La conexión Telnet se interrumpió: {error}"))?;
                if size == 0 { break; }
                let (output, reply) = telnet.receive(&buffer[..size]);
                if !reply.is_empty() { stream.write_all(&reply).await.map_err(|error| error.to_string())?; }
                if !output.is_empty() {
                    send_output(events, &output);
                    if let Some(data) = login.receive(&output, &host.username, secret.password.as_deref()) {
                        stream.write_all(&telnet.input(&data)).await.map_err(|error| error.to_string())?;
                    }
                }
            }
            command = commands.recv() => match command {
                Some(SessionCommand::Input(data)) => {
                    // Once the user types, leave login entirely in their hands.
                    login.username_sent = true; login.password_sent = true;
                    if !telnet.remote[ECHO as usize] && !login.password_prompt {
                        for &byte in &data {
                            match byte { 8 | 127 => send_output(events, b"\x08 \x08"), b'\r' => send_output(events, b"\r\n"), _ => send_output(events, &[byte]) }
                        }
                    }
                    stream.write_all(&telnet.input(&data)).await.map_err(|error| error.to_string())?;
                    if data.contains(&b'\r') { login.password_prompt = false; }
                }
                Some(SessionCommand::Resize(columns, rows)) => {
                    telnet.columns = columns; telnet.rows = rows;
                    if telnet.local[NAWS as usize] { stream.write_all(&telnet.window_size()).await.map_err(|error| error.to_string())?; }
                }
                Some(SessionCommand::Disconnect) | None => break,
            }
        }
    }
    let _ = stream.shutdown().await;
    send_status(
        events,
        "disconnected",
        Some("Conexión Telnet cerrada".into()),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn loopback_login_resize_input_output_and_disconnect() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let (sender, commands) = tokio::sync::mpsc::channel(8);
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                socket.write_all(&[IAC, WILL, ECHO, IAC, DO, NAWS]).await.unwrap();
                socket.write_all(b"User").await.unwrap();
                socket.write_all(b"name:").await.unwrap();
                let mut negotiation = [0; 15];
                socket.read_exact(&mut negotiation).await.unwrap();
                assert_eq!(&negotiation[..6], &[IAC, DO, ECHO, IAC, WILL, NAWS]);
                let mut username = [0; 10];
                socket.read_exact(&mut username).await.unwrap();
                assert_eq!(&username, b"operator\r\n");
                socket.write_all(b"\r\nPassword:").await.unwrap();
                let mut password = [0; 8];
                socket.read_exact(&mut password).await.unwrap();
                assert_eq!(&password, b"secret\r\n");
                socket.write_all(b"\r\nWelcome to legacy\r\n").await.unwrap();
                sender.send(SessionCommand::Resize(120, 40)).await.unwrap();
                sender.send(SessionCommand::Input(b"status\r".to_vec())).await.unwrap();
                let mut resized = [0; 9];
                socket.read_exact(&mut resized).await.unwrap();
                assert_eq!(resized, [IAC, SB, NAWS, 0, 120, 0, 40, IAC, SE]);
                let mut command = [0; 8];
                socket.read_exact(&mut command).await.unwrap();
                assert_eq!(&command, b"status\r\n");
                sender.send(SessionCommand::Disconnect).await.unwrap();
                assert_eq!(socket.read(&mut [0; 1]).await.unwrap(), 0);
            });
            let host: crate::models::Host = serde_json::from_value(serde_json::json!({
                "id":"legacy", "vaultId":"vault", "groupId":null, "name":"Legacy", "address":"127.0.0.1", "port":port,
                "protocol":"telnet", "username":"operator", "authMethod":"password", "keyPath":null,
                "favorite":false, "color":"blue", "tags":[], "note":"", "createdAt":"now", "updatedAt":"now"
            })).unwrap();
            let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let captured = events.clone();
            let channel = Channel::new(move |event| {
                if let tauri::ipc::InvokeResponseBody::Json(json) = event { captured.lock().unwrap().push(json); }
                Ok(())
            });
            let secret = crate::models::HostSecret { password: Some("secret".into()), private_key: None, private_key_name: None, key_passphrase: None };
            run((host, None, secret, None, None), 80, 24, commands, &channel).await.unwrap();
            server.await.unwrap();
            let recorded = events.lock().unwrap().join("\n");
            assert!(recorded.contains("connected") && recorded.contains("disconnected") && recorded.contains("output"));
            assert!(!recorded.contains("secret"));
        }).await.unwrap();
    }
    #[test]
    fn fragmented_negotiation_and_literal_iac() {
        let mut parser = Telnet::new(80, 24);
        assert_eq!(parser.receive(&[b'A', IAC]).0, b"A");
        assert_eq!(parser.receive(&[WILL]).0, b"");
        assert_eq!(parser.receive(&[ECHO]), (vec![], vec![IAC, DO, ECHO]));
        assert!(parser.receive(&[IAC, WILL, ECHO]).1.is_empty());
        assert_eq!(
            parser.receive(&[IAC, IAC, b'B', b'\r', 0]).0,
            [IAC, b'B', b'\r']
        );
        assert_eq!(parser.receive(&[IAC, DO, 99]).1, [IAC, WONT, 99]);
    }
    #[test]
    fn window_size_terminal_type_and_nvt_input() {
        let mut parser = Telnet::new(255, 24);
        let (_, reply) =
            parser.receive(&[IAC, DO, NAWS, IAC, DO, TTYPE, IAC, SB, TTYPE, 1, IAC, SE]);
        assert!(
            reply
                .windows(9)
                .any(|part| part == [IAC, SB, NAWS, 0, IAC, IAC, 0, 24, IAC])
        );
        assert!(
            reply
                .windows(b"VT100\xff".len())
                .any(|part| part == b"VT100\xff")
        );
        assert_eq!(
            parser.input(&[b'a', b'\r', IAC]),
            [b'a', b'\r', b'\n', IAC, IAC]
        );
    }
    #[test]
    fn login_prompts_can_be_fragmented_and_never_repeat_credentials() {
        let mut login = Login::new();
        assert_eq!(login.receive(b"User", "operator", Some("secret")), None);
        assert_eq!(
            login.receive(b"name:", "operator", Some("secret")),
            Some(b"operator\r".to_vec())
        );
        assert_eq!(
            login.receive(b"\r\nPassword:", "operator", Some("secret")),
            Some(b"secret\r".to_vec())
        );
        assert!(!login.password_prompt);
        assert_eq!(
            login.receive(b"\r\nPassword:", "operator", Some("secret")),
            None
        );
        assert!(login.password_prompt);
    }
}
