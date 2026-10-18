use std::path::{Component, Path, PathBuf};

/// A remote name is untrusted, even when supplied by an authenticated server.
pub fn validate_component(name: &str, windows: bool) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\0']) {
        return Err("El nombre debe ser un único componente de archivo".into());
    }
    if windows {
        if name.contains('\\')
            || !matches!(
                Path::new(name).components().next(),
                Some(Component::Normal(_))
            )
            || Path::new(name).components().count() != 1
        {
            return Err("El nombre debe ser un único componente de archivo".into());
        }
        let stem = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let reserved = matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|number| {
                matches!(
                    number,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
        if reserved
            || name.ends_with(['.', ' '])
            || name.chars().any(|c| c < ' ' || "<>:\"|?*".contains(c))
        {
            return Err("El nombre no es compatible con el sistema de archivos de Windows".into());
        }
    }
    Ok(())
}

pub async fn reject_symlink(path: &Path) -> Result<(), String> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("No se permite reemplazar ni recorrer enlaces simbólicos en el destino".into())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("No se pudo validar el destino: {error}")),
    }
}

pub async fn local_child(parent: &Path, name: &str) -> Result<PathBuf, String> {
    validate_component(name, cfg!(target_os = "windows"))?;
    reject_symlink(parent).await?;
    let parent = tokio::fs::canonicalize(parent)
        .await
        .map_err(|e| format!("No se pudo resolver la carpeta de destino: {e}"))?;
    let child = parent.join(name);
    if child.parent() != Some(parent.as_path()) {
        return Err("El destino no pertenece a la carpeta elegida".into());
    }
    reject_symlink(&child).await?;
    Ok(child)
}

pub fn reject_remote_self_copy(
    source: &str,
    target: &str,
    is_directory: bool,
) -> Result<(), String> {
    let source = source.trim_end_matches('/');
    let target = target.trim_end_matches('/');
    if source == target
        || (is_directory && (source.is_empty() || target.starts_with(&format!("{source}/"))))
    {
        return Err(
            "No se puede transferir un elemento sobre sí mismo ni dentro de sí mismo".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_windows_drive_stream_device_and_alias_names() {
        for name in [
            "D:escape.txt",
            "C:escape.txt",
            "notes.txt:stream",
            "CON",
            "nul.txt",
            "COM1.log",
            "LPT¹",
            ".. ",
            "file.",
            "a\\b",
            "../x",
        ] {
            assert!(validate_component(name, true).is_err(), "{name}");
        }
        assert!(validate_component("informe.txt", true).is_ok());
        assert!(validate_component("COM10.txt", true).is_ok());
        assert!(validate_component("a:b", false).is_ok());
    }
    #[test]
    fn rejects_final_remote_target_equal_to_origin() {
        assert!(reject_remote_self_copy("/home/a.txt", "/home/a.txt", false).is_err());
        assert!(reject_remote_self_copy("/home/folder", "/home/folder/child", true).is_err());
        assert!(reject_remote_self_copy("/home/folder", "/home/folder-copy", true).is_ok());
    }
}
