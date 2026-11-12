# Phase 12 P2P Validation Report

## 1. Local Multi-Instance P2P Validation (Executed on One Physical Windows Host)

- **Rust P2P Core (`cargo test -p cloak-p2p`):** Two independent `P2pNode` instances over real localhost TCP sockets validated:
  - Signed `PairingTicket` creation, Ed25519 signature verification, `JoinWithInvite` -> `JoinAccepted` / `JoinRejected`, and strict `DirectOnly` refusal when port is unreachable (`strict_direct_only_reports_explicit_failure_without_relay`).
  - Bidirectional encrypted message sync, message edit/delete propagation, chunked sealed attachment transfer, and WebRTC signaling (`two_peers_direct_encrypted_messaging_edit_delete_file_and_webrtc_signal`).
  - Offline outbox persistence & flush on reconnect (`offline_outbox_flushes_when_peer_comes_online`).
  - Replay/expiry/revocation/tamper rejection (`signed_invitation_replay_expiry_revocation_and_tamper_rejected`), cross-room isolation (`cross_room_broadcast_isolation_and_revocation_cleanup`), and uninvited peer rejection (`uninvited_authenticated_peer_rejected_across_all_room_wire_frames`).
- **Desktop Axum Loopback + Native Binary (`server::tests` & Playwright E2E):**
  - Two live `cloak-desktop.exe` processes (`DesktopAlice` and `DesktopBob`; `MediaAlice` and `MediaBob`) verified end-to-end UI pairing with single-use signed tickets, `DirectOnly` refusal on wrong port, real two-peer attachment exchange, Ghost Mode view/clear/burn isolation, WebRTC media/screen-share negotiation (`Spec 3`), and Stealth PDF decoy lock/unlock (`stealth-mode.spec.ts`).

## 2. Host Network Interfaces Observed

Enumerated during hardware probe on this machine (`Get-NetIPAddress -AddressFamily IPv4`):
- `Wi-Fi`: `192.168.29.241`
- `Tailscale`: `100.73.157.26`
- `Ethernet 3`: `192.168.56.1`
- `Ethernet`: `172.17.16.64`
- Link-local `169.254.*` virtual adapters present

No second physical Windows PC running Cloak was available on the local network during this session.

## 3. Two-PC LAN Validation Kit (`scripts/two-pc-lan-qa.ps1`)

Upgraded `scripts/two-pc-lan-qa.ps1` with Phase 12 manual & automated operator verification steps `[1]-[7]`:
1. Expand **"Advanced Connection & Vault Diagnostics"** on Host A and confirm `DPAPI` + `LAN IPv4` interface suggestions match `Wi-Fi`/`Ethernet`/`Tailscale`.
2. Export a **Single-use (1)** signed `cloakp2p://` pairing ticket advertising Host A's reachable LAN/VPN IPv4 address.
3. Pair Host B across physical LAN and verify Host A displays `1` used on the invite and refuses replay from a third client (`PeerRejected`).
4. Verify bidirectional E2EE messaging, file transfer, voice/video + native screen share, and Windows Defender Firewall TCP inbound rule status (`netsh advfirewall`).
5. Test live peer revocation + Stealth lock (`"Document Reader"` Win32 HWND title -> `"Cloak"` on unlock).

## 4. Two-PC LAN & WAN Classification

| Validation Target | Status | Notes |
| :--- | :--- | :--- |
| Same-PC two-instance `DirectOnly` TCP + WebRTC | **Tested on one physical PC** | Automated via Rust tests (`16/16`), HTTP tests (`2/2`), and Playwright E2E (`4/4`) |
| Two physical Windows PCs on same LAN (`Wi-Fi`/`Ethernet`) | **Blocked — Pending Physical Hardware** | Kit ready (`scripts/two-pc-lan-qa.ps1`); no second PC present during session |
| Cross-subnet / WAN / CGNAT traversal (`Tailscale` / `STUN`) | **Blocked — Pending Physical Hardware** | Requires second physical/remote peer host |

