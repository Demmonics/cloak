# Phase 12 Security Verification Report

## 1. Authorization & Room Membership Hardening (`crates/cloak-p2p`)

### Database & Schema (`crates/cloak-p2p/src/storage.rs`)
- **`room_members`:** `(room_id, device_id)` composite key with `role` (`owner` / `member`), `added_at`, and `revoked` flag. Existing legacy vaults run a idempotent backfill on `LocalVault::open` authorizing existing identity owners cleanly.
- **`room_invitations`:** tracks `invite_id`, `room_id`, `issued_at_ms`, `expires_at_ms`, `max_uses` (default `1`), `uses_count`, and `revoked`.
- **Atomic Admission Check (`consume_room_invitation`):** executes conditional SQL `UPDATE` enforcing `revoked = 0`, `expires_at_ms > now_ms`, and `uses_count < max_uses` before authorizing `room_members`. Concurrent/replay attempts exceeding `max_uses` fail closed cleanly with `P2pError::PeerRejected`.
- **Peer Revocation (`revoke_peer(..., true)`):** marks peer revoked, sets `room_members.revoked = 1` across rooms, purges queued `outbox` frames for `device_id`, and signals active session `PeerSessionHandle.close_tx` to drop live TCP sockets immediately (`broadcast_to_room` replaces all 6 prior global peer broadcast call sites).

### Cryptographic Signed Tickets & Wire Protocol (`model.rs`, `crypto.rs`, `transport.rs`)
- `PairingTicket` carries `invite_id`, `issued_at_ms`, `expires_at_ms`, `max_uses`, and Ed25519 signature `invite_sig_b64` over `invite_signing_payload()`.
- Outbound `pair_and_connect` verifies ticket expiry and signature locally, establishes the authenticated X25519/Ed25519 transport session via `connect_to_peer_internal(&peer.device_id, false)` (preventing premature `SyncRequest` before admission and preventing cross-room `SyncRequest` leakage on reconnect), sends `WireFrame::JoinWithInvite`, waits for `WireFrame::JoinAccepted` (or revokes/errors cleanly on `WireFrame::JoinRejected` or timeout), and only then initiates `WireFrame::SyncRequest`.
- Inbound `handle_inbound_frame` enforces `is_peer_room_member(&room_id, peer_device_id)` on `SyncRequest`, `SyncBatch`, `EncryptedMessage`, `MessageEdit`, `MessageDelete`, `RoomKeyRotate`, `RoomBurn`, `AttachmentHeader`, `AttachmentChunk`, and `WebRtcSignal`, plus validates room-scoped Ed25519 signatures on messages and edits.

## 2. Desktop HTTP & Loopback Boundary (`apps/desktop/src/server.rs`)

- **Endpoints Added Under Both `require_loopback_auth` AND `require_unlocked_stealth`:**
  - `POST /p2p/v1/rooms/{room_id}/ticket` (`ttlSeconds`, `maxUses`)
  - `GET /p2p/v1/rooms/{room_id}/invitations`
  - `DELETE /p2p/v1/rooms/{room_id}/invitations/{invite_id}`
  - `GET /p2p/v1/rooms/{room_id}/members`
  - `GET /p2p/v1/capture/stream/{source_id}` (WebSocket upgrade validating `Origin`/`Host`, constant-time session token via `?token=`, and Stealth lock check before and during streaming)
- Verified in `server::tests::desktop_embedded_ui_security_guard_and_two_instance_p2p_flow` and `server::tests::stealth_locked_blocks_private_routes_until_secret_code_unlock`:
  - Unauthenticated requests return `401 UNAUTHORIZED`.
  - Requests while Stealth is locked return `403 STEALTH_LOCKED` across `/status`, `/rooms`, `/peers`, `/rooms/*/invitations`, `/rooms/*/members`, `/stealth/settings`, `/stealth/codes`, and `/ghost/policy`.
  - Production default blocks `/stealth/test-clock-advance` with `403 TEST_CLOCK_DISABLED`.

## 3. Native WinRT COM Windows Hello & Stealth Title Integrity

- `winrt_hello` in `crates/cloak-p2p/src/stealth_controller.rs` loads `combase.dll` (`RoInitialize`, `RoGetActivationFactory`, `WindowsCreateString`, `WindowsDeleteString`) to invoke `Windows.Security.Credentials.UI.UserConsentVerifier` directly via COM vtables without spawning `powershell.exe`.
- `windows_hello_native_winrt_probe_is_fast_and_well_formed` verified fast availability probing (`< 1.5s`, clean `Available (...)` / `Unavailable (...)` tuple; **interactive user biometric/PIN prompt on hardware UI not invoked automatically in CI**).
- `apps/desktop/src/native_shell.rs` preserves Win32 HWND title synchronization across `RecvError::Lagged` and document title mutations (`Cloak` <-> `Document Reader`).

## 4. Verified Security Tests

| Test | Scope & Assertion | Status |
| :--- | :--- | :--- |
| `tests::signed_invitation_replay_expiry_revocation_and_tamper_rejected` | Rejects replayed single-use ticket, expired ticket, revoked ticket, and tampered `invite_id`/`room_id`/`max_uses` signature | **Passed** |
| `tests::cross_room_broadcast_isolation_and_revocation_cleanup` | Enforces zero cross-room broadcast leakage to unauthorized peers and clears outbox + terminates access on revocation | **Passed** |
| `transport::security_tests::uninvited_authenticated_peer_rejected_across_all_room_wire_frames` | Authenticated uninvited peer probing `SyncRequest`, `SyncBatch`, `EncryptedMessage`, `MessageEdit`, `MessageDelete`, `RoomKeyRotate`, `RoomBurn`, `AttachmentHeader`, and `WebRtcSignal` receives rejection/zero state mutation | **Passed** |
| `stealth_controller::winrt_hello_tests::windows_hello_native_winrt_probe_is_fast_and_well_formed` | Verifies native WinRT COM availability probe without external shell process | **Passed** |
| `server::tests::desktop_embedded_ui_security_guard_and_two_instance_p2p_flow` | Verifies loopback token/Origin guard, ticket/invitation/member HTTP routes (`401`/`204`/`404`), and two-instance `DirectOnly` E2EE flow | **Passed** |
| `server::tests::stealth_locked_blocks_private_routes_until_secret_code_unlock` | Verifies fail-closed `403 STEALTH_LOCKED` on private/invitation/member routes until secret code unlock | **Passed** |

