# Secret Unlock Security & Rate-Limiting Design

**Primary Files:** `crates/cloak-p2p/src/stealth.rs`, `crates/cloak-p2p/src/stealth_controller.rs`, `crates/cloak-p2p/src/stealth_storage.rs`

## Zero Plaintext & Cryptographic Verification

- Every secret unlock code, standalone passphrase, and recovery code is hashed with **Salted Argon2id** (`Algorithm::Argon2id`, `Version::V0x13`, `Params::new(19456, 2, 1, None)`) via `hash_secret_code` / `verify_secret_code` in `crates/cloak-p2p/src/stealth.rs`.
- Normalized input preserves Unicode text and only lowercases characters when `case_sensitive` is `false`.
- Weak-code screening (`is_weak_secret_code`) flags short/trivial codes (< 6 chars or common literals) in the UI without storing raw secrets on disk.
- Neither `stealth_secret_codes` nor `stealth_passphrase` nor GET `/p2p/v1/stealth/codes` ever returns plaintext secret values or raw hashes to the frontend (`StealthSecretCodeSummary` returns metadata only: `id`, `label`, `action`, `targetRoomId`, `caseSensitive`, `isWeak`, `requireAdditionalAuth`, `createdAt`, `lastUsedAt`).

## Supported Unlock Pathways & Actions

- **Methods (`UnlockMethod`):** `PdfSearch` (Enter in PDF reader search bar), `HiddenShortcutInput` (`Ctrl+Shift+U` neutral `Enter Command / Access Code` dialog), `DiscreetCommand` (`:`/`>` command prompt), `Passphrase`, `Pin`, and `WindowsHello` (`Windows.Security.Credentials.UI.UserConsentVerifier::RequestVerificationAsync`).
- **Configured Secret Code Actions (`SecretCodeAction`):**
  - `UnlockMessenger`: opens private messenger
  - `UnlockDirectRoom`: opens a specific room (`pendingNavigationTarget`)
  - `OpenPrivacySettings`: unlocks directly into Privacy & Stealth Settings (`pendingOpenPrivacySettings`)
  - `DecoyOnlyStayPdf`: returns `matched = false` surface change (`stay_pdf` outcome) without revealing private chats
  - `WipeAndResetDecoy`: permanently wipes local messages via Ghost engine while staying in locked PDF decoy mode
- **Two-Step Verification (`requireAdditionalAuth`):** If enabled globally (`unlock.requireAdditionalAuth`) or per secret code, submitting a valid code transitions to `step_up_required` and requires a configured second passphrase or PIN before unlocking.
- **Recovery Key:** Generating a recovery code stores its Argon2id hash inside `stealth_settings`/`stealth_passphrase` recovery slot (`POST /p2p/v1/stealth/recovery-code`, verified by `POST /p2p/v1/stealth/recover`).

## Persistent Progressive Cooldown (`stealth_rate_limit`)

- Failed attempts increment `failed_attempts` in SQLite table `stealth_rate_limit` (`singleton = 1`) and persist `cooldown_until_ms`, `lockout_tier`, and `last_failed_at` across process restarts.
- Cooldown progression (`next_progressive_cooldown_secs`):
  - Attempts 1–2: `0s`
  - Attempt 3: `15s`
  - Attempt 4: `30s`
  - Attempt 5: `60s`
  - Attempts 6+: `300s`
- Any valid unlock or recovery resets `failed_attempts = 0`, `cooldown_until_ms = NULL`, and `lockout_tier = 0`.
