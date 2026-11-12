# Cloak Windows Firewall, LAN & Two-PC QA Guide

Use this guide when testing Cloak Desktop across **two separate physical PCs** on the same Wi-Fi/Ethernet LAN or encrypted overlay VPN (Tailscale / WireGuard).

---

## 1. Selecting the Right Interface & Binding Address

- By default, launching `cloak-desktop.exe` with no arguments binds P2P TCP to `0.0.0.0:0` (all interfaces, random OS port) and HTTP UI strictly to `127.0.0.1:<random_port>`.
- `crates/cloak-p2p/src/netinfo.rs` filters loopback/link-local addresses and surfaces usable interfaces in the **Advertised interface address** selector, prioritizing `primaryLanIp` (real Wi-Fi/Ethernet LAN IPv4 such as `192.168.x.x` ahead of VirtualBox host-only adapters such as `192.168.56.1`).
- **Important:** Do **not** launch with `--p2p-bind 127.0.0.1:0` when pairing across two physical machines — loopback binds only accept local connections on the same PC.
- **Note on VirtualBox / VMware / Tailscale:** If the ticket advertises `192.168.56.1` (VirtualBox host-only), pick your `Wi-Fi` or `Ethernet` LAN IP (or `Tailscale` `100.x.y.z` / IPv6 ULA) in the **Advertised interface address** dropdown before clicking **Generate Ticket**.

---

## 2. Windows Defender Firewall Rule

When another PC connects inbound to your Cloak Desktop P2P port on Windows:
- Windows Defender Firewall may prompt `"Allow Cloak (cloak-desktop.exe) to communicate on Private networks"`. Allow **Private networks** (or Tailscale interface).
- If running silently or pre-provisioning from an Administrator PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Cloak P2P Desktop" `
  -Direction Inbound `
  -Program "$env:LOCALAPPDATA\Programs\Cloak\cloak-desktop.exe" `
  -Action Allow `
  -Profile Private
```

The left sidebar in `/p2p` runs `netsh advfirewall firewall show rule name="Cloak P2P Desktop"` diagnostics and displays whether a matching allow rule is present.

---

## 3. Two-PC Physical LAN QA Checklist (Pending Execution)

1. Install or unzip Cloak Desktop (`Cloak-Setup-x64.exe` or `Cloak-Portable-win64.zip`) on **PC-A** and **PC-B** connected to the same Wi-Fi/Ethernet subnet.
2. On **PC-A**, create a room, choose **PC-A**'s Wi-Fi/Ethernet IPv4 in **Advertised interface address**, and click **Generate Ticket**.
3. Transfer the `cloakp2p://` URI to **PC-B** and click **Pair & Connect Directly** (`Strict Direct-Only` checked).
4. Verify **Paired Peers (1) · Direct** appears on **both** PC-A and PC-B.
5. Exchange signed text messages, transfer a >= 2 MiB binary file (verify matching filename & SHA-256 verification banner), and run `.cloakexport` -> verify opening the archive under `/archive`.
6. Start **Video** call -> confirm real camera/mic stream renders (`ICE: connected`, non-zero `RX` Mbps/FPS), toggle **Share Screen** (native Win32 window/monitor capture + `1080p30`), and test Ghost Mode **Privacy Shield** while call remains live.
7. Disconnect PC-B's Wi-Fi briefly, send messages from PC-A (verify queued outbox), reconnect PC-B, and verify automatic flush & sync.

