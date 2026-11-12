# ADR-002: End-to-End Encryption Key Model and MLS Evaluation

## Status
Accepted (Cloak v1 Epoch Room-Key Model; MLS Roadmap Defined)

## Context
Cloak must support instant anonymous room creation, multi-browser invitation links, group channels, encrypted attachments, LiveKit E2EE media, room history burn with key rotation, and complete offline HTML exports without exposing plaintext messages, attachment keys, or passwords to the application server.

## Decision
### Cloak v1 Key Hierarchy
1. **Device Identity Keys (Client-Generated):**
   - Ed25519 (`crypto_sign_keypair`) for authenticating challenges and signing message envelopes.
   - X25519 (`crypto_box_keypair`) for asymmetric epoch-key wrapping.
   - Stored locally in IndexedDB; optionally encrypted at rest with a user-supplied Device Passphrase (Argon2id + XChaCha20-Poly1305) and exportable as an encrypted `.cloakkey` backup.
2. **Room Epoch Keys:**
   - Every room maintains a monotonic `encryption_epoch` (starting at `1`).
   - A 256-bit `room_epoch_key` is generated client-side and wrapped per authorized device (`crypto_box_easy` from sender X25519 to recipient X25519).
3. **Invitations (Zero-Knowledge Fragment Wrapping):**
   - Invite links use `https://<host>/invite/<invite_token>#k=<base64url(invite_secret_key)>`.
   - Browsers never transmit the `#k=` URL fragment in HTTP requests.
   - The client wraps `room_epoch_key` using XChaCha20-Poly1305 under `BLAKE2b(invite_secret_key || optional_password_argon2id)` with AAD = `cloak-invite-v1|room_id|invite_id|epoch`.
   - The server stores only `SHA-256(invite_token)` (and an independent Argon2id password verifier if password-gated) plus the encrypted key envelope.
4. **Messages & Attachments:**
   - Messages are encrypted client-side with `XChaCha20-Poly1305` (random 192-bit nonce, AAD = `cloak-msg-v1|room_id|channel_id|message_id|sender_device_id|epoch`) and signed by the sender's Ed25519 key.
   - Attachments use unique per-file 256-bit keys encrypted with `crypto_secretstream_xchacha20poly1305`; metadata (filename, MIME, file key, header) lives strictly inside the encrypted message payload.
5. **LiveKit Media E2EE:**
   - LiveKit `ExternalE2EEKeyProvider` receives a media key derived via domain-separated BLAKE2b (`cloak-media-v1|room_id|epoch`) from `room_epoch_key`. The SFU routes encrypted frames without possessing the key.

## Documented Limitations of v1 (Critical Security Transparency)
1. **No Per-Message Forward Secrecy (PCS/FS within an epoch):** Compromise of a device holding `room_epoch_key(e)` decrypts all messages sent in epoch `e`. Mitigation: users can burn room history or rotate epochs.
2. **Removed-Member Retroactive Access:** Removing or banning a member increments the epoch to `e + 1` and prevents access to future messages (`>= e + 1`), but cannot cryptographically revoke knowledge of keys from prior epochs (`<= e`) that the removed device previously decrypted.
3. **Server-Visible Metadata:** The API server observes room IDs, channel IDs, device IDs, membership lists, timestamps, ciphertext sizes, and LiveKit signaling presence.
4. **Key Recovery Tradeoff:** Multi-device key sync relies on explicit `.cloakkey` encrypted export/import or owner-approved member envelopes; losing all devices without a backup loses access to encrypted history.
5. **Not Independently Audited:** Cloak v1 uses vetted libsodium primitives (`XChaCha20-Poly1305`, `X25519`, `Ed25519`, `Argon2id`) in a custom epoch-key composition. It has **not** undergone a third-party cryptographic audit.

## Evaluation of MLS (RFC 9420) for v2
- **Why MLS fits Cloak v2:** IETF Messaging Layer Security (`openmls` compiled to WASM on the client + Delivery/Authentication Service in Rust) provides TreeKEM-based $O(\log N)$ key updates, genuine forward secrecy across epochs/commits, post-compromise security on member key rotation, and standardized key-schedule proofs.
- **Why v1 starts with Epoch Keys:** Instant browser-first room creation via URL-fragment invitations and multi-channel offline archive export require asynchronous key availability before a new device has an interactive KeyPackage published. In v2, rooms can negotiate MLS groups once devices register KeyPackages while preserving the v1 epoch/version envelope field (`protocol_version` / `epoch`) for clean upgrade.

