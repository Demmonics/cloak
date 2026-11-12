use std::net::{IpAddr, SocketAddr, UdpSocket};

use if_addrs::{IfAddr, get_if_addrs};

use crate::model::{NetworkDiagnostics, NetworkInterfaceCandidate};

/// Probes the OS routing table without transmitting packets to find the preferred outbound LAN IPv4/IPv6.
fn probe_outbound_ip(target: &str) -> Option<IpAddr> {
    let bind_addr = if target.starts_with('[') {
        "[::]:0"
    } else {
        "0.0.0.0:0"
    };
    let sock = UdpSocket::bind(bind_addr).ok()?;
    sock.connect(target).ok()?;
    let ip = sock.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        return None;
    }
    Some(ip)
}

/// Formats a `host:port` cleanly, wrapping IPv6 literals in `[...]`.
pub fn format_host_port(ip: IpAddr, port: u16) -> String {
    match ip {
        IpAddr::V4(v4) => format!("{v4}:{port}"),
        IpAddr::V6(v6) => format!("[{v6}]:{port}"),
    }
}

/// Enumerates usable local LAN / Tailscale / IPv6 interfaces for two-computer direct pairing.
pub fn enumerate_interface_candidates(listen_port: u16) -> Vec<NetworkInterfaceCandidate> {
    let mut out = Vec::new();
    let Ok(ifaces) = get_if_addrs() else {
        return out;
    };

    for iface in ifaces {
        let ip = match iface.addr {
            IfAddr::V4(v4) => IpAddr::V4(v4.ip),
            IfAddr::V6(v6) => IpAddr::V6(v6.ip),
        };
        if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
            continue;
        }
        let (family, scope) = match ip {
            IpAddr::V4(v4) => {
                if v4.is_link_local() {
                    continue;
                }
                let oct = v4.octets();
                let scope = if v4.is_private() {
                    "lan_private"
                } else if oct[0] == 100 && (64..=127).contains(&oct[1]) {
                    "cgnat_vpn"
                } else {
                    "public_ipv4"
                };
                ("ipv4", scope)
            }
            IpAddr::V6(v6) => {
                // Skip link-local fe80:: addresses since zone IDs are not portable in URLs.
                let seg0 = v6.segments()[0];
                if (seg0 & 0xffc0) == 0xfe80 {
                    continue;
                }
                let scope = if (seg0 & 0xfe00) == 0xfc00 {
                    "ula_private"
                } else {
                    "global_ipv6"
                };
                ("ipv6", scope)
            }
        };

        out.push(NetworkInterfaceCandidate {
            name: iface.name,
            ip: ip.to_string(),
            family: family.to_string(),
            scope: scope.to_string(),
            suggested_addr: format_host_port(ip, listen_port),
        });
    }

    // Sort LAN IPv4 ahead of VPN/IPv6 for ergonomic ticket defaults
    out.sort_by_key(|c| match c.scope.as_str() {
        "lan_private" => 0,
        "cgnat_vpn" => 1,
        "public_ipv4" => 2,
        "global_ipv6" => 3,
        _ => 4,
    });
    out
}

/// Checks whether a Windows Defender Firewall inbound rule exists for Cloak P2P Desktop.
#[cfg(target_os = "windows")]
fn check_windows_firewall_rule() -> (Option<bool>, String) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let output = std::process::Command::new("netsh")
        .args([
            "advfirewall",
            "firewall",
            "show",
            "rule",
            "name=Cloak P2P Desktop",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    match output {
        Ok(out) if out.status.success() => (
            Some(true),
            "Windows Firewall rule 'Cloak P2P Desktop' is present.".to_string(),
        ),
        Ok(_) => (
            Some(false),
            "No 'Cloak P2P Desktop' Windows Firewall allow rule detected; incoming LAN connections on other PCs may prompt Windows Defender Firewall or require allowing TCP on Cloak's listen port."
                .to_string(),
        ),
        Err(err) => (
            None,
            format!("Unable to query netsh advfirewall status ({err})."),
        ),
    }
}

#[cfg(not(target_os = "windows"))]
fn check_windows_firewall_rule() -> (Option<bool>, String) {
    (
        None,
        "Non-Windows host; firewall diagnostics skipped.".to_string(),
    )
}

/// Collects real host network & vault diagnostics for the Desktop UI.
pub fn collect_network_diagnostics(
    listen_addr: SocketAddr,
    vault_dpapi_protected: bool,
) -> NetworkDiagnostics {
    let primary_lan_ip = probe_outbound_ip("8.8.8.8:80").map(|ip| ip.to_string());
    let primary_ipv6 = probe_outbound_ip("[2001:4860:4860::8888]:80").map(|ip| ip.to_string());
    let interfaces = enumerate_interface_candidates(listen_addr.port());
    let (windows_firewall_rule_present, firewall_note) = check_windows_firewall_rule();

    NetworkDiagnostics {
        listen_addr: listen_addr.to_string(),
        primary_lan_ip,
        primary_ipv6,
        interfaces,
        windows_firewall_rule_present,
        firewall_note,
        vault_dpapi_protected,
    }
}
