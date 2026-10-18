use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use crate::AppError;

pub fn recover_interrupted_replace(path: &Path) -> Result<(), AppError> {
    let temporary = sibling_path(path, ".tmp");
    let backup = sibling_path(path, ".bak");

    if path.exists() {
        remove_if_exists(&temporary)?;
        remove_if_exists(&backup)?;
        return Ok(());
    }

    if backup.exists() {
        fs::rename(&backup, path)?;
        remove_if_exists(&temporary)?;
    } else if temporary.exists() {
        // An uncommitted first write may be partial. Never promote it.
        remove_if_exists(&temporary)?;
    }
    Ok(())
}

pub fn write_atomic(path: &Path, payload: &[u8]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    recover_interrupted_replace(path)?;

    let temporary = sibling_path(path, ".tmp");
    let backup = sibling_path(path, ".bak");
    {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(payload)?;
        file.sync_all()?;
    }

    replace_file(&temporary, path, true)?;

    // La sustitución ya quedó confirmada; un respaldo que no pueda borrarse se
    // limpiará en la siguiente apertura y no debe convertir el guardado en fallo.
    let _ = remove_if_exists(&backup);
    sync_parent(path);
    Ok(())
}

/// The original remains present if replacement fails. Both paths must share a filesystem.
pub fn replace_file(temporary: &Path, target: &Path, overwrite: bool) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        };
        let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        let flags = MOVEFILE_WRITE_THROUGH
            | if overwrite {
                MOVEFILE_REPLACE_EXISTING
            } else {
                0
            };
        // Buffers are NUL-terminated and remain alive throughout the call.
        if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), flags) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        if overwrite {
            fs::rename(temporary, target)
        } else {
            // Atomic create-if-absent without the exists/rename race.
            fs::hard_link(temporary, target)?;
            let _ = fs::remove_file(temporary);
            Ok(())
        }
    }
}

fn sibling_path(path: &Path, suffix: &str) -> PathBuf {
    let mut name: OsString = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn remove_if_exists(path: &Path) -> Result<(), AppError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn sync_parent(path: &Path) {
    if let Some(parent) = path.parent()
        && let Ok(directory) = OpenOptions::new().read(true).open(parent)
    {
        let _ = directory.sync_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovers_last_valid_file_after_interrupted_replace() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vault.bin");
        let backup = sibling_path(&path, ".bak");
        let temporary = sibling_path(&path, ".tmp");
        fs::write(&backup, b"previous").unwrap();
        fs::write(&temporary, b"partial replacement").unwrap();

        recover_interrupted_replace(&path).unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"previous");
        assert!(!backup.exists());
        assert!(!temporary.exists());
    }

    #[test]
    fn atomically_replaces_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vault.bin");
        fs::write(&path, b"previous").unwrap();

        write_atomic(&path, b"replacement").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        assert!(!sibling_path(&path, ".tmp").exists());
        assert!(!sibling_path(&path, ".bak").exists());
    }

    #[test]
    fn failed_replace_preserves_the_original() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("original");
        fs::write(&target, b"keep me").unwrap();
        assert!(replace_file(&directory.path().join("missing"), &target, true).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"keep me");
        let temporary = directory.path().join("new");
        fs::write(&temporary, b"new").unwrap();
        assert!(replace_file(&temporary, &target, false).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"keep me");
    }

    #[test]
    fn does_not_promote_an_interrupted_first_write() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("new");
        fs::write(sibling_path(&target, ".tmp"), b"partial").unwrap();
        recover_interrupted_replace(&target).unwrap();
        assert!(!target.exists());
    }
}
