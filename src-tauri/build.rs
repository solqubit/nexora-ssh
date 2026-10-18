fn main() {
    configure_windows_resource_compiler();
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "load_snapshot",
            "list_tunnels",
            "start_tunnel",
            "stop_tunnel",
            "stop_all_tunnels",
            "save_snapshot",
            "save_host_profile",
            "create_temporary_host",
            "load_temporary_hosts",
            "promote_temporary_host",
            "forget_temporary_host",
            "save_identity_profile",
            "get_identity_status",
            "save_duplicated_host",
            "get_secret_status",
            "reveal_host_password",
            "start_ssh_session",
            "start_local_session",
            "write_ssh_session",
            "resize_ssh_session",
            "disconnect_ssh_session",
            "trust_ssh_host_key",
            "connect_sftp",
            "disconnect_sftp",
            "list_sftp_directory",
            "read_sftp_text_file",
            "save_sftp_text_file",
            "create_sftp_directory",
            "create_sftp_file",
            "rename_sftp_entry",
            "delete_sftp_entry",
            "chmod_sftp_entry",
            "upload_sftp_file",
            "overwrite_sftp_file",
            "download_sftp_file",
            "list_local_directory",
            "create_local_directory",
            "create_local_file",
            "rename_local_entry",
            "delete_local_entry",
            "transfer_local_to_sftp",
            "transfer_sftp_to_local",
            "transfer_sftp_to_sftp",
            "copy_local_entry",
            "cancel_file_transfer",
            "prepare_file_drag",
            "cleanup_prepared_drag",
            "start_file_drag",
            "vault_info",
            "choose_vault_folder",
            "unlock_vault",
            "close_vault",
            "open_external_url",
        ]),
    ))
    .expect("failed to build Nexora Tauri context");
}

#[cfg(target_os = "windows")]
fn configure_windows_resource_compiler() {
    if std::env::var_os("RC").is_some() {
        return;
    }
    let Some(program_files) = std::env::var_os("ProgramFiles(x86)") else {
        return;
    };
    let kits = std::path::PathBuf::from(program_files)
        .join("Windows Kits")
        .join("10")
        .join("bin");
    let Ok(versions) = std::fs::read_dir(kits) else {
        return;
    };
    let mut candidates = versions
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("x64").join("rc.exe"))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    candidates.sort();
    if let Some(compiler) = candidates.pop() {
        // El build script es monohilo en este punto y no vuelve a leer/modificar RC.
        unsafe {
            std::env::set_var("RC", compiler);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn configure_windows_resource_compiler() {}
