use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use base64::{engine::general_purpose::STANDARD as B64_STD, Engine as _};
use chrono::{Duration, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::CloakError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionClaims {
    pub sub: String, // device_id UUID
    pub jti: String, // credential UUID for revocation
    pub iat: usize,
    pub exp: usize,
}

pub fn decode_base64_exact(b64: &str, expected_len: usize, label: &str) -> Result<Vec<u8>, CloakError> {
    let bytes = B64_STD
        .decode(b64)
        .map_err(|_| CloakError::BadRequest(format!("invalid base64 for {label}")))?;
    if bytes.len() != expected_len {
        return Err(CloakError::BadRequest(format!(
            "{label} must be {expected_len} bytes"
        )));
    }
    Ok(bytes)
}

pub fn decode_base64_any(b64: &str, max_len: usize, label: &str) -> Result<Vec<u8>, CloakError> {
    let bytes = B64_STD
        .decode(b64)
        .map_err(|_| CloakError::BadRequest(format!("invalid base64 for {label}")))?;
    if bytes.is_empty() || bytes.len() > max_len {
        return Err(CloakError::BadRequest(format!(
            "{label} length must be between 1 and {max_len} bytes"
        )));
    }
    Ok(bytes)
}

pub fn verify_ed25519_signature(
    public_key_bytes: &[u8],
    message: &[u8],
    signature_bytes: &[u8],
) -> Result<(), CloakError> {
    let pk_arr: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| CloakError::BadRequest("invalid Ed25519 public key length".into()))?;
    let sig_arr: [u8; 64] = signature_bytes
        .try_into()
        .map_err(|_| CloakError::Unauthorized("invalid Ed25519 signature length".into()))?;

    let verifying_key = VerifyingKey::from_bytes(&pk_arr)
        .map_err(|_| CloakError::BadRequest("malformed Ed25519 public key".into()))?;
    let signature = Signature::from_bytes(&sig_arr);

    verifying_key
        .verify(message, &signature)
        .map_err(|_| CloakError::Unauthorized("signature verification failed".into()))
}

pub fn issue_session_jwt(
    device_id: Uuid,
    secret: &str,
    ttl_hours: i64,
) -> Result<(String, Uuid, chrono::DateTime<Utc>), CloakError> {
    let now = Utc::now();
    let expires_at = now + Duration::hours(ttl_hours);
    let jti = Uuid::new_v4();
    let claims = SessionClaims {
        sub: device_id.to_string(),
        jti: jti.to_string(),
        iat: now.timestamp() as usize,
        exp: expires_at.timestamp() as usize,
    };

    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| CloakError::Internal(format!("jwt encode failed: {e}")))?;

    Ok((token, jti, expires_at))
}

pub fn verify_session_jwt(token: &str, secret: &str) -> Result<(Uuid, Uuid, usize), CloakError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;

    let token_data = decode::<SessionClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|_| CloakError::Unauthorized("invalid or expired session token".into()))?;

    let device_id = Uuid::parse_str(&token_data.claims.sub)
        .map_err(|_| CloakError::Unauthorized("malformed token subject".into()))?;
    let jti = Uuid::parse_str(&token_data.claims.jti)
        .map_err(|_| CloakError::Unauthorized("malformed token id".into()))?;

    Ok((device_id, jti, token_data.claims.exp))
}

pub fn sha256_bytes(input: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(input);
    hasher.finalize().to_vec()
}

pub fn hash_invite_password(password: &str) -> Result<String, CloakError> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    argon2
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| CloakError::Internal(format!("password hashing failed: {e}")))
}

pub fn verify_invite_password(password: &str, encoded_hash: &str) -> Result<bool, CloakError> {
    let parsed = PasswordHash::new(encoded_hash)
        .map_err(|_| CloakError::Internal("corrupted invite password verifier".into()))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

