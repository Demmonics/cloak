use std::path::PathBuf;

use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};
use uuid::Uuid;

use crate::crypto::{hash_pin, validate_uuid_component, verify_pin};
use crate::error::{P2pError, P2pResult};
use crate::stealth::{
    PdfDocumentRecord, PdfDocumentStateUpdate, SecretCodeAction, SecretCodeMetadata, StealthConfig,
    StealthRateLimitState, generate_recovery_code, hash_secret_code, is_weak_secret_code,
    next_progressive_cooldown_secs, validate_pdf_document, verify_secret_code,
};
use crate::storage::LocalVault;

#[derive(Debug, Clone)]
pub struct StealthRuntimeCheckpoint {
    pub locked: bool,
    pub away_deadline_ms: Option<i64>,
    pub last_wall_ms: i64,
    pub locked_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MatchedSecretCode {
    pub id: String,
    pub action: SecretCodeAction,
    pub target_room_id: Option<String>,
    pub require_additional_auth: bool,
}

impl LocalVault {
    pub(crate) fn init_stealth_schema(&self) -> P2pResult<()> {
        self.conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS stealth_settings (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                config_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS stealth_secret_codes (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                action TEXT NOT NULL,
                target_room_id TEXT,
                case_sensitive INTEGER NOT NULL DEFAULT 1,
                is_weak INTEGER NOT NULL DEFAULT 0,
                require_additional_auth INTEGER NOT NULL DEFAULT 0,
                argon2_hash TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_used_at TEXT
            );

            CREATE TABLE IF NOT EXISTS stealth_passphrase (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                passphrase_hash TEXT,
                recovery_hash TEXT
            );

            CREATE TABLE IF NOT EXISTS stealth_rate_limit (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                failed_attempts INTEGER NOT NULL DEFAULT 0,
                cooldown_until_ms INTEGER,
                lockout_tier INTEGER NOT NULL DEFAULT 0,
                last_failed_at TEXT
            );

            CREATE TABLE IF NOT EXISTS stealth_runtime_checkpoint (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                locked INTEGER NOT NULL DEFAULT 0,
                away_deadline_ms INTEGER,
                last_wall_ms INTEGER NOT NULL DEFAULT 0,
                locked_reason TEXT
            );

            CREATE TABLE IF NOT EXISTS pdf_library (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                filename TEXT NOT NULL,
                file_size_bytes INTEGER NOT NULL,
                page_count INTEGER NOT NULL DEFAULT 1,
                sha256_hex TEXT NOT NULL,
                last_page INTEGER NOT NULL DEFAULT 1,
                last_zoom REAL NOT NULL DEFAULT 1.0,
                rotation INTEGER NOT NULL DEFAULT 0,
                bookmarks_json TEXT NOT NULL DEFAULT '[]',
                is_default_decoy INTEGER NOT NULL DEFAULT 0,
                last_opened_at TEXT,
                added_at TEXT NOT NULL
            );
            ",
        )?;

        let settings_exists: Option<i64> = self
            .conn
            .query_row(
                "SELECT singleton FROM stealth_settings WHERE singleton = 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if settings_exists.is_none() {
            let default_json = serde_json::to_string(&StealthConfig::default())?;
            self.conn.execute(
                "INSERT INTO stealth_settings (singleton, config_json) VALUES (1, ?1)",
                params![default_json],
            )?;
        }

        let pp_exists: Option<i64> = self
            .conn
            .query_row(
                "SELECT singleton FROM stealth_passphrase WHERE singleton = 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if pp_exists.is_none() {
            self.conn.execute(
                "INSERT INTO stealth_passphrase (singleton, passphrase_hash, recovery_hash) VALUES (1, NULL, NULL)",
                [],
            )?;
        }

        let rl_exists: Option<i64> = self
            .conn
            .query_row(
                "SELECT singleton FROM stealth_rate_limit WHERE singleton = 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if rl_exists.is_none() {
            self.conn.execute(
                "INSERT INTO stealth_rate_limit (singleton, failed_attempts, cooldown_until_ms, lockout_tier, last_failed_at)
                 VALUES (1, 0, NULL, 0, NULL)",
                [],
            )?;
        }

        let cp_exists: Option<i64> = self
            .conn
            .query_row(
                "SELECT singleton FROM stealth_runtime_checkpoint WHERE singleton = 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if cp_exists.is_none() {
            self.conn.execute(
                "INSERT INTO stealth_runtime_checkpoint (singleton, locked, away_deadline_ms, last_wall_ms, locked_reason)
                 VALUES (1, 0, NULL, ?1, NULL)",
                params![Utc::now().timestamp_millis()],
            )?;
        }

        Ok(())
    }

    pub fn get_stealth_config(&self) -> P2pResult<StealthConfig> {
        let json: String = self.conn.query_row(
            "SELECT config_json FROM stealth_settings WHERE singleton = 1",
            [],
            |r| r.get(0),
        )?;
        Ok(serde_json::from_str(&json).unwrap_or_default())
    }

    pub fn update_stealth_config(&self, mut config: StealthConfig) -> P2pResult<StealthConfig> {
        config.timers.background_away_seconds =
            config.timers.background_away_seconds.clamp(1, 86_400);
        config.timers.foreground_idle_seconds =
            config.timers.foreground_idle_seconds.clamp(5, 86_400);
        config.timers.system_idle_seconds = config.timers.system_idle_seconds.clamp(5, 86_400);
        if config.pdf_reader.neutral_window_title.trim().is_empty() {
            config.pdf_reader.neutral_window_title = "Document Reader".to_string();
        }
        let json = serde_json::to_string(&config)?;
        self.conn.execute(
            "UPDATE stealth_settings SET config_json = ?1 WHERE singleton = 1",
            params![json],
        )?;
        Ok(config)
    }

    pub fn add_secret_code(
        &self,
        label: &str,
        raw_code: &str,
        action: SecretCodeAction,
        target_room_id: Option<&str>,
        case_sensitive: bool,
        require_additional_auth: bool,
    ) -> P2pResult<SecretCodeMetadata> {
        let clean_label = if label.trim().is_empty() {
            "Secret Code".to_string()
        } else {
            label.trim().chars().take(64).collect()
        };
        if let Some(rid) = target_room_id {
            validate_uuid_component(rid, "target_room_id")?;
        }
        let argon2_hash = hash_secret_code(raw_code, case_sensitive)?;
        let weak = is_weak_secret_code(raw_code);
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let action_json = serde_json::to_string(&action)?;

        self.conn.execute(
            "INSERT INTO stealth_secret_codes (id, label, action, target_room_id, case_sensitive, is_weak, require_additional_auth, argon2_hash, created_at, last_used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
            params![
                id,
                clean_label,
                action_json,
                target_room_id,
                if case_sensitive { 1 } else { 0 },
                if weak { 1 } else { 0 },
                if require_additional_auth { 1 } else { 0 },
                argon2_hash,
                now.to_rfc3339(),
            ],
        )?;

        Ok(SecretCodeMetadata {
            id,
            label: clean_label,
            action,
            target_room_id: target_room_id.map(ToOwned::to_owned),
            case_sensitive,
            is_weak: weak,
            require_additional_auth,
            created_at: now,
            last_used_at: None,
        })
    }

    pub fn list_secret_code_metadata(&self) -> P2pResult<Vec<SecretCodeMetadata>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, label, action, target_room_id, case_sensitive, is_weak, require_additional_auth, created_at, last_used_at
             FROM stealth_secret_codes
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            let action_json: String = r.get(2)?;
            let created_raw: String = r.get(7)?;
            let used_raw: Option<String> = r.get(8)?;
            Ok(SecretCodeMetadata {
                id: r.get(0)?,
                label: r.get(1)?,
                action: serde_json::from_str(&action_json)
                    .unwrap_or(SecretCodeAction::OpenMessenger),
                target_room_id: r.get(3)?,
                case_sensitive: r.get::<_, i64>(4)? != 0,
                is_weak: r.get::<_, i64>(5)? != 0,
                require_additional_auth: r.get::<_, i64>(6)? != 0,
                created_at: DateTime::parse_from_rfc3339(&created_raw)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
                last_used_at: used_raw.and_then(|s| {
                    DateTime::parse_from_rfc3339(&s)
                        .map(|dt| dt.with_timezone(&Utc))
                        .ok()
                }),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(P2pError::from)
    }

    pub fn remove_secret_code(&self, id: &str) -> P2pResult<bool> {
        validate_uuid_component(id, "secret_code_id")?;
        let deleted = self.conn.execute(
            "DELETE FROM stealth_secret_codes WHERE id = ?1",
            params![id],
        )?;
        Ok(deleted > 0)
    }

    pub fn verify_secret_code_against_store(
        &self,
        candidate: &str,
        global_case_sensitive: bool,
    ) -> P2pResult<Option<MatchedSecretCode>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, action, target_room_id, case_sensitive, require_additional_auth, argon2_hash
             FROM stealth_secret_codes",
        )?;
        let entries: Vec<(String, String, Option<String>, i64, i64, String)> = stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let mut matched: Option<MatchedSecretCode> = None;
        for (id, action_json, target_room_id, code_cs, req_add, hash) in entries {
            let cs = global_case_sensitive && (code_cs != 0);
            if verify_secret_code(candidate, cs, &hash).unwrap_or(false) && matched.is_none() {
                matched = Some(MatchedSecretCode {
                    id: id.clone(),
                    action: serde_json::from_str(&action_json)
                        .unwrap_or(SecretCodeAction::OpenMessenger),
                    target_room_id,
                    require_additional_auth: req_add != 0,
                });
            }
        }

        if let Some(ref m) = matched {
            self.conn.execute(
                "UPDATE stealth_secret_codes SET last_used_at = ?1 WHERE id = ?2",
                params![Utc::now().to_rfc3339(), m.id],
            )?;
        }
        Ok(matched)
    }

    pub fn set_stealth_passphrase(&self, passphrase: Option<&str>) -> P2pResult<bool> {
        let hash = match passphrase {
            Some(p) if !p.is_empty() => Some(hash_pin(p)?),
            _ => None,
        };
        self.conn.execute(
            "UPDATE stealth_passphrase SET passphrase_hash = ?1 WHERE singleton = 1",
            params![hash],
        )?;
        Ok(hash.is_some())
    }

    pub fn has_stealth_passphrase(&self) -> P2pResult<bool> {
        let p: Option<String> = self.conn.query_row(
            "SELECT passphrase_hash FROM stealth_passphrase WHERE singleton = 1",
            [],
            |r| r.get(0),
        )?;
        Ok(p.is_some())
    }

    pub fn verify_stealth_passphrase(&self, candidate: &str) -> P2pResult<bool> {
        let p: Option<String> = self.conn.query_row(
            "SELECT passphrase_hash FROM stealth_passphrase WHERE singleton = 1",
            [],
            |r| r.get(0),
        )?;
        match p {
            Some(h) => verify_pin(candidate, &h),
            None => Ok(false),
        }
    }

    pub fn generate_and_store_recovery_code(&self) -> P2pResult<String> {
        let raw = generate_recovery_code();
        let hashed = hash_secret_code(&raw, true)?;
        self.conn.execute(
            "UPDATE stealth_passphrase SET recovery_hash = ?1 WHERE singleton = 1",
            params![hashed],
        )?;
        Ok(raw)
    }

    pub fn verify_recovery_code(&self, candidate: &str) -> P2pResult<bool> {
        let r: Option<String> = self.conn.query_row(
            "SELECT recovery_hash FROM stealth_passphrase WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        match r {
            Some(h) => verify_secret_code(candidate.trim(), true, &h),
            None => Ok(false),
        }
    }

    pub fn get_rate_limit_state(&self) -> P2pResult<StealthRateLimitState> {
        self.conn
            .query_row(
                "SELECT failed_attempts, cooldown_until_ms, lockout_tier, last_failed_at FROM stealth_rate_limit WHERE singleton = 1",
                [],
                |r| {
                    let last_raw: Option<String> = r.get(3)?;
                    Ok(StealthRateLimitState {
                        failed_attempts: r.get::<_, i64>(0)? as u32,
                        cooldown_until_ms: r.get(1)?,
                        lockout_tier: r.get::<_, i64>(2)? as u32,
                        last_failed_at: last_raw.and_then(|s| {
                            DateTime::parse_from_rfc3339(&s)
                                .map(|dt| dt.with_timezone(&Utc))
                                .ok()
                        }),
                    })
                },
            )
            .map_err(P2pError::from)
    }

    pub fn record_failed_unlock_attempt(&self, now_ms: i64) -> P2pResult<StealthRateLimitState> {
        let mut st = self.get_rate_limit_state()?;
        st.failed_attempts = st.failed_attempts.saturating_add(1);
        let delay_secs = next_progressive_cooldown_secs(st.failed_attempts);
        st.lockout_tier = if delay_secs > 0 {
            st.lockout_tier.saturating_add(1)
        } else {
            st.lockout_tier
        };
        st.cooldown_until_ms = if delay_secs > 0 {
            Some(now_ms + (delay_secs as i64) * 1000)
        } else {
            None
        };
        st.last_failed_at = Some(Utc::now());

        self.conn.execute(
            "UPDATE stealth_rate_limit SET failed_attempts = ?1, cooldown_until_ms = ?2, lockout_tier = ?3, last_failed_at = ?4 WHERE singleton = 1",
            params![
                st.failed_attempts as i64,
                st.cooldown_until_ms,
                st.lockout_tier as i64,
                st.last_failed_at.map(|d| d.to_rfc3339()),
            ],
        )?;
        Ok(st)
    }

    pub fn reset_unlock_rate_limit(&self) -> P2pResult<()> {
        self.conn.execute(
            "UPDATE stealth_rate_limit SET failed_attempts = 0, cooldown_until_ms = NULL, lockout_tier = 0 WHERE singleton = 1",
            [],
        )?;
        Ok(())
    }

    pub fn get_runtime_checkpoint(&self) -> P2pResult<StealthRuntimeCheckpoint> {
        self.conn
            .query_row(
                "SELECT locked, away_deadline_ms, last_wall_ms, locked_reason FROM stealth_runtime_checkpoint WHERE singleton = 1",
                [],
                |r| {
                    Ok(StealthRuntimeCheckpoint {
                        locked: r.get::<_, i64>(0)? != 0,
                        away_deadline_ms: r.get(1)?,
                        last_wall_ms: r.get(2)?,
                        locked_reason: r.get(3)?,
                    })
                },
            )
            .map_err(P2pError::from)
    }

    pub fn save_runtime_checkpoint(&self, cp: &StealthRuntimeCheckpoint) -> P2pResult<()> {
        self.conn.execute(
            "UPDATE stealth_runtime_checkpoint SET locked = ?1, away_deadline_ms = ?2, last_wall_ms = ?3, locked_reason = ?4 WHERE singleton = 1",
            params![
                if cp.locked { 1 } else { 0 },
                cp.away_deadline_ms,
                cp.last_wall_ms,
                cp.locked_reason,
            ],
        )?;
        Ok(())
    }

    // ==================== Local PDF Library Storage ====================

    fn pdf_blob_path(&self, doc_id: &str) -> P2pResult<PathBuf> {
        validate_uuid_component(doc_id, "pdf_document_id")?;
        Ok(self.pdfs_dir.join(format!("{doc_id}.pdf")))
    }

    pub fn import_pdf_document(
        &self,
        title: Option<&str>,
        filename: &str,
        bytes: &[u8],
        page_count: u32,
        make_default: bool,
    ) -> P2pResult<PdfDocumentRecord> {
        let (clean_name, sha) = validate_pdf_document(filename, bytes)?;
        let id = Uuid::new_v4().to_string();
        let path = self.pdf_blob_path(&id)?;
        std::fs::write(&path, bytes)?;

        let clean_title = title
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(120).collect())
            .unwrap_or_else(|| {
                clean_name
                    .strip_suffix(".pdf")
                    .or_else(|| clean_name.strip_suffix(".PDF"))
                    .unwrap_or(&clean_name)
                    .to_string()
            });

        if make_default {
            self.conn
                .execute("UPDATE pdf_library SET is_default_decoy = 0", [])?;
        }

        let now = Utc::now();
        self.conn.execute(
            "INSERT INTO pdf_library (id, title, filename, file_size_bytes, page_count, sha256_hex, last_page, last_zoom, rotation, bookmarks_json, is_default_decoy, last_opened_at, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1.0, 0, '[]', ?7, ?8, ?8)",
            params![
                id,
                clean_title,
                clean_name,
                bytes.len() as i64,
                page_count.max(1) as i64,
                sha,
                if make_default { 1 } else { 0 },
                now.to_rfc3339(),
            ],
        )?;

        Ok(PdfDocumentRecord {
            id,
            title: clean_title,
            filename: clean_name,
            file_size_bytes: bytes.len() as u64,
            page_count: page_count.max(1),
            sha256_hex: sha,
            last_page: 1,
            last_zoom: 1.0,
            rotation: 0,
            bookmarks: Vec::new(),
            is_default_decoy: make_default,
            last_opened_at: Some(now),
            added_at: now,
        })
    }

    pub fn list_pdf_documents(&self) -> P2pResult<Vec<PdfDocumentRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, filename, file_size_bytes, page_count, sha256_hex, last_page, last_zoom, rotation, bookmarks_json, is_default_decoy, last_opened_at, added_at
             FROM pdf_library
             ORDER BY COALESCE(last_opened_at, added_at) DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            let b_json: String = r.get(9)?;
            let opened_raw: Option<String> = r.get(11)?;
            let added_raw: String = r.get(12)?;
            Ok(PdfDocumentRecord {
                id: r.get(0)?,
                title: r.get(1)?,
                filename: r.get(2)?,
                file_size_bytes: r.get::<_, i64>(3)? as u64,
                page_count: r.get::<_, i64>(4)? as u32,
                sha256_hex: r.get(5)?,
                last_page: r.get::<_, i64>(6)? as u32,
                last_zoom: r.get::<_, f64>(7)? as f32,
                rotation: r.get::<_, i64>(8)? as u16,
                bookmarks: serde_json::from_str(&b_json).unwrap_or_default(),
                is_default_decoy: r.get::<_, i64>(10)? != 0,
                last_opened_at: opened_raw.and_then(|s| {
                    DateTime::parse_from_rfc3339(&s)
                        .map(|dt| dt.with_timezone(&Utc))
                        .ok()
                }),
                added_at: DateTime::parse_from_rfc3339(&added_raw)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(P2pError::from)
    }

    pub fn read_pdf_bytes(&self, doc_id: &str) -> P2pResult<Vec<u8>> {
        let path = self.pdf_blob_path(doc_id)?;
        if !path.exists() {
            return Err(P2pError::NotFound(format!("PDF document {doc_id}")));
        }
        let bytes = std::fs::read(path)?;
        Ok(bytes)
    }

    pub fn update_pdf_document_state(
        &self,
        doc_id: &str,
        patch: &PdfDocumentStateUpdate,
    ) -> P2pResult<PdfDocumentRecord> {
        validate_uuid_component(doc_id, "pdf_document_id")?;
        if let Some(pc) = patch.page_count {
            self.conn.execute(
                "UPDATE pdf_library SET page_count = ?1 WHERE id = ?2",
                params![pc.max(1) as i64, doc_id],
            )?;
        }
        if let Some(lp) = patch.last_page {
            self.conn.execute(
                "UPDATE pdf_library SET last_page = ?1, last_opened_at = ?2 WHERE id = ?3",
                params![lp.max(1) as i64, Utc::now().to_rfc3339(), doc_id],
            )?;
        }
        if let Some(zoom) = patch.last_zoom {
            let clamped = zoom.clamp(0.25, 4.0) as f64;
            self.conn.execute(
                "UPDATE pdf_library SET last_zoom = ?1 WHERE id = ?2",
                params![clamped, doc_id],
            )?;
        }
        if let Some(rot) = patch.rotation {
            let clean_rot = ((rot / 90) * 90) % 360;
            self.conn.execute(
                "UPDATE pdf_library SET rotation = ?1 WHERE id = ?2",
                params![clean_rot as i64, doc_id],
            )?;
        }
        if let Some(ref bms) = patch.bookmarks {
            let json = serde_json::to_string(bms)?;
            self.conn.execute(
                "UPDATE pdf_library SET bookmarks_json = ?1 WHERE id = ?2",
                params![json, doc_id],
            )?;
        }
        if let Some(is_def) = patch.is_default_decoy {
            if is_def {
                self.conn
                    .execute("UPDATE pdf_library SET is_default_decoy = 0", [])?;
            }
            self.conn.execute(
                "UPDATE pdf_library SET is_default_decoy = ?1 WHERE id = ?2",
                params![if is_def { 1 } else { 0 }, doc_id],
            )?;
        }

        self.list_pdf_documents()?
            .into_iter()
            .find(|d| d.id == doc_id)
            .ok_or_else(|| P2pError::NotFound(format!("PDF document {doc_id}")))
    }

    pub fn delete_pdf_document(&self, doc_id: &str) -> P2pResult<()> {
        let path = self.pdf_blob_path(doc_id)?;
        let _ = self
            .conn
            .execute("DELETE FROM pdf_library WHERE id = ?1", params![doc_id])?;
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    }
}
