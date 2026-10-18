//! TCP port forwarding over an owned SSH route. No shell commands or direct fallback.
use crate::{
    models::{TunnelKind, TunnelProfile},
    ssh_route::RouteConnection,
};
use russh::{Channel, client};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, watch},
    task::JoinSet,
};

const CLIENT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CLIENTS: usize = 128;
pub(crate) struct ForwardRequest {
    pub channel: Channel<client::Msg>,
    pub reply: client::ChannelOpenHandle,
}

pub(crate) fn validate(profile: &TunnelProfile) -> Result<(), String> {
    let text = |value: &str, max: usize| {
        !value.is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
    };
    if !text(&profile.id, 200)
        || !text(&profile.host_id, 200)
        || !text(profile.name.trim(), 160)
        || !text(&profile.updated_at, 80)
    {
        return Err("El túnel necesita un identificador, host y nombre válidos".into());
    }
    // A literal address avoids ambiguous local DNS and accidental wildcard binds.
    let bind: IpAddr = profile
        .listen_address
        .parse()
        .map_err(|_| "Usa una dirección IPv4 o IPv6 para la escucha del túnel")?;
    if profile.kind == TunnelKind::Socks && !bind.is_loopback() {
        return Err("El proxy SOCKS sin contraseña solo puede escuchar en 127.0.0.1 o ::1".into());
    }
    if profile.kind != TunnelKind::Socks {
        let address = profile
            .target_address
            .as_deref()
            .ok_or("Falta la dirección de destino")?;
        if !text(address, 253)
            || address.chars().any(char::is_whitespace)
            || profile.target_port.is_none_or(|port| port == 0)
        {
            return Err("Configura una dirección de destino y un puerto entre 1 y 65535".into());
        }
    } else if profile.target_address.is_some() || profile.target_port.is_some() {
        return Err(
            "El destino SOCKS lo solicita cada aplicación; deja vacío el destino fijo".into(),
        );
    }
    Ok(())
}

/// The caller owns cancellation and publishes callbacks into its generation-checked runtime.
pub(crate) async fn serve<H, R, E>(
    connection: Arc<RouteConnection<H>>,
    profile: TunnelProfile,
    mut incoming: mpsc::Receiver<ForwardRequest>,
    mut stop: watch::Receiver<bool>,
    ready: R,
    report_error: E,
) -> Result<(), String>
where
    H: client::Handler<Error = russh::Error> + Send + Sync + 'static,
    R: Fn(u16) + Send + Sync,
    E: Fn(String) + Clone + Send + Sync + 'static,
{
    validate(&profile)?;
    if *stop.borrow() {
        return Ok(());
    }
    let listener = if profile.kind != TunnelKind::Remote {
        Some(TcpListener::bind((profile.listen_address.as_str(), profile.listen_port)).await
            .map_err(|error| format!("No se pudo escuchar en {}:{}: {error}. Comprueba si el puerto está ocupado.", profile.listen_address, profile.listen_port))?)
    } else {
        None
    };
    let port = if let Some(listener) = &listener {
        listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port()
    } else {
        let requested = tokio::time::timeout(
            CLIENT_TIMEOUT,
            connection.tcpip_forward(
                profile.listen_address.clone(),
                u32::from(profile.listen_port),
            ),
        );
        let assigned = tokio::select! {
            biased;
            _ = stop.changed() => return Ok(()),
            result = requested => result,
        }
            .map_err(|_| "El servidor no respondió al solicitar el túnel remoto")?
            .map_err(|error| format!("El servidor rechazó la escucha remota: {error}. Comprueba TCP forwarding y GatewayPorts."))?;
        if assigned == 0 && profile.listen_port != 0 {
            profile.listen_port
        } else {
            u16::try_from(assigned)
                .ok()
                .filter(|port| *port > 0)
                .ok_or("El servidor devolvió un puerto remoto no válido")?
        }
    };
    ready(port);
    let mut tasks = JoinSet::new();
    let mut health = tokio::time::interval(Duration::from_millis(500));
    let result = loop {
        if *stop.borrow() {
            break Ok(());
        }
        tokio::select! {
            biased;
            _ = stop.changed() => { break Ok(()); }
            _ = health.tick() => { if connection.is_closed() { break Err("La conexión SSH del túnel se interrumpió; vuelve a iniciarlo".into()); } }
            Some(result) = tasks.join_next(), if !tasks.is_empty() => { if let Err(error) = result { report_error(format!("La conexión del túnel terminó: {error}")); } }
            accepted = async { listener.as_ref().expect("local listener").accept().await }, if listener.is_some() => {
                let (socket, origin) = match accepted { Ok(value) => value, Err(error) => break Err(format!("No se pudo aceptar una conexión del túnel: {error}")) };
                if tasks.len() >= MAX_CLIENTS { report_error("El túnel alcanzó 128 conexiones simultáneas".into()); drop(socket); continue; }
                let connection = connection.clone(); let profile = profile.clone(); let report_error = report_error.clone();
                tasks.spawn(async move {
                    if let Err(error) = local_client(connection, profile, socket, origin.ip().to_string(), origin.port()).await { report_error(error); }
                });
            }
            Some(request) = incoming.recv(), if profile.kind == TunnelKind::Remote => {
                if tasks.len() >= MAX_CLIENTS { report_error("El túnel alcanzó 128 conexiones simultáneas".into()); drop(request); continue; }
                let profile = profile.clone(); let report_error = report_error.clone();
                tasks.spawn(async move {
                    if let Err(error) = remote_client(profile, request).await { report_error(error); }
                });
            }
        }
    };
    drop(listener); // Release local ports before remote cleanup.
    tasks.shutdown().await; // Also closes active channels and sockets.
    if profile.kind == TunnelKind::Remote {
        let cancelled = tokio::time::timeout(
            Duration::from_secs(3),
            connection.cancel_tcpip_forward(profile.listen_address.clone(), u32::from(port)),
        )
        .await;
        if !matches!(cancelled, Ok(Ok(()))) {
            report_error(
                "No se confirmó la retirada de la escucha remota; se cerrará la conexión SSH"
                    .into(),
            );
        }
    }
    drop(connection);
    result
}

async fn local_client<H: client::Handler<Error = russh::Error> + Send + Sync + 'static>(
    connection: Arc<RouteConnection<H>>,
    profile: TunnelProfile,
    mut socket: TcpStream,
    origin: String,
    origin_port: u16,
) -> Result<(), String> {
    let socks = profile.kind == TunnelKind::Socks;
    let (address, port) = if socks {
        tokio::time::timeout(CLIENT_TIMEOUT, socks_request(&mut socket))
            .await
            .map_err(|_| "La negociación SOCKS agotó el tiempo de espera")?
            .map_err(|error| format!("Solicitud SOCKS rechazada: {error}"))?
    } else {
        (
            profile.target_address.unwrap(),
            profile.target_port.unwrap(),
        )
    };
    let opened = tokio::time::timeout(
        CLIENT_TIMEOUT,
        connection.channel_open_direct_tcpip(
            address.clone(),
            u32::from(port),
            origin,
            u32::from(origin_port),
        ),
    )
    .await;
    let channel = match opened {
        Ok(Ok(channel)) => channel,
        reason => {
            if socks {
                let _ = socks_reply(&mut socket, 5).await;
            }
            return Err(format!(
                "No se pudo abrir {address}:{port} desde el servidor SSH: {}",
                match reason {
                    Ok(Err(error)) => error.to_string(),
                    _ => "tiempo de espera agotado".into(),
                }
            ));
        }
    };
    if socks {
        socks_reply(&mut socket, 0)
            .await
            .map_err(|error| error.to_string())?;
    }
    let mut stream = channel.into_stream();
    tokio::io::copy_bidirectional(&mut socket, &mut stream)
        .await
        .map_err(|error| format!("Se interrumpió el tráfico hacia {address}:{port}: {error}"))?;
    Ok(())
}
async fn remote_client(profile: TunnelProfile, request: ForwardRequest) -> Result<(), String> {
    let address = profile.target_address.unwrap();
    let port = profile.target_port.unwrap();
    let mut socket =
        tokio::time::timeout(CLIENT_TIMEOUT, TcpStream::connect((address.as_str(), port)))
            .await
            .map_err(|_| format!("El destino local {address}:{port} no respondió"))?
            .map_err(|error| {
                format!("No se pudo abrir el destino local {address}:{port}: {error}")
            })?;
    request.reply.accept().await;
    let mut stream = request.channel.into_stream();
    tokio::io::copy_bidirectional(&mut socket, &mut stream)
        .await
        .map_err(|error| {
            format!("Se interrumpió el tráfico remoto hacia {address}:{port}: {error}")
        })?;
    Ok(())
}

async fn socks_reply(socket: &mut TcpStream, code: u8) -> std::io::Result<()> {
    socket.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await
}
async fn socks_request(socket: &mut TcpStream) -> Result<(String, u16), String> {
    let mut greeting = [0; 2];
    socket
        .read_exact(&mut greeting)
        .await
        .map_err(|error| error.to_string())?;
    if greeting[0] != 5 || greeting[1] == 0 {
        return Err("Solo se admite SOCKS5".into());
    }
    let mut methods = vec![0; usize::from(greeting[1])];
    socket
        .read_exact(&mut methods)
        .await
        .map_err(|error| error.to_string())?;
    if !methods.contains(&0) {
        socket
            .write_all(&[5, 255])
            .await
            .map_err(|error| error.to_string())?;
        return Err("La aplicación requiere un método de autenticación SOCKS no disponible".into());
    }
    socket
        .write_all(&[5, 0])
        .await
        .map_err(|error| error.to_string())?;
    let mut header = [0; 4];
    socket
        .read_exact(&mut header)
        .await
        .map_err(|error| error.to_string())?;
    if header[0] != 5 || header[2] != 0 {
        socks_reply(socket, 1)
            .await
            .map_err(|error| error.to_string())?;
        return Err("Cabecera SOCKS no válida".into());
    }
    if header[1] != 1 {
        socks_reply(socket, 7)
            .await
            .map_err(|error| error.to_string())?;
        return Err("SOCKS admite CONNECT TCP; BIND y UDP no están disponibles".into());
    }
    let address = match header[3] {
        1 => {
            let mut bytes = [0; 4];
            socket
                .read_exact(&mut bytes)
                .await
                .map_err(|error| error.to_string())?;
            Ipv4Addr::from(bytes).to_string()
        }
        4 => {
            let mut bytes = [0; 16];
            socket
                .read_exact(&mut bytes)
                .await
                .map_err(|error| error.to_string())?;
            Ipv6Addr::from(bytes).to_string()
        }
        3 => {
            let size = socket.read_u8().await.map_err(|error| error.to_string())?;
            let mut bytes = vec![0; usize::from(size)];
            socket
                .read_exact(&mut bytes)
                .await
                .map_err(|error| error.to_string())?;
            let address = String::from_utf8(bytes).map_err(|_| "El nombre SOCKS no es UTF-8")?;
            if address.is_empty()
                || address
                    .chars()
                    .any(|character| character.is_control() || character.is_whitespace())
            {
                socks_reply(socket, 8)
                    .await
                    .map_err(|error| error.to_string())?;
                return Err("Nombre de destino SOCKS no válido".into());
            }
            address
        }
        _ => {
            socks_reply(socket, 8)
                .await
                .map_err(|error| error.to_string())?;
            return Err("Tipo de dirección SOCKS no compatible".into());
        }
    };
    let port = socket.read_u16().await.map_err(|error| error.to_string())?;
    if port == 0 {
        socks_reply(socket, 1)
            .await
            .map_err(|error| error.to_string())?;
        return Err("El destino SOCKS necesita un puerto".into());
    }
    Ok((address, port))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        connection_profile::ConnectionMaterial,
        models::{Host, HostSecret, KnownHost},
        ssh_route,
        test_server::TestServer,
    };
    use std::sync::Mutex;
    fn profile(kind: TunnelKind) -> TunnelProfile {
        TunnelProfile {
            id: "tunnel".into(),
            host_id: "server".into(),
            name: "Fixture".into(),
            kind: kind.clone(),
            listen_address: "127.0.0.1".into(),
            listen_port: 0,
            target_address: (kind != TunnelKind::Socks)
                .then(|| "remote-only.fixture.invalid".into()),
            target_port: (kind != TunnelKind::Socks).then_some(8080),
            updated_at: "now".into(),
        }
    }
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
                color: "blue".into(),
                tags: vec![],
                note: "".into(),
                created_at: "now".into(),
                updated_at: "now".into(),
            },
            Some(KnownHost {
                id: "known".into(),
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
            None,
            None,
        )
    }
    struct Handler {
        key: String,
        incoming: mpsc::Sender<ForwardRequest>,
    }
    impl client::Handler for Handler {
        type Error = russh::Error;
        async fn check_server_key(
            &mut self,
            key: &russh::keys::PublicKey,
        ) -> Result<bool, Self::Error> {
            Ok(key.to_openssh()? == self.key)
        }
        async fn server_channel_open_forwarded_tcpip(
            &mut self,
            channel: Channel<client::Msg>,
            _: &str,
            _: u32,
            _: &str,
            _: u32,
            reply: client::ChannelOpenHandle,
            _: &mut client::Session,
        ) -> Result<(), Self::Error> {
            let _ = self.incoming.try_send(ForwardRequest { channel, reply });
            Ok(())
        }
    }
    struct Echo {
        port: u16,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Echo {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl Echo {
        async fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let task = tokio::spawn(async move {
                let mut clients = JoinSet::new();
                loop {
                    tokio::select! {
                        accepted = listener.accept() => { let Ok((mut socket, _)) = accepted else { break; }; clients.spawn(async move { let mut bytes = [0; 8192]; loop { let count = socket.read(&mut bytes).await.unwrap_or(0); if count == 0 || socket.write_all(&bytes[..count]).await.is_err() { break; } } }); }
                        _ = clients.join_next(), if !clients.is_empty() => {}
                    }
                }
            });
            Self { port, task }
        }
    }
    async fn route(
        server: &TestServer,
        gateway: Option<&TestServer>,
    ) -> (
        Arc<RouteConnection<Handler>>,
        mpsc::Receiver<ForwardRequest>,
    ) {
        let (sender, receiver) = mpsc::channel(128);
        let mut route = vec![material(
            "server",
            "127.0.0.1",
            server.port,
            &server.public_key,
        )];
        if let Some(gateway) = gateway {
            gateway.forwarding.lock().unwrap().targets.insert(
                ("private-ssh.fixture.invalid".into(), 22),
                ([127, 0, 0, 1], server.port).into(),
            );
            route[0].0.address = "private-ssh.fixture.invalid".into();
            route[0].0.port = 22;
            route.insert(
                0,
                material("gateway", "127.0.0.1", gateway.port, &gateway.public_key),
            );
        }
        (
            Arc::new(
                ssh_route::connect(
                    &route,
                    0,
                    |material| Handler {
                        key: material.1.as_ref().unwrap().public_key.clone(),
                        incoming: sender.clone(),
                    },
                    |_, _| {},
                )
                .await
                .unwrap(),
            ),
            receiver,
        )
    }
    async fn started(
        server: &TestServer,
        gateway: Option<&TestServer>,
        profile: TunnelProfile,
    ) -> (
        u16,
        watch::Sender<bool>,
        tokio::task::JoinHandle<Result<(), String>>,
        Arc<Mutex<Vec<String>>>,
    ) {
        let (connection, incoming) = route(server, gateway).await;
        let (stop, cancelled) = watch::channel(false);
        let (ready, mut bound) = mpsc::channel(1);
        let errors = Arc::new(Mutex::new(Vec::new()));
        let reported = errors.clone();
        let task = tokio::spawn(serve(
            connection,
            profile,
            incoming,
            cancelled,
            move |port| {
                ready.try_send(port).unwrap();
            },
            move |error| reported.lock().unwrap().push(error),
        ));
        let port = tokio::time::timeout(Duration::from_secs(3), bound.recv())
            .await
            .unwrap()
            .unwrap();
        (port, stop, task, errors)
    }
    async fn traffic(socket: &mut TcpStream) {
        let bytes = vec![42; 200_000];
        socket.write_all(&bytes).await.unwrap();
        let mut read = vec![0; bytes.len()];
        tokio::time::timeout(Duration::from_secs(3), socket.read_exact(&mut read))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(read, bytes);
    }
    #[tokio::test]
    async fn local_forward_passes_binary_tcp_through_a_jump_and_stop_closes_active_clients_and_listener()
     {
        let gateway = TestServer::start("gateway.txt").await;
        let server = TestServer::start("server.txt").await;
        let echo = Echo::start().await;
        server.forwarding.lock().unwrap().targets.insert(
            ("remote-only.fixture.invalid".into(), 8080),
            ([127, 0, 0, 1], echo.port).into(),
        );
        let (port, stop, task, errors) =
            started(&server, Some(&gateway), profile(TunnelKind::Local)).await;
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        traffic(&mut socket).await;
        stop.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
        let mut buffer = [0; 1];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), socket.read(&mut buffer))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert!(errors.lock().unwrap().is_empty());
        assert_eq!(
            server.forwarding.lock().unwrap().requests,
            vec![("remote-only.fixture.invalid".into(), 8080)]
        );
    }
    #[tokio::test]
    async fn socks5_remote_dns_ipv4_ipv6_and_refusals_preserve_the_listener_until_stop() {
        let server = TestServer::start("socks.txt").await;
        let echo = Echo::start().await;
        for address in ["remote-only.fixture.invalid", "192.0.2.3", "2001:db8::4"] {
            server
                .forwarding
                .lock()
                .unwrap()
                .targets
                .insert((address.into(), 8080), ([127, 0, 0, 1], echo.port).into());
        }
        let (port, stop, task, errors) = started(&server, None, profile(TunnelKind::Socks)).await;
        for (kind, address) in [
            (3, b"remote-only.fixture.invalid".to_vec()),
            (1, vec![192, 0, 2, 3]),
            (
                4,
                "2001:db8::4".parse::<Ipv6Addr>().unwrap().octets().to_vec(),
            ),
        ] {
            let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            socket.write_all(&[5, 1, 0]).await.unwrap();
            let mut method = [0; 2];
            socket.read_exact(&mut method).await.unwrap();
            assert_eq!(method, [5, 0]);
            let mut request = vec![5, 1, 0, kind];
            if kind == 3 {
                request.push(address.len() as u8);
            }
            request.extend(address);
            request.extend(8080u16.to_be_bytes());
            socket.write_all(&request).await.unwrap();
            let mut response = [0; 10];
            socket.read_exact(&mut response).await.unwrap();
            assert_eq!(response[1], 0);
            traffic(&mut socket).await;
        }
        for command in [2, 3] {
            let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            socket
                .write_all(&[5, 1, 0, 5, command, 0, 1])
                .await
                .unwrap();
            let mut response = [0; 12];
            socket.read_exact(&mut response).await.unwrap();
            assert_eq!(response[3], 7);
        }
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        socket.write_all(&[5, 1, 2]).await.unwrap();
        let mut response = [0; 2];
        socket.read_exact(&mut response).await.unwrap();
        assert_eq!(response, [5, 255]);
        stop.send(true).unwrap();
        task.await.unwrap().unwrap();
        assert!(errors.lock().unwrap().len() >= 3);
    }
    #[tokio::test]
    async fn remote_forward_uses_the_assigned_port_and_removes_it_and_active_clients_on_stop() {
        let gateway = TestServer::start("gateway.txt").await;
        let server = TestServer::start("remote.txt").await;
        server.forwarding.lock().unwrap().allow_remote = true;
        let echo = Echo::start().await;
        let mut profile = profile(TunnelKind::Remote);
        profile.target_address = Some("127.0.0.1".into());
        profile.target_port = Some(echo.port);
        let (port, stop, task, errors) = started(&server, Some(&gateway), profile).await;
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        traffic(&mut socket).await;
        stop.send(true).unwrap();
        task.await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if TcpStream::connect(("127.0.0.1", port)).await.is_err() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let mut contents = Vec::new();
        tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut contents))
            .await
            .unwrap()
            .unwrap();
        assert!(contents.is_empty());
        assert_eq!(
            server.forwarding.lock().unwrap().remote_cancellations,
            vec![("127.0.0.1".into(), u32::from(port))]
        );
        assert!(errors.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn bind_collisions_remote_rejection_and_destination_refusal_do_not_claim_a_working_forward()
     {
        let server = TestServer::start("rejections.txt").await;
        let (connection, incoming) = route(&server, None).await;
        let (_local_cancel, stop) = watch::channel(false);
        let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut profile = profile(TunnelKind::Local);
        profile.listen_port = occupied.local_addr().unwrap().port();
        let error = serve(
            connection,
            profile,
            incoming,
            stop,
            |_| panic!("Must not announce ready"),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(error.contains("ocupado"));
        let (connection, incoming) = route(&server, None).await;
        let (_remote_cancel, stop) = watch::channel(false);
        let error = serve(
            connection,
            self::profile(TunnelKind::Remote),
            incoming,
            stop,
            |_| panic!("Must not announce ready"),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(error.contains("rechazó"));
        let (port, stop, task, errors) =
            started(&server, None, self::profile(TunnelKind::Local)).await;
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut buffer = [0; 1];
        assert_eq!(socket.read(&mut buffer).await.unwrap(), 0);
        assert!(
            errors
                .lock()
                .unwrap()
                .iter()
                .any(|error| error.contains("No se pudo abrir"))
        );
        stop.send(true).unwrap();
        task.await.unwrap().unwrap();
    }
    #[test]
    fn rejects_unsafe_socks_exposure_and_invalid_targets_before_network_activity() {
        let mut profile = profile(TunnelKind::Socks);
        profile.listen_address = "0.0.0.0".into();
        assert!(validate(&profile).is_err());
        profile.listen_address = "::1".into();
        assert!(validate(&profile).is_ok());
        profile.target_port = Some(22);
        assert!(validate(&profile).is_err());
        let mut profile = self::profile(TunnelKind::Local);
        profile.target_address = Some("host\nname".into());
        assert!(validate(&profile).is_err());
        profile.target_address = Some("2001:db8::1".into());
        profile.target_port = Some(0);
        assert!(validate(&profile).is_err());
    }
    #[tokio::test]
    async fn cancellation_interrupts_a_pending_remote_forward_without_announcing_an_active_listener()
     {
        let server = TestServer::start("slow.txt").await;
        {
            let mut fixture = server.forwarding.lock().unwrap();
            fixture.allow_remote = true;
            fixture.remote_delay_millis = 10_000;
        }
        let (connection, incoming) = route(&server, None).await;
        let (stop, cancelled) = watch::channel(false);
        let task = tokio::spawn(serve(
            connection,
            profile(TunnelKind::Remote),
            incoming,
            cancelled,
            |_| panic!("Cancelled setup must not announce ready"),
            |_| {},
        ));
        tokio::time::timeout(Duration::from_secs(3), async {
            while server.forwarding.lock().unwrap().remote_attempts == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        stop.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(server.forwarding.lock().unwrap().remote_requests.is_empty());
    }
    #[tokio::test]
    async fn an_interrupted_ssh_session_reports_failure_and_releases_the_local_listening_port() {
        let server = TestServer::start("closed.txt").await;
        let (connection, incoming) = route(&server, None).await;
        let owned = connection.clone();
        let (_stop, cancelled) = watch::channel(false);
        let (ready, mut port) = mpsc::channel(1);
        let task = tokio::spawn(serve(
            owned,
            profile(TunnelKind::Local),
            incoming,
            cancelled,
            move |bound| {
                ready.try_send(bound).unwrap();
            },
            |_| {},
        ));
        let bound = port.recv().await.unwrap();
        connection
            .disconnect(
                russh::Disconnect::ByApplication,
                "fixture interruption",
                "en",
            )
            .await
            .unwrap();
        let error = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.contains("interrumpió"));
        assert!(TcpStream::connect(("127.0.0.1", bound)).await.is_err());
    }
    #[test]
    fn saved_tunnel_profiles_survive_reopening_and_invalid_edits_preserve_metadata_and_ciphertext()
    {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tunnels.db");
        let mut db = crate::database::Database::open(&path).unwrap();
        let mut snapshot = db.load_snapshot().unwrap();
        let mut host = material("server", "localhost", 22, "key").0;
        host.vault_id = snapshot.vaults[0].id.clone();
        snapshot.hosts.push(host);
        snapshot.productivity.tunnels = vec![
            profile(TunnelKind::Local),
            TunnelProfile {
                id: "remote".into(),
                ..profile(TunnelKind::Remote)
            },
            TunnelProfile {
                id: "socks".into(),
                ..profile(TunnelKind::Socks)
            },
        ];
        db.save_with_secrets(&snapshot, b"original-ciphertext")
            .unwrap();
        for edit in 0..4 {
            let mut invalid = snapshot.clone();
            match edit {
                0 => invalid.productivity.tunnels[0].host_id = "deleted".into(),
                1 => invalid.productivity.tunnels[2].listen_address = "0.0.0.0".into(),
                2 => invalid.productivity.tunnels[0].target_port = Some(0),
                _ => invalid.productivity.tunnels[1].id = "tunnel".into(),
            }
            assert!(db.save_with_secrets(&invalid, b"changed").is_err());
            assert_eq!(db.load_snapshot().unwrap(), snapshot);
            assert_eq!(
                db.secret_payload().unwrap().unwrap(),
                b"original-ciphertext"
            );
        }
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
