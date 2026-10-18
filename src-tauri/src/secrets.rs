use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use chacha20poly1305::{
    Key, XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit},
};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::{
    AppError,
    atomic_file::write_atomic,
    models::{HostSecret, SecretStatus, SecretUpdate},
};

const SECRET_FILE_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct EncryptedRecord {
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SecretFile {
    version: u32,
    entries: HashMap<String, EncryptedRecord>,
}

pub struct SecretStore {
    path: Option<PathBuf>,
    key: Zeroizing<Vec<u8>>,
    entries: HashMap<String, EncryptedRecord>,
}

impl SecretStore {
    #[cfg(test)]
    pub(crate) fn fixture(payload: Option<Vec<u8>>) -> Self {
        Self {
            path: None,
            key: Zeroizing::new(vec![0x42; 32]),
            entries: payload
                .map(|bytes| {
                    serde_json::from_slice::<SecretFile>(&bytes)
                        .unwrap()
                        .entries
                })
                .unwrap_or_default(),
        }
    }
    pub fn with_key(key: Vec<u8>, payload: Option<Vec<u8>>) -> Result<Self, AppError> {
        if key.len() != 32 {
            return Err(AppError::Crypto("Clave de bóveda inválida".into()));
        }
        let entries = if let Some(bytes) = payload {
            let file: SecretFile = serde_json::from_slice(&bytes)?;
            if file.version != SECRET_FILE_VERSION {
                return Err(AppError::Crypto(
                    "Actualiza Nexora para abrir estos secretos".into(),
                ));
            }
            file.entries
        } else {
            HashMap::new()
        };
        let store = Self {
            path: None,
            key: Zeroizing::new(key),
            entries,
        };
        for id in store.entries.keys() {
            store.get(id)?;
        }
        Ok(store)
    }

    pub fn staged(&self) -> Self {
        Self {
            path: None,
            key: Zeroizing::new(self.key.to_vec()),
            entries: self.entries.clone(),
        }
    }

    pub fn encrypted_payload(&self) -> Result<Vec<u8>, AppError> {
        Ok(serde_json::to_vec(&SecretFile {
            version: SECRET_FILE_VERSION,
            entries: self.entries.clone(),
        })?)
    }

    pub fn status(&self, host_id: &str) -> Result<SecretStatus, AppError> {
        let secret = self.get(host_id)?.unwrap_or_default();
        Ok(SecretStatus::from(&secret))
    }

    pub fn get(&self, host_id: &str) -> Result<Option<HostSecret>, AppError> {
        let Some(record) = self.entries.get(host_id) else {
            return Ok(None);
        };
        decrypt_record(&self.key, host_id, record).map(Some)
    }

    pub fn update(
        &mut self,
        host_id: &str,
        update: SecretUpdate,
    ) -> Result<SecretStatus, AppError> {
        let mut secret = self.get(host_id)?.unwrap_or_default();
        if update.clear_password {
            secret.password = None;
        }
        if let Some(password) = update.password.filter(|value| !value.is_empty()) {
            secret.password = Some(password);
        }
        if update.clear_private_key {
            secret.private_key = None;
            secret.private_key_name = None;
            secret.key_passphrase = None;
        }
        if let Some(private_key) = update.private_key.filter(|value| !value.is_empty()) {
            validate_private_key(&private_key)?;
            secret.private_key = Some(private_key);
            secret.private_key_name = update.private_key_name;
        }
        if let Some(passphrase) = update.key_passphrase.filter(|value| !value.is_empty()) {
            secret.key_passphrase = Some(passphrase);
        }

        self.replace(host_id, Some(secret.clone()))?;
        Ok(SecretStatus::from(&secret))
    }

    pub fn duplicate(
        &mut self,
        source_host_id: &str,
        target_host_id: &str,
    ) -> Result<SecretStatus, AppError> {
        let Some(secret) = self.get(source_host_id)? else {
            return Ok(SecretStatus::from(&HostSecret::default()));
        };
        if secret.is_empty() {
            return Ok(SecretStatus::from(&secret));
        }
        let mut entries = self.entries.clone();
        entries.insert(
            target_host_id.to_string(),
            encrypt_record(&self.key, target_host_id, &secret)?,
        );
        self.commit_entries(entries)?;
        Ok(SecretStatus::from(&secret))
    }

    pub fn retain_hosts(&mut self, host_ids: &HashSet<&str>) -> Result<(), AppError> {
        let mut entries = self.entries.clone();
        entries.retain(|host_id, _| host_ids.contains(host_id.as_str()));
        if entries.len() != self.entries.len() {
            self.commit_entries(entries)?;
        }
        Ok(())
    }

    pub fn replace(
        &mut self,
        host_id: &str,
        secret: Option<HostSecret>,
    ) -> Result<SecretStatus, AppError> {
        let secret = secret.unwrap_or_default();
        if let Some(key) = &secret.private_key {
            validate_private_key(key)?;
        }
        let mut entries = self.entries.clone();
        if secret.is_empty() {
            entries.remove(host_id);
        } else {
            entries.insert(
                host_id.to_string(),
                encrypt_record(&self.key, host_id, &secret)?,
            );
        }
        self.commit_entries(entries)?;
        Ok(SecretStatus::from(&secret))
    }

    fn commit_entries(
        &mut self,
        entries: HashMap<String, EncryptedRecord>,
    ) -> Result<(), AppError> {
        let payload = serde_json::to_vec(&SecretFile {
            version: SECRET_FILE_VERSION,
            entries: entries.clone(),
        })?;
        if let Some(path) = &self.path {
            write_atomic(path, &payload)?;
        }
        self.entries = entries;
        Ok(())
    }
}

impl Clone for EncryptedRecord {
    fn clone(&self) -> Self {
        Self {
            nonce: self.nonce.clone(),
            ciphertext: self.ciphertext.clone(),
        }
    }
}

fn encrypt_record(
    key: &[u8],
    host_id: &str,
    secret: &HostSecret,
) -> Result<EncryptedRecord, AppError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let mut nonce_bytes = [0_u8; 24];
    OsRng.fill_bytes(&mut nonce_bytes);
    let plaintext = Zeroizing::new(serde_json::to_vec(secret)?);
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce_bytes),
            chacha20poly1305::aead::Payload {
                msg: &plaintext,
                aad: host_id.as_bytes(),
            },
        )
        .map_err(|_| AppError::Crypto("No se pudo cifrar el secreto".into()))?;
    Ok(EncryptedRecord {
        nonce: BASE64.encode(nonce_bytes),
        ciphertext: BASE64.encode(ciphertext),
    })
}

fn decrypt_record(
    key: &[u8],
    host_id: &str,
    record: &EncryptedRecord,
) -> Result<HostSecret, AppError> {
    let nonce = BASE64
        .decode(&record.nonce)
        .map_err(|_| AppError::Crypto("Nonce de secreto inválido".into()))?;
    let ciphertext = BASE64
        .decode(&record.ciphertext)
        .map_err(|_| AppError::Crypto("Secreto cifrado inválido".into()))?;
    if nonce.len() != 24 {
        return Err(AppError::Crypto("Nonce de secreto inválido".into()));
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                chacha20poly1305::aead::Payload {
                    msg: &ciphertext,
                    aad: host_id.as_bytes(),
                },
            )
            .map_err(|_| {
                AppError::Crypto("El secreto no superó la verificación de integridad".into())
            })?,
    );
    Ok(serde_json::from_slice(&plaintext)?)
}

pub fn validate_private_key(content: &str) -> Result<(), AppError> {
    const MARKERS: [&str; 5] = [
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "-----BEGIN RSA PRIVATE KEY-----",
        "-----BEGIN EC PRIVATE KEY-----",
        "-----BEGIN DSA PRIVATE KEY-----",
        "-----BEGIN PRIVATE KEY-----",
    ];
    if content.len() > 512 * 1024 {
        return Err(AppError::Validation(
            "La clave privada supera el límite de 512 KB".into(),
        ));
    }
    if content.contains("PuTTY-User-Key-File-") {
        return Err(AppError::Validation(
            "Las claves PPK todavía no son compatibles. Expórtala a formato OpenSSH desde PuTTYgen"
                .into(),
        ));
    }
    if !MARKERS.iter().any(|marker| content.contains(marker)) {
        return Err(AppError::Validation(
            "El contenido no parece una clave privada OpenSSH o PEM".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_record_round_trip_and_aad_binding() {
        let key = [42_u8; 32];
        let secret = HostSecret {
            password: Some("muy secreta".into()),
            private_key: None,
            private_key_name: None,
            key_passphrase: None,
        };
        let encrypted = encrypt_record(&key, "host-a", &secret).unwrap();
        let decrypted = decrypt_record(&key, "host-a", &encrypted).unwrap();
        assert_eq!(decrypted.password.as_deref(), Some("muy secreta"));
        assert!(decrypt_record(&key, "host-b", &encrypted).is_err());
    }

    #[test]
    fn private_key_validation_rejects_public_and_putty_keys() {
        assert!(validate_private_key("ssh-ed25519 AAAA public").is_err());
        assert!(validate_private_key("PuTTY-User-Key-File-3: ssh-rsa").is_err());
        assert!(
            validate_private_key(
                "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"
            )
            .is_ok()
        );
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn native_store_persists_encrypted_secrets_without_plaintext() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("test.secrets");
        let mut store = SecretStore::fixture(None);
        store.path = Some(path.clone());
        let status = store.update("host-test", SecretUpdate {
            password: Some("password-that-must-not-leak".into()),
            private_key: Some("-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-material\n-----END OPENSSH PRIVATE KEY-----".into()),
            private_key_name: Some("id_ed25519".into()),
            key_passphrase: Some("key-passphrase".into()),
            clear_password: false,
            clear_private_key: false,
        }).unwrap();
        assert!(status.has_password && status.has_private_key && status.has_key_passphrase);
        let duplicate_status = store.duplicate("host-test", "host-copy").unwrap();
        assert!(
            duplicate_status.has_password
                && duplicate_status.has_private_key
                && duplicate_status.has_key_passphrase
        );
        assert_eq!(
            store.get("host-copy").unwrap().unwrap().password.as_deref(),
            Some("password-that-must-not-leak")
        );
        drop(store);

        let reopened =
            SecretStore::with_key(vec![0x42; 32], Some(std::fs::read(&path).unwrap())).unwrap();
        assert_eq!(
            reopened
                .get("host-test")
                .unwrap()
                .unwrap()
                .password
                .as_deref(),
            Some("password-that-must-not-leak")
        );
        assert_eq!(
            reopened
                .get("host-copy")
                .unwrap()
                .unwrap()
                .password
                .as_deref(),
            Some("password-that-must-not-leak")
        );
        let on_disk = std::fs::read_to_string(path).unwrap();
        assert!(!on_disk.contains("password-that-must-not-leak"));
        assert!(!on_disk.contains("secret-material"));
        assert!(!on_disk.contains("key-passphrase"));
    }

    #[test]
    fn staged_secret_changes_do_not_modify_live_store_before_commit() {
        let mut live = SecretStore {
            path: None,
            key: Zeroizing::new(vec![42; 32]),
            entries: HashMap::new(),
        };
        live.replace(
            "host",
            Some(HostSecret {
                password: Some("original".into()),
                private_key: None,
                private_key_name: None,
                key_passphrase: None,
            }),
        )
        .unwrap();
        let mut staged = live.staged();
        staged
            .replace(
                "host",
                Some(HostSecret {
                    password: Some("replacement".into()),
                    private_key: None,
                    private_key_name: None,
                    key_passphrase: None,
                }),
            )
            .unwrap();
        assert_eq!(
            live.get("host").unwrap().unwrap().password.as_deref(),
            Some("original")
        );
        let payload = staged.encrypted_payload().unwrap();
        assert!(!String::from_utf8_lossy(&payload).contains("replacement"));
        let file: SecretFile = serde_json::from_slice(&payload).unwrap();
        assert_eq!(
            decrypt_record(&[42; 32], "host", &file.entries["host"])
                .unwrap()
                .password
                .as_deref(),
            Some("replacement")
        );
    }
}
