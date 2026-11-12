use bytes::Bytes;
use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::Client;
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use tokio::fs;

use crate::config::{AppConfig, ObjectStoreBackend};
use crate::error::CloakError;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub enum ObjectStore {
    S3(S3ObjectStore),
    Local(LocalFsObjectStore),
}

#[derive(Clone)]
pub struct S3ObjectStore {
    client: Client,
    endpoint: String,
    region: String,
    bucket: String,
    access_key: String,
    secret_key: String,
    force_path_style: bool,
}

#[derive(Clone)]
pub struct LocalFsObjectStore {
    root: PathBuf,
}

impl ObjectStore {
    pub async fn from_config(cfg: &AppConfig) -> Result<Self, CloakError> {
        match cfg.object_store_backend {
            ObjectStoreBackend::S3 => Ok(Self::S3(S3ObjectStore {
                client: Client::builder()
                    .timeout(std::time::Duration::from_secs(30))
                    .build()
                    .map_err(|e| CloakError::Internal(format!("http client init failed: {e}")))?,
                endpoint: cfg.s3_endpoint.trim_end_matches('/').to_string(),
                region: cfg.s3_region.clone(),
                bucket: cfg.s3_bucket.clone(),
                access_key: cfg.s3_access_key_id.clone(),
                secret_key: cfg.s3_secret_access_key.clone(),
                force_path_style: cfg.s3_force_path_style,
            })),
            ObjectStoreBackend::Local => {
                let root = PathBuf::from(&cfg.local_object_store_dir);
                fs::create_dir_all(&root)
                    .await
                    .map_err(|e| CloakError::Internal(format!("local object dir init failed: {e}")))?;
                Ok(Self::Local(LocalFsObjectStore { root }))
            }
        }
    }

    pub async fn put_object(&self, key: &str, data: Bytes) -> Result<(), CloakError> {
        validate_object_key(key)?;
        match self {
            Self::S3(s3) => s3.put_object(key, data).await,
            Self::Local(local) => local.put_object(key, data).await,
        }
    }

    pub async fn get_object(&self, key: &str) -> Result<Bytes, CloakError> {
        validate_object_key(key)?;
        match self {
            Self::S3(s3) => s3.get_object(key).await,
            Self::Local(local) => local.get_object(key).await,
        }
    }

    pub async fn delete_object(&self, key: &str) -> Result<(), CloakError> {
        validate_object_key(key)?;
        match self {
            Self::S3(s3) => s3.delete_object(key).await,
            Self::Local(local) => local.delete_object(key).await,
        }
    }
}

pub fn validate_object_key(key: &str) -> Result<(), CloakError> {
    if key.is_empty() || key.starts_with('/') || key.contains('\\') || key.contains('\0') {
        return Err(CloakError::BadRequest("invalid object key".into()));
    }
    let path = Path::new(key);
    for comp in path.components() {
        match comp {
            Component::Normal(_) => {}
            _ => return Err(CloakError::BadRequest("unsafe object key path".into())),
        }
    }
    Ok(())
}

impl LocalFsObjectStore {
    fn resolve(&self, key: &str) -> Result<PathBuf, CloakError> {
        validate_object_key(key)?;
        Ok(self.root.join(key))
    }

    async fn put_object(&self, key: &str, data: Bytes) -> Result<(), CloakError> {
        let target = self.resolve(key)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| CloakError::Internal(format!("mkdir failed: {e}")))?;
        }
        fs::write(&target, &data)
            .await
            .map_err(|e| CloakError::Internal(format!("write object failed: {e}")))?;
        Ok(())
    }

    async fn get_object(&self, key: &str) -> Result<Bytes, CloakError> {
        let target = self.resolve(key)?;
        let bytes = fs::read(&target)
            .await
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => CloakError::NotFound("encrypted object not found".into()),
                _ => CloakError::Internal(format!("read object failed: {e}")),
            })?;
        Ok(Bytes::from(bytes))
    }

    async fn delete_object(&self, key: &str) -> Result<(), CloakError> {
        let target = self.resolve(key)?;
        match fs::remove_file(&target).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(CloakError::Internal(format!("delete object failed: {e}"))),
        }
    }
}

impl S3ObjectStore {
    fn build_url_and_host(&self, key: &str) -> Result<(String, String, String), CloakError> {
        let encoded_key = key
            .split('/')
            .map(|seg| urlencoding::encode(seg).into_owned())
            .collect::<Vec<_>>()
            .join("/");
        let without_scheme = self
            .endpoint
            .strip_prefix("https://")
            .or_else(|| self.endpoint.strip_prefix("http://"))
            .ok_or_else(|| CloakError::Internal("S3_ENDPOINT must use http:// or https://".into()))?;
        let scheme = if self.endpoint.starts_with("https://") { "https" } else { "http" };
        let base_host = without_scheme.split('/').next().unwrap_or(without_scheme);

        if self.force_path_style {
            let path = format!("/{}/{}", self.bucket, encoded_key);
            Ok((format!("{scheme}://{base_host}{path}"), base_host.to_string(), path))
        } else {
            let host = format!("{}.{base_host}", self.bucket);
            let path = format!("/{encoded_key}");
            Ok((format!("{scheme}://{host}{path}"), host, path))
        }
    }

    fn sign_headers(
        &self,
        method: &str,
        host: &str,
        canonical_uri: &str,
        payload: &[u8],
    ) -> Result<(String, String, String), CloakError> {
        let now = Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date_stamp = now.format("%Y%m%d").to_string();
        let payload_hash = hex::encode(Sha256::digest(payload));

        let canonical_headers = format!(
            "host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
        );
        let signed_headers = "host;x-amz-content-sha256;x-amz-date";
        let canonical_request = format!(
            "{method}\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
        );
        let scope = format!("{date_stamp}/{}/s3/aws4_request", self.region);
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
            hex::encode(Sha256::digest(canonical_request.as_bytes()))
        );

        let k_date = hmac_sha256(format!("AWS4{}", self.secret_key).as_bytes(), date_stamp.as_bytes())?;
        let k_region = hmac_sha256(&k_date, self.region.as_bytes())?;
        let k_service = hmac_sha256(&k_region, b"s3")?;
        let k_signing = hmac_sha256(&k_service, b"aws4_request")?;
        let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes())?);

        let auth = format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            self.access_key
        );
        Ok((auth, amz_date, payload_hash))
    }

    async fn put_object(&self, key: &str, data: Bytes) -> Result<(), CloakError> {
        let (url, host, uri) = self.build_url_and_host(key)?;
        let (auth, amz_date, payload_hash) = self.sign_headers("PUT", &host, &uri, &data)?;
        let resp = self
            .client
            .put(&url)
            .header("Host", &host)
            .header("x-amz-date", &amz_date)
            .header("x-amz-content-sha256", &payload_hash)
            .header("Authorization", &auth)
            .header("Content-Type", "application/octet-stream")
            .body(data)
            .send()
            .await
            .map_err(|e| CloakError::Internal(format!("s3 put failed: {e}")))?;

        if !resp.status().is_success() {
            return Err(CloakError::Internal(format!(
                "s3 put returned status {}",
                resp.status()
            )));
        }
        Ok(())
    }

    async fn get_object(&self, key: &str) -> Result<Bytes, CloakError> {
        let (url, host, uri) = self.build_url_and_host(key)?;
        let (auth, amz_date, payload_hash) = self.sign_headers("GET", &host, &uri, b"")?;
        let resp = self
            .client
            .get(&url)
            .header("Host", &host)
            .header("x-amz-date", &amz_date)
            .header("x-amz-content-sha256", &payload_hash)
            .header("Authorization", &auth)
            .send()
            .await
            .map_err(|e| CloakError::Internal(format!("s3 get failed: {e}")))?;

        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(CloakError::NotFound("encrypted object not found".into()));
        }
        if !resp.status().is_success() {
            return Err(CloakError::Internal(format!(
                "s3 get returned status {}",
                resp.status()
            )));
        }
        resp.bytes()
            .await
            .map_err(|e| CloakError::Internal(format!("s3 body read failed: {e}")))
    }

    async fn delete_object(&self, key: &str) -> Result<(), CloakError> {
        let (url, host, uri) = self.build_url_and_host(key)?;
        let (auth, amz_date, payload_hash) = self.sign_headers("DELETE", &host, &uri, b"")?;
        let resp = self
            .client
            .delete(&url)
            .header("Host", &host)
            .header("x-amz-date", &amz_date)
            .header("x-amz-content-sha256", &payload_hash)
            .header("Authorization", &auth)
            .send()
            .await
            .map_err(|e| CloakError::Internal(format!("s3 delete failed: {e}")))?;

        if resp.status().is_success() || resp.status() == reqwest::StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(CloakError::Internal(format!(
                "s3 delete returned status {}",
                resp.status()
            )))
        }
    }
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>, CloakError> {
    let mut mac =
        HmacSha256::new_from_slice(key).map_err(|e| CloakError::Internal(format!("hmac error: {e}")))?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

