# Cloak P2P Network Verification

**Tested Host Environment:** Single Windows host (`stable-x86_64-pc-windows-gnu`), loopback TCP (`127.0.0.1`), live virtual & Wi-Fi NIC enumeration.

---

## 1. Verification Status Summary

| Capability | Status | Observed Evidence |
|---|---|---|
| Ed25519 + X25519 + HKDF-SHA-256 Handshake & Mutual HMAC Ack | **Tested on localhost** | `cloak-p2p` tests (`6/6` passed) + Playwright `Spec 1..3` (`3/3` passed) across separate processes & SQLite vaults. |
| Strict `DirectOnly` Refusal Without Silent Relay | **Tested on localhost** | `strict_direct_only_reports_explicit_failure_without_relay` + Playwright `Spec 1` attempting `cloakp2p://127.0.0.1:19999?...` explicitly displays `DirectConnectivityBlocked` error without fallback. |
| Mutual Inbound Peer Registration & Key Pinning | **Tested on localhost** | `perform_authenticated_handshake` (`transport.rs`) automatically registers & pins newly accepted inbound peers in `vault.peers`; verified in Playwright (`07-p2p-desktop-1920x1080.png` shows `Peer <id> Direct Revoke` on Alice alongside `DesktopAlice Direct Revoke` on Bob) and `Spec 2` (`Revoke` button). |
| Encrypted Messaging, Ed25519 Signatures, Search, Offline Outbox & Sync | **Tested on localhost** | `two_peers_direct_encrypted_messaging...`, `offline_outbox_flushes_when_peer_comes_online`, benchmark (`50` messages in `228.1 ms`, `50/50` synced), and Playwright `Spec 1`. |
| SHA-256 Chunked File Transfer (`FileInit` / `FileChunk` / `FileAck`) | **Tested on localhost** | Benchmark (`2 MiB` / `2,097,152` bytes in `1163.6 ms`, `100%` verified bytes) and Playwright `Spec 1` (`p2p-proof.txt` upload/download). |
| Multi-Interface LAN/IPv6/VPN Candidate Discovery & VirtualBox Filtering | **Implemented & UI-verified on localhost** | `netinfo.rs::collect_network_diagnostics` filters out loopback/link-local noise and sets `primaryLanIp` (`192.168.29.241` Wi-Fi preferred over VirtualBox `192.168.56.1` / Tailscale `100.73.157.26` / IPv6), preserving `Loopback Default` when bound to `127.0.0.1`. |
| Loopback HTTP/WS API Auth Guard | **Tested on localhost** | `desktop_embedded_ui_security_guard_and_two_instance_p2p_flow` + Playwright `Spec 1`: missing/wrong bearer token returns `401 Unauthorized`; URL `#cloakToken=` is stripped from browser location on load. |
| Multi-Machine Physical LAN / Wi-Fi Direct Pairing | **Not yet verified** | Only one physical host available during this session; cross-host firewall/LAN checklist provided in `docs/FIREWALL_AND_LAN_SETUP.md`. |
| Public WAN Across Two Symmetric NATs | **Not yet verified** | Requires two external hosts + port forwarding or user-supplied TURN/rendezvous infrastructure. |

