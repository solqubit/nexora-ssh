use russh_sftp::{
    client::SftpSession,
    protocol::{FileAttributes, OpenFlags},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTextDocument {
    pub path: String,
    pub text: String,
    pub revision: String,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SaveRemoteTextResponse {
    Saved {
        document: RemoteTextDocument,
        warning: Option<String>,
    },
    Conflict {
        document: RemoteTextDocument,
    },
}

fn validate_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') || path == "/" || path.len() > 4096 || path.contains('\0') {
        return Err("Selecciona la ruta absoluta de un archivo remoto".into());
    }
    Ok(())
}

fn revision(scope: &str, path: &str, content: &[u8], metadata: &FileAttributes) -> String {
    let mut hash = Sha256::new();
    for part in [scope.as_bytes(), path.as_bytes(), content] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part);
    }
    hash.update(
        serde_json::to_vec(&(
            metadata.permissions,
            metadata.uid,
            metadata.gid,
            metadata.mtime,
        ))
        .expect("integer metadata is serializable"),
    );
    format!("{:x}", hash.finalize())
}

fn same_metadata(first: &FileAttributes, second: &FileAttributes) -> bool {
    (
        first.size,
        first.permissions,
        first.uid,
        first.gid,
        first.mtime,
    ) == (
        second.size,
        second.permissions,
        second.uid,
        second.gid,
        second.mtime,
    )
}

async fn read(
    sftp: &SftpSession,
    path: &str,
    scope: &str,
    revision_path: &str,
) -> Result<(RemoteTextDocument, FileAttributes), String> {
    validate_path(path)?;
    let before = sftp
        .symlink_metadata(path)
        .await
        .map_err(|error| format!("No se pudo comprobar el archivo remoto: {error}"))?;
    if !before
        .permissions
        .is_some_and(|mode| mode & 0o170000 == 0o100000)
    {
        return Err(
            "El editor admite archivos regulares; selecciona el archivo de destino de un enlace"
                .into(),
        );
    }
    if before.size.is_some_and(|size| size > MAX_TEXT_BYTES as u64) {
        return Err("El editor admite archivos de texto de hasta 2 MB".into());
    }
    let mut file = sftp
        .open(path)
        .await
        .map_err(|error| format!("No se pudo abrir el archivo: {error}"))?;
    let mut content = Vec::new();
    let result = (&mut file)
        .take((MAX_TEXT_BYTES + 1) as u64)
        .read_to_end(&mut content)
        .await;
    let closed = file.shutdown().await;
    result.map_err(|error| format!("No se pudo leer el archivo: {error}"))?;
    closed.map_err(|error| format!("No se pudo cerrar el archivo: {error}"))?;
    if content.len() > MAX_TEXT_BYTES {
        return Err("El archivo creció por encima del límite de 2 MB".into());
    }
    let after = sftp
        .symlink_metadata(path)
        .await
        .map_err(|error| format!("El archivo cambió durante la lectura: {error}"))?;
    if !same_metadata(&before, &after)
        || after.size.is_some_and(|size| size != content.len() as u64)
    {
        return Err("El archivo cambió durante la lectura. Vuelve a abrirlo".into());
    }
    if content.contains(&0) {
        return Err("Este archivo contiene datos binarios y no puede editarse como texto".into());
    }
    let fingerprint = revision(scope, revision_path, &content, &after);
    let text = String::from_utf8(content).map_err(|_| {
        "El editor requiere texto UTF-8. Descarga el archivo para editar otra codificación"
            .to_string()
    })?;
    Ok((
        RemoteTextDocument {
            path: revision_path.into(),
            text,
            revision: fingerprint,
        },
        after,
    ))
}

pub(crate) async fn open_document(
    sftp: &SftpSession,
    path: &str,
    scope: &str,
) -> Result<RemoteTextDocument, String> {
    read(sftp, path, scope, path)
        .await
        .map(|(document, _)| document)
}

pub(crate) async fn save_document(
    sftp: &SftpSession,
    path: &str,
    expected_revision: &str,
    text: &str,
    scope: &str,
) -> Result<SaveRemoteTextResponse, String> {
    validate_path(path)?;
    if text.len() > MAX_TEXT_BYTES || text.contains('\0') {
        return Err("Guarda texto UTF-8 sin caracteres nulos y de hasta 2 MB".into());
    }
    if expected_revision.len() != 64
        || !expected_revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("La revisión del archivo no es válida; vuelve a abrirlo".into());
    }
    let (current, metadata) = read(sftp, path, scope, path).await?;
    if current.revision != expected_revision {
        return Ok(SaveRemoteTextResponse::Conflict { document: current });
    }
    if metadata.uid.is_none() || metadata.gid.is_none() {
        return Err("El servidor no informa el propietario y grupo. Descarga el archivo para editarlo; no se reemplazará sin poder conservar estos datos".into());
    }
    let parent = path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    let temporary = format!("{parent}/.nexora-edit-{}.tmp", Uuid::new_v4());
    let backup = format!("{parent}/.nexora-edit-{}.backup", Uuid::new_v4());
    let attributes = FileAttributes {
        permissions: metadata.permissions.map(|mode| mode & 0o7777),
        ..FileAttributes::empty()
    };
    let mut file = sftp
        .open_with_flags_and_attributes(
            &temporary,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            attributes,
        )
        .await
        .map_err(|error| format!("No se pudo crear el archivo temporal: {error}"))?;
    let written = file.write_all(text.as_bytes()).await;
    let closed = file.shutdown().await;
    if let Err(error) = written.and(closed) {
        let _ = sftp.remove_file(&temporary).await;
        return Err(format!(
            "No se pudo completar la escritura; el original se conserva: {error}"
        ));
    }
    let permissions = FileAttributes {
        permissions: metadata.permissions.map(|mode| mode & 0o7777),
        uid: metadata.uid,
        gid: metadata.gid,
        ..FileAttributes::empty()
    };
    if let Err(error) = sftp.set_metadata(&temporary, permissions).await {
        let _ = sftp.remove_file(&temporary).await;
        return Err(format!(
            "No se pudieron conservar los permisos y propietario; el original se conserva: {error}"
        ));
    }
    let temporary_metadata = sftp.symlink_metadata(&temporary).await;
    if !temporary_metadata.is_ok_and(|value| {
        value.permissions.map(|mode| mode & 0o7777)
            == metadata.permissions.map(|mode| mode & 0o7777)
            && value.uid == metadata.uid
            && value.gid == metadata.gid
    }) {
        let _ = sftp.remove_file(&temporary).await;
        return Err("No se pudo verificar la conservación de permisos y propietario; el original se conserva".into());
    }
    let latest = match read(sftp, path, scope, path).await {
        Ok((document, _)) => document,
        Err(error) => {
            let _ = sftp.remove_file(&temporary).await;
            return Err(error);
        }
    };
    if latest.revision != expected_revision {
        let _ = sftp.remove_file(&temporary).await;
        return Ok(SaveRemoteTextResponse::Conflict { document: latest });
    }
    if let Err(error) = sftp.rename(path, &backup).await {
        let _ = sftp.remove_file(&temporary).await;
        return Err(format!(
            "No se pudo proteger el original antes de guardar: {error}"
        ));
    }
    // Verify the actual file moved aside, closing the race between the last check and rename.
    let protected = read(sftp, &backup, scope, path).await;
    match protected {
        Ok((document, _)) if document.revision != expected_revision => {
            let restored = sftp.rename(&backup, path).await;
            let _ = sftp.remove_file(&temporary).await;
            if restored.is_err() {
                return Err(format!(
                    "El archivo cambió durante el guardado. Se conservó la versión anterior en {backup}; revisa ambas versiones"
                ));
            }
            return Ok(SaveRemoteTextResponse::Conflict { document });
        }
        Err(error) => {
            let restored = sftp.rename(&backup, path).await;
            let _ = sftp.remove_file(&temporary).await;
            return Err(if restored.is_ok() {
                error
            } else {
                format!("{error}. La copia protegida permanece en {backup}")
            });
        }
        _ => {}
    }
    if let Err(error) = sftp.rename(&temporary, path).await {
        let restored = sftp.rename(&backup, path).await;
        let _ = sftp.remove_file(&temporary).await;
        return Err(if restored.is_ok() {
            format!("No se pudo guardar; se restauró el original: {error}")
        } else {
            format!(
                "No se pudo guardar: {error}. El original permanece en {backup}; revisa el archivo de destino antes de repetir"
            )
        });
    }
    let warning = match read(sftp, &backup, scope, path).await {
        Ok((document, _)) if document.revision == expected_revision => {
            sftp.remove_file(&backup).await.err().map(|error| {
                format!("Archivo guardado. No se pudo retirar la copia {backup}: {error}")
            })
        }
        _ => Some(format!(
            "Archivo guardado. Se detectó actividad sobre la versión anterior; se conserva en {backup} para revisión"
        )),
    };
    let document = open_document(sftp, path, scope).await.map_err(|error| format!("La escritura terminó pero no se pudo confirmar el contenido. Revisa el archivo antes de repetir: {error}"))?;
    if document.text != text {
        return Err("Otro proceso modificó el archivo después de guardarlo. Se conserva tu borrador; vuelve a leer el servidor antes de repetir".into());
    }
    Ok(SaveRemoteTextResponse::Saved { document, warning })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_server::TestServer;

    #[tokio::test]
    async fn saves_utf8_and_line_endings_and_preserves_metadata_over_real_sftp() {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let server = TestServer::start_with_text("/config.txt", b"before\r\n").await;
            let (_connection, sftp) = server.sftp().await;
            let original = open_document(&sftp, "/config.txt", "session-a")
                .await
                .unwrap();
            let result = save_document(
                &sftp,
                "/config.txt",
                &original.revision,
                "después\r\n",
                "session-a",
            )
            .await
            .unwrap();
            let SaveRemoteTextResponse::Saved { document, warning } = result else {
                panic!("expected saved file")
            };
            assert_eq!(document.text, "después\r\n");
            assert_ne!(document.revision, original.revision);
            assert!(warning.is_none());
            let files = server.files.as_ref().unwrap().lock().unwrap();
            let file = files.files.get("/config.txt").unwrap();
            assert_eq!(
                (file.permissions, file.uid, file.gid),
                (0o100640, 1000, 1000)
            );
            assert_eq!(files.files.len(), 1);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn detects_external_changes_and_new_connection_scopes_without_overwriting() {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let server = TestServer::start_with_text("/config.txt", b"before").await; let (_connection, sftp) = server.sftp().await;
            let original = open_document(&sftp, "/config.txt", "session-a").await.unwrap();
            assert!(matches!(save_document(&sftp, "/config.txt", &original.revision, "draft", "session-b").await.unwrap(), SaveRemoteTextResponse::Conflict { .. }));
            { let mut files = server.files.as_ref().unwrap().lock().unwrap(); let file = files.files.get_mut("/config.txt").unwrap(); file.content = b"edited".to_vec(); /* same size/mtime: content hashing must still detect this */ }
            let result = save_document(&sftp, "/config.txt", &original.revision, "draft", "session-a").await.unwrap();
            let SaveRemoteTextResponse::Conflict { document } = result else { panic!("expected conflict") }; assert_eq!(document.text, "edited");
            let files = server.files.as_ref().unwrap().lock().unwrap(); assert_eq!(files.files["/config.txt"].content, b"edited"); assert_eq!(files.files.len(), 1);
        }).await.unwrap();
    }

    #[tokio::test]
    async fn failed_promotion_restores_original_and_a_race_during_backup_returns_a_conflict() {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let server = TestServer::start_with_text("/config.txt", b"before").await;
            let (_connection, sftp) = server.sftp().await;
            let original = open_document(&sftp, "/config.txt", "session")
                .await
                .unwrap();
            server.files.as_ref().unwrap().lock().unwrap().fail_promote = true;
            assert!(
                save_document(&sftp, "/config.txt", &original.revision, "draft", "session")
                    .await
                    .unwrap_err()
                    .contains("restauró el original")
            );
            {
                let mut files = server.files.as_ref().unwrap().lock().unwrap();
                assert_eq!(files.files["/config.txt"].content, b"before");
                assert_eq!(files.files.len(), 1);
                files.fail_promote = false;
                files.mutate_on_backup = true;
            }
            let SaveRemoteTextResponse::Conflict { document } =
                save_document(&sftp, "/config.txt", &original.revision, "draft", "session")
                    .await
                    .unwrap()
            else {
                panic!("expected backup race conflict")
            };
            assert_eq!(document.text, "externally changed");
            let files = server.files.as_ref().unwrap().lock().unwrap();
            assert_eq!(files.files["/config.txt"].content, b"externally changed");
            assert_eq!(files.files.len(), 1);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn rejects_a_server_that_acknowledges_but_does_not_preserve_ownership() {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let server = TestServer::start_with_text("/config.txt", b"before").await;
            {
                let mut files = server.files.as_ref().unwrap().lock().unwrap();
                files.files.get_mut("/config.txt").unwrap().uid = 2000;
                files.ignore_setstat = true;
            }
            let (_connection, sftp) = server.sftp().await;
            let original = open_document(&sftp, "/config.txt", "session")
                .await
                .unwrap();
            let error = save_document(&sftp, "/config.txt", &original.revision, "draft", "session")
                .await
                .unwrap_err();
            assert!(error.contains("verificar la conservación"));
            let files = server.files.as_ref().unwrap().lock().unwrap();
            assert_eq!(files.files["/config.txt"].content, b"before");
            assert_eq!(files.files["/config.txt"].uid, 2000);
            assert_eq!(files.files.len(), 1);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn rejects_binary_non_utf8_oversized_and_symlink_files() {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let server = TestServer::start_with_text("/config.txt", b"a\0b").await;
            let (_connection, sftp) = server.sftp().await;
            assert!(
                open_document(&sftp, "/config.txt", "session")
                    .await
                    .unwrap_err()
                    .contains("binarios")
            );
            server
                .files
                .as_ref()
                .unwrap()
                .lock()
                .unwrap()
                .files
                .get_mut("/config.txt")
                .unwrap()
                .content = vec![0xff];
            assert!(
                open_document(&sftp, "/config.txt", "session")
                    .await
                    .unwrap_err()
                    .contains("UTF-8")
            );
            {
                let mut files = server.files.as_ref().unwrap().lock().unwrap();
                let file = files.files.get_mut("/config.txt").unwrap();
                file.content = vec![b'a'; MAX_TEXT_BYTES + 1];
            }
            assert!(
                open_document(&sftp, "/config.txt", "session")
                    .await
                    .unwrap_err()
                    .contains("2 MB")
            );
            {
                let mut files = server.files.as_ref().unwrap().lock().unwrap();
                let file = files.files.get_mut("/config.txt").unwrap();
                file.content = b"target".to_vec();
                file.permissions = 0o120777;
            }
            assert!(
                open_document(&sftp, "/config.txt", "session")
                    .await
                    .unwrap_err()
                    .contains("enlace")
            );
        })
        .await
        .unwrap();
    }
}
