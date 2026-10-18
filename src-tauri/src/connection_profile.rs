use crate::{
    AppState,
    models::{AppSnapshot, Host, HostSecret, KnownHost},
};
use std::collections::HashSet;

pub(crate) struct ResolvedProfile {
    pub host: Host,
    pub identity_id: Option<String>,
    pub keepalive_seconds: Option<u64>,
    pub tmux_session: Option<String>,
}

pub(crate) fn resolve(snapshot: &AppSnapshot, host: &Host) -> Result<ResolvedProfile, String> {
    let profile = snapshot
        .productivity
        .connection_profiles
        .iter()
        .find(|profile| profile.host_id == host.id);
    let mut username = None;
    let mut port = None;
    let mut identity_id = None;
    let mut keepalive = None;
    let mut group_id = host.group_id.as_deref();
    let mut visited = HashSet::new();
    while let Some(id) = group_id {
        if !visited.insert(id) {
            return Err("La jerarquía de grupos contiene un ciclo".into());
        }
        if let Some(defaults) = snapshot
            .productivity
            .group_defaults
            .iter()
            .find(|group| group.group_id == id)
        {
            username = username.or(defaults.username.as_deref());
            port = port.or(defaults.port);
            identity_id = identity_id.or(defaults.identity_id.as_deref());
            keepalive = keepalive.or(defaults.keepalive_seconds);
        }
        group_id = snapshot
            .groups
            .iter()
            .find(|group| group.id == id)
            .and_then(|group| group.parent_id.as_deref());
    }
    let mut effective = host.clone();
    let identity_id = profile
        .filter(|_| host.protocol != "telnet")
        .and_then(|profile| {
            if profile.inherit_identity {
                identity_id.or(profile.identity_id.as_deref())
            } else {
                profile.identity_id.as_deref()
            }
        });
    let identity = identity_id
        .map(|id| {
            snapshot
                .productivity
                .identities
                .iter()
                .find(|identity| identity.id == id)
                .ok_or_else(|| "La identidad ya no existe".to_string())
        })
        .transpose()?;
    if let Some(profile) = profile {
        if profile.inherit_username {
            effective.username = username.unwrap_or(&host.username).to_string();
        }
        if profile.inherit_port {
            effective.port = port.unwrap_or(host.port);
        }
        keepalive = if profile.inherit_keepalive {
            keepalive.or(profile.keepalive_seconds)
        } else {
            profile.keepalive_seconds
        };
    } else {
        keepalive = None;
    }
    if let Some(identity) = identity {
        effective.auth_method.clone_from(&identity.auth_method);
        if effective.username.is_empty() {
            effective.username.clone_from(&identity.username);
        }
    }
    Ok(ResolvedProfile {
        host: effective,
        identity_id: identity_id.map(str::to_owned),
        keepalive_seconds: keepalive,
        tmux_session: None,
    })
}

pub(crate) type ConnectionMaterial = (
    Host,
    Option<KnownHost>,
    HostSecret,
    Option<u64>,
    Option<String>,
);

#[cfg(test)]
pub(crate) fn load_material(host_id: &str, state: &AppState) -> Result<ConnectionMaterial, String> {
    let database = state
        .database
        .lock()
        .map_err(|_| "La base de datos está ocupada")?;
    state.ensure_available()?;
    let snapshot = database
        .load_snapshot()
        .map_err(|error| error.to_string())?;
    material_from_snapshot(host_id, &snapshot, state)
}

fn material_from_snapshot(
    host_id: &str,
    snapshot: &AppSnapshot,
    state: &AppState,
) -> Result<ConnectionMaterial, String> {
    let Some(host) = snapshot.hosts.iter().find(|host| host.id == host_id) else {
        return crate::temporary_hosts::material(host_id, snapshot, state);
    };
    let resolved = resolve(snapshot, host)?;
    let key = resolved
        .identity_id
        .as_ref()
        .map(|id| format!("identity:{id}"))
        .unwrap_or_else(|| host_id.to_string());
    let secret = state
        .secrets
        .lock()
        .map_err(|_| "El almacén seguro está ocupado")?
        .get(&key)
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    let known = snapshot
        .known_hosts
        .iter()
        .find(|known| known.host_id == host_id)
        .cloned();
    Ok((
        resolved.host,
        known,
        secret,
        resolved.keepalive_seconds,
        resolved.tmux_session,
    ))
}

pub(crate) fn route_ids(snapshot: &AppSnapshot, host_id: &str) -> Result<Vec<String>, String> {
    let target = snapshot
        .hosts
        .iter()
        .find(|host| host.id == host_id)
        .ok_or("El destino SSH ya no existe")?;
    let mut current = Some(host_id);
    let mut ids = Vec::new();
    while let Some(id) = current {
        if ids.iter().any(|value| value == id) {
            return Err("La ruta de salto contiene un ciclo".into());
        }
        if ids.len() >= 9 {
            return Err("La ruta admite hasta ocho hosts de salto".into());
        }
        let hop = snapshot
            .hosts
            .iter()
            .find(|host| host.id == id)
            .ok_or("Un host de salto ya no existe; revisa la configuración del destino")?;
        if hop.vault_id != target.vault_id {
            return Err("Los hosts de salto deben pertenecer a la misma bóveda".into());
        }
        ids.push(id.to_string());
        current = snapshot
            .productivity
            .connection_profiles
            .iter()
            .find(|profile| profile.host_id == id)
            .and_then(|profile| profile.jump_host_id.as_deref());
    }
    ids.reverse();
    Ok(ids)
}

pub(crate) fn load_route(
    host_id: &str,
    state: &AppState,
) -> Result<Vec<ConnectionMaterial>, String> {
    let database = state
        .database
        .lock()
        .map_err(|_| "La base de datos está ocupada")?;
    state.ensure_available()?;
    let snapshot = database
        .load_snapshot()
        .map_err(|error| error.to_string())?;
    let mut view = snapshot.clone();
    if !view.hosts.iter().any(|host| host.id == host_id) {
        let temporary = state
            .ssh
            .temporary
            .list()?
            .into_iter()
            .find(|item| item.host.id == host_id)
            .ok_or("La conexión temporal ya no existe")?;
        view.hosts.push(temporary.host);
        view.productivity
            .connection_profiles
            .push(temporary.connection);
    }
    route_ids(&view, host_id)?
        .iter()
        .map(|id| {
            let material = material_from_snapshot(id, &snapshot, state)?;
            if material.0.protocol == "ssh" && material.0.username.trim().is_empty() {
                return Err(format!(
                    "Configura el usuario SSH de {} antes de conectar",
                    material.0.name
                ));
            }
            Ok(material)
        })
        .collect()
}

pub(crate) fn secret_ids(snapshot: &AppSnapshot) -> Vec<String> {
    snapshot
        .hosts
        .iter()
        .map(|host| host.id.clone())
        .chain(
            snapshot
                .productivity
                .identities
                .iter()
                .map(|identity| format!("identity:{}", identity.id)),
        )
        .collect()
}

pub(crate) fn load_own_secret(host_id: &str, state: &AppState) -> Result<HostSecret, String> {
    let database = state
        .database
        .lock()
        .map_err(|_| "La base de datos está ocupada")?;
    state.ensure_available()?;
    let snapshot = database
        .load_snapshot()
        .map_err(|error| error.to_string())?;
    if !snapshot.hosts.iter().any(|host| host.id == host_id) {
        return Err("El host ya no existe".into());
    }
    state
        .secrets
        .lock()
        .map_err(|_| "El almacén seguro está ocupado")?
        .get(host_id)
        .map_err(|error| error.to_string())
        .map(Option::unwrap_or_default)
}
