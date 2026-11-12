//! Cloak native local-first peer-to-peer storage, cryptography, and direct TCP transport engine.

pub mod crypto;
pub mod error;
pub mod ghost;
pub mod model;
pub mod netinfo;
pub mod stealth;
pub mod stealth_controller;
pub mod stealth_storage;
pub mod storage;
pub mod transport;

pub use error::{P2pError, P2pResult};
pub use model::{
    ConnectivityMode, DecryptedMessageView, DeletionTombstone, GhostDeletionSummary,
    GhostModeLevel, GhostPolicy, GhostRoomOverride, GhostRuntimeState, GhostTriggerKind,
    GhostTriggers, LocalAttachmentMeta, LocalChannel, LocalRoom, NetworkDiagnostics,
    NetworkInterfaceCandidate, NodeEvent, OutgoingViewedPolicy, PairingTicket, PeerConnectionState,
    PeerSummary, RoomInvitationSummary, RoomMemberSummary, StoredMessage, TombstoneScope,
    WebRtcSignalPayload, WireFrame,
};
pub use stealth::{
    ActiveCallPrivacySummary, ActiveSurface, AttachmentPurgeAction, CallPrivacySettings,
    CameraAction, LocalDeletionAction, LockAction, NotificationPrivacyLevel,
    NotificationPrivacySettings, PdfDocumentRecord, PdfDocumentStateUpdate, PdfReaderSettings,
    PdfReaderTheme, PrivacyRule, PrivacyTriggerKind, RuleEvaluationDecision, ScreenShareAction,
    SecretCodeAction, SecretCodeMetadata, StealthBootstrapState, StealthConfig, StealthLaunchView,
    StealthLifecycleState, StealthPdfReturnBehavior, StealthRateLimitState,
    StealthTestPreviewResult, StealthVisualAction, TimerPreferences, UnlockMethod, UnlockOutcome,
    UnlockPreferences, VoiceCallAction,
};
pub use stealth_controller::StealthController;
pub use transport::P2pNode;

#[cfg(test)]
mod stealth_tests;

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use uuid::Uuid;

    use super::*;

    fn temp_vault_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cloak-p2p-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp vault dir");
        dir
    }

    #[tokio::test]
    async fn two_peers_direct_encrypted_messaging_edit_delete_file_and_webrtc_signal() {
        let dir_alice = temp_vault_dir("alice");
        let dir_bob = temp_vault_dir("bob");

        let alice = P2pNode::start(&dir_alice, "127.0.0.1:0", "Alice")
            .await
            .expect("start alice");
        let bob = P2pNode::start(&dir_bob, "127.0.0.1:0", "Bob")
            .await
            .expect("start bob");

        let mut bob_events = bob.subscribe();

        let (room, channel, _) = alice
            .create_room("Direct Lounge", None)
            .expect("create room");
        let ticket = alice
            .export_pairing_ticket(&room.id, None)
            .expect("export pairing ticket");
        let uri = ticket.to_uri();
        let parsed = PairingTicket::from_uri(&uri).expect("parse ticket URI");

        // Bob pairs with Alice using strict DirectOnly mode and connects directly
        let (bob_room, bob_chan) = bob
            .pair_and_connect(&parsed, ConnectivityMode::DirectOnly)
            .await
            .expect("bob pair and connect");
        assert_eq!(bob_room.id, room.id);
        assert_eq!(bob_chan.id, channel.id);

        // Also register Bob on Alice so Alice broadcasts back on her direct connection or PeerConnected triggers
        let bob_ident = bob.identity().expect("bob identity");
        alice
            .upsert_peer(&PeerSummary {
                device_id: bob_ident.device_id.clone(),
                display_name: bob_ident.display_name,
                ed25519_public_key_b64: bob_ident.ed25519_public_b64,
                x25519_public_key_b64: bob_ident.x25519_public_b64,
                direct_addr: bob.local_addr().to_string(),
                alternate_addrs: vec![],
                connectivity_mode: ConnectivityMode::DirectOnly,
                last_seen_at: None,
                revoked: false,
            })
            .expect("alice add bob peer");

        // Send a direct encrypted file attachment (split across multiple 64 KiB chunks)
        let mut payload = Vec::with_capacity(140 * 1024);
        for i in 0..(140 * 1024) {
            payload.push((i % 251) as u8);
        }
        let att = alice
            .store_and_send_file(
                &room.id,
                "blueprint.bin",
                "application/octet-stream",
                &payload,
            )
            .await
            .expect("alice send file");

        // Wait until Bob receives final file chunk
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if Instant::now() > deadline {
                panic!("timed out waiting for AttachmentReceived event on Bob");
            }
            if let Ok(NodeEvent::AttachmentReceived { attachment_id, .. }) =
                tokio::time::timeout(Duration::from_millis(500), bob_events.recv())
                    .await
                    .unwrap_or(Err(tokio::sync::broadcast::error::RecvError::Lagged(0)))
                && attachment_id == att.id
            {
                break;
            }
        }

        let bob_bytes = bob
            .read_verified_attachment(&att.id)
            .expect("bob read verified attachment");
        assert_eq!(bob_bytes, payload);

        // Send an encrypted signed chat message linking the attachment
        let sent = alice
            .send_message(
                &room.id,
                &channel.id,
                "Check the peer-to-peer blueprint!",
                vec![att.id.clone()],
                None,
                None,
            )
            .await
            .expect("alice send message");

        // Wait briefly for message frame to arrive at Bob
        for _ in 0..30 {
            let msgs = bob
                .list_decrypted_messages(&bob_room.id, &bob_chan.id)
                .expect("bob list msgs");
            if let Some(found) = msgs.iter().find(|m| m.id == sent.id) {
                assert_eq!(found.text, "Check the peer-to-peer blueprint!");
                assert!(found.signature_verified);
                assert_eq!(found.attachments.len(), 1);
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        // Edit message and verify propagation
        alice
            .edit_message(&room.id, &sent.id, "Updated peer blueprint!")
            .await
            .expect("alice edit");
        let mut edit_seen = false;
        for _ in 0..40 {
            let msgs = bob
                .list_decrypted_messages(&bob_room.id, &bob_chan.id)
                .expect("bob msgs after edit");
            if msgs
                .iter()
                .any(|m| m.id == sent.id && m.text == "Updated peer blueprint!")
            {
                edit_seen = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(edit_seen, "Bob should observe edited plaintext locally");

        // WebRTC SDP signaling directly over P2P stream
        alice
            .send_webrtc_signal(WebRtcSignalPayload {
                room_id: room.id.clone(),
                call_id: "call-1".into(),
                sender_device_id: alice.identity().unwrap().device_id,
                kind: "offer_sdp".into(),
                payload: "v=0\r\no=- 123 2 IN IP4 127.0.0.1".into(),
            })
            .await
            .expect("send webrtc offer");

        let mut got_signal = false;
        for _ in 0..40 {
            if let Ok(Ok(NodeEvent::WebRtcSignal(sig))) =
                tokio::time::timeout(Duration::from_millis(50), bob_events.recv()).await
                && sig.call_id == "call-1"
            {
                got_signal = true;
                break;
            }
        }
        assert!(got_signal, "Bob should receive direct WebRTC SDP signal");

        // Burn room history and confirm deletion propagates
        alice.burn_room_history(&room.id).await.expect("alice burn");
        let mut burned = false;
        for _ in 0..40 {
            let msgs = bob
                .list_decrypted_messages(&bob_room.id, &bob_chan.id)
                .expect("bob msgs after burn");
            if msgs.is_empty() {
                burned = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(burned, "Bob history must be wiped after burn tombstone");

        alice.shutdown();
        bob.shutdown();
        let _ = std::fs::remove_dir_all(&dir_alice);
        let _ = std::fs::remove_dir_all(&dir_bob);
    }

    #[tokio::test]
    async fn strict_direct_only_reports_explicit_failure_without_relay() {
        let dir = temp_vault_dir("unreachable");
        let node = P2pNode::start(&dir, "127.0.0.1:0", "Solo")
            .await
            .expect("start solo");

        // Allocate an ephemeral unused port and immediately drop listener so connect fails fast
        let closed_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let closed_addr = closed_listener.local_addr().unwrap();
        drop(closed_listener);

        let fake_ident = crypto::DeviceIdentity::generate("UnreachablePeer");
        let now_ms = chrono::Utc::now().timestamp_millis();
        let mut ticket = PairingTicket {
            device_id: fake_ident.device_id.clone(),
            display_name: "UnreachablePeer".into(),
            ed25519_public_key_b64: fake_ident.ed25519_public_b64.clone(),
            x25519_public_key_b64: fake_ident.x25519_public_b64.clone(),
            direct_addr: closed_addr.to_string(),
            alternate_addrs: vec![],
            room_id: Uuid::new_v4().to_string(),
            room_name: "Test".into(),
            room_key_b64: crypto::generate_room_key_b64(),
            invite_id: Uuid::new_v4().to_string(),
            issued_at_ms: now_ms,
            expires_at_ms: now_ms + 60_000,
            max_uses: 1,
            invite_sig_b64: String::new(),
        };
        ticket.invite_sig_b64 =
            crypto::sign_text(&fake_ident, &ticket.invite_signing_payload()).unwrap();

        let err = node
            .pair_and_connect(&ticket, ConnectivityMode::DirectOnly)
            .await
            .expect_err("unreachable direct peer must fail explicitly");
        match err {
            P2pError::DirectConnectivityBlocked { mode, detail } => {
                assert_eq!(mode, "direct_only");
                assert!(detail.contains("refused any silent relay fallback"));
            }
            other => panic!("expected DirectConnectivityBlocked, got {other:?}"),
        }

        node.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn ghost_mode_clear_viewed_preserves_unread_remote_and_blocks_resurrection() {
        let dir_alice = temp_vault_dir("ghost-alice");
        let dir_bob = temp_vault_dir("ghost-bob");

        let alice = P2pNode::start(&dir_alice, "127.0.0.1:0", "Alice")
            .await
            .expect("start alice");
        let bob = P2pNode::start(&dir_bob, "127.0.0.1:0", "Bob")
            .await
            .expect("start bob");

        let (room, channel, _) = alice.create_room("Ghost Sanctuary", None).unwrap();
        let ticket = alice.export_pairing_ticket(&room.id, None).unwrap();
        let (bob_room, bob_chan) = bob
            .pair_and_connect(&ticket, ConnectivityMode::DirectOnly)
            .await
            .expect("pair");
        alice
            .upsert_peer(&PeerSummary {
                device_id: bob.identity().unwrap().device_id,
                display_name: "Bob".into(),
                ed25519_public_key_b64: bob.identity().unwrap().ed25519_public_b64,
                x25519_public_key_b64: bob.identity().unwrap().x25519_public_b64,
                direct_addr: bob.local_addr().to_string(),
                alternate_addrs: vec![],
                connectivity_mode: ConnectivityMode::DirectOnly,
                last_seen_at: None,
                revoked: false,
            })
            .unwrap();

        // Alice sends viewed message with attachment + unviewed message
        let att = alice
            .store_and_send_file(&room.id, "../../secret_photo.png", "image/png", b"PNGDATA")
            .await
            .unwrap();
        assert_eq!(att.filename, "secret_photo.png"); // Sanitized against path traversal

        let msg1 = alice
            .send_message(
                &room.id,
                &channel.id,
                "Viewed Secret 1",
                vec![att.id.clone()],
                None,
                None,
            )
            .await
            .unwrap();
        let msg2 = alice
            .send_message(&room.id, &channel.id, "Unread Secret 2", vec![], None, None)
            .await
            .unwrap();

        for _ in 0..40 {
            if bob
                .list_decrypted_messages(&bob_room.id, &bob_chan.id)
                .unwrap()
                .len()
                >= 2
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        // Bob enables ClearViewed + attachment cleanup + PIN lock
        bob.set_active_conversation(Some(&bob_room.id), Some(&bob_chan.id))
            .unwrap();
        bob.set_ghost_pin(Some("2580")).unwrap();
        let mut policy = bob.get_ghost_policy().unwrap();
        policy.enabled = true;
        policy.mode = GhostModeLevel::ClearViewed;
        policy.clear_attachments = true;
        policy.require_pin_unlock = true;
        bob.update_ghost_policy(policy).unwrap();

        // Mark ONLY msg1 as viewed while foreground/unlocked
        let marked = bob
            .mark_messages_viewed(&bob_room.id, &bob_chan.id, std::slice::from_ref(&msg1.id))
            .unwrap();
        assert_eq!(marked, 1);

        // Opening an app-owned dialog prevents destructive wipe on spurious focus change
        bob.set_in_app_modal_open(true);
        let modal_state = bob
            .handle_ghost_trigger(GhostTriggerKind::ExternalFocusLoss)
            .unwrap();
        assert!(!modal_state.shielded);
        assert_eq!(
            bob.list_decrypted_messages(&bob_room.id, &bob_chan.id)
                .unwrap()
                .len(),
            2
        );
        bob.set_in_app_modal_open(false);

        // Real Alt+Tab external focus loss wipes msg1 + orphan blob locally, keeps unread msg2, shields & locks PIN
        let locked_state = bob
            .handle_ghost_trigger(GhostTriggerKind::ExternalFocusLoss)
            .unwrap();
        assert!(locked_state.shielded);
        assert!(locked_state.pin_locked);
        let summary = locked_state.last_cleanup.expect("cleanup summary");
        assert_eq!(summary.deleted_messages, 1);
        assert_eq!(summary.deleted_attachments, 1);
        assert_eq!(summary.preserved_unread, 1);

        // Unviewed msg2 survives locally AND attachment blob for msg1 is deleted on Bob
        let bob_remaining = bob
            .list_decrypted_messages(&bob_room.id, &bob_chan.id)
            .unwrap();
        assert_eq!(bob_remaining.len(), 1);
        assert_eq!(bob_remaining[0].id, msg2.id);
        assert!(bob.read_verified_attachment(&att.id).is_err());

        // Remote peer Alice STILL keeps ALL her independent history untouched!
        assert_eq!(
            alice
                .list_decrypted_messages(&room.id, &channel.id)
                .unwrap()
                .len(),
            2
        );

        // Wrong PIN rejected, correct PIN unlocks
        assert!(bob.unlock_ghost_mode(Some("0000")).is_err());
        let unlocked = bob.unlock_ghost_mode(Some("2580")).unwrap();
        assert!(!unlocked.shielded);
        assert!(!unlocked.pin_locked);

        // Restart Bob's vault from SQLite + reconnect to Alice -> msg1 MUST NOT resurrect!
        let bob_dev_id = bob.identity().unwrap().device_id;
        bob.shutdown();
        let bob_restarted = P2pNode::start(&dir_bob, "127.0.0.1:0", "Bob")
            .await
            .expect("restart bob");
        bob_restarted
            .connect_to_peer(&alice.identity().unwrap().device_id)
            .await
            .expect("reconnect");
        tokio::time::sleep(Duration::from_millis(150)).await;
        let post_sync = bob_restarted
            .list_decrypted_messages(&bob_room.id, &bob_chan.id)
            .unwrap();
        assert_eq!(post_sync.len(), 1);
        assert_eq!(post_sync[0].id, msg2.id);

        // Genuinely NEW message sent after wipe still syncs cleanly!
        let msg3 = alice
            .send_message(
                &room.id,
                &channel.id,
                "Fresh post-wipe msg 3",
                vec![],
                None,
                None,
            )
            .await
            .unwrap();
        alice
            .upsert_peer(&PeerSummary {
                device_id: bob_dev_id,
                display_name: "Bob".into(),
                ed25519_public_key_b64: bob_restarted.identity().unwrap().ed25519_public_b64,
                x25519_public_key_b64: bob_restarted.identity().unwrap().x25519_public_b64,
                direct_addr: bob_restarted.local_addr().to_string(),
                alternate_addrs: vec![],
                connectivity_mode: ConnectivityMode::DirectOnly,
                last_seen_at: None,
                revoked: false,
            })
            .unwrap();
        let mut saw_msg3 = false;
        for _ in 0..40 {
            if bob_restarted
                .list_decrypted_messages(&bob_room.id, &bob_chan.id)
                .unwrap()
                .iter()
                .any(|m| m.id == msg3.id)
            {
                saw_msg3 = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(saw_msg3, "New message after Ghost clear must still sync");

        alice.shutdown();
        bob_restarted.shutdown();
        let _ = std::fs::remove_dir_all(&dir_alice);
        let _ = std::fs::remove_dir_all(&dir_bob);
    }

    #[tokio::test]
    async fn ghost_mode_full_wipe_suppression_peer_revocation_and_key_pinning() {
        let dir_a = temp_vault_dir("full-a");
        let dir_b = temp_vault_dir("full-b");

        let a = P2pNode::start(&dir_a, "127.0.0.1:0", "Alice")
            .await
            .unwrap();
        let b = P2pNode::start(&dir_b, "127.0.0.1:0", "Bob").await.unwrap();

        let (room1, chan1, _) = a.create_room("Sensitive Room", None).unwrap();
        let (room2, chan2, _) = a.create_room("Preserved Room", None).unwrap();
        let ticket = a.export_pairing_ticket(&room1.id, None).unwrap();
        b.pair_and_connect(&ticket, ConnectivityMode::DirectOnly)
            .await
            .unwrap();

        // Send in room1 + preserve unrelated room2 on A
        a.send_message(
            &room2.id,
            &chan2.id,
            "Unrelated convo message",
            vec![],
            None,
            None,
        )
        .await
        .unwrap();
        let m1 = a
            .send_message(&room1.id, &chan1.id, "Before full wipe", vec![], None, None)
            .await
            .unwrap();
        for _ in 0..40 {
            if b.list_decrypted_messages(&room1.id, &chan1.id)
                .unwrap()
                .len()
                == 1
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        // Enable ClearOpenConversation on B with explicit confirmation & trigger Alt+Tab
        b.set_active_conversation(Some(&room1.id), Some(&chan1.id))
            .unwrap();
        let mut pol = b.get_ghost_policy().unwrap();
        pol.enabled = true;
        pol.mode = GhostModeLevel::ClearOpenConversation;
        pol.destructive_confirmed = true;
        b.update_ghost_policy(pol).unwrap();

        let wiped = b.handle_ghost_trigger(GhostTriggerKind::Minimize).unwrap();
        assert_eq!(wiped.last_cleanup.unwrap().deleted_messages, 1);
        assert!(
            b.list_decrypted_messages(&room1.id, &chan1.id)
                .unwrap()
                .is_empty()
        );

        // Identity, peer pairing, room, and room2 on A remain intact; reconnecting A->B doesn't resurrect m1
        assert_eq!(
            a.list_decrypted_messages(&room2.id, &chan2.id)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            a.list_decrypted_messages(&room1.id, &chan1.id).unwrap()[0].id,
            m1.id
        );

        // Key-pinning rejects an impersonating Ed25519 key for an already paired device_id
        let a_ident = a.identity().unwrap();
        let imposter_ident = crypto::DeviceIdentity::generate("Imposter");
        let spoof_err = b.upsert_peer(&PeerSummary {
            device_id: a_ident.device_id.clone(),
            display_name: "AliceSpoof".into(),
            ed25519_public_key_b64: imposter_ident.ed25519_public_b64,
            x25519_public_key_b64: imposter_ident.x25519_public_b64,
            direct_addr: a.local_addr().to_string(),
            alternate_addrs: vec![],
            connectivity_mode: ConnectivityMode::DirectOnly,
            last_seen_at: None,
            revoked: false,
        });
        assert!(spoof_err.is_err());

        // Peer revocation blocks outgoing connect_to_peer
        b.revoke_peer(&a_ident.device_id, true).await.unwrap();
        assert!(b.connect_to_peer(&a_ident.device_id).await.is_err());

        a.shutdown();
        b.shutdown();
        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
    }

    #[tokio::test]
    async fn offline_outbox_flushes_when_peer_comes_online() {
        let dir_alice = temp_vault_dir("offline-alice");
        let dir_bob = temp_vault_dir("offline-bob");

        let alice = P2pNode::start(&dir_alice, "127.0.0.1:0", "Alice")
            .await
            .expect("start alice");
        let bob = P2pNode::start(&dir_bob, "127.0.0.1:0", "Bob")
            .await
            .expect("start bob");

        let (room, channel, _) = alice.create_room("Async Room", None).expect("room");
        let ticket = alice.export_pairing_ticket(&room.id, None).unwrap();
        let bob_ident = bob.identity().unwrap();

        // Register Bob locally in Alice's vault BEFORE connecting
        alice
            .upsert_peer(&PeerSummary {
                device_id: bob_ident.device_id,
                display_name: bob_ident.display_name,
                ed25519_public_key_b64: bob_ident.ed25519_public_b64,
                x25519_public_key_b64: bob_ident.x25519_public_b64,
                direct_addr: bob.local_addr().to_string(),
                alternate_addrs: vec![],
                connectivity_mode: ConnectivityMode::DirectOnly,
                last_seen_at: None,
                revoked: false,
            })
            .unwrap();

        // Alice queues message while Bob isn't connected yet
        let queued_msg = alice
            .send_message(
                &room.id,
                &channel.id,
                "Sent while offline!",
                vec![],
                None,
                None,
            )
            .await
            .expect("queue offline msg");

        // Now Bob creates/imports the ticket locally and connects to Alice OR Alice connects to Bob
        bob.pair_and_connect(&ticket, ConnectivityMode::DirectOnly)
            .await
            .expect("bob connect to alice");
        alice
            .connect_to_peer(&bob.identity().unwrap().device_id)
            .await
            .expect("alice flush outbox");

        let mut synced = false;
        for _ in 0..40 {
            let msgs = bob
                .list_decrypted_messages(&room.id, &channel.id)
                .expect("bob list");
            if msgs
                .iter()
                .any(|m| m.id == queued_msg.id && m.text == "Sent while offline!")
            {
                synced = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(
            synced,
            "Offline outbox message must synchronize on reconnect"
        );

        alice.shutdown();
        bob.shutdown();
        let _ = std::fs::remove_dir_all(&dir_alice);
        let _ = std::fs::remove_dir_all(&dir_bob);
    }

    #[tokio::test]
    async fn ghost_timed_disappear_restart_recovery_and_zero_dh_rejection() {
        let dir = temp_vault_dir("ghost-timed");
        let node = P2pNode::start(&dir, "127.0.0.1:0", "TimerUser")
            .await
            .unwrap();
        let (room, chan, _) = node.create_room("Ephemeral", None).unwrap();
        let (room2, chan2, _) = node.create_room("OtherRoom", None).unwrap();
        node.set_active_conversation(Some(&room.id), Some(&chan.id))
            .unwrap();

        // Store one expire-on-leave message and one after-view-0s message
        let m_leave = node
            .send_message_with_ghost_options(
                &room.id,
                &chan.id,
                "Leave msg",
                vec![],
                None,
                None,
                true,
                None,
            )
            .await
            .unwrap();
        let m_after_view = node
            .send_message_with_ghost_options(
                &room.id,
                &chan.id,
                "After view 0s",
                vec![],
                None,
                None,
                false,
                Some(0),
            )
            .await
            .unwrap();
        let m_ttl = node
            .send_message_with_ghost_options(
                &room.id,
                &chan.id,
                "Short TTL",
                vec![],
                None,
                Some(1),
                false,
                None,
            )
            .await
            .unwrap();

        // Viewing arms expire_after_view_seconds = 0 and marks m_leave as viewed
        node.mark_messages_viewed(
            &room.id,
            &chan.id,
            &[m_leave.id.clone(), m_after_view.id.clone()],
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let visible_now = node.list_decrypted_messages(&room.id, &chan.id).unwrap();
        assert!(
            !visible_now.iter().any(|m| m.id == m_after_view.id),
            "0s after-view message must expire"
        );

        // Switching away purges expire_on_leave message
        node.set_active_conversation(Some(&room2.id), Some(&chan2.id))
            .unwrap();
        let after_leave = node.list_decrypted_messages(&room.id, &chan.id).unwrap();
        assert!(
            !after_leave.iter().any(|m| m.id == m_leave.id),
            "expire_on_leave message must purge"
        );
        assert!(
            after_leave.iter().any(|m| m.id == m_ttl.id),
            "1s TTL still alive before 1s elapses"
        );

        // Shutdown, wait 1.1s so TTL expires while app is CLOSED, then restart -> must stay purged!
        node.shutdown();
        tokio::time::sleep(Duration::from_millis(1150)).await;
        let restarted = P2pNode::start(&dir, "127.0.0.1:0", "TimerUser")
            .await
            .unwrap();
        assert!(
            restarted
                .list_decrypted_messages(&room.id, &chan.id)
                .unwrap()
                .is_empty(),
            "Expired timed messages must never reappear after restart"
        );
        restarted.shutdown();

        // Verify X25519 low-order all-zero shared secret rejection
        let zero_pub = x25519_dalek::PublicKey::from([0u8; 32]);
        let sec = x25519_dalek::StaticSecret::from([42u8; 32]);
        let res =
            crypto::TransportSessionCrypto::derive(sec, &zero_pub, &[1u8; 32], &[2u8; 32], true);
        assert!(
            res.is_err(),
            "All-zero X25519 shared secret must be rejected"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn signed_invitation_replay_expiry_revocation_and_tamper_rejected() {
        let dir_alice = temp_vault_dir("inv-alice");
        let dir_bob = temp_vault_dir("inv-bob");
        let dir_charlie = temp_vault_dir("inv-charlie");

        let alice = P2pNode::start(&dir_alice, "127.0.0.1:0", "Alice")
            .await
            .expect("alice");
        let bob = P2pNode::start(&dir_bob, "127.0.0.1:0", "Bob")
            .await
            .expect("bob");
        let charlie = P2pNode::start(&dir_charlie, "127.0.0.1:0", "Charlie")
            .await
            .expect("charlie");

        let (room, chan, _) = alice.create_room("VIP Ops", None).unwrap();
        alice
            .send_message(
                &room.id,
                &chan.id,
                "Alice confidential brief",
                vec![],
                None,
                None,
            )
            .await
            .unwrap();

        // 1) Tampered ticket URI (e.g. bumping maxUses without inviter's private Ed25519 key) MUST fail signature check
        let ticket = alice.export_pairing_ticket(&room.id, None).unwrap();
        let mut tampered = ticket.clone();
        tampered.max_uses = 99;
        let tamper_err = bob
            .pair_and_connect(&tampered, ConnectivityMode::DirectOnly)
            .await
            .expect_err("tampered ticket max_uses must fail Ed25519 verification");
        assert!(matches!(tamper_err, P2pError::PeerRejected(_)));

        // 2) Expired ticket MUST fail immediately
        let mut expired_ticket = ticket.clone();
        expired_ticket.expires_at_ms = chrono::Utc::now().timestamp_millis() - 5_000;
        let exp_err = bob
            .pair_and_connect(&expired_ticket, ConnectivityMode::DirectOnly)
            .await
            .expect_err("expired ticket must be rejected");
        assert!(matches!(exp_err, P2pError::PeerRejected(_)));

        // 3) Valid single-use ticket succeeds for Bob
        bob.pair_and_connect(&ticket, ConnectivityMode::DirectOnly)
            .await
            .expect("bob valid pairing");
        let mut bob_synced = false;
        for _ in 0..40 {
            if let Ok(msgs) = bob.list_decrypted_messages(&room.id, &chan.id)
                && msgs.iter().any(|m| m.text == "Alice confidential brief")
            {
                bob_synced = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(
            bob_synced,
            "Bob must receive synced secret via valid ticket"
        );

        // 4) Single-use replay by Charlie using the SAME ticket URI MUST be rejected synchronously by Alice!
        let replay_err = charlie
            .pair_and_connect(&ticket, ConnectivityMode::DirectOnly)
            .await
            .expect_err("replayed single-use ticket must be rejected explicitly");
        assert!(matches!(replay_err, P2pError::PeerRejected(_)));
        let charlie_id = charlie.identity().unwrap().device_id;
        let alice_members = alice.list_room_members(&room.id).unwrap();
        assert!(
            !alice_members.iter().any(|m| m.device_id == charlie_id),
            "Charlie replaying a single-use ticket must NEVER gain room membership"
        );
        assert!(
            charlie
                .list_decrypted_messages(&room.id, &chan.id)
                .unwrap_or_default()
                .is_empty(),
            "Charlie must receive ZERO room messages on replayed single-use ticket"
        );

        // 5) Revoked invitation MUST also reject new redeemers before first use
        let revocable = alice.export_pairing_ticket(&room.id, None).unwrap();
        assert!(
            alice
                .revoke_room_invitation(&room.id, &revocable.invite_id)
                .unwrap()
        );
        let dir_dave = temp_vault_dir("inv-dave");
        let dave = P2pNode::start(&dir_dave, "127.0.0.1:0", "Dave")
            .await
            .expect("dave");
        let revoked_err = dave
            .pair_and_connect(&revocable, ConnectivityMode::DirectOnly)
            .await
            .expect_err("revoked invitation must be rejected explicitly");
        assert!(matches!(revoked_err, P2pError::PeerRejected(_)));
        let dave_id = dave.identity().unwrap().device_id;
        assert!(
            !alice
                .list_room_members(&room.id)
                .unwrap()
                .iter()
                .any(|m| m.device_id == dave_id),
            "Revoked ticket must NOT admit Dave"
        );
        assert!(
            dave.list_decrypted_messages(&room.id, &chan.id)
                .unwrap_or_default()
                .is_empty(),
            "Dave must receive ZERO messages from revoked ticket"
        );

        dave.shutdown();
        charlie.shutdown();
        bob.shutdown();
        alice.shutdown();
        let _ = std::fs::remove_dir_all(&dir_alice);
        let _ = std::fs::remove_dir_all(&dir_bob);
        let _ = std::fs::remove_dir_all(&dir_charlie);
        let _ = std::fs::remove_dir_all(&dir_dave);
    }

    #[tokio::test]
    async fn cross_room_broadcast_isolation_and_revocation_cleanup() {
        let dir_alice = temp_vault_dir("iso-alice");
        let dir_bob = temp_vault_dir("iso-bob");

        let alice = P2pNode::start(&dir_alice, "127.0.0.1:0", "Alice")
            .await
            .expect("alice");
        let bob = P2pNode::start(&dir_bob, "127.0.0.1:0", "Bob")
            .await
            .expect("bob");

        let (room1, chan1, _) = alice.create_room("Room One", None).unwrap();
        let (room2, chan2, _) = alice.create_room("Room Two Secret", None).unwrap();

        // Pair Bob strictly into Room One
        let t1 = alice.export_pairing_ticket(&room1.id, None).unwrap();
        bob.pair_and_connect(&t1, ConnectivityMode::DirectOnly)
            .await
            .expect("pair bob to room1");

        // Send in Room Two -> Bob is on an active TCP connection with Alice, MUST NEVER receive Room Two messages!
        alice
            .send_message(
                &room2.id,
                &chan2.id,
                "ROOM TWO EYES ONLY",
                vec![],
                None,
                None,
            )
            .await
            .unwrap();
        alice
            .send_message(&room1.id, &chan1.id, "Room One Hello", vec![], None, None)
            .await
            .unwrap();

        let mut got_r1 = false;
        for _ in 0..40 {
            if let Ok(msgs) = bob.list_decrypted_messages(&room1.id, &chan1.id)
                && msgs.iter().any(|m| m.text == "Room One Hello")
            {
                got_r1 = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(got_r1, "Bob must receive Room One broadcast");
        assert!(
            !bob.list_rooms().unwrap().iter().any(|r| r.id == room2.id),
            "Bob must NEVER learn about or store Room Two"
        );
        assert!(
            bob.list_decrypted_messages(&room2.id, &chan2.id).is_err(),
            "Bob must NOT have Room Two keys or history"
        );

        // Revoking Bob MUST close active transport, mark room_members revoked, and purge queued outbox
        let bob_id = bob.identity().unwrap().device_id;
        alice.revoke_peer(&bob_id, true).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            alice.active_peer_ids().await.is_empty(),
            "Revoking peer must immediately drop active TCP handle"
        );
        // Queue a new message in Room One on Alice while Bob is revoked -> Bob must NOT even get outbox queued frames
        alice
            .send_message(
                &room1.id,
                &chan1.id,
                "Post revocation secret",
                vec![],
                None,
                None,
            )
            .await
            .unwrap();
        assert!(
            bob.list_decrypted_messages(&room1.id, &chan1.id)
                .unwrap()
                .iter()
                .all(|m| m.text != "Post revocation secret"),
            "Revoked peer must never receive subsequent broadcasts"
        );

        bob.shutdown();
        alice.shutdown();
        let _ = std::fs::remove_dir_all(&dir_alice);
        let _ = std::fs::remove_dir_all(&dir_bob);
    }
}
