use std::path::Path;

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::RngCore;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};
use zeroize::Zeroizing;

use crate::error::{P2pError, P2pResult};

type HmacSha256 = Hmac<Sha256>;

pub const P2P_PROTOCOL_VERSION: u16 = 1;
pub const REKEY_AFTER_FRAMES: u64 = 4096;
const SEALED_PREFIX: &str = "encv1:";

/// Local Ed25519 signing identity + X25519 static keypair persisted in the device SQLite vault.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: String,
    pub display_name: String,
    pub ed25519_secret_b64: String,
    pub ed25519_public_b64: String,
    pub x25519_secret_b64: String,
    pub x25519_public_b64: String,
}

impl DeviceIdentity {
    /// Generates fresh OS-random Ed25519 + X25519 keypairs for the local device.
    pub fn generate(display_name: impl Into<String>) -> Self {
        let mut ed_bytes = [0u8; 32];
        let mut x_bytes = [0u8; 32];
        OsRng.fill_bytes(&mut ed_bytes);
        OsRng.fill_bytes(&mut x_bytes);

        let signing = SigningKey::from_bytes(&ed_bytes);
        let verifying = signing.verifying_key();
        let x_secret = X25519StaticSecret::from(x_bytes);
        let x_public = X25519PublicKey::from(&x_secret);

        let ed_pub_bytes = verifying.to_bytes();
        let device_digest = Sha256::digest(ed_pub_bytes);
        let device_id = hex::encode(&device_digest[..16]);

        Self {
            device_id,
            display_name: display_name.into(),
            ed25519_secret_b64: STANDARD.encode(ed_bytes),
            ed25519_public_b64: STANDARD.encode(ed_pub_bytes),
            x25519_secret_b64: STANDARD.encode(x_secret.to_bytes()),
            x25519_public_b64: STANDARD.encode(x_public.to_bytes()),
        }
    }

    pub fn signing_key(&self) -> P2pResult<SigningKey> {
        let raw = decode_32_b64(&self.ed25519_secret_b64, "ed25519_secret")?;
        Ok(SigningKey::from_bytes(&raw))
    }

    pub fn verifying_key(&self) -> P2pResult<VerifyingKey> {
        parse_ed25519_verifying(&self.ed25519_public_b64)
    }
}

/// DPAPI-backed local vault key protecting SQLite identity secrets and room keys at rest.
#[derive(Clone)]
pub struct VaultSecretBox {
    master_key: Zeroizing<[u8; 32]>,
    pub dpapi_protected: bool,
}

impl VaultSecretBox {
    /// Loads or initializes the per-vault 32-byte key in `<data_dir>/vault.dpapi` (or `vault.key` non-Windows).
    pub fn load_or_create(data_dir: &Path) -> P2pResult<Self> {
        std::fs::create_dir_all(data_dir)?;
        let dpapi_path = data_dir.join("vault.dpapi");
        let fallback_path = data_dir.join("vault.key");

        #[cfg(target_os = "windows")]
        {
            if dpapi_path.exists() {
                let protected = std::fs::read(&dpapi_path)?;
                let raw = dpapi_unprotect(&protected)?;
                if raw.len() != 32 {
                    return Err(P2pError::Crypto("Corrupted vault.dpapi key length".into()));
                }
                let mut key = Zeroizing::new([0u8; 32]);
                key.copy_from_slice(&raw);
                return Ok(Self {
                    master_key: key,
                    dpapi_protected: true,
                });
            }
            let mut key = Zeroizing::new([0u8; 32]);
            OsRng.fill_bytes(key.as_mut());
            if let Ok(protected) = dpapi_protect(key.as_ref()) {
                std::fs::write(&dpapi_path, protected)?;
                return Ok(Self {
                    master_key: key,
                    dpapi_protected: true,
                });
            }
            // Fallback only if DPAPI user store is unavailable (e.g., restricted service context)
            std::fs::write(&fallback_path, STANDARD.encode(key.as_ref()))?;
            Ok(Self {
                master_key: key,
                dpapi_protected: false,
            })
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = dpapi_path;
            if fallback_path.exists() {
                let raw_b64 = std::fs::read_to_string(&fallback_path)?;
                let raw = decode_32_b64(&raw_b64, "vault.key")?;
                return Ok(Self {
                    master_key: Zeroizing::new(raw),
                    dpapi_protected: false,
                });
            }
            let mut key = Zeroizing::new([0u8; 32]);
            OsRng.fill_bytes(key.as_mut());
            std::fs::write(&fallback_path, STANDARD.encode(key.as_ref()))?;
            Ok(Self {
                master_key: key,
                dpapi_protected: false,
            })
        }
    }

    pub fn seal_field(&self, label: &str, plaintext: &str) -> P2pResult<String> {
        if plaintext.starts_with(SEALED_PREFIX) {
            return Ok(plaintext.to_string());
        }
        let cipher = XChaCha20Poly1305::new(self.master_key.as_ref().into());
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let aad = format!("cloak-vault-field-v1:{label}");
        let ct = cipher
            .encrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|e| P2pError::Crypto(format!("vault seal failed: {e}")))?;

        let mut combined = Vec::with_capacity(24 + ct.len());
        combined.extend_from_slice(&nonce);
        combined.extend_from_slice(&ct);
        Ok(format!("{SEALED_PREFIX}{}", STANDARD.encode(combined)))
    }

    pub fn open_field(&self, label: &str, value: &str) -> P2pResult<String> {
        let Some(rest) = value.strip_prefix(SEALED_PREFIX) else {
            // Backward compatibility with legacy plaintext column values from initial builds
            return Ok(value.to_string());
        };
        let raw = STANDARD
            .decode(rest.trim())
            .map_err(|e| P2pError::Crypto(format!("invalid sealed field b64: {e}")))?;
        if raw.len() <= 24 {
            return Err(P2pError::Crypto("sealed vault field truncated".into()));
        }
        let (nonce, ct) = raw.split_at(24);
        let mut nonce_arr = [0u8; 24];
        nonce_arr.copy_from_slice(nonce);
        let cipher = XChaCha20Poly1305::new(self.master_key.as_ref().into());
        let aad = format!("cloak-vault-field-v1:{label}");
        let pt = cipher
            .decrypt(
                &XNonce::from(nonce_arr),
                Payload {
                    msg: ct,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| {
                P2pError::Crypto(format!("vault unseal authentication failed for {label}"))
            })?;
        String::from_utf8(pt)
            .map_err(|_| P2pError::Crypto("unsealed vault field is not valid UTF-8".into()))
    }

    /// Seals raw binary attachment chunks under the DPAPI-protected vault master key.
    pub fn seal_bytes(&self, label: &str, plaintext: &[u8]) -> P2pResult<Vec<u8>> {
        const MAGIC: &[u8; 8] = b"CLKBLOB1";
        if plaintext.starts_with(MAGIC) {
            return Ok(plaintext.to_vec());
        }
        let cipher = XChaCha20Poly1305::new(self.master_key.as_ref().into());
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let aad = format!("cloak-vault-blob-v1:{label}");
        let ct = cipher
            .encrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: plaintext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|e| P2pError::Crypto(format!("vault blob seal failed: {e}")))?;
        let mut out = Vec::with_capacity(MAGIC.len() + 24 + ct.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    /// Unseals a binary attachment chunk (supports pre-hardening unsealed chunks read-only).
    pub fn open_bytes(&self, label: &str, raw: &[u8]) -> P2pResult<Vec<u8>> {
        const MAGIC: &[u8; 8] = b"CLKBLOB1";
        let Some(rest) = raw.strip_prefix(MAGIC) else {
            return Ok(raw.to_vec());
        };
        if rest.len() <= 24 {
            return Err(P2pError::Crypto("sealed vault blob truncated".into()));
        }
        let (nonce, ct) = rest.split_at(24);
        let mut nonce_arr = [0u8; 24];
        nonce_arr.copy_from_slice(nonce);
        let cipher = XChaCha20Poly1305::new(self.master_key.as_ref().into());
        let aad = format!("cloak-vault-blob-v1:{label}");
        cipher
            .decrypt(
                &XNonce::from(nonce_arr),
                Payload {
                    msg: ct,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| P2pError::Crypto(format!("vault blob unseal failed for {label}")))
    }
}

#[cfg(target_os = "windows")]
fn dpapi_protect(plain: &[u8]) -> P2pResult<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };

    let entropy_bytes = b"cloak-local-vault-dpapi-v1";
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy_bytes.len() as u32,
        pbData: entropy_bytes.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    let ok = unsafe {
        CryptProtectData(
            &in_blob,
            std::ptr::null(),
            &entropy,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pbData.is_null() {
        return Err(P2pError::Crypto(
            "Windows DPAPI CryptProtectData failed".into(),
        ));
    }
    let slice = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) };
    let out = slice.to_vec();
    unsafe {
        LocalFree(out_blob.pbData as _);
    }
    Ok(out)
}

#[cfg(target_os = "windows")]
fn dpapi_unprotect(cipher: &[u8]) -> P2pResult<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };

    let entropy_bytes = b"cloak-local-vault-dpapi-v1";
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: cipher.len() as u32,
        pbData: cipher.as_ptr() as *mut u8,
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy_bytes.len() as u32,
        pbData: entropy_bytes.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    let ok = unsafe {
        CryptUnprotectData(
            &in_blob,
            std::ptr::null_mut(),
            &entropy,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pbData.is_null() {
        return Err(P2pError::Crypto(
            "Windows DPAPI CryptUnprotectData failed".into(),
        ));
    }
    let slice = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) };
    let out = slice.to_vec();
    unsafe {
        LocalFree(out_blob.pbData as _);
    }
    Ok(out)
}

/// Hashes a Ghost Mode Privacy Shield unlock PIN using Argon2id.
pub fn hash_pin(pin: &str) -> P2pResult<String> {
    if pin.len() < 4 || pin.len() > 64 {
        return Err(P2pError::Validation(
            "Ghost Mode PIN must be 4-64 characters".into(),
        ));
    }
    let salt = SaltString::generate(&mut OsRng);
    let params = Params::new(19 * 1024, 2, 1, None)
        .map_err(|e| P2pError::Crypto(format!("Argon2 params error: {e}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let hash = argon2
        .hash_password(pin.as_bytes(), &salt)
        .map_err(|e| P2pError::Crypto(format!("PIN hash failed: {e}")))?;
    Ok(hash.to_string())
}

pub fn verify_pin(pin: &str, phc_hash: &str) -> P2pResult<bool> {
    let parsed = PasswordHash::new(phc_hash)
        .map_err(|e| P2pError::Crypto(format!("Stored PIN hash invalid: {e}")))?;
    Ok(Argon2::default()
        .verify_password(pin.as_bytes(), &parsed)
        .is_ok())
}

pub fn sanitize_attachment_filename(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("file.bin").trim();
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_control()
                || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let collapsed = cleaned.trim_matches(['.', ' ']);
    let candidate = if collapsed.is_empty() {
        "file.bin".to_string()
    } else {
        collapsed.chars().take(180).collect()
    };
    let upper = candidate.to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "LPT1" | "LPT2"
    ) {
        format!("_{candidate}")
    } else {
        candidate
    }
}

pub fn validate_uuid_component(id: &str, label: &str) -> P2pResult<()> {
    uuid::Uuid::parse_str(id)
        .map_err(|_| P2pError::Validation(format!("Invalid {label} identifier")))?;
    Ok(())
}

pub fn decode_32_b64(b64: &str, label: &str) -> P2pResult<[u8; 32]> {
    let bytes = STANDARD
        .decode(b64.trim())
        .map_err(|e| P2pError::Crypto(format!("invalid base64 for {label}: {e}")))?;
    if bytes.len() != 32 {
        return Err(P2pError::Crypto(format!(
            "{label} must be 32 bytes, got {}",
            bytes.len()
        )));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

pub fn parse_ed25519_verifying(b64: &str) -> P2pResult<VerifyingKey> {
    let raw = decode_32_b64(b64, "ed25519_public")?;
    VerifyingKey::from_bytes(&raw)
        .map_err(|e| P2pError::Crypto(format!("invalid Ed25519 public key: {e}")))
}

pub fn parse_x25519_public(b64: &str) -> P2pResult<X25519PublicKey> {
    let raw = decode_32_b64(b64, "x25519_public")?;
    Ok(X25519PublicKey::from(raw))
}

/// Generates a fresh 32-byte symmetric room epoch key encoded in base64.
pub fn generate_room_key_b64() -> String {
    let mut key = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(key.as_mut());
    STANDARD.encode(key.as_ref())
}

/// Computes lowercase hex SHA-256 of arbitrary byte slices.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Encrypts message plaintext using room `XChaCha20-Poly1305` AEAD with room/channel/message AAD,
/// then signs the ciphertext commitment with the sender's Ed25519 key.
pub fn encrypt_and_sign_message(
    room_id: &str,
    channel_id: &str,
    message_id: &str,
    epoch: i64,
    room_key_b64: &str,
    identity: &DeviceIdentity,
    plaintext: &str,
) -> P2pResult<(String, String)> {
    let room_key = Zeroizing::new(decode_32_b64(room_key_b64, "room_key")?);
    let cipher = XChaCha20Poly1305::new((&*room_key).into());

    let mut nonce_bytes = [0u8; 24];
    OsRng.fill_bytes(&mut nonce_bytes);
    let aad = format!("cloak-p2p-msg-v1:{room_id}:{channel_id}:{message_id}:{epoch}");

    let ct = cipher
        .encrypt(
            &XNonce::from(nonce_bytes),
            Payload {
                msg: plaintext.as_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|e| P2pError::Crypto(format!("AEAD message encrypt failed: {e}")))?;

    let mut combined = Vec::with_capacity(24 + ct.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ct);
    let ciphertext_b64 = STANDARD.encode(combined);

    let sig_input = format!("{aad}:{ciphertext_b64}");
    let signing_key = identity.signing_key()?;
    let signature = signing_key.sign(sig_input.as_bytes());
    let signature_b64 = STANDARD.encode(signature.to_bytes());
    Ok((ciphertext_b64, signature_b64))
}

/// Decrypts and verifies Ed25519 authenticity of a stored message.
pub fn decrypt_and_verify_message(
    msg: &crate::model::StoredMessage,
    room_key_b64: &str,
    sender_ed25519_pub_b64: Option<&str>,
) -> P2pResult<(String, bool)> {
    let raw = STANDARD
        .decode(msg.ciphertext_b64.trim())
        .map_err(|e| P2pError::Crypto(format!("invalid message ciphertext b64: {e}")))?;
    if raw.len() <= 24 {
        return Err(P2pError::Crypto("ciphertext too short".to_string()));
    }
    let (nonce_slice, ct) = raw.split_at(24);
    let mut nonce_bytes = [0u8; 24];
    nonce_bytes.copy_from_slice(nonce_slice);
    let aad = format!(
        "cloak-p2p-msg-v1:{}:{}:{}:{}",
        msg.room_id, msg.channel_id, msg.id, msg.encryption_epoch
    );

    let room_key = Zeroizing::new(decode_32_b64(room_key_b64, "room_key")?);
    let cipher = XChaCha20Poly1305::new((&*room_key).into());
    let plain = cipher
        .decrypt(
            &XNonce::from(nonce_bytes),
            Payload {
                msg: ct,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| P2pError::Crypto("AEAD authentication failed for message".to_string()))?;

    let text = String::from_utf8(plain)
        .map_err(|_| P2pError::Crypto("decrypted payload is not valid UTF-8".to_string()))?;

    let verified = if let Some(pub_b64) = sender_ed25519_pub_b64 {
        match (
            parse_ed25519_verifying(pub_b64),
            STANDARD.decode(msg.signature_b64.trim()),
        ) {
            (Ok(vk), Ok(sig_bytes)) if sig_bytes.len() == 64 => {
                let mut sig_arr = [0u8; 64];
                sig_arr.copy_from_slice(&sig_bytes);
                let sig = Signature::from_bytes(&sig_arr);
                let sig_input = format!("{aad}:{}", msg.ciphertext_b64);
                vk.verify(sig_input.as_bytes(), &sig).is_ok()
            }
            _ => false,
        }
    } else {
        false
    };

    Ok((text, verified))
}

/// Handshake initial hello signed by each peer to mutually authenticate identity + ephemeral X25519 keys.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerHandshake {
    #[serde(default = "default_proto_ver")]
    pub proto_ver: u16,
    pub device_id: String,
    pub ed25519_public_b64: String,
    pub ephemeral_x25519_b64: String,
    pub nonce_b64u: String,
    pub signature_b64: String,
}

fn default_proto_ver() -> u16 {
    P2P_PROTOCOL_VERSION
}

impl PeerHandshake {
    pub fn build(
        identity: &DeviceIdentity,
        ephemeral_pub: &X25519PublicKey,
        nonce: &[u8; 32],
    ) -> P2pResult<Self> {
        let eph_b64 = STANDARD.encode(ephemeral_pub.as_bytes());
        let nonce_b64u = URL_SAFE_NO_PAD.encode(nonce);
        let transcript = format!(
            "cloak-p2p-hs-v1:{}:{}:{}:{}:{}",
            P2P_PROTOCOL_VERSION,
            identity.device_id,
            identity.ed25519_public_b64,
            eph_b64,
            nonce_b64u
        );
        let sig = identity.signing_key()?.sign(transcript.as_bytes());
        Ok(Self {
            proto_ver: P2P_PROTOCOL_VERSION,
            device_id: identity.device_id.clone(),
            ed25519_public_b64: identity.ed25519_public_b64.clone(),
            ephemeral_x25519_b64: eph_b64,
            nonce_b64u,
            signature_b64: STANDARD.encode(sig.to_bytes()),
        })
    }

    pub fn verify(&self) -> P2pResult<(VerifyingKey, X25519PublicKey)> {
        if self.proto_ver != P2P_PROTOCOL_VERSION {
            return Err(P2pError::PeerRejected(format!(
                "Unsupported peer protocol version {} (expected {})",
                self.proto_ver, P2P_PROTOCOL_VERSION
            )));
        }
        let vk = parse_ed25519_verifying(&self.ed25519_public_b64)?;
        let expected_id = hex::encode(&Sha256::digest(vk.to_bytes())[..16]);
        if self
            .device_id
            .as_bytes()
            .ct_eq(expected_id.as_bytes())
            .unwrap_u8()
            != 1
        {
            return Err(P2pError::PeerRejected(
                "Peer device_id does not match Ed25519 public key fingerprint".to_string(),
            ));
        }

        let eph_pub = parse_x25519_public(&self.ephemeral_x25519_b64)?;
        let sig_bytes = STANDARD.decode(self.signature_b64.trim()).map_err(|_| {
            P2pError::PeerRejected("Invalid handshake signature base64".to_string())
        })?;
        if sig_bytes.len() != 64 {
            return Err(P2pError::PeerRejected(
                "Invalid handshake signature length".to_string(),
            ));
        }
        let mut sig_arr = [0u8; 64];
        sig_arr.copy_from_slice(&sig_bytes);
        let sig = Signature::from_bytes(&sig_arr);

        let transcript = format!(
            "cloak-p2p-hs-v1:{}:{}:{}:{}:{}",
            self.proto_ver,
            self.device_id,
            self.ed25519_public_b64,
            self.ephemeral_x25519_b64,
            self.nonce_b64u
        );
        vk.verify(transcript.as_bytes(), &sig)
            .map_err(|_| P2pError::PeerRejected("Handshake signature invalid".to_string()))?;
        Ok((vk, eph_pub))
    }
}

/// Phase-2 mutual handshake transcript confirmation frame binding initiator & responder hellos.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeAck {
    pub mac_b64u: String,
}

/// Bidirectional AEAD stream cipher state derived from ephemeral X25519 DH + HKDF-SHA256,
/// supporting transcript confirmation and forward-secrecy session rekeying.
pub struct TransportSessionCrypto {
    tx_cipher: XChaCha20Poly1305,
    rx_cipher: XChaCha20Poly1305,
    tx_chain: Zeroizing<[u8; 32]>,
    rx_chain: Zeroizing<[u8; 32]>,
    tx_salt: [u8; 16],
    rx_salt: [u8; 16],
    tx_counter: u64,
    rx_counter: u64,
    auth_key: Zeroizing<[u8; 32]>,
    key_epoch: u64,
}

impl TransportSessionCrypto {
    pub fn derive(
        local_ephemeral_secret: X25519StaticSecret,
        remote_ephemeral_pub: &X25519PublicKey,
        local_nonce: &[u8; 32],
        remote_nonce: &[u8; 32],
        is_initiator: bool,
    ) -> P2pResult<Self> {
        let shared = local_ephemeral_secret.diffie_hellman(remote_ephemeral_pub);
        // Reject all-zero small-subgroup / low-order X25519 points (RFC 7748 section 6.1)
        if shared.as_bytes().ct_eq(&[0u8; 32]).unwrap_u8() == 1 {
            return Err(P2pError::PeerRejected(
                "Rejected weak/all-zero X25519 shared secret".to_string(),
            ));
        }

        let mut salt = [0u8; 64];
        if is_initiator {
            salt[..32].copy_from_slice(local_nonce);
            salt[32..].copy_from_slice(remote_nonce);
        } else {
            salt[..32].copy_from_slice(remote_nonce);
            salt[32..].copy_from_slice(local_nonce);
        }
        Self::from_ikm_and_salt(shared.as_bytes(), &salt, is_initiator, 1)
    }

    fn from_ikm_and_salt(
        ikm: &[u8],
        salt: &[u8],
        is_initiator: bool,
        key_epoch: u64,
    ) -> P2pResult<Self> {
        let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
        let mut okm = Zeroizing::new([0u8; 192]);
        hk.expand(b"cloak-p2p-session-v2", okm.as_mut())
            .map_err(|_| P2pError::Crypto("HKDF expand failed".to_string()))?;

        let (tx_key, rx_key, tx_s, rx_s, tx_c, rx_c) = if is_initiator {
            (
                &okm[0..32],
                &okm[32..64],
                &okm[64..80],
                &okm[80..96],
                &okm[96..128],
                &okm[128..160],
            )
        } else {
            (
                &okm[32..64],
                &okm[0..32],
                &okm[80..96],
                &okm[64..80],
                &okm[128..160],
                &okm[96..128],
            )
        };

        let mut tx_salt = [0u8; 16];
        let mut rx_salt = [0u8; 16];
        tx_salt.copy_from_slice(tx_s);
        rx_salt.copy_from_slice(rx_s);

        let mut tx_chain = Zeroizing::new([0u8; 32]);
        let mut rx_chain = Zeroizing::new([0u8; 32]);
        tx_chain.copy_from_slice(tx_c);
        rx_chain.copy_from_slice(rx_c);

        let mut auth_key = Zeroizing::new([0u8; 32]);
        auth_key.copy_from_slice(&okm[160..192]);

        Ok(Self {
            tx_cipher: XChaCha20Poly1305::new(tx_key.into()),
            rx_cipher: XChaCha20Poly1305::new(rx_key.into()),
            tx_chain,
            rx_chain,
            tx_salt,
            rx_salt,
            tx_counter: 0,
            rx_counter: 0,
            auth_key,
            key_epoch,
        })
    }

    pub fn compute_handshake_ack(
        &self,
        initiator_hello_bytes: &[u8],
        responder_hello_bytes: &[u8],
        role_label: &str,
    ) -> P2pResult<HandshakeAck> {
        let mut mac = <HmacSha256 as Mac>::new_from_slice(self.auth_key.as_ref())
            .map_err(|_| P2pError::Crypto("HMAC init failed".into()))?;
        mac.update(b"cloak-p2p-ack-v1:");
        mac.update(role_label.as_bytes());
        mac.update(&Sha256::digest(initiator_hello_bytes));
        mac.update(&Sha256::digest(responder_hello_bytes));
        let tag = mac.finalize().into_bytes();
        Ok(HandshakeAck {
            mac_b64u: URL_SAFE_NO_PAD.encode(tag),
        })
    }

    pub fn verify_handshake_ack(
        &self,
        ack: &HandshakeAck,
        initiator_hello_bytes: &[u8],
        responder_hello_bytes: &[u8],
        expected_role_label: &str,
    ) -> P2pResult<()> {
        let expected = self.compute_handshake_ack(
            initiator_hello_bytes,
            responder_hello_bytes,
            expected_role_label,
        )?;
        if ack
            .mac_b64u
            .as_bytes()
            .ct_eq(expected.mac_b64u.as_bytes())
            .unwrap_u8()
            != 1
        {
            return Err(P2pError::PeerRejected(
                "Handshake transcript MAC verification failed (possible MITM or downgrade)".into(),
            ));
        }
        Ok(())
    }

    fn derive_direction_step(
        chain: &[u8; 32],
        next_epoch: u64,
    ) -> P2pResult<(XChaCha20Poly1305, [u8; 16], Zeroizing<[u8; 32]>)> {
        let salt = format!("cloak-dir-rekey:{next_epoch}");
        let hk = Hkdf::<Sha256>::new(Some(salt.as_bytes()), chain);
        let mut okm = Zeroizing::new([0u8; 80]);
        hk.expand(b"cloak-p2p-dir-v2", okm.as_mut())
            .map_err(|_| P2pError::Crypto("HKDF dir ratchet failed".into()))?;
        let mut next_salt = [0u8; 16];
        next_salt.copy_from_slice(&okm[32..48]);
        let mut next_chain = Zeroizing::new([0u8; 32]);
        next_chain.copy_from_slice(&okm[48..80]);
        Ok((
            XChaCha20Poly1305::new((&okm[0..32]).into()),
            next_salt,
            next_chain,
        ))
    }

    /// Advances ONLY the TX key & counter after queueing a FIFO `WireFrame::Rekey` frame.
    pub fn advance_tx_key(&mut self) -> P2pResult<u64> {
        let next_epoch = self.key_epoch + 1;
        let (cipher, salt, chain) = Self::derive_direction_step(&self.tx_chain, next_epoch)?;
        self.tx_cipher = cipher;
        self.tx_salt = salt;
        self.tx_chain = chain;
        self.tx_counter = 0;
        self.key_epoch = next_epoch;
        Ok(next_epoch)
    }

    /// Advances ONLY the RX key & counter upon receiving a FIFO `WireFrame::Rekey` frame.
    pub fn advance_rx_key(&mut self, expected_epoch: u64) -> P2pResult<()> {
        let (cipher, salt, chain) = Self::derive_direction_step(&self.rx_chain, expected_epoch)?;
        self.rx_cipher = cipher;
        self.rx_salt = salt;
        self.rx_chain = chain;
        self.rx_counter = 0;
        Ok(())
    }

    pub fn key_epoch(&self) -> u64 {
        self.key_epoch
    }

    pub fn tx_counter(&self) -> u64 {
        self.tx_counter
    }

    pub fn encrypt_frame(&mut self, plaintext: &[u8]) -> P2pResult<Vec<u8>> {
        let mut nonce = [0u8; 24];
        nonce[..16].copy_from_slice(&self.tx_salt);
        nonce[16..24].copy_from_slice(&self.tx_counter.to_be_bytes());
        self.tx_counter = self
            .tx_counter
            .checked_add(1)
            .ok_or_else(|| P2pError::Crypto("TX nonce counter exhausted".to_string()))?;

        self.tx_cipher
            .encrypt(&XNonce::from(nonce), plaintext)
            .map_err(|e| P2pError::Crypto(format!("stream encrypt failed: {e}")))
    }

    pub fn decrypt_frame(&mut self, ciphertext: &[u8]) -> P2pResult<Vec<u8>> {
        let mut nonce = [0u8; 24];
        nonce[..16].copy_from_slice(&self.rx_salt);
        nonce[16..24].copy_from_slice(&self.rx_counter.to_be_bytes());
        self.rx_counter = self
            .rx_counter
            .checked_add(1)
            .ok_or_else(|| P2pError::Crypto("RX nonce counter exhausted".to_string()))?;

        self.rx_cipher
            .decrypt(&XNonce::from(nonce), ciphertext)
            .map_err(|_| P2pError::Crypto("stream AEAD authentication failed".to_string()))
    }
}
