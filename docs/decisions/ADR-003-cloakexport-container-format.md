# ADR-003: Password-Protected `.cloakexport` Binary Container Specification (v1)

## Status
Accepted

## Context
Cloak's export engine must output an offline, self-contained HTML + attachment archive whose filenames, manifests, participant lists, and message histories are confidential even at rest, using vetted Argon2id + libsodium secretstream XChaCha20-Poly1305 without loading huge archives wholly into memory or exposing metadata in headers.

## Decision
Define `.cloakexport` version `1` as a framed binary format:

### Unencrypted Header (Fixed 72 bytes)
| Offset | Size | Field | Value / Encoding |
| --- | --- | --- | --- |
| `0` | `8` | Magic | ASCII `CLKEXP01` |
| `8` | `2` | Version | `uint16 LE` = `1` |
| `10` | `2` | Flags | `uint16 LE` = `0` |
| `12` | `1` | KDF ID | `1` = `libsodium Argon2id13` |
| `13` | `1` | Cipher ID | `1` = `libsodium secretstream_xchacha20poly1305` |
| `14` | `2` | Reserved | `0x0000` |
| `16` | `8` | `opslimit` | `uint64 LE` (validated against safe min/max bounds) |
| `24` | `8` | `memlimit` | `uint64 LE` (bytes; validated against safe max RAM cap) |
| `32` | `16` | `salt` | 16 cryptographically random bytes |
| `48` | `24` | `stream_header` | 24-byte `crypto_secretstream_xchacha20poly1305_HEADERBYTES` |

*Note: Zero room IDs, room names, participant identities, message counts, or filenames appear in the 72-byte header.*

### Authenticated Encrypted Stream Payload
- Key derivation: `key = crypto_pwhash(32, password_utf8, salt, opslimit, memlimit, crypto_pwhash_ALG_ARGON2ID13)`
- Stream initialization: `crypto_secretstream_xchacha20poly1305_init_push(key)`
- Framing: Repeated sequence of `[uint32 LE encrypted_chunk_len][ciphertext_chunk]`, where each `ciphertext_chunk` is produced by `crypto_secretstream_xchacha20poly1305_push`.
- **Header integrity binding:** Chunk `0` binds the exact 72-byte header as Additional Authenticated Data (`ad = header[0..72]`). Any tampering with magic/version/flags/KDF params/salt/stream_header fails AEAD authentication on chunk `0`.
- **Finality enforcement:** The last chunk MUST carry `TAG_FINAL`. Any EOF prior to `TAG_FINAL` (truncation) or trailing bytes after `TAG_FINAL` is rejected as corrupted/tampered.
- **Inner Payload:** Streaming ZIP built with `@zip.js/zip.js` containing `CLOAK-EXPORT/{index.html, manifest.json, messages.json, styles/archive.css, assets/..., integrity/sha256.json}`.
- **Safety Limits on Unlock:** Max compressed container check, ZIP path traversal rejection (`..`, absolute, drive-letter, backslash, null-byte), max uncompressed entry size, max total extracted bytes, max entry count, and compression ratio guard against ZIP bombs.

