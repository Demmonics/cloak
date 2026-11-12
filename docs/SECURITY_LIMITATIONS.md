# Cloak Security Architecture & Honest Limitations

Cloak prioritizes strong local cryptography and minimal metadata exposure while stating remaining threat-model boundaries transparently.

---

## 1. What Is Enforced & Verified

- **P2P Wire Confidentiality & Authentication (`crates/cloak-p2p/src/crypto.rs`):** Every TCP session performs an Ed25519-signed ephemeral X25519 handshake with 32-byte nonces, HKDF-SHA-256 session derivation, mutual HMAC transcript confirmation (`HandshakeAck`), zero/low-order DH point rejection, counter-nonce `XChaCha20-Poly1305` AEAD framing, periodic FIFO rekeying (`REKEY_AFTER_FRAMES`), and replay-window message ID checks.
- **Peer Key Pinning & Revocation (`storage.rs`):** First-seen Ed25519 identity keys are pinned per `device_id` on both outgoing pairing and accepted inbound handshakes. Mismatched keys or locally revoked peers are rejected before frame exchange.
- **Localhost API & WebSocket Hardening (`apps/desktop/src/server.rs`):** Every `/p2p/v1/*` HTTP call requires `Authorization: Bearer <session_token>` (`subtle::ConstantTimeEq`) and restricts `Host` / `Origin` headers to the local `127.0.0.1:<expected_port>` origin. WebSocket `/p2p/v1/ws` requires matching `?token=`. Browser URL `#cloakToken=` fragments are cleared cleanly on load.
- **At-Rest Key Wrapping (`crypto.rs::dpapi_protect` / `dpapi_unprotect`):** On Windows, the local vault master key and sensitive fields (`VaultSecretBox`) are protected using Win32 DPAPI (`CryptProtectData`) scoped to the signed-in Windows user account (`DPAPI` badge shown in UI).
- **Ghost PIN Verification (`crypto.rs`):** Ghost Privacy Shield PINs are hashed with Argon2id + random salt (`argon2` crate), never plaintext.
- **No Silent Relay Fallback:** In `DirectOnly` mode (default), failed TCP routes raise `DirectConnectivityBlocked` explicitly rather than falling back to third-party relays.

---

## 2. Honest Security & Forensic Limitations

1. **Windows DPAPI User-Session Boundary:** Any malicious process running under the **same Windows user account** can call Win32 `CryptUnprotectData` or inspect process memory while Cloak is unlocked. Cloak relies on OS user isolation + Windows login credentials + BitLocker for offline physical disk protection.
2. **SQLite Forensic Persistence (`PRAGMA` & OS Cache Caveat):** Deleting messages in `clear_viewed`, `clear_open_conversation`, or `burn` removes rows from SQLite tables, deletes attachment chunk files/rows, and records anti-resurrection entries in `local_suppressions`. However, without full-disk encryption (BitLocker/VeraCrypt) and explicit SQLite `VACUUM` / `PRAGMA secure_delete = ON` + OS SSD TRIM/wear-leveling control, magnetic/flash blocks on unencrypted disks may still hold historical fragments outside SQLite's active B-tree.
3. **`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` OS Limits:** Capturing the Cloak window appears black in standard Windows Desktop Duplication / PrintWindow / browser tab pickers on supported Windows 10/11 builds, **unless** privileged kernel display drivers, hardware HDMI splitters/cameras aimed at the monitor, or certain legacy/virtual display capture hooks bypass DWM composition.
4. **Unsigned Windows Binaries:** `cloak-desktop.exe` and `Cloak-Setup-x64.exe` are currently **unsigned** (no Authenticode certificate), so Windows Defender SmartScreen will warn users downloading them from the internet until signed.
5. **Direct Peer IP Disclosure:** Direct P2P TCP connections and `cloakp2p://` tickets inherently reveal participating peers' IP addresses to each other over LAN, VPN, or WAN.
6. **Direct WebRTC Signaling Trust Model:** SDP/ICE signaling rides inside encrypted P2P TCP frames, while media packets travel via standard WebRTC DTLS-SRTP (`RTCPeerConnection`). WebRTC UDP media bypasses Cloak's TCP stream framing (using browser/WebView2's native DTLS-SRTP) and may expose ICE host/srflx candidates to the connected peer (or user-configured STUN server if Assisted mode is enabled).

