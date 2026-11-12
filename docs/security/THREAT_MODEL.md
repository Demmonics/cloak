# Cloak Threat Model

**Scope:** Native Local-First P2P Desktop (`crates/cloak-p2p` + `apps/desktop`) & Optional Self-Hosted Relay (`services/*` + `apps/web`)

---

## 1. Security Goals & Guarantees

1. **Device-Local Identity Sovereignty:** Ed25519 signing keys and X25519 key-exchange secrets are generated locally on the user's device and persisted solely in local storage (SQLite `cloak_local.db` on desktop; IndexedDB with WebCrypto non-extractable key or Argon2id passphrase wrapping in browsers).
2. **End-to-End Authenticated Confidentiality:**
   - **P2P Wire Transport:** Mutual Ed25519 signatures over handshake transcripts prevent impersonation; ephemeral X25519 Diffie-Hellman + HKDF-SHA256 + directional counter-nonce `XChaCha20-Poly1305` provides forward-secret transport encryption.
   - **Message & Attachment Confidentiality:** Messages are encrypted with room symmetric `XChaCha20-Poly1305` AEAD (domain-separated AAD binding `room_id`, `channel_id`, `message_id`, and `epoch`) and signed by the sender's Ed25519 identity. Attachments are verified by SHA-256 hash on reassembly.
   - **Encrypted Offline Exports:** `.cloakexport` archives use Argon2id KDF (libsodium) + `XChaCha20-Poly1305` `secretstream`, verified end-to-end in Web Workers with zero server plaintext exposure.
3. **Explicit Connectivity Policy (`DirectOnly` vs `Assisted`):** Strict `DirectOnly` mode connects solely to the peer's direct address and returns explicit errors (`DirectConnectivityBlocked`) when NAT/firewall blocks the route; it **never** falls back silently to any relay.
4. **Content Injection & Archive Safety:** Markdown rendering sanitizes HTML strictly via DOM `Sanitizer` or locked-down `DOMPurify` (`ALLOW_ARIA_ATTR=false`, `ALLOW_DATA_ATTR=false`); SVG attachments disable inline preview; `.cloakexport` / ZIP imports enforce path traversal rejection and decompression size/ratio guards.

## 2. Trust Boundaries & Mitigations

| Boundary | Threat | Mitigation Implemented |
|---|---|---|
| Local Endpoint (`cloak-desktop` UI <-> Loopback HTTP/WS) | Cross-origin scripts reading local vault API | Bound strictly to `127.0.0.1` loopback |
| Direct Peer TCP Stream | MITM / spoofing / replay | Mutual Ed25519 fingerprint check (`device_id == sha256(ed25519_pub)[..16]`) + ephemeral X25519 + monotonic counter nonces |
| Peer Compromise / Poisoned Payload | XSS or malformed files from an authorized peer | Strict HTML sanitizer + inert CSP offline HTML export + disabled inline SVG render + chunked SHA-256 verification |
| Optional Relay Server (`cloak-api`) | Honest-but-curious or compromised VPS | Receives ciphertext blobs & blind metadata only; `AllowedOrigins` CORS allowlist; production config fails closed on default JWT/Redis settings |
| Device Local Disk Theft | Physical access to `cloak_local.db` | Desktop relies on OS disk encryption (BitLocker) + Windows user profile permissions (`%LOCALAPPDATA%\CloakDesktop`); browser mode supports optional Argon2id passphrase vault lock |

## 3. Out-of-Scope Threats

- Malware or keyloggers already executing with user privileges on the local OS.
- Network-level traffic timing/volume correlation between directly paired IPs (`DirectOnly` inherently exposes peer IP addresses to the paired peer by definition of direct P2P TCP/WebRTC connectivity).

