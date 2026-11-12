use std::time::Duration;

use uuid::Uuid;

use super::*;
use crate::stealth::simulate_stealth_test_mode;
use crate::stealth_storage::StealthRuntimeCheckpoint;
use crate::storage::LocalVault;

fn temp_vault_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("cloak-stealth-{label}-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create temp stealth dir");
    dir
}

fn minimal_valid_pdf_bytes(title_text: &str) -> Vec<u8> {
    format!(
        "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n\
         2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n\
         3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj\n\
         4 0 obj << /Length 44 >> stream\nBT /F1 12 Tf 72 720 Td ({title_text}) Tj ET\nendstream\nendobj\n\
         xref\n0 5\n0000000000 65535 f \ntrailer << /Size 5 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n"
    )
    .into_bytes()
}

#[tokio::test]
async fn secret_codes_unicode_actions_multi_factor_recovery_and_no_plaintext() {
    let dir = temp_vault_dir("codes");
    let node = P2pNode::start(&dir, "127.0.0.1:0", "StealthUser")
        .await
        .expect("start node");

    let (room_conv, _chan, _) = node.create_room("VIP Brief", None).unwrap();

    // Configure Stealth Mode with multiple user-defined secret codes & passphrase
    let mut cfg = node.stealth().get_config().unwrap();
    cfg.enabled = true;
    cfg.launch_view = StealthLaunchView::PdfReader;
    cfg.unlock.enabled_methods = vec![
        UnlockMethod::PdfSearch,
        UnlockMethod::HiddenShortcutInput,
        UnlockMethod::Passphrase,
    ];
    node.stealth().update_config(cfg).unwrap();

    let hashtag_code = node
        .add_stealth_secret_code(
            "Hashtag Messenger",
            "#project_alpha 42!",
            SecretCodeAction::OpenMessenger,
            None,
            true,
            false,
        )
        .unwrap();
    assert!(!hashtag_code.is_weak);

    let unicode_conv = node
        .add_stealth_secret_code(
            "Unicode Direct Conv",
            "секрет-🔑-vault",
            SecretCodeAction::OpenConversation,
            Some(&room_conv.id),
            false, // case-insensitive supported
            true,  // requires secondary passphrase factor
        )
        .unwrap();
    assert!(unicode_conv.require_additional_auth);

    let weak_short = node
        .add_stealth_secret_code(
            "Weak Code",
            "1234",
            SecretCodeAction::OpenPrivacySettings,
            None,
            true,
            false,
        )
        .unwrap();
    assert!(weak_short.is_weak);

    node.set_stealth_passphrase(Some("Correct-Horse-Staple#99"))
        .unwrap();
    let recovery = node.generate_stealth_recovery_code().unwrap();
    assert!(recovery.starts_with("CLK-"));

    // Inspect raw SQLite bytes to confirm NO plaintext secret string is ever persisted
    let db_bytes = std::fs::read(dir.join("cloak_local.db")).unwrap();
    let db_lossy = String::from_utf8_lossy(&db_bytes);
    assert!(!db_lossy.contains("#project_alpha 42!"));
    assert!(!db_lossy.contains("Correct-Horse-Staple#99"));
    assert!(!db_lossy.contains("секрет-🔑-vault"));

    // Lock into PDF decoy mode
    node.stealth()
        .handle_trigger(PrivacyTriggerKind::ManualLock)
        .unwrap();
    assert!(node.is_stealth_locked());

    // Wrong code never leaks secret match
    let miss = node
        .stealth()
        .verify_and_unlock(UnlockMethod::PdfSearch, "annual report", None)
        .unwrap();
    assert!(!miss.matched);
    assert!(!miss.unlocked);
    assert!(node.is_stealth_locked());

    // Hashtag + spaces + symbol code unlocks cleanly
    let ok = node
        .stealth()
        .verify_and_unlock(UnlockMethod::PdfSearch, "#project_alpha 42!", None)
        .unwrap();
    assert!(ok.matched);
    assert!(ok.unlocked);
    assert_eq!(ok.action, Some(SecretCodeAction::OpenMessenger));
    assert!(!node.is_stealth_locked());

    // Lock again and test case-insensitive Unicode + multi-factor step-up
    node.stealth()
        .handle_trigger(PrivacyTriggerKind::ManualLock)
        .unwrap();
    let step1 = node
        .stealth()
        .verify_and_unlock(UnlockMethod::HiddenShortcutInput, "СЕКРЕТ-🔑-VAULT", None)
        .unwrap();
    assert!(step1.matched);
    assert!(!step1.unlocked);
    assert!(step1.needs_additional_factor);
    assert!(node.is_stealth_locked());

    let step2 = node
        .stealth()
        .verify_and_unlock(
            UnlockMethod::HiddenShortcutInput,
            "СЕКРЕТ-🔑-VAULT",
            Some("Correct-Horse-Staple#99"),
        )
        .unwrap();
    assert!(step2.unlocked);
    assert_eq!(step2.action, Some(SecretCodeAction::OpenConversation));
    assert_eq!(step2.target_room_id.as_deref(), Some(room_conv.id.as_str()));

    // Weak settings shortcut opens privacy settings cleanly
    node.stealth()
        .handle_trigger(PrivacyTriggerKind::ManualLock)
        .unwrap();
    let settings_ok = node
        .stealth()
        .verify_and_unlock(UnlockMethod::PdfSearch, "1234", None)
        .unwrap();
    assert!(settings_ok.unlocked);
    assert!(settings_ok.open_privacy_settings);

    // Removing a code stops unlock immediately
    assert!(node.remove_stealth_secret_code(&hashtag_code.id).unwrap());
    node.stealth()
        .handle_trigger(PrivacyTriggerKind::ManualLock)
        .unwrap();
    let removed_fail = node
        .stealth()
        .verify_and_unlock(UnlockMethod::PdfSearch, "#project_alpha 42!", None)
        .unwrap();
    assert!(!removed_fail.matched);
    assert!(!removed_fail.unlocked);

    // Offline recovery key unlocks vault
    let rec_ok = node
        .stealth()
        .recover_unlock_with_recovery_code(&recovery)
        .unwrap();
    assert!(rec_ok.unlocked);
    assert!(!node.is_stealth_locked());

    node.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn rate_limiting_persists_across_restarts_and_modal_guard_protects_work() {
    let dir = temp_vault_dir("ratelimit");
    let node = P2pNode::start(&dir, "127.0.0.1:0", "RateUser")
        .await
        .expect("start");
    let (room, chan, _) = node.create_room("Modal Guard", None).unwrap();
    let m1 = node
        .send_message(&room.id, &chan.id, "Viewed draft note", vec![], None, None)
        .await
        .unwrap();
    node.mark_messages_viewed(&room.id, &chan.id, std::slice::from_ref(&m1.id))
        .unwrap();
    node.set_active_conversation(Some(&room.id), Some(&chan.id))
        .unwrap();

    let mut cfg = node.stealth().get_config().unwrap();
    cfg.enabled = true;
    cfg.launch_view = StealthLaunchView::PdfReader;
    cfg.unlock.enabled_methods = vec![UnlockMethod::Passphrase, UnlockMethod::HiddenShortcutInput];
    node.stealth().update_config(cfg).unwrap();
    node.add_stealth_secret_code(
        "Vault Unlock",
        "obsidian-cedar-moon",
        SecretCodeAction::OpenMessenger,
        None,
        true,
        false,
    )
    .unwrap();

    // Open in-app modal -> FocusLoss must NOT lock or wipe viewed messages
    node.stealth().set_modal_open(true);
    let guarded = node
        .stealth()
        .handle_trigger(PrivacyTriggerKind::FocusLoss)
        .unwrap();
    assert!(!guarded.locked);
    assert_eq!(guarded.active_surface, ActiveSurface::Messenger);
    assert_eq!(
        node.list_decrypted_messages(&room.id, &chan.id)
            .unwrap()
            .len(),
        1
    );
    node.stealth().set_modal_open(false);

    // Lock explicitly, then fail 3 wrong passphrase attempts to trigger progressive cooldown
    node.stealth()
        .handle_trigger(PrivacyTriggerKind::ManualLock)
        .unwrap();
    assert!(node.is_stealth_locked());

    for _ in 0..3 {
        let _ = node
            .stealth()
            .verify_and_unlock(UnlockMethod::Passphrase, "wrong-guess", None)
            .unwrap();
    }
    let blocked = node
        .stealth()
        .verify_and_unlock(UnlockMethod::Passphrase, "obsidian-cedar-moon", None)
        .unwrap();
    assert!(!blocked.unlocked);
    assert!(blocked.lockout_remaining_seconds > 0);
    node.shutdown();

    // Restart P2pNode: launch_view=PdfReader boots locked AND rate-limit cooldown survives restart!
    let reopened = P2pNode::start(&dir, "127.0.0.1:0", "RateUser")
        .await
        .expect("reopen");
    assert!(reopened.is_stealth_locked());
    let boot = reopened.get_stealth_bootstrap();
    assert_eq!(boot.active_surface, ActiveSurface::PdfReader);
    assert!(boot.lockout_remaining_seconds > 0);

    // Advance deterministic test clock past cooldown and verify unlock succeeds
    reopened
        .stealth()
        .advance_clock_ms((boot.lockout_remaining_seconds as i64 + 2) * 1000)
        .unwrap();
    let unlocked = reopened
        .stealth()
        .verify_and_unlock(
            UnlockMethod::HiddenShortcutInput,
            "obsidian-cedar-moon",
            None,
        )
        .unwrap();
    assert!(unlocked.unlocked);
    assert_eq!(reopened.get_stealth_bootstrap().failed_attempts, 0);

    reopened.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn timers_30s_60s_10m_cancel_on_return_overdue_restart_and_foreground_idle() {
    let dir_a = temp_vault_dir("timers-a");
    let dir_b = temp_vault_dir("timers-b");

    let alice = P2pNode::start(&dir_a, "127.0.0.1:0", "TimerAlice")
        .await
        .expect("alice");
    let bob = P2pNode::start(&dir_b, "127.0.0.1:0", "TimerBob")
        .await
        .expect("bob");

    let (room, chan, _) = alice.create_room("Timer Sync", None).unwrap();
    let ticket = alice.export_pairing_ticket(&room.id, None).unwrap();
    let (bob_room, bob_chan) = bob
        .pair_and_connect(&ticket, ConnectivityMode::DirectOnly)
        .await
        .unwrap();
    alice
        .upsert_peer(&PeerSummary {
            device_id: bob.identity().unwrap().device_id,
            display_name: "TimerBob".into(),
            ed25519_public_key_b64: bob.identity().unwrap().ed25519_public_b64,
            x25519_public_key_b64: bob.identity().unwrap().x25519_public_b64,
            direct_addr: bob.local_addr().to_string(),
            alternate_addrs: vec![],
            connectivity_mode: ConnectivityMode::DirectOnly,
            last_seen_at: None,
            revoked: false,
        })
        .unwrap();

    // Send m1 (will be viewed on Alice), m2 (unread on Alice)
    let m1 = alice
        .send_message(&room.id, &chan.id, "Alpha viewed", vec![], None, None)
        .await
        .unwrap();
    let m2 = alice
        .send_message(&room.id, &chan.id, "Beta unread", vec![], None, None)
        .await
        .unwrap();
    for _ in 0..30 {
        if bob
            .list_decrypted_messages(&bob_room.id, &bob_chan.id)
            .unwrap()
            .len()
            == 2
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    alice
        .mark_messages_viewed(&room.id, &chan.id, std::slice::from_ref(&m1.id))
        .unwrap();
    alice
        .set_active_conversation(Some(&room.id), Some(&chan.id))
        .unwrap();

    // Case 1: 30s background-away with cancel_on_return = true
    let mut cfg = alice.stealth().get_config().unwrap();
    cfg.enabled = true;
    cfg.trigger_on_focus_loss = true;
    cfg.trigger_on_alt_tab = true;
    cfg.unlock.require_unlock_on_return = false; // returning cancels timer rather than requiring code
    cfg.timers.background_away_enabled = true;
    cfg.timers.background_away_seconds = 30;
    cfg.timers.background_away_cancel_on_return = true;
    cfg.timers.background_away_preserve_deadline = false;
    cfg.timers.background_away_deletion = LocalDeletionAction::DeleteViewedLocal;
    alice.stealth().update_config(cfg.clone()).unwrap();

    alice
        .stealth()
        .handle_trigger(PrivacyTriggerKind::AltTab)
        .unwrap();
    assert!(alice.get_stealth_bootstrap().away_deadline_ms.is_some());
    alice.stealth().advance_clock_ms(15_000).unwrap();
    alice.stealth().notify_window_focus_restored(false).unwrap();
    assert!(alice.get_stealth_bootstrap().away_deadline_ms.is_none());
    // Viewed message was NOT deleted because user returned within 15s < 30s
    assert_eq!(
        alice
            .list_decrypted_messages(&room.id, &chan.id)
            .unwrap()
            .len(),
        2
    );

    // Case 2: 60s preserve_absolute_deadline = true (brief return doesn't cancel away countdown? Wait: if background_away_cancel_on_return=false, away continues until unlock/return!)
    cfg.timers.background_away_seconds = 60;
    cfg.timers.background_away_cancel_on_return = false;
    cfg.timers.background_away_preserve_deadline = true;
    cfg.timers.background_away_deletion = LocalDeletionAction::KeepAll;
    cfg.unlock.require_unlock_on_return = true;
    alice.stealth().update_config(cfg.clone()).unwrap();

    alice
        .stealth()
        .handle_trigger(PrivacyTriggerKind::AltTab)
        .unwrap();
    alice.stealth().advance_clock_ms(61_000).unwrap();
    assert!(alice.is_stealth_locked());
    // Still KeepAll visual-only: both m1 and m2 untouched!
    assert_eq!(
        alice
            .list_decrypted_messages(&room.id, &chan.id)
            .unwrap()
            .len(),
        2
    );

    // Unlock and verify Foreground Inactivity ignores incoming P2P messages from Bob!
    alice
        .add_stealth_secret_code(
            "Main",
            "alice-unlock-key",
            SecretCodeAction::OpenMessenger,
            None,
            true,
            false,
        )
        .unwrap();
    alice
        .stealth()
        .verify_and_unlock(UnlockMethod::HiddenShortcutInput, "alice-unlock-key", None)
        .unwrap();

    cfg.timers.background_away_enabled = false;
    cfg.timers.foreground_idle_enabled = true;
    cfg.timers.foreground_idle_seconds = 30;
    cfg.timers.system_idle_enabled = true;
    cfg.timers.system_idle_seconds = 90;
    alice.stealth().update_config(cfg.clone()).unwrap();
    alice.stealth().record_foreground_activity();
    alice.stealth().advance_clock_ms(15_000).unwrap();

    // Bob sends a real P2P message while Alice is idle: MUST NOT reset Alice's foreground idle timer!
    let m3 = bob
        .send_message(
            &bob_room.id,
            &bob_chan.id,
            "Background P2P ping",
            vec![],
            None,
            None,
        )
        .await
        .unwrap();
    for _ in 0..30 {
        if alice
            .list_decrypted_messages(&room.id, &chan.id)
            .unwrap()
            .iter()
            .any(|m| m.id == m3.id)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(!alice.is_stealth_locked());
    alice.stealth().advance_clock_ms(16_000).unwrap();
    // 15s + 16s = 31s > 30s even though m3 arrived in between -> foreground idle fires cleanly!
    assert!(alice.is_stealth_locked());
    assert_eq!(
        alice.get_stealth_bootstrap().active_surface,
        ActiveSurface::PdfReader
    );

    // Unlock and arm 10m (600s) background-away with DeleteViewedLocal, then simulate crash/shutdown across overdue deadline
    alice
        .stealth()
        .verify_and_unlock(UnlockMethod::HiddenShortcutInput, "alice-unlock-key", None)
        .unwrap();
    cfg.timers.foreground_idle_enabled = false;
    cfg.timers.system_idle_enabled = false;
    cfg.timers.background_away_enabled = true;
    cfg.timers.background_away_seconds = 600;
    cfg.timers.background_away_deletion = LocalDeletionAction::DeleteViewedLocal;
    alice.stealth().update_config(cfg.clone()).unwrap();
    alice
        .stealth()
        .handle_trigger(PrivacyTriggerKind::Minimize)
        .unwrap();
    alice.shutdown();

    // Write overdue deadline (-5 seconds in the past) directly to persisted SQLite runtime checkpoint to simulate offline passage of 10m
    {
        let vault = LocalVault::open(&dir_a, "TimerAlice").unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        vault
            .save_runtime_checkpoint(&StealthRuntimeCheckpoint {
                locked: true,
                away_deadline_ms: Some(now - 5_000),
                last_wall_ms: now - 605_000,
                locked_reason: Some("minimize".into()),
            })
            .unwrap();
    }

    let alice_restarted = P2pNode::start(&dir_a, "127.0.0.1:0", "TimerAlice")
        .await
        .expect("restart alice");
    assert!(alice_restarted.is_stealth_locked());
    // Startup recovery MUST have executed overdue DeleteViewedLocal: m1 (viewed) gone, m2 & m3 (unread) preserved!
    let alice_after = alice_restarted
        .list_decrypted_messages(&room.id, &chan.id)
        .unwrap();
    assert!(!alice_after.iter().any(|m| m.id == m1.id));
    assert!(alice_after.iter().any(|m| m.id == m2.id));
    assert!(alice_after.iter().any(|m| m.id == m3.id));
    // Bob still keeps all 3 messages!
    assert_eq!(
        bob.list_decrypted_messages(&bob_room.id, &bob_chan.id)
            .unwrap()
            .len(),
        3
    );

    // Verify Safe Test Mode does not touch real messages at all
    let sim = simulate_stealth_test_mode(
        &cfg,
        PrivacyTriggerKind::BackgroundAwayTimeout,
        10,
        4,
        GhostModeLevel::Off,
        false,
    );
    assert_eq!(sim.disposable_messages_cleared, 4);
    assert_eq!(sim.disposable_messages_remaining, 6);
    assert_eq!(
        alice_restarted
            .list_decrypted_messages(&room.id, &chan.id)
            .unwrap()
            .len(),
        2
    );

    alice_restarted.shutdown();
    bob.shutdown();
    let _ = std::fs::remove_dir_all(&dir_a);
    let _ = std::fs::remove_dir_all(&dir_b);
}

#[tokio::test]
async fn pdf_validation_blocks_corrupt_files_and_persists_reader_metadata() {
    let dir = temp_vault_dir("pdf");
    let node = P2pNode::start(&dir, "127.0.0.1:0", "PdfUser")
        .await
        .expect("start");

    // Non-PDF bytes and empty files must be rejected safely
    assert!(
        node.import_pdf_document(None, "fake.pdf", b"<html>not a pdf</html>", 1, false)
            .is_err()
    );
    assert!(
        node.import_pdf_document(None, "empty.pdf", b"", 1, false)
            .is_err()
    );

    // Valid PDF with path traversal filename gets sanitized cleanly
    let valid_bytes = minimal_valid_pdf_bytes("Quarterly Budget 2026");
    let rec = node
        .import_pdf_document(
            Some("Quarterly Budget"),
            "../../secret_dir/quarterly_budget.pdf",
            &valid_bytes,
            3,
            true,
        )
        .unwrap();
    assert_eq!(rec.filename, "quarterly_budget.pdf");
    assert!(rec.is_default_decoy);
    assert_eq!(node.read_pdf_bytes(&rec.id).unwrap(), valid_bytes);

    let updated = node
        .update_pdf_document_state(
            &rec.id,
            &PdfDocumentStateUpdate {
                page_count: Some(3),
                last_page: Some(2),
                last_zoom: Some(1.35),
                rotation: Some(90),
                bookmarks: Some(vec![1, 3]),
                is_default_decoy: Some(true),
            },
        )
        .unwrap();
    assert_eq!(updated.last_page, 2);
    assert_eq!(updated.rotation, 90);
    assert_eq!(updated.bookmarks, vec![1, 3]);
    node.shutdown();

    // Restart preserves PDF reader metadata & document content offline
    let reopened = P2pNode::start(&dir, "127.0.0.1:0", "PdfUser")
        .await
        .expect("reopen");
    let docs = reopened.list_pdf_documents().unwrap();
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0].last_page, 2);
    assert_eq!(docs[0].bookmarks, vec![1, 3]);
    assert_eq!(reopened.read_pdf_bytes(&rec.id).unwrap(), valid_bytes);

    reopened.delete_pdf_document(&rec.id).unwrap();
    assert!(reopened.list_pdf_documents().unwrap().is_empty());
    assert!(reopened.read_pdf_bytes(&rec.id).is_err());

    reopened.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn attachment_chunks_are_sealed_at_rest_and_verified_on_read() {
    let dir = temp_vault_dir("blob-seal");
    let vault = LocalVault::open(&dir, "BlobSeal").unwrap();
    let (room, _, _) = vault.create_room(None, "Vault", None, None).unwrap();
    let secret_payload = b"CONFIDENTIAL_ATTACHMENT_PAYLOAD_SHOULD_NOT_BE_PLAINTEXT_ON_DISK";
    let meta = vault
        .store_local_attachment(&room.id, "secret.txt", "text/plain", secret_payload, 4096)
        .unwrap();

    let chunk_path = dir.join("blobs").join(&meta.id).join("chunk_0.bin");
    let disk_bytes = std::fs::read(&chunk_path).unwrap();
    assert!(disk_bytes.starts_with(b"CLKBLOB1"));
    assert!(
        !disk_bytes
            .windows(b"CONFIDENTIAL".len())
            .any(|w| w == b"CONFIDENTIAL")
    );

    let restored = vault.read_verified_attachment_bytes(&meta.id).unwrap();
    assert_eq!(restored, secret_payload);
    drop(vault);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn pdf_search_ordinary_queries_do_not_lockout_while_burst_throttles() {
    let dir = temp_vault_dir("pdf-search-sep");
    let node = P2pNode::start(&dir, "127.0.0.1:0", "SearchUser")
        .await
        .expect("start");
    let mut cfg = node.stealth().get_config().unwrap();
    cfg.enabled = true;
    cfg.launch_view = StealthLaunchView::PdfReader;
    node.stealth().update_config(cfg).unwrap();
    node.add_stealth_secret_code(
        "Search Key",
        "#ember-signal-77",
        SecretCodeAction::OpenMessenger,
        None,
        true,
        false,
    )
    .unwrap();
    node.stealth()
        .handle_trigger(PrivacyTriggerKind::ManualLock)
        .unwrap();

    // 5 ordinary non-matching searches in PDF bar must NOT increment explicit auth failed_attempts
    for term in ["invoice", "quarterly", "thermal", "budget", "telemetry"] {
        let res = node
            .stealth()
            .verify_and_unlock(UnlockMethod::PdfSearch, term, None)
            .unwrap();
        assert!(!res.unlocked);
    }
    assert_eq!(node.get_stealth_bootstrap().failed_attempts, 0);
    assert_eq!(node.get_stealth_bootstrap().lockout_remaining_seconds, 0);

    // 3 more misses (8 total in burst window) silently throttle pdf_search brute force
    for term in ["probe6", "probe7", "probe8"] {
        let _ = node
            .stealth()
            .verify_and_unlock(UnlockMethod::PdfSearch, term, None)
            .unwrap();
    }
    let burst_blocked = node
        .stealth()
        .verify_and_unlock(UnlockMethod::PdfSearch, "#ember-signal-77", None)
        .unwrap();
    assert!(!burst_blocked.unlocked);
    assert_eq!(node.get_stealth_bootstrap().failed_attempts, 0);

    // After 31s burst cooldown elapses, valid code unlocks normally
    node.stealth().advance_clock_ms(31_000).unwrap();
    let unlocked = node
        .stealth()
        .verify_and_unlock(UnlockMethod::PdfSearch, "#ember-signal-77", None)
        .unwrap();
    assert!(unlocked.unlocked);

    node.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}
