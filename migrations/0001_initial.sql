-- Cloak PostgreSQL Schema v1
-- Privacy boundary: The server NEVER stores plaintext messages, filenames, passwords,
-- or unwrapped content encryption keys. All message bodies and file metadata remain
-- authenticated ciphertext controlled by client devices.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Device Identities (Anonymous-first cryptographic identities)
CREATE TABLE device_identities (
    id UUID PRIMARY KEY,
    ed25519_public_key BYTEA NOT NULL UNIQUE,
    x25519_public_key BYTEA NOT NULL,
    display_name VARCHAR(64) NOT NULL DEFAULT 'Anonymous',
    avatar_color VARCHAR(16) NOT NULL DEFAULT '#7c6cff',
    avatar_emoji VARCHAR(16),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_ed25519_len CHECK (octet_length(ed25519_public_key) = 32),
    CONSTRAINT chk_x25519_len CHECK (octet_length(x25519_public_key) = 32)
);

CREATE INDEX idx_device_identities_last_seen ON device_identities (last_seen_at DESC);

-- Short-lived single-use challenge nonces for replay-protected Ed25519 login
CREATE TABLE auth_challenges (
    id UUID PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES device_identities(id) ON DELETE CASCADE,
    nonce BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_auth_challenges_device_exp ON auth_challenges (device_id, expires_at);

-- 2. Revoked Credentials (JWT JTIs, revoked device tokens)
CREATE TABLE revoked_credentials (
    jti UUID PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES device_identities(id) ON DELETE CASCADE,
    reason VARCHAR(128) NOT NULL,
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_revoked_credentials_expires ON revoked_credentials (expires_at);

-- 3. Rooms (Stable opaque ID independent of message history)
CREATE TABLE rooms (
    id UUID PRIMARY KEY,
    room_kind VARCHAR(16) NOT NULL DEFAULT 'group', -- dm | group | community
    name VARCHAR(100) NOT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    owner_device_id UUID NOT NULL REFERENCES device_identities(id),
    current_epoch BIGINT NOT NULL DEFAULT 1,
    default_disappear_seconds INTEGER, -- NULL = retained until deleted/burned
    quota_bytes BIGINT NOT NULL DEFAULT 536870912,
    used_bytes BIGINT NOT NULL DEFAULT 0,
    next_event_seq BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_room_kind CHECK (room_kind IN ('dm', 'group', 'community')),
    CONSTRAINT chk_room_epoch CHECK (current_epoch >= 1),
    CONSTRAINT chk_room_quota CHECK (quota_bytes >= 0 AND used_bytes >= 0)
);

CREATE INDEX idx_rooms_owner ON rooms (owner_device_id);
CREATE INDEX idx_rooms_active ON rooms (id) WHERE deleted_at IS NULL;

-- 4. Roles & Permissions (Normalized RBAC per room)
CREATE TABLE roles (
    id UUID PRIMARY KEY,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name VARCHAR(48) NOT NULL, -- owner | admin | member | readonly | custom
    rank INTEGER NOT NULL DEFAULT 0,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (room_id, name)
);

CREATE INDEX idx_roles_room ON roles (room_id);

CREATE TABLE permissions (
    id UUID PRIMARY KEY,
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_key VARCHAR(64) NOT NULL,
    allowed BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (role_id, permission_key)
);

CREATE INDEX idx_permissions_role ON permissions (role_id);

-- 5. Memberships (Authorized devices per room + ban/approval state)
CREATE TABLE memberships (
    id UUID PRIMARY KEY,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES device_identities(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES roles(id),
    status VARCHAR(24) NOT NULL DEFAULT 'active', -- active | pending_approval | removed | banned
    nickname_override VARCHAR(64),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_at TIMESTAMPTZ,
    removed_by_device_id UUID REFERENCES device_identities(id),
    UNIQUE (room_id, device_id),
    CONSTRAINT chk_membership_status CHECK (status IN ('active', 'pending_approval', 'removed', 'banned'))
);

CREATE INDEX idx_memberships_device_status ON memberships (device_id, status);
CREATE INDEX idx_memberships_room_status ON memberships (room_id, status);

-- 6. Channels (Text, Voice, Announcement, Categories)
CREATE TABLE channels (
    id UUID PRIMARY KEY,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    category_name VARCHAR(64),
    name VARCHAR(64) NOT NULL,
    topic VARCHAR(256) NOT NULL DEFAULT '',
    channel_type VARCHAR(24) NOT NULL DEFAULT 'text', -- text | voice | announcement
    position INTEGER NOT NULL DEFAULT 0,
    is_private BOOLEAN NOT NULL DEFAULT FALSE,
    slow_mode_seconds INTEGER NOT NULL DEFAULT 0,
    disappear_seconds INTEGER,
    created_by_device_id UUID NOT NULL REFERENCES device_identities(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMPTZ,
    CONSTRAINT chk_channel_type CHECK (channel_type IN ('text', 'voice', 'announcement')),
    CONSTRAINT chk_slow_mode CHECK (slow_mode_seconds >= 0)
);

CREATE INDEX idx_channels_room_pos ON channels (room_id, position) WHERE archived_at IS NULL;

-- Per-channel permission overrides (for invite-only or read-only channels)
CREATE TABLE channel_role_overrides (
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    can_view BOOLEAN NOT NULL DEFAULT TRUE,
    can_send BOOLEAN NOT NULL DEFAULT TRUE,
    can_connect_voice BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (channel_id, role_id)
);

-- 7. Room Encryption Epochs & Per-Device Wrapped Epoch Keys
CREATE TABLE room_encryption_epochs (
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    epoch BIGINT NOT NULL,
    created_by_device_id UUID NOT NULL REFERENCES device_identities(id),
    reason VARCHAR(64) NOT NULL DEFAULT 'initial', -- initial | member_removed | room_burned | manual_rotate
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_id, epoch)
);

CREATE TABLE epoch_key_envelopes (
    id UUID PRIMARY KEY,
    room_id UUID NOT NULL,
    epoch BIGINT NOT NULL,
    recipient_device_id UUID NOT NULL REFERENCES device_identities(id) ON DELETE CASCADE,
    sender_device_id UUID NOT NULL REFERENCES device_identities(id),
    sender_x25519_public_key BYTEA NOT NULL,
    wrapped_key_ciphertext BYTEA NOT NULL, -- crypto_box_easy ciphertext + 24-byte nonce
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (room_id, epoch, recipient_device_id),
    FOREIGN KEY (room_id, epoch) REFERENCES room_encryption_epochs(room_id, epoch) ON DELETE CASCADE,
    CONSTRAINT chk_sender_x25519_len CHECK (octet_length(sender_x25519_public_key) = 32)
);

CREATE INDEX idx_epoch_envelopes_recipient ON epoch_key_envelopes (recipient_device_id, room_id, epoch DESC);

-- 8. Invitations (Hash-indexed tokens, optional password gate, fragment-encrypted key envelopes)
CREATE TABLE invitations (
    id UUID PRIMARY KEY,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    created_by_device_id UUID NOT NULL REFERENCES device_identities(id),
    token_hash BYTEA NOT NULL UNIQUE, -- SHA-256 of invite token
    role_id UUID NOT NULL REFERENCES roles(id),
    access_scope VARCHAR(16) NOT NULL DEFAULT 'read_write', -- read_only | read_write
    requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
    password_hash TEXT, -- Argon2id verifier for server gate (never used as E2EE key!)
    wrapped_epoch BIGINT NOT NULL,
    wrapped_room_key_blob BYTEA NOT NULL, -- XChaCha20-Poly1305 encrypted under fragment secret (+ optional password)
    max_uses INTEGER,
    uses_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoked_by_device_id UUID REFERENCES device_identities(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_invite_scope CHECK (access_scope IN ('read_only', 'read_write')),
    CONSTRAINT chk_invite_uses CHECK (uses_count >= 0 AND (max_uses IS NULL OR max_uses >= 1))
);

CREATE INDEX idx_invitations_room ON invitations (room_id, created_at DESC);

-- 9. Encrypted Messages (Server stores ciphertext only)
CREATE TABLE encrypted_messages (
    id UUID PRIMARY KEY, -- Client-generated UUIDv4/v7
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    sender_device_id UUID NOT NULL REFERENCES device_identities(id),
    idempotency_key UUID NOT NULL,
    encryption_epoch BIGINT NOT NULL,
    event_seq BIGINT NOT NULL,
    ciphertext BYTEA NOT NULL, -- Includes nonce + AEAD tag + encrypted JSON body + sender signature
    ciphertext_version SMALLINT NOT NULL DEFAULT 1,
    reply_to_message_id UUID,
    thread_root_id UUID,
    edited_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    expire_after_read_seconds INTEGER,
    deleted_for_everyone_at TIMESTAMPTZ,
    deleted_by_device_id UUID REFERENCES device_identities(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (room_id, sender_device_id, idempotency_key),
    UNIQUE (room_id, event_seq)
);

CREATE INDEX idx_encrypted_messages_channel_seq ON encrypted_messages (channel_id, event_seq DESC);
CREATE INDEX idx_encrypted_messages_room_seq ON encrypted_messages (room_id, event_seq ASC);
CREATE INDEX idx_encrypted_messages_expires ON encrypted_messages (expires_at) WHERE expires_at IS NOT NULL AND deleted_for_everyone_at IS NULL;

-- 10. Monotonic Room Event Log (Cursor-based sync, edits, deletes, pins, reactions, burns)
CREATE TABLE message_events (
    id UUID PRIMARY KEY,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    message_id UUID,
    actor_device_id UUID NOT NULL REFERENCES device_identities(id),
    event_seq BIGINT NOT NULL,
    event_type VARCHAR(40) NOT NULL, -- message.created | message.edited | message.deleted | message.reacted | message.pinned | room.burned | channel.updated | member.updated
    encrypted_payload BYTEA, -- Ciphertext for edit/reaction payloads; NULL for metadata-only events
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (room_id, event_seq)
);

CREATE INDEX idx_message_events_room_seq ON message_events (room_id, event_seq ASC);

-- 11. Message Tombstones (Delete-for-me, Delete-for-everyone, Expired, Burned)
CREATE TABLE message_tombstones (
    id UUID PRIMARY KEY,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id UUID NOT NULL,
    scope VARCHAR(24) NOT NULL, -- device | everyone | expired | burned | cleared
    target_device_id UUID REFERENCES device_identities(id) ON DELETE CASCADE, -- non-NULL only when scope = 'device'
    actor_device_id UUID NOT NULL REFERENCES device_identities(id),
    event_seq BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_tombstone_scope CHECK (scope IN ('device', 'everyone', 'expired', 'burned', 'cleared'))
);

CREATE INDEX idx_tombstones_room_seq ON message_tombstones (room_id, event_seq ASC);
CREATE INDEX idx_tombstones_message ON message_tombstones (message_id);

-- 12. Pinned Messages (References message ID only; content stays E2EE)
CREATE TABLE channel_pins (
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES encrypted_messages(id) ON DELETE CASCADE,
    pinned_by_device_id UUID NOT NULL REFERENCES device_identities(id),
    pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, message_id)
);

-- 13. Encrypted Attachments, Chunks & References (No plaintext filenames or MIME on server)
CREATE TABLE encrypted_attachments (
    id UUID PRIMARY KEY,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    uploader_device_id UUID NOT NULL REFERENCES device_identities(id),
    encryption_epoch BIGINT NOT NULL,
    state VARCHAR(24) NOT NULL DEFAULT 'pending', -- pending | uploading | uploaded | failed | expired | deleted | unavailable
    object_key TEXT NOT NULL,
    expected_ciphertext_bytes BIGINT NOT NULL,
    actual_ciphertext_bytes BIGINT NOT NULL DEFAULT 0,
    chunk_size_bytes INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    ciphertext_sha256 BYTEA,
    stream_header BYTEA NOT NULL, -- 24-byte secretstream header (safe without file_key)
    expires_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_attachment_state CHECK (state IN ('pending', 'uploading', 'uploaded', 'failed', 'expired', 'deleted', 'unavailable')),
    CONSTRAINT chk_stream_header_len CHECK (octet_length(stream_header) = 24)
);

CREATE INDEX idx_attachments_room_state ON encrypted_attachments (room_id, state);
CREATE INDEX idx_attachments_expires ON encrypted_attachments (expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE attachment_chunks (
    attachment_id UUID NOT NULL REFERENCES encrypted_attachments(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    object_key TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    sha256 BYTEA NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (attachment_id, chunk_index)
);

CREATE TABLE attachment_references (
    attachment_id UUID NOT NULL REFERENCES encrypted_attachments(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES encrypted_messages(id) ON DELETE CASCADE,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (attachment_id, message_id)
);

CREATE INDEX idx_attachment_refs_message ON attachment_references (message_id);

-- 14. Call Sessions (LiveKit metadata & active participants)
CREATE TABLE call_sessions (
    id UUID PRIMARY KEY,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    livekit_room_name VARCHAR(128) NOT NULL,
    started_by_device_id UUID NOT NULL REFERENCES device_identities(id),
    e2ee_required BOOLEAN NOT NULL DEFAULT TRUE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ
);

CREATE INDEX idx_call_sessions_channel_active ON call_sessions (channel_id) WHERE ended_at IS NULL;

-- 15. Retention Jobs (Background deletion, disappearing message sweep, S3 object cleanup)
CREATE TABLE retention_jobs (
    id UUID PRIMARY KEY,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    job_type VARCHAR(40) NOT NULL, -- expire_messages | purge_attachment_object | burn_room | cleanup_expired_invites
    target_id UUID,
    object_key TEXT,
    status VARCHAR(24) NOT NULL DEFAULT 'queued', -- queued | running | completed | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT chk_retention_status CHECK (status IN ('queued', 'running', 'completed', 'failed'))
);

CREATE INDEX idx_retention_jobs_pending ON retention_jobs (status, run_after) WHERE status IN ('queued', 'failed');

