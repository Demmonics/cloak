use cloak_core::error::CloakError;
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct MemberContext {
    pub membership_id: Uuid,
    pub room_id: Uuid,
    pub device_id: Uuid,
    pub role_id: Uuid,
    pub role_name: String,
    pub role_rank: i32,
    pub owner_device_id: Uuid,
    pub current_epoch: i64,
}

#[derive(Debug, Clone)]
pub struct ChannelContext {
    pub channel_id: Uuid,
    pub room_id: Uuid,
    pub channel_type: String,
    pub slow_mode_seconds: i32,
    pub disappear_seconds: Option<i32>,
    pub member: MemberContext,
}

pub async fn require_active_member(
    db: &PgPool,
    room_id: Uuid,
    device_id: Uuid,
) -> Result<MemberContext, CloakError> {
    let row = sqlx::query(
        r#"
        SELECT m.id AS membership_id, m.role_id, m.status,
               r.name AS role_name, r.rank AS role_rank,
               rm.owner_device_id, rm.current_epoch
        FROM memberships m
        JOIN roles r ON r.id = m.role_id
        JOIN rooms rm ON rm.id = m.room_id
        WHERE m.room_id = $1 AND m.device_id = $2 AND rm.deleted_at IS NULL
        "#,
    )
    .bind(room_id)
    .bind(device_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| CloakError::Forbidden("not a member of this room".into()))?;

    let status: String = row.get("status");
    if status != "active" {
        return Err(CloakError::Forbidden(format!(
            "membership is not active (status: {status})"
        )));
    }

    Ok(MemberContext {
        membership_id: row.get("membership_id"),
        room_id,
        device_id,
        role_id: row.get("role_id"),
        role_name: row.get("role_name"),
        role_rank: row.get("role_rank"),
        owner_device_id: row.get("owner_device_id"),
        current_epoch: row.get("current_epoch"),
    })
}

pub async fn has_permission(
    db: &PgPool,
    ctx: &MemberContext,
    permission_key: &str,
) -> Result<bool, CloakError> {
    if ctx.device_id == ctx.owner_device_id || ctx.role_name == "owner" {
        return Ok(true);
    }
    let allowed: Option<bool> = sqlx::query_scalar(
        "SELECT allowed FROM permissions WHERE role_id = $1 AND permission_key = $2",
    )
    .bind(ctx.role_id)
    .bind(permission_key)
    .fetch_optional(db)
    .await?;

    Ok(allowed.unwrap_or(false))
}

pub async fn require_permission(
    db: &PgPool,
    room_id: Uuid,
    device_id: Uuid,
    permission_key: &str,
) -> Result<MemberContext, CloakError> {
    let ctx = require_active_member(db, room_id, device_id).await?;
    if !has_permission(db, &ctx, permission_key).await? {
        return Err(CloakError::Forbidden(format!(
            "missing required permission: {permission_key}"
        )));
    }
    Ok(ctx)
}

pub async fn require_channel_access(
    db: &PgPool,
    room_id: Uuid,
    channel_id: Uuid,
    device_id: Uuid,
    require_send: bool,
    require_voice: bool,
) -> Result<ChannelContext, CloakError> {
    let member = require_active_member(db, room_id, device_id).await?;

    let ch_row = sqlx::query(
        r#"
        SELECT c.channel_type, c.is_private, c.slow_mode_seconds, c.disappear_seconds,
               rm.default_disappear_seconds
        FROM channels c
        JOIN rooms rm ON rm.id = c.room_id
        WHERE c.id = $1 AND c.room_id = $2 AND c.archived_at IS NULL
        "#,
    )
    .bind(channel_id)
    .bind(room_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| CloakError::NotFound("channel not found".into()))?;

    let channel_type: String = ch_row.get("channel_type");
    let is_private: bool = ch_row.get("is_private");
    let slow_mode_seconds: i32 = ch_row.get("slow_mode_seconds");
    let ch_disappear: Option<i32> = ch_row.get("disappear_seconds");
    let room_disappear: Option<i32> = ch_row.get("default_disappear_seconds");

    let override_row = sqlx::query(
        "SELECT can_view, can_send, can_connect_voice FROM channel_role_overrides WHERE channel_id = $1 AND role_id = $2",
    )
    .bind(channel_id)
    .bind(member.role_id)
    .fetch_optional(db)
    .await?;

    let is_priv = member.device_id == member.owner_device_id || member.role_name == "owner" || member.role_name == "admin";

    if let Some(ov) = override_row {
        if !is_priv && !ov.get::<bool, _>("can_view") {
            return Err(CloakError::Forbidden("no access to view channel".into()));
        }
        if require_send && !is_priv && !ov.get::<bool, _>("can_send") {
            return Err(CloakError::Forbidden("no permission to send in this channel".into()));
        }
        if require_voice && !is_priv && !ov.get::<bool, _>("can_connect_voice") {
            return Err(CloakError::Forbidden("no permission to connect voice in this channel".into()));
        }
    } else if is_private && !is_priv {
        return Err(CloakError::Forbidden("channel is restricted to authorized roles".into()));
    }

    if require_send {
        if channel_type == "voice" {
            return Err(CloakError::BadRequest("cannot send text messages to a voice-only channel".into()));
        }
        if channel_type == "announcement" && !is_priv {
            return Err(CloakError::Forbidden("announcement channel is read-only for members".into()));
        }
        if !has_permission(db, &member, "send_messages").await? {
            return Err(CloakError::Forbidden("role is read-only".into()));
        }
    }

    if require_voice {
        if channel_type != "voice" {
            return Err(CloakError::BadRequest("channel is not a voice channel".into()));
        }
        if !has_permission(db, &member, "connect_voice").await? {
            return Err(CloakError::Forbidden("role cannot connect to voice".into()));
        }
    }

    Ok(ChannelContext {
        channel_id,
        room_id,
        channel_type,
        slow_mode_seconds,
        disappear_seconds: ch_disappear.or(room_disappear),
        member,
    })
}

