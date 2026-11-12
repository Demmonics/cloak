# Cloak Remaining Work & Known Follow-Ups

While the core native Rust P2P desktop core (`crates/cloak-p2p`), native Windows desktop runner (`apps/desktop`), web E2EE workspace (`apps/web`), and optional API relay (`services/*`) all compile, lint, and pass automated tests on this host, the following items remain outside single-machine localhost verification:

1. **Physical Two-Machine LAN & WAN P2P Validation:**
   - Test `cloak-desktop.exe` across two separate Windows hosts on both same-subnet LAN and external NATs/firewalls, including explicit Windows Defender Firewall rules or UPnP/port-forwarding guidance.
2. **Optional Assisted Rendezvous / TURN Helper Implementation:**
   - `ConnectivityMode::Assisted` currently surfaces STUN ICE servers for WebRTC media setup; adding an external self-hostable NAT-traversal / TURN relay daemon for restrictive symmetric NATs remains future opt-in work when users choose to leave strict `DirectOnly` mode.
3. **Desktop Native WebRTC E2EE Media Testing:**
   - Automated Playwright E2E verified WebRTC signaling frame exchange inside `cloak-p2p` TCP streams; end-to-end physical microphone, webcam, and screen-capture playback in two separate Edge App Mode desktop windows should be tested interactively on real media devices.
4. **Full Docker Compose Production Smoke Run:**
   - Run `infrastructure/docker/docker-compose.yml` (PostgreSQL, Redis, MinIO, LiveKit, Caddy, `cloak-api`, `cloak-worker`, `cloak-web`) on a Linux/Docker host before public internet deployment of the optional relay stack.
5. **Single-File Windows Installer Packaging:**
   - Package `target/release/cloak-desktop.exe` with an icon resource (`winres`), code signing certificate, and optional MSI/MSIX or portable ZIP release checksums for end-user distribution.

