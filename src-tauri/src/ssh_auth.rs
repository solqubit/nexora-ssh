use crate::models::{Host, HostSecret};
use russh::{
    client::{self, KeyboardInteractiveAuthResponse},
    keys::{PrivateKeyWithHashAlg, decode_secret_key},
};
use std::sync::Arc;

pub(crate) async fn authenticate<H: client::Handler>(
    session: &mut client::Handle<H>,
    host: &Host,
    secret: &HostSecret,
) -> Result<(), String> {
    let authenticated = match host.auth_method.as_str() {
        "password" => {
            let password = secret
                .password
                .as_deref()
                .ok_or_else(|| "Este host no tiene una contraseña guardada".to_string())?;
            let direct = session
                .authenticate_password(host.username.clone(), password)
                .await
                .map_err(|error| format!("Falló la autenticación por contraseña: {error}"))?;
            if direct.success() {
                true
            } else {
                authenticate_keyboard_interactive(session, &host.username, password).await?
            }
        }
        "private_key" => {
            let private_key = secret
                .private_key
                .as_deref()
                .ok_or_else(|| "Este host no tiene una llave privada guardada".to_string())?;
            let key = decode_secret_key(private_key, secret.key_passphrase.as_deref())
                .map_err(|error| format!("No se pudo leer la llave privada: {error}"))?;
            let hash_algorithm = session
                .best_supported_rsa_hash()
                .await
                .map_err(|error| format!("No se pudo negociar la firma de la llave: {error}"))?
                .flatten();
            session
                .authenticate_publickey(
                    host.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_algorithm),
                )
                .await
                .map_err(|error| format!("Falló la autenticación con llave privada: {error}"))?
                .success()
        }
        _ => return Err("El método de autenticación del perfil no es compatible".into()),
    };
    if !authenticated {
        return Err("El servidor rechazó las credenciales".into());
    }
    Ok(())
}

async fn authenticate_keyboard_interactive<H: client::Handler>(
    session: &mut client::Handle<H>,
    username: &str,
    password: &str,
) -> Result<bool, String> {
    let mut response = session
        .authenticate_keyboard_interactive_start(username.to_string(), None::<String>)
        .await
        .map_err(|error| format!("Falló la autenticación interactiva: {error}"))?;
    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                response = session
                    .authenticate_keyboard_interactive_respond(
                        prompts.iter().map(|_| password.to_string()).collect(),
                    )
                    .await
                    .map_err(|error| {
                        format!("Falló la respuesta de autenticación interactiva: {error}")
                    })?;
            }
        }
    }
}
