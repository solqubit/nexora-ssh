//! SSH links are authenticated independently; only the first opens a local TCP socket.
use crate::{connection_profile::ConnectionMaterial, ssh_auth::authenticate};
use russh::{Disconnect, client};
use std::{
    future::Future,
    io,
    ops::{Deref, DerefMut},
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};

const TIMEOUT: Duration = Duration::from_secs(12);
#[derive(Debug)]
pub(crate) struct RouteError {
    pub message: String,
    pub retryable: bool,
}
impl RouteError {
    fn new(message: String, retryable: bool) -> Self {
        Self { message, retryable }
    }
}
pub(crate) struct RouteConnection<H: client::Handler + 'static> {
    links: Vec<client::Handle<H>>,
    transports: Vec<tokio::sync::oneshot::Sender<()>>,
}
// russh can spawn its session task before connect_stream returns a Handle. Closing the
// owned transport also covers cancellation during key exchange, before that Handle exists.
struct RouteStream<R> {
    stream: R,
    closed: tokio::sync::oneshot::Receiver<()>,
    is_closed: bool,
}
impl<R: Unpin> RouteStream<R> {
    fn poll_closed(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        if self.is_closed || Pin::new(&mut self.closed).poll(cx).is_ready() {
            self.is_closed = true;
            Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "Ruta SSH cerrada",
            ))
        } else {
            Ok(())
        }
    }
}
impl<R: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for RouteStream<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.poll_closed(cx)?;
        Pin::new(&mut self.stream).poll_read(cx, buffer)
    }
}
impl<R: tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for RouteStream<R> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.poll_closed(cx)?;
        Pin::new(&mut self.stream).poll_write(cx, buffer)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.poll_closed(cx)?;
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.poll_closed(cx)?;
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
impl<H: client::Handler + 'static> Deref for RouteConnection<H> {
    type Target = client::Handle<H>;
    fn deref(&self) -> &Self::Target {
        self.links
            .last()
            .expect("Authenticated route has a destination")
    }
}
impl<H: client::Handler + 'static> DerefMut for RouteConnection<H> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.links
            .last_mut()
            .expect("Authenticated route has a destination")
    }
}
impl<H: client::Handler + 'static> Drop for RouteConnection<H> {
    fn drop(&mut self) {
        self.transports.clear();
        // Handle::drop alone does not send Disconnect. Cover cancellation and every early return.
        for link in self.links.drain(..).rev() {
            tauri::async_runtime::spawn(async move {
                let _ = tokio::time::timeout(
                    Duration::from_secs(1),
                    link.disconnect(Disconnect::ByApplication, "Ruta SSH cerrada", "es"),
                )
                .await;
            });
        }
    }
}

pub(crate) async fn connect<H, F, S>(
    route: &[ConnectionMaterial],
    default_keepalive: u64,
    handler: F,
    stage: S,
) -> Result<RouteConnection<H>, RouteError>
where
    H: client::Handler<Error = russh::Error> + Send + 'static,
    F: Fn(&ConnectionMaterial) -> H,
    S: Fn(&str, String),
{
    if route.iter().any(|material| material.0.protocol != "ssh") {
        return Err(RouteError::new(
            "SFTP, saltos y túneles requieren un host SSH".into(),
            false,
        ));
    }
    if route.is_empty() || route.len() > 9 {
        return Err(RouteError::new("Ruta SSH no válida".into(), false));
    }
    let mut connection = RouteConnection {
        links: Vec::<client::Handle<H>>::new(),
        transports: Vec::new(),
    };
    for (index, material) in route.iter().enumerate() {
        let (host, _, secret, keepalive, _) = material;
        let keepalive = keepalive.unwrap_or(default_keepalive);
        let endpoint = format!("{}:{}", host.address, host.port);
        let label = if index + 1 == route.len() {
            format!("Destino · {}", host.name)
        } else {
            format!("Salto {} de {} · {}", index + 1, route.len() - 1, host.name)
        };
        stage(
            "network",
            format!("{label}: negociando SSH con {endpoint}…"),
        );
        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: (keepalive > 0)
                .then(|| Duration::from_secs(keepalive.clamp(5, 300))),
            keepalive_max: 3,
            ..Default::default()
        });
        let (transport, closed) = tokio::sync::oneshot::channel();
        connection.transports.push(transport);
        let link = if let Some(previous) = connection.links.last() {
            let channel = tokio::time::timeout(TIMEOUT, previous.channel_open_direct_tcpip(host.address.clone(), u32::from(host.port), "127.0.0.1", 0)).await
                .map_err(|_| RouteError::new(format!("{label}: el host de salto no respondió al abrir {endpoint}"), true))?
                .map_err(|error| RouteError::new(format!("{label}: el host de salto no pudo abrir {endpoint}: {error}. Comprueba TCP forwarding y el acceso desde el salto."), false))?;
            tokio::time::timeout(
                TIMEOUT,
                client::connect_stream(
                    config,
                    RouteStream {
                        stream: channel.into_stream(),
                        closed,
                        is_closed: false,
                    },
                    handler(material),
                ),
            )
            .await
        } else {
            let stream = tokio::time::timeout(
                TIMEOUT,
                tokio::net::TcpStream::connect((host.address.as_str(), host.port)),
            )
            .await
            .map_err(|_| {
                RouteError::new(
                    format!("{label}: la conexión TCP con {endpoint} agotó el tiempo de espera"),
                    true,
                )
            })?
            .map_err(|error| {
                RouteError::new(
                    format!("{label}: no se pudo conectar con {endpoint}: {error}"),
                    true,
                )
            })?;
            tokio::time::timeout(
                TIMEOUT,
                client::connect_stream(
                    config,
                    RouteStream {
                        stream,
                        closed,
                        is_closed: false,
                    },
                    handler(material),
                ),
            )
            .await
        };
        let link = link
            .map_err(|_| {
                RouteError::new(
                    format!("{label}: la conexión con {endpoint} agotó el tiempo de espera"),
                    true,
                )
            })?
            .map_err(|error| {
                RouteError::new(
                    format!("{label}: no se pudo negociar SSH con {endpoint}: {error}"),
                    true,
                )
            })?;
        connection.links.push(link);
        stage(
            "authentication",
            format!("{label}: autenticando a {}…", host.username),
        );
        tokio::time::timeout(
            TIMEOUT,
            authenticate(connection.links.last_mut().unwrap(), host, secret),
        )
        .await
        .map_err(|_| {
            RouteError::new(
                format!("{label}: la autenticación agotó el tiempo de espera"),
                true,
            )
        })?
        .map_err(|error| {
            RouteError::new(
                format!("{label}: falló la autenticación SSH: {error}"),
                false,
            )
        })?;
    }
    Ok(connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::{ConnectionProfile, Host, HostSecret, KnownHost},
        test_server::{PinnedKey, TestServer},
    };
    use std::sync::{Mutex, atomic::Ordering};
    fn material(id: &str, address: &str, port: u16, key: &str) -> ConnectionMaterial {
        (
            Host {
                protocol: "ssh".into(),
                id: id.into(),
                vault_id: "fixture".into(),
                group_id: None,
                name: id.into(),
                address: address.into(),
                port,
                username: "test".into(),
                auth_method: "password".into(),
                key_path: None,
                favorite: false,
                color: "#7198f5".into(),
                tags: vec![],
                note: String::new(),
                created_at: "now".into(),
                updated_at: "now".into(),
            },
            Some(KnownHost {
                id: format!("known-{id}"),
                host_id: id.into(),
                algorithm: "ssh-ed25519".into(),
                fingerprint: "fixture".into(),
                public_key: key.into(),
                trusted_at: "now".into(),
            }),
            HostSecret {
                password: Some("fixture-password".into()),
                private_key: None,
                private_key_name: None,
                key_passphrase: None,
            },
            Some(30),
            None,
        )
    }
    fn pin(material: &ConnectionMaterial) -> PinnedKey {
        PinnedKey(material.1.as_ref().unwrap().public_key.clone())
    }
    fn forward(server: &TestServer, address: &str, port: u16, destination: &TestServer) {
        server.forwarding.lock().unwrap().targets.insert(
            (address.into(), u32::from(port)),
            ([127, 0, 0, 1], destination.port).into(),
        );
    }
    async fn closed(servers: &[&TestServer]) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while servers.iter().any(|server| {
                server
                    .forwarding
                    .lock()
                    .unwrap()
                    .active_relays
                    .load(Ordering::SeqCst)
                    != 0
            }) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("All intermediate streams close");
    }
    #[tokio::test]
    async fn two_jump_hosts_reach_remote_only_destination_for_terminal_and_sftp_then_close_every_link()
     {
        let first = TestServer::start("first.txt").await;
        let second = TestServer::start("second.txt").await;
        let target = TestServer::start("target.txt").await;
        forward(&first, "inside-one.fixture.invalid", 2201, &second);
        forward(&second, "inside-two.fixture.invalid", 2202, &target);
        let route = vec![
            material("first", "127.0.0.1", first.port, &first.public_key),
            material(
                "second",
                "inside-one.fixture.invalid",
                2201,
                &second.public_key,
            ),
            material(
                "target",
                "inside-two.fixture.invalid",
                2202,
                &target.public_key,
            ),
        ];
        let stages = Mutex::new(Vec::new());
        let connection = connect(&route, 0, pin, |phase, message| {
            stages.lock().unwrap().push((phase.to_string(), message))
        })
        .await
        .unwrap();
        let mut shell = connection.channel_open_session().await.unwrap();
        crate::ssh_engine::open_interactive(
            &mut shell,
            80,
            24,
            &tauri::ipc::Channel::new(|_| Ok(())),
        )
        .await
        .unwrap();
        shell.close().await.unwrap();
        let channel = connection.channel_open_session().await.unwrap();
        channel.request_subsystem(true, "sftp").await.unwrap();
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .unwrap();
        sftp.set_timeout(3);
        assert!(
            sftp.read_dir("/")
                .await
                .unwrap()
                .any(|entry| entry.file_name() == "target.txt")
        );
        sftp.close().await.unwrap();
        assert_eq!(
            first.forwarding.lock().unwrap().requests,
            vec![("inside-one.fixture.invalid".into(), 2201)]
        );
        assert_eq!(
            second.forwarding.lock().unwrap().requests,
            vec![("inside-two.fixture.invalid".into(), 2202)]
        );
        assert_eq!(
            stages
                .lock()
                .unwrap()
                .iter()
                .filter(|(phase, _)| phase == "authentication")
                .count(),
            3
        );
        drop(connection);
        closed(&[&first, &second]).await;
    }
    #[tokio::test]
    async fn untrusted_key_at_each_hop_stops_before_authentication_and_closes_the_partial_route() {
        for rejected in 0..3 {
            let first = TestServer::start("first.txt").await;
            let second = TestServer::start("second.txt").await;
            let target = TestServer::start("target.txt").await;
            forward(&first, "second.fixture.invalid", 22, &second);
            forward(&second, "target.fixture.invalid", 22, &target);
            let mut route = vec![
                material("first", "127.0.0.1", first.port, &first.public_key),
                material("second", "second.fixture.invalid", 22, &second.public_key),
                material("target", "target.fixture.invalid", 22, &target.public_key),
            ];
            route[rejected].1.as_mut().unwrap().public_key = "wrong-key".into();
            let result = connect(&route, 0, pin, |_, _| {}).await;
            let error = match result {
                Ok(_) => panic!("Untrusted hop must stop the route"),
                Err(error) => error,
            };
            assert!(error.message.contains(&route[rejected].0.name));
            for (index, server) in [&first, &second, &target].iter().enumerate() {
                assert_eq!(
                    server.forwarding.lock().unwrap().auth_attempts,
                    usize::from(index < rejected)
                );
            }
            closed(&[&first, &second]).await;
        }
    }
    #[tokio::test]
    async fn denied_forwarding_and_wrong_credentials_are_actionable_and_never_fall_back_to_direct_connection()
     {
        let first = TestServer::start("first.txt").await;
        let target = TestServer::start("target.txt").await;
        let mut route = vec![
            material("first", "127.0.0.1", first.port, &first.public_key),
            material(
                "target",
                "no-direct.fixture.invalid",
                22,
                &target.public_key,
            ),
        ];
        let error = connect(&route, 0, pin, |_, _| {}).await.err().unwrap();
        assert!(error.message.contains("TCP forwarding"));
        assert!(!error.retryable);
        assert_eq!(target.forwarding.lock().unwrap().auth_attempts, 0);
        forward(&first, "no-direct.fixture.invalid", 22, &target);
        route[1].2.password = Some("wrong-password".into());
        let error = connect(&route, 0, pin, |_, _| {}).await.err().unwrap();
        assert!(error.message.contains("target") && error.message.contains("autenticación"));
        assert!(!error.retryable);
        closed(&[&first]).await;
    }
    #[tokio::test]
    async fn cancelling_during_the_destination_handshake_closes_authenticated_jump_links() {
        let first = TestServer::start("first.txt").await;
        let second = TestServer::start("second.txt").await;
        let stalled = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        forward(&first, "second.fixture.invalid", 22, &second);
        second.forwarding.lock().unwrap().targets.insert(
            ("stalled.fixture.invalid".into(), 22),
            stalled.local_addr().unwrap(),
        );
        let route = vec![
            material("first", "127.0.0.1", first.port, &first.public_key),
            material("second", "second.fixture.invalid", 22, &second.public_key),
            material("stalled", "stalled.fixture.invalid", 22, "unused-key"),
        ];
        let task = tokio::spawn(async move { connect(&route, 0, pin, |_, _| {}).await });
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(3), stalled.accept())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            first
                .forwarding
                .lock()
                .unwrap()
                .active_relays
                .load(Ordering::SeqCst),
            1
        );
        task.abort();
        assert!(task.await.err().unwrap().is_cancelled());
        closed(&[&first, &second]).await;
        use tokio::io::AsyncReadExt;
        let mut contents = Vec::new();
        tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut contents))
            .await
            .unwrap()
            .unwrap();
        assert!(contents.len() < 1024);
    }
    #[tokio::test]
    async fn cancellation_after_the_banner_closes_the_transport_before_a_client_handle_exists() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let route = vec![material(
            "stalled",
            "127.0.0.1",
            listener.local_addr().unwrap().port(),
            "unused",
        )];
        let task = tokio::spawn(async move { connect(&route, 0, pin, |_, _| {}).await });
        let (mut socket, _) = listener.accept().await.unwrap();
        socket
            .write_all(b"SSH-2.0-stalled-fixture\r\n")
            .await
            .unwrap();
        let mut received = Vec::new();
        tokio::time::timeout(Duration::from_secs(3), async {
            while received.len() < 100 {
                let mut buffer = [0u8; 4096];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                received.extend_from_slice(&buffer[..count]);
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(task.await.err().unwrap().is_cancelled());
        tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut received))
            .await
            .unwrap()
            .unwrap();
        assert!(received.len() < 16384);
        // Shutdown/flush after observing cancellation must not poll a completed oneshot again.
        let (sender, closed) = tokio::sync::oneshot::channel::<()>();
        let (stream, _) = tokio::io::duplex(10);
        let mut stream = RouteStream {
            stream,
            closed,
            is_closed: false,
        };
        drop(sender);
        assert!(stream.write_all(b"x").await.is_err());
        assert!(stream.flush().await.is_err());
        assert!(stream.shutdown().await.is_err());
    }
    #[test]
    fn route_graph_is_validated_before_write_survives_reopen_and_preserves_old_data_on_invalid_updates()
     {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("route.db");
        let mut db = crate::database::Database::open(&path).unwrap();
        let mut snapshot = db.load_snapshot().unwrap();
        snapshot.hosts = ["a", "b", "c"]
            .into_iter()
            .map(|id| {
                let mut host = material(id, "localhost", 22, "key").0;
                host.vault_id = snapshot.vaults[0].id.clone();
                host
            })
            .collect();
        snapshot.productivity.connection_profiles = vec![
            ConnectionProfile {
                host_id: "c".into(),
                jump_host_id: Some("b".into()),
                ..Default::default()
            },
            ConnectionProfile {
                host_id: "b".into(),
                jump_host_id: Some("a".into()),
                ..Default::default()
            },
        ];
        db.save_snapshot(&snapshot).unwrap();
        assert_eq!(
            crate::connection_profile::route_ids(&snapshot, "c").unwrap(),
            ["a", "b", "c"]
        );
        for invalid_parent in ["c", "deleted"] {
            let mut invalid = snapshot.clone();
            invalid.productivity.connection_profiles[1].jump_host_id = Some(invalid_parent.into());
            assert!(db.save_snapshot(&invalid).is_err());
            assert_eq!(db.load_snapshot().unwrap(), snapshot);
        }
        let mut too_long = snapshot.clone();
        too_long.hosts = (0..10)
            .map(|index| {
                let mut host = snapshot.hosts[0].clone();
                host.id = index.to_string();
                host
            })
            .collect();
        too_long.productivity.connection_profiles = (1..10)
            .map(|index| ConnectionProfile {
                host_id: index.to_string(),
                jump_host_id: Some((index - 1).to_string()),
                ..Default::default()
            })
            .collect();
        assert!(db.save_snapshot(&too_long).is_err());
        drop(db);
        assert_eq!(
            crate::database::Database::open(&path)
                .unwrap()
                .load_snapshot()
                .unwrap(),
            snapshot
        );
    }
}
