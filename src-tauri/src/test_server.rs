//! Disposable loopback fixture: never reads profiles or credentials from the user's machine.
use russh::{
    Channel, ChannelId, ChannelMsg, Pty, client,
    keys::{Algorithm, PrivateKey},
    server::{self, Auth, ChannelOpenHandle, Msg, Session},
};
use russh_sftp::{
    client::SftpSession,
    protocol::{Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone)]
pub(crate) struct FixtureFile {
    pub content: Vec<u8>,
    pub permissions: u32,
    pub uid: u32,
    pub gid: u32,
    pub mtime: u32,
}
impl FixtureFile {
    fn metadata(&self) -> FileAttributes {
        FileAttributes {
            size: Some(self.content.len() as u64),
            permissions: Some(self.permissions),
            uid: Some(self.uid),
            gid: Some(self.gid),
            mtime: Some(self.mtime),
            atime: Some(1),
            ..FileAttributes::empty()
        }
    }
}
#[derive(Default)]
pub(crate) struct FixtureFiles {
    pub files: HashMap<String, FixtureFile>,
    pub fail_promote: bool,
    pub mutate_on_backup: bool,
    pub ignore_setstat: bool,
}

pub(crate) struct TestServer {
    pub port: u16,
    pub public_key: String,
    pub files: Option<Arc<Mutex<FixtureFiles>>>,
    pub terminal: Arc<Mutex<TerminalFixture>>,
    pub forwarding: Arc<Mutex<ForwardFixture>>,
    task: tokio::task::JoinHandle<()>,
}
#[derive(Default)]
pub(crate) struct ForwardFixture {
    pub allow_remote: bool,
    pub remote_delay_millis: u64,
    pub remote_attempts: usize,
    pub remote_requests: Vec<(String, u32)>,
    pub remote_cancellations: Vec<(String, u32)>,
    pub targets: HashMap<(String, u32), std::net::SocketAddr>,
    pub requests: Vec<(String, u32)>,
    pub auth_attempts: usize,
    pub active_relays: Arc<std::sync::atomic::AtomicUsize>,
}
#[derive(Default)]
pub(crate) struct TerminalFixture {
    pub reject_pty: bool,
    pub reject_shell: bool,
    pub reject_exec: bool,
    pub last_exec: Option<String>,
}
impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl TestServer {
    pub async fn start(filename: &str) -> Self {
        Self::start_inner(filename, None).await
    }
    pub async fn start_with_text(path: &str, text: &[u8]) -> Self {
        let files = Arc::new(Mutex::new(FixtureFiles {
            files: HashMap::from([(
                path.into(),
                FixtureFile {
                    content: text.into(),
                    permissions: 0o100640,
                    uid: 1000,
                    gid: 1000,
                    mtime: 1,
                },
            )]),
            ..Default::default()
        }));
        Self::start_inner(path.trim_start_matches('/'), Some(files)).await
    }
    async fn start_inner(filename: &str, files: Option<Arc<Mutex<FixtureFiles>>>) -> Self {
        let key =
            PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519).unwrap();
        let public_key = key.public_key().to_openssh().unwrap();
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let filename = filename.to_string();
        let shared_files = files.clone();
        let terminal = Arc::new(Mutex::new(TerminalFixture::default()));
        let shared_terminal = terminal.clone();
        let forwarding = Arc::new(Mutex::new(ForwardFixture::default()));
        let shared_forwarding = forwarding.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let config = config.clone();
                let handler = TestSsh {
                    channels: HashMap::new(),
                    relays: HashMap::new(),
                    remote_listeners: HashMap::new(),
                    filename: filename.clone(),
                    files: shared_files.clone(),
                    terminal: shared_terminal.clone(),
                    forwarding: shared_forwarding.clone(),
                };
                tokio::spawn(async move {
                    if let Ok(session) = server::run_stream(config, stream, handler).await {
                        let _ = session.await;
                    }
                });
            }
        });
        Self {
            port,
            public_key,
            files,
            terminal,
            forwarding,
            task,
        }
    }

    pub async fn connect(&self) -> client::Handle<PinnedKey> {
        client::connect(
            Arc::new(client::Config::default()),
            ("127.0.0.1", self.port),
            PinnedKey(self.public_key.clone()),
        )
        .await
        .unwrap()
    }
    pub async fn sftp(&self) -> (client::Handle<PinnedKey>, SftpSession) {
        let mut connection = self.connect().await;
        assert!(
            connection
                .authenticate_password("test", "fixture-password")
                .await
                .unwrap()
                .success()
        );
        let channel = connection.channel_open_session().await.unwrap();
        channel.request_subsystem(true, "sftp").await.unwrap();
        let sftp = SftpSession::new(channel.into_stream()).await.unwrap();
        sftp.set_timeout(3);
        (connection, sftp)
    }
}

pub(crate) struct PinnedKey(pub String);
impl client::Handler for PinnedKey {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(key.to_openssh().unwrap() == self.0)
    }
}

struct TestSsh {
    channels: HashMap<ChannelId, Channel<Msg>>,
    relays: HashMap<ChannelId, tokio::task::JoinHandle<()>>,
    remote_listeners: HashMap<(String, u32), tokio::task::JoinHandle<()>>,
    filename: String,
    files: Option<Arc<Mutex<FixtureFiles>>>,
    terminal: Arc<Mutex<TerminalFixture>>,
    forwarding: Arc<Mutex<ForwardFixture>>,
}
impl Drop for TestSsh {
    fn drop(&mut self) {
        for relay in self.relays.values() {
            relay.abort();
        }
        for listener in self.remote_listeners.values() {
            listener.abort();
        }
    }
}
impl server::Handler for TestSsh {
    type Error = russh::Error;
    async fn tcpip_forward(
        &mut self,
        address: &str,
        port: &mut u32,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        let delay = {
            let mut fixture = self.forwarding.lock().unwrap();
            fixture.remote_attempts += 1;
            fixture.remote_delay_millis
        };
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        if !self.forwarding.lock().unwrap().allow_remote || address != "127.0.0.1" {
            return Ok(false);
        }
        let Ok(port_number) = u16::try_from(*port) else {
            return Ok(false);
        };
        let Ok(listener) = tokio::net::TcpListener::bind((address, port_number)).await else {
            return Ok(false);
        };
        *port = u32::from(listener.local_addr().unwrap().port());
        self.forwarding
            .lock()
            .unwrap()
            .remote_requests
            .push((address.into(), *port));
        let address = address.to_string();
        let allocated = *port;
        let listener_key = (address.clone(), *port);
        let handle = session.handle();
        let relay = tokio::spawn(async move {
            let mut clients = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((mut socket, origin)) = accepted else { break; };
                        let handle = handle.clone(); let address = address.clone();
                        clients.spawn(async move {
                            if let Ok(channel) = handle.channel_open_forwarded_tcpip(address, allocated, origin.ip().to_string(), u32::from(origin.port())).await {
                                let mut stream = channel.into_stream();
                                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                            }
                        });
                    }
                    _ = clients.join_next(), if !clients.is_empty() => {}
                }
            }
        });
        self.remote_listeners.insert(listener_key, relay);
        Ok(true)
    }
    async fn cancel_tcpip_forward(
        &mut self,
        address: &str,
        port: u32,
        _: &mut Session,
    ) -> Result<bool, Self::Error> {
        self.forwarding
            .lock()
            .unwrap()
            .remote_cancellations
            .push((address.into(), port));
        if let Some(listener) = self.remote_listeners.remove(&(address.into(), port)) {
            listener.abort();
            Ok(true)
        } else {
            Ok(false)
        }
    }
    async fn channel_close(&mut self, id: ChannelId, _: &mut Session) -> Result<(), Self::Error> {
        if let Some(relay) = self.relays.remove(&id) {
            relay.abort();
        }
        self.channels.remove(&id);
        Ok(())
    }
    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        self.forwarding.lock().unwrap().auth_attempts += 1;
        Ok(if user == "test" && password == "fixture-password" {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }
    async fn auth_publickey(
        &mut self,
        user: &str,
        _: &russh::keys::PublicKey,
    ) -> Result<Auth, Self::Error> {
        Ok(if user == "test" {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        _: &str,
        _: u32,
        reply: ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        let (target, active) = {
            let mut fixture = self.forwarding.lock().unwrap();
            fixture.requests.push((host.into(), port));
            (
                fixture.targets.get(&(host.into(), port)).copied(),
                fixture.active_relays.clone(),
            )
        };
        let Some(target) = target.filter(|address| address.ip().is_loopback()) else {
            return Ok(());
        };
        let Ok(mut socket) = tokio::net::TcpStream::connect(target).await else {
            return Ok(());
        };
        reply.accept().await;
        active.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        struct RelayGuard(Arc<std::sync::atomic::AtomicUsize>);
        impl Drop for RelayGuard {
            fn drop(&mut self) {
                self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let guard = RelayGuard(active);
        let id = channel.id();
        let relay = tokio::spawn(async move {
            let _guard = guard;
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut socket).await;
        });
        self.relays.insert(id, relay);
        Ok(())
    }
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.terminal.lock().unwrap().reject_pty {
            session.channel_failure(channel)?;
        } else {
            session.channel_success(channel)?;
        }
        Ok(())
    }
    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.terminal.lock().unwrap().reject_shell {
            session.channel_failure(channel)?;
        } else {
            session.channel_success(channel)?;
        }
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let mut terminal = self.terminal.lock().unwrap();
        terminal.last_exec = Some(String::from_utf8_lossy(data).into_owned());
        if terminal.reject_exec {
            session.channel_failure(channel)?;
        } else {
            session.channel_success(channel)?;
        }
        Ok(())
    }
    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.channels.contains_key(&channel) {
            return Ok(());
        }
        session.data(channel, data.to_vec())?;
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            session.channel_failure(channel)?;
            return Ok(());
        }
        session.channel_success(channel)?;
        let stream = self.channels.remove(&channel).unwrap().into_stream();
        let handler = TestSftp {
            filename: self.filename.clone(),
            listed: false,
            files: self.files.clone(),
        };
        tokio::spawn(async move {
            russh_sftp::server::run(stream, handler).await;
        });
        Ok(())
    }
}
struct TestSftp {
    filename: String,
    listed: bool,
    files: Option<Arc<Mutex<FixtureFiles>>>,
}
impl TestSftp {
    fn metadata(&self, id: u32, path: &str) -> Result<Attrs, StatusCode> {
        let files = self
            .files
            .as_ref()
            .ok_or(StatusCode::Failure)?
            .lock()
            .unwrap();
        let file = files.files.get(path).ok_or(StatusCode::NoSuchFile)?;
        Ok(Attrs {
            id,
            attrs: file.metadata(),
        })
    }
    fn success(id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: String::new(),
        }
    }
}
impl russh_sftp::server::Handler for TestSftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error {
        StatusCode::Failure
    }
    async fn realpath(&mut self, id: u32, _: String) -> Result<Name, Self::Error> {
        Ok(Name {
            id,
            files: vec![File::dummy("/")],
        })
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        self.listed = false;
        Ok(Handle { id, handle: path })
    }
    async fn readdir(&mut self, id: u32, _: String) -> Result<Name, Self::Error> {
        if self.listed {
            return Err(StatusCode::Eof);
        }
        self.listed = true;
        Ok(Name {
            id,
            files: vec![File::new(self.filename.clone(), FileAttributes::dummy())],
        })
    }
    async fn open(
        &mut self,
        id: u32,
        filename: String,
        flags: OpenFlags,
        attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        if let Some(files) = &self.files {
            let mut files = files.lock().unwrap();
            if flags.contains(OpenFlags::CREATE) {
                if flags.contains(OpenFlags::EXCLUDE) && files.files.contains_key(&filename) {
                    return Err(StatusCode::Failure);
                }
                files.files.entry(filename.clone()).or_insert(FixtureFile {
                    content: Vec::new(),
                    permissions: 0o100000 | attrs.permissions.unwrap_or(0o600),
                    uid: 1000,
                    gid: 1000,
                    mtime: 1,
                });
            } else if !files.files.contains_key(&filename) {
                return Err(StatusCode::NoSuchFile);
            }
        }
        Ok(Handle {
            id,
            handle: filename,
        })
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, Self::Error> {
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: String::new(),
        })
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.metadata(id, &path)
    }
    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.metadata(id, &path)
    }
    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        self.metadata(id, &handle)
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let files = self
            .files
            .as_ref()
            .ok_or(StatusCode::Failure)?
            .lock()
            .unwrap();
        let file = files.files.get(&handle).ok_or(StatusCode::NoSuchFile)?;
        let offset = offset as usize;
        if offset >= file.content.len() {
            return Err(StatusCode::Eof);
        }
        Ok(Data {
            id,
            data: file.content[offset..(offset + len as usize).min(file.content.len())].to_vec(),
        })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let mut files = self
            .files
            .as_ref()
            .ok_or(StatusCode::Failure)?
            .lock()
            .unwrap();
        let file = files.files.get_mut(&handle).ok_or(StatusCode::NoSuchFile)?;
        let offset = offset as usize;
        if offset + data.len() > 4 * 1024 * 1024 {
            return Err(StatusCode::Failure);
        }
        file.content
            .resize(file.content.len().max(offset + data.len()), 0);
        file.content[offset..offset + data.len()].copy_from_slice(&data);
        file.mtime += 1;
        Ok(Self::success(id))
    }
    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let mut files = self
            .files
            .as_ref()
            .ok_or(StatusCode::Failure)?
            .lock()
            .unwrap();
        if files.ignore_setstat {
            return Ok(Self::success(id));
        }
        let file = files.files.get_mut(&path).ok_or(StatusCode::NoSuchFile)?;
        if let Some(mode) = attrs.permissions {
            file.permissions = 0o100000 | (mode & 0o7777);
        }
        if let Some(uid) = attrs.uid {
            file.uid = uid;
        }
        if let Some(gid) = attrs.gid {
            file.gid = gid;
        }
        Ok(Self::success(id))
    }
    async fn remove(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        self.files
            .as_ref()
            .ok_or(StatusCode::Failure)?
            .lock()
            .unwrap()
            .files
            .remove(&path)
            .ok_or(StatusCode::NoSuchFile)?;
        Ok(Self::success(id))
    }
    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        let mut files = self
            .files
            .as_ref()
            .ok_or(StatusCode::Failure)?
            .lock()
            .unwrap();
        if files.files.contains_key(&newpath) || files.fail_promote && oldpath.ends_with(".tmp") {
            return Err(StatusCode::Failure);
        }
        let mut file = files.files.remove(&oldpath).ok_or(StatusCode::NoSuchFile)?;
        if files.mutate_on_backup && newpath.ends_with(".backup") {
            file.content = b"externally changed".to_vec();
            file.mtime += 1;
            files.mutate_on_backup = false;
        }
        files.files.insert(newpath, file);
        Ok(Self::success(id))
    }
}

#[tokio::test]
async fn loopback_password_authentication_pty_and_host_key_rejection() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let server = TestServer::start("test.txt").await;
        assert!(
            client::connect(
                Arc::new(client::Config::default()),
                ("127.0.0.1", server.port),
                PinnedKey("wrong-key".into())
            )
            .await
            .is_err()
        );
        let mut connection = server.connect().await;
        let mut host = crate::models::Host {
            protocol: "ssh".into(),
            id: "host".into(),
            vault_id: "vault".into(),
            group_id: None,
            name: "Test".into(),
            address: "127.0.0.1".into(),
            port: server.port,
            username: "test".into(),
            auth_method: "password".into(),
            key_path: None,
            favorite: false,
            color: "#fff".into(),
            tags: vec![],
            note: String::new(),
            created_at: "now".into(),
            updated_at: "now".into(),
        };
        let secret = crate::models::HostSecret {
            password: Some("fixture-password".into()),
            private_key: None,
            private_key_name: None,
            key_passphrase: None,
        };
        host.username = "invalid".into();
        assert!(
            crate::ssh_auth::authenticate(&mut connection, &host, &secret)
                .await
                .is_err()
        );
        host.username = "test".into();
        crate::ssh_auth::authenticate(&mut connection, &host, &secret)
            .await
            .unwrap();
        let mut channel = connection.channel_open_session().await.unwrap();
        channel
            .request_pty(true, "xterm", 80, 24, 0, 0, &[])
            .await
            .unwrap();
        channel.request_shell(true).await.unwrap();
        channel.data(&b"NEXORA_LOOPBACK_OK"[..]).await.unwrap();
        let mut output = vec![];
        while let Some(message) = channel.wait().await {
            if let ChannelMsg::Data { data } = message {
                output.extend_from_slice(&data);
            }
        }
        assert_eq!(output, b"NEXORA_LOOPBACK_OK");
        let key =
            PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519).unwrap();
        let mut key_secret = crate::models::HostSecret::default();
        key_secret.private_key = Some(key.to_openssh(Default::default()).unwrap().to_string());
        host.auth_method = "private_key".into();
        let mut key_connection = server.connect().await;
        crate::ssh_auth::authenticate(&mut key_connection, &host, &key_secret)
            .await
            .unwrap();
        let _key_channel = key_connection.channel_open_session().await.unwrap();
    })
    .await
    .unwrap();
}
