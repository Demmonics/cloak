use std::collections::HashSet;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use chrono::{DateTime, Duration, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::crypto::{
    DeviceIdentity, VaultSecretBox, decrypt_and_verify_message, encrypt_and_sign_message,
    generate_room_key_b64, hash_pin, sanitize_attachment_filename, sha256_hex,
    validate_uuid_component, verify_pin,
};
use crate::error::{P2pError, P2pResult};
use crate::ghost::make_cleanup_summary;
use crate::model::{
    ConnectivityMode, DecryptedMessageView, DeletionTombstone, GhostDeletionSummary,
    GhostModeLevel, GhostPolicy, GhostRoomOverride, LocalAttachmentMeta, LocalChannel, LocalRoom,
    OutgoingViewedPolicy, PeerSummary, StoredMessage, TombstoneScope, WireFrame,
};

use crate::stealth::LocalDeletionAction;

/// Local-first SQLite + filesystem attachment vault backing every desktop P2P node.
pub struct LocalVault {
    pub(crate) conn: Connection,
    blobs_dir: PathBuf,
    pub(crate) pdfs_dir: PathBuf,
    vault_box: VaultSecretBox,
}

impl LocalVault {
    /// Opens or initializes the local SQLite database and attachment blob directory.
    pub fn open(data_dir: impl AsRef<Path>, default_display_name: &str) -> P2pResult<Self> {
        let data_dir = data_dir.as_ref();
        std::fs::create_dir_all(data_dir)?;
        let blobs_dir = data_dir.join("blobs");
        std::fs::create_dir_all(&blobs_dir)?;
        let pdfs_dir = data_dir.join("pdfs");
        std::fs::create_dir_all(&pdfs_dir)?;
        let vault_box = VaultSecretBox::load_or_create(data_dir)?;

        let db_path = data_dir.join("cloak_local.db");
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            PRAGMA secure_delete = ON;

            CREATE TABLE IF NOT EXISTS identity (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                device_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                ed25519_secret_b64 TEXT NOT NULL,
                ed25519_public_b64 TEXT NOT NULL,
                x25519_secret_b64 TEXT NOT NULL,
                x25519_public_b64 TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS peers (
                device_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                ed25519_public_key_b64 TEXT NOT NULL,
                x25519_public_key_b64 TEXT NOT NULL,
                direct_addr TEXT NOT NULL,
                alternate_addrs_json TEXT NOT NULL DEFAULT '[]',
                connectivity_json TEXT NOT NULL,
                last_seen_at TEXT,
                revoked INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS rooms (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                current_epoch INTEGER NOT NULL DEFAULT 1,
                room_key_b64 TEXT NOT NULL,
                default_disappear_seconds INTEGER,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS channels (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                channel_type TEXT NOT NULL DEFAULT 'text',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
                sender_device_id TEXT NOT NULL,
                encryption_epoch INTEGER NOT NULL,
                seq INTEGER NOT NULL,
                ciphertext_b64 TEXT NOT NULL,
                signature_b64 TEXT NOT NULL,
                attachment_ids_json TEXT NOT NULL DEFAULT '[]',
                reply_to_message_id TEXT,
                created_at TEXT NOT NULL,
                edited_at TEXT,
                expires_at TEXT,
                deleted_for_me INTEGER NOT NULL DEFAULT 0,
                deleted_for_everyone INTEGER NOT NULL DEFAULT 0,
                viewed_at TEXT,
                expire_on_leave INTEGER NOT NULL DEFAULT 0,
                expire_after_view_seconds INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_messages_room_chan_seq
                ON messages(room_id, channel_id, seq);

            CREATE TABLE IF NOT EXISTS tombstones (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL,
                channel_id TEXT,
                message_id TEXT,
                scope TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS attachments (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                total_size_bytes INTEGER NOT NULL,
                chunk_size_bytes INTEGER NOT NULL,
                total_chunks INTEGER NOT NULL,
                sha256_hex TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                peer_device_id TEXT NOT NULL,
                frame_json TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ghost_settings (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                policy_json TEXT NOT NULL,
                pin_hash TEXT
            );

            CREATE TABLE IF NOT EXISTS ghost_room_overrides (
                room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
                enabled INTEGER NOT NULL,
                mode TEXT NOT NULL,
                clear_attachments INTEGER
            );

            CREATE TABLE IF NOT EXISTS local_suppressions (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL,
                channel_id TEXT,
                message_id TEXT,
                max_suppressed_seq INTEGER,
                max_suppressed_created_at TEXT,
                kind TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_suppressions_room_msg
                ON local_suppressions(room_id, message_id);

            CREATE TABLE IF NOT EXISTS deletion_intents (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                mode TEXT NOT NULL,
                clear_attachments INTEGER NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            ",
        )?;

        // Non-destructive column upgrades for any existing databases from prior versions
        Self::ensure_column(
            &conn,
            "peers",
            "alternate_addrs_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        Self::ensure_column(&conn, "peers", "revoked", "INTEGER NOT NULL DEFAULT 0")?;
        Self::ensure_column(&conn, "messages", "viewed_at", "TEXT")?;
        Self::ensure_column(
            &conn,
            "messages",
            "expire_on_leave",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        Self::ensure_column(&conn, "messages", "expire_after_view_seconds", "INTEGER")?;

        let exists: Option<String> = conn
            .query_row(
                "SELECT device_id FROM identity WHERE singleton = 1",
                [],
                |r| r.get(0),
            )
            .optional()?;

        if exists.is_none() {
            let ident = DeviceIdentity::generate(default_display_name);
            let sealed_ed = vault_box.seal_field("ed25519_secret", &ident.ed25519_secret_b64)?;
            let sealed_x = vault_box.seal_field("x25519_secret", &ident.x25519_secret_b64)?;
            conn.execute(
                "INSERT INTO identity (singleton, device_id, display_name, ed25519_secret_b64, ed25519_public_b64, x25519_secret_b64, x25519_public_b64, created_at)
                 VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    ident.device_id,
                    ident.display_name,
                    sealed_ed,
                    ident.ed25519_public_b64,
                    sealed_x,
                    ident.x25519_public_b64,
                    Utc::now().to_rfc3339(),
                ],
            )?;
        }

        let vault = Self {
            conn,
            blobs_dir,
            pdfs_dir,
            vault_box,
        };

        vault.init_stealth_schema()?;

        // Ensure default safe Ghost Mode policy row exists (Ghost Mode OFF on new install)
        let ghost_exists: Option<i64> = vault
            .conn
            .query_row(
                "SELECT singleton FROM ghost_settings WHERE singleton = 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if ghost_exists.is_none() {
            let default_json = serde_json::to_string(&GhostPolicy::default())?;
            vault.conn.execute(
                "INSERT INTO ghost_settings (singleton, policy_json, pin_hash) VALUES (1, ?1, NULL)",
                params![default_json],
            )?;
        }

        // Complete any durable Ghost deletion intents left pending by an abrupt process kill
        let _ = vault.recover_pending_deletion_intents()?;
        let _ = vault.purge_expired_messages()?;

        Ok(vault)
    }

    fn ensure_column(conn: &Connection, table: &str, col: &str, def_sql: &str) -> P2pResult<()> {
        let sql = format!("PRAGMA table_info({table})");
        let mut stmt = conn.prepare(&sql)?;
        let cols: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        if !cols.iter().any(|c| c == col) {
            let alter = format!("ALTER TABLE {table} ADD COLUMN {col} {def_sql}");
            conn.execute(&alter, [])?;
        }
        Ok(())
    }

    pub fn is_dpapi_protected(&self) -> bool {
        self.vault_box.dpapi_protected
    }

    pub fn blobs_dir(&self) -> &Path {
        &self.blobs_dir
    }

    pub fn identity(&self) -> P2pResult<DeviceIdentity> {
        let raw = self.conn.query_row(
            "SELECT device_id, display_name, ed25519_secret_b64, ed25519_public_b64, x25519_secret_b64, x25519_public_b64
             FROM identity WHERE singleton = 1",
            [],
            |row| {
                Ok(DeviceIdentity {
                    device_id: row.get(0)?,
                    display_name: row.get(1)?,
                    ed25519_secret_b64: row.get(2)?,
                    ed25519_public_b64: row.get(3)?,
                    x25519_secret_b64: row.get(4)?,
                    x25519_public_b64: row.get(5)?,
                })
            },
        )?;
        Ok(DeviceIdentity {
            device_id: raw.device_id,
            display_name: raw.display_name,
            ed25519_secret_b64: self
                .vault_box
                .open_field("ed25519_secret", &raw.ed25519_secret_b64)?,
            ed25519_public_b64: raw.ed25519_public_b64,
            x25519_secret_b64: self
                .vault_box
                .open_field("x25519_secret", &raw.x25519_secret_b64)?,
            x25519_public_b64: raw.x25519_public_b64,
        })
    }

    pub fn update_display_name(&self, display_name: &str) -> P2pResult<()> {
        let trimmed = display_name.trim();
        if trimmed.is_empty() {
            return Err(P2pError::Validation("display_name cannot be empty".into()));
        }
        self.conn.execute(
            "UPDATE identity SET display_name = ?1 WHERE singleton = 1",
            params![trimmed],
        )?;
        Ok(())
    }

    pub fn upsert_peer(&self, peer: &PeerSummary) -> P2pResult<()> {
        // Key-pinning verification: refuse silently replacing a pinned Ed25519 key for an existing peer ID
        if let Some(existing) = self.get_peer(&peer.device_id)?
            && existing.ed25519_public_key_b64 != peer.ed25519_public_key_b64
        {
            return Err(P2pError::PeerRejected(format!(
                "Pinned Ed25519 identity mismatch for peer {}",
                peer.device_id
            )));
        }

        let conn_json = serde_json::to_string(&peer.connectivity_mode)?;
        let alt_json = serde_json::to_string(&peer.alternate_addrs)?;
        self.conn.execute(
            "INSERT INTO peers (device_id, display_name, ed25519_public_key_b64, x25519_public_key_b64, direct_addr, alternate_addrs_json, connectivity_json, last_seen_at, revoked)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(device_id) DO UPDATE SET
                display_name = excluded.display_name,
                direct_addr = excluded.direct_addr,
                alternate_addrs_json = excluded.alternate_addrs_json,
                connectivity_json = excluded.connectivity_json,
                last_seen_at = COALESCE(excluded.last_seen_at, peers.last_seen_at),
                revoked = excluded.revoked",
            params![
                peer.device_id,
                peer.display_name,
                peer.ed25519_public_key_b64,
                peer.x25519_public_key_b64,
                peer.direct_addr,
                alt_json,
                conn_json,
                peer.last_seen_at.map(|d| d.to_rfc3339()),
                if peer.revoked { 1 } else { 0 },
            ],
        )?;
        Ok(())
    }

    pub fn revoke_peer(&self, device_id: &str, revoked: bool) -> P2pResult<()> {
        let updated = self.conn.execute(
            "UPDATE peers SET revoked = ?1 WHERE device_id = ?2",
            params![if revoked { 1 } else { 0 }, device_id],
        )?;
        if updated == 0 {
            return Err(P2pError::NotFound(format!("peer {device_id}")));
        }
        Ok(())
    }

    pub fn is_peer_allowed(&self, device_id: &str, ed25519_public_b64: &str) -> P2pResult<bool> {
        let Some(peer) = self.get_peer(device_id)? else {
            // Unknown peers can still connect cleanly during mutual ticket onboarding
            return Ok(true);
        };
        if peer.revoked {
            return Ok(false);
        }
        Ok(peer.ed25519_public_key_b64 == ed25519_public_b64)
    }

    pub fn touch_peer_seen(&self, device_id: &str) -> P2pResult<()> {
        self.conn.execute(
            "UPDATE peers SET last_seen_at = ?1 WHERE device_id = ?2",
            params![Utc::now().to_rfc3339(), device_id],
        )?;
        Ok(())
    }

    pub fn get_peer(&self, device_id: &str) -> P2pResult<Option<PeerSummary>> {
        self.conn
            .query_row(
                "SELECT device_id, display_name, ed25519_public_key_b64, x25519_public_key_b64, direct_addr, alternate_addrs_json, connectivity_json, last_seen_at, revoked
                 FROM peers WHERE device_id = ?1",
                params![device_id],
                Self::map_peer_row,
            )
            .optional()
            .map_err(P2pError::from)
    }

    pub fn list_peers(&self) -> P2pResult<Vec<PeerSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT device_id, display_name, ed25519_public_key_b64, x25519_public_key_b64, direct_addr, alternate_addrs_json, connectivity_json, last_seen_at, revoked
             FROM peers ORDER BY display_name ASC",
        )?;
        let rows = stmt.query_map([], Self::map_peer_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    fn map_peer_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PeerSummary> {
        let alt_json: String = row.get(5)?;
        let conn_json: String = row.get(6)?;
        let connectivity_mode: ConnectivityMode =
            serde_json::from_str(&conn_json).unwrap_or(ConnectivityMode::DirectOnly);
        let alternate_addrs: Vec<String> = serde_json::from_str(&alt_json).unwrap_or_default();
        let last_seen_raw: Option<String> = row.get(7)?;
        let last_seen_at = last_seen_raw.and_then(|s| parse_utc(&s).ok());
        let revoked_int: i64 = row.get(8)?;
        Ok(PeerSummary {
            device_id: row.get(0)?,
            display_name: row.get(1)?,
            ed25519_public_key_b64: row.get(2)?,
            x25519_public_key_b64: row.get(3)?,
            direct_addr: row.get(4)?,
            alternate_addrs,
            connectivity_mode,
            last_seen_at,
            revoked: revoked_int != 0,
        })
    }

    pub fn create_room(
        &self,
        room_id: Option<&str>,
        name: &str,
        room_key_b64: Option<&str>,
        default_disappear_seconds: Option<i64>,
    ) -> P2pResult<(LocalRoom, LocalChannel, String)> {
        let rid = room_id
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let rkey = room_key_b64
            .map(ToOwned::to_owned)
            .unwrap_or_else(generate_room_key_b64);
        let sealed_rkey = self
            .vault_box
            .seal_field(&format!("room_key:{rid}"), &rkey)?;
        let now = Utc::now();

        self.conn.execute(
            "INSERT OR IGNORE INTO rooms (id, name, current_epoch, room_key_b64, default_disappear_seconds, created_at)
             VALUES (?1, ?2, 1, ?3, ?4, ?5)",
            params![rid, name.trim(), sealed_rkey, default_disappear_seconds, now.to_rfc3339()],
        )?;

        let existing_channel: Option<LocalChannel> = self
            .conn
            .query_row(
                "SELECT id, room_id, name, channel_type, created_at FROM channels WHERE room_id = ?1 LIMIT 1",
                params![rid],
                |row| {
                    let ts: String = row.get(4)?;
                    Ok(LocalChannel {
                        id: row.get(0)?,
                        room_id: row.get(1)?,
                        name: row.get(2)?,
                        channel_type: row.get(3)?,
                        created_at: parse_utc(&ts).unwrap_or(now),
                    })
                },
            )
            .optional()?;

        let channel = if let Some(ch) = existing_channel {
            ch
        } else {
            let digest = sha256_hex(format!("cloak-general:{rid}").as_bytes());
            let mut raw = [0u8; 16];
            let decoded = hex::decode(&digest[..32]).unwrap_or_default();
            raw.copy_from_slice(&decoded[..16]);
            let cid = Uuid::from_bytes(raw).to_string();
            self.conn.execute(
                "INSERT INTO channels (id, room_id, name, channel_type, created_at)
                 VALUES (?1, ?2, 'general', 'text', ?3)",
                params![cid, rid, now.to_rfc3339()],
            )?;
            LocalChannel {
                id: cid,
                room_id: rid.clone(),
                name: "general".into(),
                channel_type: "text".into(),
                created_at: now,
            }
        };

        let room = self
            .get_room(&rid)?
            .ok_or_else(|| P2pError::NotFound(format!("room {rid}")))?;
        let key_out = self.get_room_key(&rid)?;
        Ok((room, channel, key_out))
    }

    pub fn list_rooms(&self) -> P2pResult<Vec<LocalRoom>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, current_epoch, default_disappear_seconds, created_at FROM rooms ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], Self::map_room_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn get_room(&self, room_id: &str) -> P2pResult<Option<LocalRoom>> {
        self.conn
            .query_row(
                "SELECT id, name, current_epoch, default_disappear_seconds, created_at FROM rooms WHERE id = ?1",
                params![room_id],
                Self::map_room_row,
            )
            .optional()
            .map_err(P2pError::from)
    }

    fn map_room_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalRoom> {
        let created_raw: String = row.get(4)?;
        Ok(LocalRoom {
            id: row.get(0)?,
            name: row.get(1)?,
            current_epoch: row.get(2)?,
            default_disappear_seconds: row.get(3)?,
            created_at: parse_utc(&created_raw).unwrap_or_else(|_| Utc::now()),
        })
    }

    pub fn list_channels(&self, room_id: &str) -> P2pResult<Vec<LocalChannel>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, room_id, name, channel_type, created_at FROM channels WHERE room_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![room_id], |row| {
            let ts: String = row.get(4)?;
            Ok(LocalChannel {
                id: row.get(0)?,
                room_id: row.get(1)?,
                name: row.get(2)?,
                channel_type: row.get(3)?,
                created_at: parse_utc(&ts).unwrap_or_else(|_| Utc::now()),
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn get_room_key(&self, room_id: &str) -> P2pResult<String> {
        let stored: String = self
            .conn
            .query_row(
                "SELECT room_key_b64 FROM rooms WHERE id = ?1",
                params![room_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| P2pError::NotFound(format!("room key for {room_id}")))?;
        self.vault_box
            .open_field(&format!("room_key:{room_id}"), &stored)
    }

    pub fn rotate_room_key(
        &self,
        room_id: &str,
        new_epoch: i64,
        new_key_b64: &str,
    ) -> P2pResult<()> {
        let sealed = self
            .vault_box
            .seal_field(&format!("room_key:{room_id}"), new_key_b64)?;
        self.conn.execute(
            "UPDATE rooms SET current_epoch = ?1, room_key_b64 = ?2 WHERE id = ?3",
            params![new_epoch, sealed, room_id],
        )?;
        Ok(())
    }

    fn next_seq_for_room(&self, room_id: &str) -> P2pResult<i64> {
        let max_msg_seq: Option<i64> = self.conn.query_row(
            "SELECT MAX(seq) FROM messages WHERE room_id = ?1",
            params![room_id],
            |r| r.get(0),
        )?;
        let max_sup_seq: Option<i64> = self.conn.query_row(
            "SELECT MAX(max_suppressed_seq) FROM local_suppressions WHERE room_id = ?1",
            params![room_id],
            |r| r.get(0),
        )?;
        Ok(max_msg_seq.unwrap_or(0).max(max_sup_seq.unwrap_or(0)) + 1)
    }

    /// Encrypts, signs, and stores an outgoing local message in SQLite.
    #[allow(clippy::too_many_arguments)]
    pub fn store_outgoing_message(
        &self,
        room_id: &str,
        channel_id: &str,
        plaintext: &str,
        attachment_ids: Vec<String>,
        reply_to_message_id: Option<String>,
        expire_in_seconds: Option<i64>,
        expire_on_leave: bool,
        expire_after_view_seconds: Option<i64>,
    ) -> P2pResult<StoredMessage> {
        let identity = self.identity()?;
        let room = self
            .get_room(room_id)?
            .ok_or_else(|| P2pError::NotFound(format!("room {room_id}")))?;
        let room_key_b64 = self.get_room_key(room_id)?;
        let ghost_policy = self.get_ghost_policy()?;

        let message_id = Uuid::new_v4().to_string();
        let seq = self.next_seq_for_room(room_id)?;
        let now = Utc::now();
        let effective_ttl = expire_in_seconds.or(room.default_disappear_seconds);
        let expires_at = effective_ttl.map(|secs| now + Duration::seconds(secs));

        let (ciphertext_b64, signature_b64) = encrypt_and_sign_message(
            room_id,
            channel_id,
            &message_id,
            room.current_epoch,
            &room_key_b64,
            &identity,
            plaintext,
        )?;

        let msg = StoredMessage {
            id: message_id.clone(),
            room_id: room_id.to_string(),
            channel_id: channel_id.to_string(),
            sender_device_id: identity.device_id,
            encryption_epoch: room.current_epoch,
            seq,
            ciphertext_b64,
            signature_b64,
            attachment_ids,
            reply_to_message_id,
            created_at: now,
            edited_at: None,
            expires_at,
            expire_on_leave,
            expire_after_view_seconds,
        };
        self.upsert_received_message(&msg)?;

        if ghost_policy.outgoing_viewed_policy == OutgoingViewedPolicy::ImmediateOnSend {
            let _ = self.conn.execute(
                "UPDATE messages SET viewed_at = ?1 WHERE id = ?2",
                params![now.to_rfc3339(), message_id],
            );
        }

        Ok(msg)
    }

    fn is_suppressed_locally(&self, msg: &StoredMessage) -> P2pResult<bool> {
        let by_tombstone: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM tombstones WHERE room_id = ?1 AND message_id = ?2 LIMIT 1",
                params![msg.room_id, msg.id],
                |r| r.get(0),
            )
            .optional()?;
        if by_tombstone.is_some() {
            return Ok(true);
        }

        let by_msg_suppression: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM local_suppressions WHERE room_id = ?1 AND kind = 'message_id' AND message_id = ?2 LIMIT 1",
                params![msg.room_id, msg.id],
                |r| r.get(0),
            )
            .optional()?;
        if by_msg_suppression.is_some() {
            return Ok(true);
        }

        // Check full-channel wipe cutoffs: suppress historical sync items created before the wipe cutoff,
        // while allowing genuinely new messages sent after the wipe!
        let mut stmt = self.conn.prepare(
            "SELECT max_suppressed_seq, max_suppressed_created_at FROM local_suppressions
             WHERE room_id = ?1 AND channel_id = ?2 AND kind = 'channel_cutoff'",
        )?;
        let rows = stmt.query_map(params![msg.room_id, msg.channel_id], |r| {
            Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<String>>(1)?))
        })?;
        for row in rows {
            let (max_seq, max_ts) = row?;
            let before_ts = max_ts
                .as_deref()
                .and_then(|s| parse_utc(s).ok())
                .is_some_and(|cutoff| msg.created_at <= cutoff);
            let before_seq = max_seq.is_some_and(|s| msg.seq <= s);
            if before_ts || before_seq {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Inserts or updates a wire message received from a direct peer (enforces remote tombstones AND local Ghost suppressions).
    pub fn upsert_received_message(&self, msg: &StoredMessage) -> P2pResult<bool> {
        if self.is_suppressed_locally(msg)? {
            return Ok(false);
        }

        let att_json = serde_json::to_string(&msg.attachment_ids)?;
        self.conn.execute(
            "INSERT INTO messages (id, room_id, channel_id, sender_device_id, encryption_epoch, seq, ciphertext_b64, signature_b64, attachment_ids_json, reply_to_message_id, created_at, edited_at, expires_at, expire_on_leave, expire_after_view_seconds)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(id) DO UPDATE SET
                ciphertext_b64 = excluded.ciphertext_b64,
                signature_b64 = excluded.signature_b64,
                edited_at = excluded.edited_at
             WHERE messages.sender_device_id = excluded.sender_device_id
               AND messages.room_id = excluded.room_id",
            params![
                msg.id,
                msg.room_id,
                msg.channel_id,
                msg.sender_device_id,
                msg.encryption_epoch,
                msg.seq,
                msg.ciphertext_b64,
                msg.signature_b64,
                att_json,
                msg.reply_to_message_id,
                msg.created_at.to_rfc3339(),
                msg.edited_at.map(|d| d.to_rfc3339()),
                msg.expires_at.map(|d| d.to_rfc3339()),
                if msg.expire_on_leave { 1 } else { 0 },
                msg.expire_after_view_seconds,
            ],
        )?;
        Ok(true)
    }

    pub fn edit_message(
        &self,
        room_id: &str,
        message_id: &str,
        new_plaintext: &str,
    ) -> P2pResult<(String, String, DateTime<Utc>)> {
        let identity = self.identity()?;
        let row: Option<(String, String, i64)> = self
            .conn
            .query_row(
                "SELECT channel_id, sender_device_id, encryption_epoch FROM messages WHERE id = ?1 AND room_id = ?2 AND deleted_for_everyone = 0",
                params![message_id, room_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;

        let (channel_id, sender, epoch) =
            row.ok_or_else(|| P2pError::NotFound(format!("message {message_id}")))?;
        if sender != identity.device_id {
            return Err(P2pError::PeerRejected(
                "Cannot edit message authored by another peer".into(),
            ));
        }

        let room_key_b64 = self.get_room_key(room_id)?;
        let (ct, sig) = encrypt_and_sign_message(
            room_id,
            &channel_id,
            message_id,
            epoch,
            &room_key_b64,
            &identity,
            new_plaintext,
        )?;
        let edited_at = Utc::now();
        self.apply_remote_edit(room_id, message_id, &ct, &sig, edited_at)?;
        Ok((ct, sig, edited_at))
    }

    pub fn apply_remote_edit(
        &self,
        room_id: &str,
        message_id: &str,
        new_ct: &str,
        new_sig: &str,
        edited_at: DateTime<Utc>,
    ) -> P2pResult<()> {
        // Ensure a remote edit never resurrects a locally suppressed message
        let sup: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM local_suppressions WHERE room_id = ?1 AND kind = 'message_id' AND message_id = ?2 LIMIT 1",
                params![room_id, message_id],
                |r| r.get(0),
            )
            .optional()?;
        if sup.is_some() {
            return Ok(());
        }

        self.conn.execute(
            "UPDATE messages SET ciphertext_b64 = ?1, signature_b64 = ?2, edited_at = ?3
             WHERE id = ?4 AND room_id = ?5",
            params![new_ct, new_sig, edited_at.to_rfc3339(), message_id, room_id],
        )?;
        Ok(())
    }

    pub fn record_and_apply_tombstone(&self, tomb: &DeletionTombstone) -> P2pResult<()> {
        let scope_str = serde_json::to_string(&tomb.scope)?;
        self.conn.execute(
            "INSERT OR IGNORE INTO tombstones (id, room_id, channel_id, message_id, scope, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                tomb.id,
                tomb.room_id,
                tomb.channel_id,
                tomb.message_id,
                scope_str,
                tomb.created_at.to_rfc3339(),
            ],
        )?;

        match tomb.scope {
            TombstoneScope::Burned => {
                let blobs: Vec<String> = {
                    let mut st = self
                        .conn
                        .prepare("SELECT id FROM attachments WHERE room_id = ?1")?;
                    st.query_map(params![tomb.room_id], |r| r.get(0))?
                        .collect::<Result<Vec<_>, _>>()?
                };
                self.conn.execute(
                    "DELETE FROM messages WHERE room_id = ?1",
                    params![tomb.room_id],
                )?;
                self.conn.execute(
                    "DELETE FROM attachments WHERE room_id = ?1",
                    params![tomb.room_id],
                )?;
                self.conn.execute(
                    "UPDATE rooms SET current_epoch = current_epoch + 1 WHERE id = ?1",
                    params![tomb.room_id],
                )?;
                for aid in blobs {
                    let _ = self.delete_attachment_blob_dir(&aid);
                }
            }
            TombstoneScope::Cleared => {
                if let Some(ch) = &tomb.channel_id {
                    self.conn.execute(
                        "DELETE FROM messages WHERE room_id = ?1 AND channel_id = ?2",
                        params![tomb.room_id, ch],
                    )?;
                }
            }
            TombstoneScope::Everyone | TombstoneScope::Expired => {
                if let Some(mid) = &tomb.message_id {
                    self.conn.execute(
                        "DELETE FROM messages WHERE room_id = ?1 AND id = ?2",
                        params![tomb.room_id, mid],
                    )?;
                }
            }
        }
        Ok(())
    }

    pub fn delete_for_me(&self, message_id: &str) -> P2pResult<()> {
        self.conn.execute(
            "UPDATE messages SET deleted_for_me = 1 WHERE id = ?1",
            params![message_id],
        )?;
        Ok(())
    }

    pub fn purge_expired_messages(&self) -> P2pResult<Vec<DeletionTombstone>> {
        let now = Utc::now().to_rfc3339();
        let mut stmt = self.conn.prepare(
            "SELECT id, room_id, channel_id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?1",
        )?;
        let expired: Vec<(String, String, String)> = stmt
            .query_map(params![now], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let mut tombstones = Vec::with_capacity(expired.len());
        for (mid, rid, cid) in expired {
            let tomb = DeletionTombstone {
                id: Uuid::new_v4().to_string(),
                room_id: rid,
                channel_id: Some(cid),
                message_id: Some(mid),
                scope: TombstoneScope::Expired,
                created_at: Utc::now(),
            };
            self.record_and_apply_tombstone(&tomb)?;
            tombstones.push(tomb);
        }
        Ok(tombstones)
    }

    // ==================== Ghost Mode Settings, PIN, Viewed State & Atomic Erasure ====================

    pub fn get_ghost_policy(&self) -> P2pResult<GhostPolicy> {
        let (policy_json, pin_hash): (String, Option<String>) = self.conn.query_row(
            "SELECT policy_json, pin_hash FROM ghost_settings WHERE singleton = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let mut policy: GhostPolicy = serde_json::from_str(&policy_json).unwrap_or_default();
        policy.has_pin_configured = pin_hash.is_some();
        Ok(policy)
    }

    pub fn update_ghost_policy(&self, mut policy: GhostPolicy) -> P2pResult<GhostPolicy> {
        let pin_hash: Option<String> = self.conn.query_row(
            "SELECT pin_hash FROM ghost_settings WHERE singleton = 1",
            [],
            |r| r.get(0),
        )?;
        policy.has_pin_configured = pin_hash.is_some();
        policy.viewed_dwell_ms = policy.viewed_dwell_ms.clamp(200, 30_000);
        if policy.mode == GhostModeLevel::ClearOpenConversation && !policy.destructive_confirmed {
            return Err(P2pError::Validation(
                "Clear Entire Open Conversation requires explicit destructive confirmation".into(),
            ));
        }
        let json = serde_json::to_string(&policy)?;
        self.conn.execute(
            "UPDATE ghost_settings SET policy_json = ?1 WHERE singleton = 1",
            params![json],
        )?;
        Ok(policy)
    }

    pub fn set_ghost_pin(&self, new_pin: Option<&str>) -> P2pResult<GhostPolicy> {
        let hashed = match new_pin {
            Some(p) if !p.trim().is_empty() => Some(hash_pin(p.trim())?),
            _ => None,
        };
        self.conn.execute(
            "UPDATE ghost_settings SET pin_hash = ?1 WHERE singleton = 1",
            params![hashed],
        )?;
        self.get_ghost_policy()
    }

    pub fn verify_ghost_pin(&self, candidate: &str) -> P2pResult<bool> {
        let pin_hash: Option<String> = self.conn.query_row(
            "SELECT pin_hash FROM ghost_settings WHERE singleton = 1",
            [],
            |r| r.get(0),
        )?;
        match pin_hash {
            Some(phc) => verify_pin(candidate.trim(), &phc),
            None => Ok(true),
        }
    }

    pub fn set_room_ghost_override(&self, ov: &GhostRoomOverride) -> P2pResult<()> {
        if !ov.enabled {
            self.conn.execute(
                "DELETE FROM ghost_room_overrides WHERE room_id = ?1",
                params![ov.room_id],
            )?;
            return Ok(());
        }
        let mode_json = serde_json::to_string(&ov.mode)?;
        self.conn.execute(
            "INSERT INTO ghost_room_overrides (room_id, enabled, mode, clear_attachments)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(room_id) DO UPDATE SET
                enabled = excluded.enabled,
                mode = excluded.mode,
                clear_attachments = excluded.clear_attachments",
            params![
                ov.room_id,
                1,
                mode_json,
                ov.clear_attachments.map(|b| if b { 1 } else { 0 }),
            ],
        )?;
        Ok(())
    }

    pub fn get_room_ghost_override(&self, room_id: &str) -> P2pResult<Option<GhostRoomOverride>> {
        self.conn
            .query_row(
                "SELECT room_id, enabled, mode, clear_attachments FROM ghost_room_overrides WHERE room_id = ?1",
                params![room_id],
                |r| {
                    let enabled_i: i64 = r.get(1)?;
                    let mode_json: String = r.get(2)?;
                    let ca_i: Option<i64> = r.get(3)?;
                    Ok(GhostRoomOverride {
                        room_id: r.get(0)?,
                        enabled: enabled_i != 0,
                        mode: serde_json::from_str(&mode_json).unwrap_or(GhostModeLevel::Off),
                        clear_attachments: ca_i.map(|v| v != 0),
                    })
                },
            )
            .optional()
            .map_err(P2pError::from)
    }

    pub fn list_room_ghost_overrides(&self) -> P2pResult<Vec<GhostRoomOverride>> {
        let mut stmt = self.conn.prepare(
            "SELECT room_id, enabled, mode, clear_attachments FROM ghost_room_overrides",
        )?;
        let rows = stmt.query_map([], |r| {
            let enabled_i: i64 = r.get(1)?;
            let mode_json: String = r.get(2)?;
            let ca_i: Option<i64> = r.get(3)?;
            Ok(GhostRoomOverride {
                room_id: r.get(0)?,
                enabled: enabled_i != 0,
                mode: serde_json::from_str(&mode_json).unwrap_or(GhostModeLevel::Off),
                clear_attachments: ca_i.map(|v| v != 0),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(P2pError::from)
    }

    /// Persists viewport-verified viewed timestamps cleanly into SQLite and arms `expire_after_view_seconds` timers.
    pub fn mark_messages_viewed(
        &self,
        room_id: &str,
        channel_id: &str,
        message_ids: &[String],
    ) -> P2pResult<usize> {
        let now = Utc::now();
        let now_str = now.to_rfc3339();
        let mut updated = 0usize;
        for mid in message_ids {
            let existing: Option<(Option<String>, Option<i64>, Option<String>)> = self
                .conn
                .query_row(
                    "SELECT viewed_at, expire_after_view_seconds, expires_at FROM messages WHERE id = ?1 AND room_id = ?2 AND channel_id = ?3",
                    params![mid, room_id, channel_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            if let Some((viewed_at, after_view_secs, existing_exp)) = existing
                && viewed_at.is_none()
            {
                let next_exp = match (existing_exp, after_view_secs) {
                    (Some(e), _) => Some(e),
                    (None, Some(secs)) => Some((now + Duration::seconds(secs.max(0))).to_rfc3339()),
                    (None, None) => None,
                };
                self.conn.execute(
                    "UPDATE messages SET viewed_at = ?1, expires_at = ?2 WHERE id = ?3",
                    params![now_str, next_exp, mid],
                )?;
                updated += 1;
            }
        }
        Ok(updated)
    }

    /// Expires messages marked `expire_on_leave` when leaving a conversation.
    pub fn purge_on_leave_messages(&self, room_id: &str, channel_id: &str) -> P2pResult<usize> {
        let mut stmt = self.conn.prepare(
            "SELECT id, attachment_ids_json FROM messages WHERE room_id = ?1 AND channel_id = ?2 AND expire_on_leave = 1 AND viewed_at IS NOT NULL",
        )?;
        let rows: Vec<(String, String)> = stmt
            .query_map(params![room_id, channel_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        if rows.is_empty() {
            return Ok(0);
        }

        let now = Utc::now().to_rfc3339();
        let mut att_candidates = HashSet::new();
        for (mid, att_json) in &rows {
            if let Ok(aids) = serde_json::from_str::<Vec<String>>(att_json) {
                att_candidates.extend(aids);
            }
            self.conn.execute(
                "INSERT OR IGNORE INTO local_suppressions (id, room_id, channel_id, message_id, kind, created_at)
                 VALUES (?1, ?2, ?3, ?4, 'message_id', ?5)",
                params![Uuid::new_v4().to_string(), room_id, channel_id, mid, now],
            )?;
            self.conn
                .execute("DELETE FROM messages WHERE id = ?1", params![mid])?;
        }
        self.cleanup_orphan_attachments(att_candidates)?;
        Ok(rows.len())
    }

    /// Executes a local-only scoped Ghost/Stealth deletion (`KeepAll` is a no-op).
    pub fn execute_local_deletion(
        &self,
        room_id: &str,
        channel_id: &str,
        action: LocalDeletionAction,
        clear_attachments: bool,
    ) -> P2pResult<GhostDeletionSummary> {
        match action {
            LocalDeletionAction::KeepAll => Ok(make_cleanup_summary(
                room_id.to_string(),
                channel_id.to_string(),
                GhostModeLevel::PrivacyShield,
                0,
                0,
                0,
            )),
            LocalDeletionAction::DeleteActiveConversation => self.execute_ghost_clear(
                room_id,
                channel_id,
                GhostModeLevel::ClearOpenConversation,
                clear_attachments,
            ),
            LocalDeletionAction::DeleteViewedLocal => self.execute_ghost_clear(
                room_id,
                channel_id,
                GhostModeLevel::ClearViewed,
                clear_attachments,
            ),
            LocalDeletionAction::DeleteIncomingViewedLocal
            | LocalDeletionAction::DeleteOutgoingViewedLocal => {
                let intent_id = Uuid::new_v4().to_string();
                let mode_str = serde_json::to_string(&GhostModeLevel::ClearViewed)?;
                self.conn.execute(
                    "INSERT INTO deletion_intents (id, room_id, channel_id, mode, clear_attachments, status, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)",
                    params![
                        intent_id,
                        room_id,
                        channel_id,
                        mode_str,
                        if clear_attachments { 1 } else { 0 },
                        Utc::now().to_rfc3339(),
                    ],
                )?;
                let filter_outgoing_only = action == LocalDeletionAction::DeleteOutgoingViewedLocal;
                let summary = self.apply_scoped_viewed_deletion(
                    &intent_id,
                    room_id,
                    channel_id,
                    clear_attachments,
                    Some(filter_outgoing_only),
                )?;
                Ok(summary)
            }
        }
    }

    /// Executes an atomic local-only Ghost Mode wipe (preserving identity, peer pairings, other channels, and remote peer's copy).
    pub fn execute_ghost_clear(
        &self,
        room_id: &str,
        channel_id: &str,
        mode: GhostModeLevel,
        clear_attachments: bool,
    ) -> P2pResult<GhostDeletionSummary> {
        if !matches!(
            mode,
            GhostModeLevel::ClearViewed | GhostModeLevel::ClearOpenConversation
        ) {
            return Ok(make_cleanup_summary(
                room_id.to_string(),
                channel_id.to_string(),
                mode,
                0,
                0,
                0,
            ));
        }

        let intent_id = Uuid::new_v4().to_string();
        let mode_str = serde_json::to_string(&mode)?;
        self.conn.execute(
            "INSERT INTO deletion_intents (id, room_id, channel_id, mode, clear_attachments, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)",
            params![
                intent_id,
                room_id,
                channel_id,
                mode_str,
                if clear_attachments { 1 } else { 0 },
                Utc::now().to_rfc3339(),
            ],
        )?;

        let summary =
            self.apply_deletion_intent(&intent_id, room_id, channel_id, mode, clear_attachments)?;
        Ok(summary)
    }

    fn apply_scoped_viewed_deletion(
        &self,
        intent_id: &str,
        room_id: &str,
        channel_id: &str,
        clear_attachments: bool,
        outgoing_only_opt: Option<bool>,
    ) -> P2pResult<GhostDeletionSummary> {
        let local_dev = self.identity()?.device_id;
        let now = Utc::now().to_rfc3339();
        let mut att_candidates = HashSet::new();
        let mut deleted_messages = 0usize;

        let mut stmt = self.conn.prepare(
            "SELECT id, sender_device_id, attachment_ids_json FROM messages
             WHERE room_id = ?1 AND channel_id = ?2 AND viewed_at IS NOT NULL",
        )?;
        let viewed_rows: Vec<(String, String, String)> = stmt
            .query_map(params![room_id, channel_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        for (mid, sender, att_json) in viewed_rows {
            if let Some(outgoing_only) = outgoing_only_opt {
                let is_out = sender == local_dev;
                if outgoing_only != is_out {
                    continue;
                }
            }
            if let Ok(aids) = serde_json::from_str::<Vec<String>>(&att_json) {
                att_candidates.extend(aids);
            }
            self.conn.execute(
                "INSERT OR IGNORE INTO local_suppressions (id, room_id, channel_id, message_id, kind, created_at)
                 VALUES (?1, ?2, ?3, ?4, 'message_id', ?5)",
                params![Uuid::new_v4().to_string(), room_id, channel_id, mid, now],
            )?;
            self.conn
                .execute("DELETE FROM messages WHERE id = ?1", params![mid])?;
            deleted_messages += 1;
        }

        let deleted_attachments = if clear_attachments {
            self.cleanup_orphan_attachments(att_candidates)?
        } else {
            0
        };
        let preserved_unread: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE room_id = ?1 AND channel_id = ?2 AND deleted_for_me = 0 AND deleted_for_everyone = 0",
            params![room_id, channel_id],
            |r| r.get(0),
        )?;
        self.conn.execute(
            "UPDATE deletion_intents SET status = 'completed' WHERE id = ?1",
            params![intent_id],
        )?;
        let _ = self.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");

        Ok(make_cleanup_summary(
            room_id.to_string(),
            channel_id.to_string(),
            GhostModeLevel::ClearViewed,
            deleted_messages,
            deleted_attachments,
            preserved_unread as usize,
        ))
    }

    fn recover_pending_deletion_intents(&self) -> P2pResult<usize> {
        let mut stmt = self.conn.prepare(
            "SELECT id, room_id, channel_id, mode, clear_attachments FROM deletion_intents WHERE status = 'pending'",
        )?;
        let pending: Vec<(String, String, String, String, i64)> = stmt
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let count = pending.len();
        for (id, room_id, channel_id, mode_json, clear_att) in pending {
            let mode: GhostModeLevel =
                serde_json::from_str(&mode_json).unwrap_or(GhostModeLevel::ClearViewed);
            self.apply_deletion_intent(&id, &room_id, &channel_id, mode, clear_att != 0)?;
        }
        Ok(count)
    }

    fn apply_deletion_intent(
        &self,
        intent_id: &str,
        room_id: &str,
        channel_id: &str,
        mode: GhostModeLevel,
        clear_attachments: bool,
    ) -> P2pResult<GhostDeletionSummary> {
        let policy = self.get_ghost_policy()?;
        let local_dev = self.identity()?.device_id;
        let now = Utc::now().to_rfc3339();
        let mut att_candidates = HashSet::new();
        let mut deleted_messages = 0usize;

        match mode {
            GhostModeLevel::ClearViewed => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, sender_device_id, attachment_ids_json FROM messages
                     WHERE room_id = ?1 AND channel_id = ?2 AND viewed_at IS NOT NULL",
                )?;
                let viewed_rows: Vec<(String, String, String)> = stmt
                    .query_map(params![room_id, channel_id], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                drop(stmt);

                for (mid, sender, att_json) in viewed_rows {
                    if policy.outgoing_viewed_policy == OutgoingViewedPolicy::PreserveOutgoing
                        && sender == local_dev
                    {
                        continue;
                    }
                    if let Ok(aids) = serde_json::from_str::<Vec<String>>(&att_json) {
                        att_candidates.extend(aids);
                    }
                    self.conn.execute(
                        "INSERT OR IGNORE INTO local_suppressions (id, room_id, channel_id, message_id, kind, created_at)
                         VALUES (?1, ?2, ?3, ?4, 'message_id', ?5)",
                        params![Uuid::new_v4().to_string(), room_id, channel_id, mid, now],
                    )?;
                    self.conn
                        .execute("DELETE FROM messages WHERE id = ?1", params![mid])?;
                    deleted_messages += 1;
                }
            }
            GhostModeLevel::ClearOpenConversation => {
                let (max_seq, max_ts): (Option<i64>, Option<String>) = self.conn.query_row(
                    "SELECT MAX(seq), MAX(created_at) FROM messages WHERE room_id = ?1 AND channel_id = ?2",
                    params![room_id, channel_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?;

                let mut stmt = self.conn.prepare(
                    "SELECT id, attachment_ids_json FROM messages WHERE room_id = ?1 AND channel_id = ?2",
                )?;
                let all_rows: Vec<(String, String)> = stmt
                    .query_map(params![room_id, channel_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                drop(stmt);

                deleted_messages = all_rows.len();
                for (_mid, att_json) in all_rows {
                    if let Ok(aids) = serde_json::from_str::<Vec<String>>(&att_json) {
                        att_candidates.extend(aids);
                    }
                }

                if max_seq.is_some() || max_ts.is_some() {
                    self.conn.execute(
                        "INSERT INTO local_suppressions (id, room_id, channel_id, max_suppressed_seq, max_suppressed_created_at, kind, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, 'channel_cutoff', ?6)",
                        params![
                            Uuid::new_v4().to_string(),
                            room_id,
                            channel_id,
                            max_seq,
                            max_ts,
                            now
                        ],
                    )?;
                }

                self.conn.execute(
                    "DELETE FROM messages WHERE room_id = ?1 AND channel_id = ?2",
                    params![room_id, channel_id],
                )?;
            }
            GhostModeLevel::Off | GhostModeLevel::PrivacyShield => {}
        }

        let deleted_attachments = if clear_attachments {
            self.cleanup_orphan_attachments(att_candidates)?
        } else {
            0
        };

        let preserved_unread: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE room_id = ?1 AND channel_id = ?2 AND deleted_for_me = 0 AND deleted_for_everyone = 0",
            params![room_id, channel_id],
            |r| r.get(0),
        )?;

        self.conn.execute(
            "UPDATE deletion_intents SET status = 'completed' WHERE id = ?1",
            params![intent_id],
        )?;

        // Flush WAL freed pages cleanly so wiped plaintext/ciphertext doesn't sit uncheckpointed in WAL
        let _ = self.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");

        Ok(make_cleanup_summary(
            room_id.to_string(),
            channel_id.to_string(),
            mode,
            deleted_messages,
            deleted_attachments,
            preserved_unread as usize,
        ))
    }

    fn cleanup_orphan_attachments(&self, candidate_ids: HashSet<String>) -> P2pResult<usize> {
        if candidate_ids.is_empty() {
            return Ok(0);
        }
        let mut stmt = self
            .conn
            .prepare("SELECT attachment_ids_json FROM messages")?;
        let active_jsons: Vec<String> = stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let mut referenced = HashSet::new();
        for json in active_jsons {
            if let Ok(list) = serde_json::from_str::<Vec<String>>(&json) {
                referenced.extend(list);
            }
        }

        let mut removed = 0usize;
        for aid in candidate_ids {
            if !referenced.contains(&aid) {
                self.conn
                    .execute("DELETE FROM attachments WHERE id = ?1", params![aid])?;
                if self.delete_attachment_blob_dir(&aid).is_ok() {
                    removed += 1;
                }
            }
        }
        Ok(removed)
    }

    fn delete_attachment_blob_dir(&self, attachment_id: &str) -> P2pResult<()> {
        validate_uuid_component(attachment_id, "attachment_id")?;
        let dir = self.blobs_dir.join(attachment_id);
        if dir.exists() {
            std::fs::remove_dir_all(dir)?;
        }
        Ok(())
    }

    /// Reads and decrypts all visible channel messages from local SQLite for UI or search rendering.
    pub fn list_decrypted_channel_messages(
        &self,
        room_id: &str,
        channel_id: &str,
    ) -> P2pResult<Vec<DecryptedMessageView>> {
        let _ = self.purge_expired_messages()?;
        let identity = self.identity()?;
        let room_key_b64 = self.get_room_key(room_id)?;

        let mut stmt = self.conn.prepare(
            "SELECT id, room_id, channel_id, sender_device_id, encryption_epoch, seq, ciphertext_b64, signature_b64, attachment_ids_json, reply_to_message_id, created_at, edited_at, expires_at, viewed_at, expire_on_leave, expire_after_view_seconds
             FROM messages
             WHERE room_id = ?1 AND channel_id = ?2 AND deleted_for_me = 0 AND deleted_for_everyone = 0
             ORDER BY created_at ASC, seq ASC",
        )?;
        let stored: Vec<(StoredMessage, Option<DateTime<Utc>>)> = stmt
            .query_map(params![room_id, channel_id], |row| {
                let msg = Self::map_stored_msg_row(row)?;
                let viewed_raw: Option<String> = row.get(13)?;
                Ok((msg, viewed_raw.and_then(|s| parse_utc(&s).ok())))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let mut views = Vec::with_capacity(stored.len());
        for (msg, viewed_at) in stored {
            let is_outgoing = msg.sender_device_id == identity.device_id;
            let sender_pub = if is_outgoing {
                Some(identity.ed25519_public_b64.clone())
            } else {
                self.get_peer(&msg.sender_device_id)?
                    .map(|p| p.ed25519_public_key_b64)
            };

            let (text, verified) =
                match decrypt_and_verify_message(&msg, &room_key_b64, sender_pub.as_deref()) {
                    Ok(v) => v,
                    Err(_) => (
                        "[Unable to decrypt message with current local key]".into(),
                        false,
                    ),
                };

            let mut attachments = Vec::new();
            for aid in &msg.attachment_ids {
                if let Some(meta) = self.get_attachment_meta(aid)? {
                    attachments.push(meta);
                }
            }

            views.push(DecryptedMessageView {
                id: msg.id,
                room_id: msg.room_id,
                channel_id: msg.channel_id,
                sender_device_id: msg.sender_device_id,
                encryption_epoch: msg.encryption_epoch,
                seq: msg.seq,
                text,
                signature_verified: verified,
                attachments,
                reply_to_message_id: msg.reply_to_message_id,
                created_at: msg.created_at,
                edited_at: msg.edited_at,
                expires_at: msg.expires_at,
                viewed_at,
                is_outgoing,
                expire_on_leave: msg.expire_on_leave,
                expire_after_view_seconds: msg.expire_after_view_seconds,
            });
        }
        Ok(views)
    }

    pub fn list_stored_messages_since(
        &self,
        room_id: &str,
        after_seq: i64,
    ) -> P2pResult<Vec<StoredMessage>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, room_id, channel_id, sender_device_id, encryption_epoch, seq, ciphertext_b64, signature_b64, attachment_ids_json, reply_to_message_id, created_at, edited_at, expires_at, expire_on_leave, expire_after_view_seconds
             FROM messages
             WHERE room_id = ?1 AND seq > ?2 AND deleted_for_everyone = 0
             ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![room_id, after_seq], Self::map_stored_msg_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(P2pError::from)
    }

    pub fn list_tombstones_for_room(&self, room_id: &str) -> P2pResult<Vec<DeletionTombstone>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, room_id, channel_id, message_id, scope, created_at FROM tombstones WHERE room_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![room_id], |row| {
            let scope_json: String = row.get(4)?;
            let ts: String = row.get(5)?;
            Ok(DeletionTombstone {
                id: row.get(0)?,
                room_id: row.get(1)?,
                channel_id: row.get(2)?,
                message_id: row.get(3)?,
                scope: serde_json::from_str(&scope_json).unwrap_or(TombstoneScope::Everyone),
                created_at: parse_utc(&ts).unwrap_or_else(|_| Utc::now()),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(P2pError::from)
    }

    fn map_stored_msg_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredMessage> {
        let att_json: String = row.get(8)?;
        let created_raw: String = row.get(10)?;
        let edited_raw: Option<String> = row.get(11)?;
        let expires_raw: Option<String> = row.get(12)?;
        let expire_on_leave: i64 = row.get(14).unwrap_or(0);
        let expire_after_view_seconds: Option<i64> = row.get(15).unwrap_or(None);
        Ok(StoredMessage {
            id: row.get(0)?,
            room_id: row.get(1)?,
            channel_id: row.get(2)?,
            sender_device_id: row.get(3)?,
            encryption_epoch: row.get(4)?,
            seq: row.get(5)?,
            ciphertext_b64: row.get(6)?,
            signature_b64: row.get(7)?,
            attachment_ids: serde_json::from_str(&att_json).unwrap_or_default(),
            reply_to_message_id: row.get(9)?,
            created_at: parse_utc(&created_raw).unwrap_or_else(|_| Utc::now()),
            edited_at: edited_raw.and_then(|s| parse_utc(&s).ok()),
            expires_at: expires_raw.and_then(|s| parse_utc(&s).ok()),
            expire_on_leave: expire_on_leave != 0,
            expire_after_view_seconds,
        })
    }

    /// Saves a file cleanly into chunked local storage and records SHA-256 metadata in SQLite.
    pub fn store_local_attachment(
        &self,
        room_id: &str,
        filename: &str,
        mime_type: &str,
        bytes: &[u8],
        chunk_size: usize,
    ) -> P2pResult<LocalAttachmentMeta> {
        let chunk_size = chunk_size.max(1024);
        let id = Uuid::new_v4().to_string();
        let safe_name = sanitize_attachment_filename(filename);
        let digest = sha256_hex(bytes);
        let dir = self.blobs_dir.join(&id);
        std::fs::create_dir_all(&dir)?;

        let mut total_chunks: u32 = 0;
        if bytes.is_empty() {
            let sealed = self.vault_box.seal_bytes(&format!("blob:{id}:0"), &[])?;
            std::fs::write(dir.join("chunk_0.bin"), sealed)?;
            total_chunks = 1;
        } else {
            for (idx, chunk) in bytes.chunks(chunk_size).enumerate() {
                let sealed = self
                    .vault_box
                    .seal_bytes(&format!("blob:{id}:{idx}"), chunk)?;
                std::fs::write(dir.join(format!("chunk_{idx}.bin")), sealed)?;
                total_chunks += 1;
            }
        }

        let meta = LocalAttachmentMeta {
            id,
            room_id: room_id.to_string(),
            filename: safe_name,
            mime_type: mime_type.to_string(),
            total_size_bytes: bytes.len() as u64,
            chunk_size_bytes: chunk_size as u32,
            total_chunks,
            sha256_hex: digest,
        };
        self.register_attachment_meta(&meta)?;
        Ok(meta)
    }

    pub fn register_attachment_meta(&self, meta: &LocalAttachmentMeta) -> P2pResult<()> {
        validate_uuid_component(&meta.id, "attachment_id")?;
        if meta.total_size_bytes > 256 * 1024 * 1024 {
            return Err(P2pError::Validation(
                "Attachment exceeds 256 MiB limit".into(),
            ));
        }
        let safe_name = sanitize_attachment_filename(&meta.filename);
        let dir = self.blobs_dir.join(&meta.id);
        std::fs::create_dir_all(dir)?;
        self.conn.execute(
            "INSERT OR REPLACE INTO attachments (id, room_id, filename, mime_type, total_size_bytes, chunk_size_bytes, total_chunks, sha256_hex, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                meta.id,
                meta.room_id,
                safe_name,
                meta.mime_type,
                meta.total_size_bytes as i64,
                meta.chunk_size_bytes as i64,
                meta.total_chunks as i64,
                meta.sha256_hex,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn write_attachment_chunk(
        &self,
        attachment_id: &str,
        chunk_index: u32,
        data_b64: &str,
    ) -> P2pResult<()> {
        validate_uuid_component(attachment_id, "attachment_id")?;
        if self.get_attachment_meta(attachment_id)?.is_none() {
            return Err(P2pError::PeerRejected(format!(
                "Refusing chunk for unregistered attachment {attachment_id}"
            )));
        }
        let bytes = STANDARD
            .decode(data_b64.trim())
            .map_err(|e| P2pError::Protocol(format!("invalid chunk base64: {e}")))?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(P2pError::Protocol("Attachment chunk exceeds 2 MiB".into()));
        }
        let sealed = self
            .vault_box
            .seal_bytes(&format!("blob:{attachment_id}:{chunk_index}"), &bytes)?;
        let dir = self.blobs_dir.join(attachment_id);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join(format!("chunk_{chunk_index}.bin")), sealed)?;
        Ok(())
    }

    pub fn read_attachment_chunk(
        &self,
        attachment_id: &str,
        chunk_index: u32,
    ) -> P2pResult<Vec<u8>> {
        validate_uuid_component(attachment_id, "attachment_id")?;
        let path = self
            .blobs_dir
            .join(attachment_id)
            .join(format!("chunk_{chunk_index}.bin"));
        let raw = std::fs::read(path)?;
        self.vault_box
            .open_bytes(&format!("blob:{attachment_id}:{chunk_index}"), &raw)
    }

    /// Reassembles all local attachment chunks and verifies exact SHA-256 digest before returning.
    pub fn read_verified_attachment_bytes(&self, attachment_id: &str) -> P2pResult<Vec<u8>> {
        validate_uuid_component(attachment_id, "attachment_id")?;
        let meta = self
            .get_attachment_meta(attachment_id)?
            .ok_or_else(|| P2pError::NotFound(format!("attachment {attachment_id}")))?;
        let mut assembled = Vec::with_capacity(meta.total_size_bytes as usize);
        for idx in 0..meta.total_chunks {
            assembled.extend_from_slice(&self.read_attachment_chunk(attachment_id, idx)?);
        }
        let actual = sha256_hex(&assembled);
        if actual != meta.sha256_hex {
            return Err(P2pError::Crypto(format!(
                "attachment SHA-256 mismatch: expected {}, got {actual}",
                meta.sha256_hex
            )));
        }
        Ok(assembled)
    }

    pub fn get_attachment_meta(
        &self,
        attachment_id: &str,
    ) -> P2pResult<Option<LocalAttachmentMeta>> {
        self.conn
            .query_row(
                "SELECT id, room_id, filename, mime_type, total_size_bytes, chunk_size_bytes, total_chunks, sha256_hex FROM attachments WHERE id = ?1",
                params![attachment_id],
                |row| {
                    Ok(LocalAttachmentMeta {
                        id: row.get(0)?,
                        room_id: row.get(1)?,
                        filename: row.get(2)?,
                        mime_type: row.get(3)?,
                        total_size_bytes: row.get::<_, i64>(4)? as u64,
                        chunk_size_bytes: row.get::<_, i64>(5)? as u32,
                        total_chunks: row.get::<_, i64>(6)? as u32,
                        sha256_hex: row.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(P2pError::from)
    }

    pub fn queue_outbox_frame(&self, peer_device_id: &str, frame: &WireFrame) -> P2pResult<()> {
        let frame_json = serde_json::to_string(frame)?;
        self.conn.execute(
            "INSERT INTO outbox (peer_device_id, frame_json, attempts, created_at) VALUES (?1, ?2, 0, ?3)",
            params![peer_device_id, frame_json, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn pop_outbox_for_peer(&self, peer_device_id: &str) -> P2pResult<Vec<WireFrame>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, frame_json FROM outbox WHERE peer_device_id = ?1 ORDER BY id ASC",
        )?;
        let rows: Vec<(i64, String)> = stmt
            .query_map(params![peer_device_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let mut frames = Vec::with_capacity(rows.len());
        for (row_id, json) in rows {
            if let Ok(frame) = serde_json::from_str::<WireFrame>(&json) {
                frames.push(frame);
            }
            self.conn
                .execute("DELETE FROM outbox WHERE id = ?1", params![row_id])?;
        }
        Ok(frames)
    }
}

fn parse_utc(raw: &str) -> P2pResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|e| P2pError::Protocol(format!("invalid RFC3339 timestamp '{raw}': {e}")))
}
