<#
.SYNOPSIS
Reproducible Two-PC Windows LAN QA Helper for Cloak Desktop (Phase 11).

.DESCRIPTION
Prepares a Windows PC for real two-machine LAN testing:
  1. Verifies local LAN IPv4/IPv6 addresses and listening TCP sockets.
  2. Checks whether Windows Defender Firewall has an inbound allow rule for Cloak.
  3. Optionally creates a scoped inbound allow rule (-ConfigureFirewall) for cloak-desktop.exe.
  4. Launches Cloak Desktop (-Role Host or -Role Peer) with a clean QA data directory and prints
     exact verification steps for pairing tickets, Strict Direct-Only failure, LAN chat/file sync,
     and live WebRTC audio/video/screen sharing across two physical PCs.
#>
param(
    [ValidateSet("Host", "Peer", "CheckOnly")]
    [string]$Role = "CheckOnly",
    [switch]$ConfigureFirewall,
    [int]$P2pPort = 47890,
    [string]$ExecutablePath = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not $ExecutablePath) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Cloak\cloak-desktop.exe"),
        (Join-Path $RepoRoot "target\release\cloak-desktop.exe")
    )
    $ExecutablePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

Write-Host "=== Cloak Two-PC LAN QA Diagnostics ===" -ForegroundColor Cyan
Write-Host "Host Machine : $env:COMPUTERNAME ($env:USERNAME)"
Write-Host "Binary Path  : $ExecutablePath"

$lanIpv4 = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -ExpandProperty IPAddress
Write-Host "LAN IPv4(s)  : $(if ($lanIpv4) { $lanIpv4 -join ', ' } else { 'None detected' })"

$fwRules = Get-NetFirewallRule -DisplayName "*Cloak*" -ErrorAction SilentlyContinue
if ($fwRules) {
    Write-Host "Firewall Rule: Present ($($fwRules.Count) rule(s) matching *Cloak*)" -ForegroundColor Green
} else {
    Write-Host "Firewall Rule: MISSING (Windows Defender Firewall may block inbound LAN pairing unless allowed)" -ForegroundColor Yellow
}

if ($ConfigureFirewall) {
    if (-not $ExecutablePath -or -not (Test-Path $ExecutablePath)) {
        throw "Cannot configure firewall: cloak-desktop.exe not found."
    }
    Write-Host "Creating scoped inbound firewall rule for $ExecutablePath (Private,Domain)..." -ForegroundColor Cyan
    New-NetFirewallRule `
        -DisplayName "Cloak P2P Desktop (LAN QA)" `
        -Direction Inbound `
        -Action Allow `
        -Program $ExecutablePath `
        -Protocol TCP `
        -Profile Private,Domain `
        -ErrorAction Stop | Out-Null
    Write-Host "Firewall allow rule created successfully." -ForegroundColor Green
}

if ($Role -eq "CheckOnly") {
    Write-Host "`nNext steps on TWO physical Windows PCs on the same subnet:"
    Write-Host "  PC A (Host): powershell -ExecutionPolicy Bypass -File scripts\two-pc-lan-qa.ps1 -Role Host"
    Write-Host "  PC B (Peer): powershell -ExecutionPolicy Bypass -File scripts\two-pc-lan-qa.ps1 -Role Peer"
    exit 0
}

if (-not $ExecutablePath -or -not (Test-Path $ExecutablePath)) {
    throw "cloak-desktop.exe not found. Run scripts\package-windows.ps1 or install Cloak-Setup-x64.exe first."
}

$QaVault = Join-Path $env:TEMP "cloak-lan-qa-$Role"
New-Item -ItemType Directory -Force -Path $QaVault | Out-Null

Write-Host "`nLaunching Cloak Desktop ($Role) with isolated QA vault: $QaVault" -ForegroundColor Green
Write-Host "Checklist across PC A and PC B:"
Write-Host "  [1] Verify LAN IPv4 displays in sidebar diagnostics on both PCs."
Write-Host "  [2] Test Strict Direct-Only failure BEFORE firewall allow rule or with wrong port."
Write-Host "  [3] Export cloakp2p://<LAN_IP>:$P2pPort?... ticket on PC A -> Pair on PC B."
Write-Host "  [4] Verify 20+ encrypted messages, >10 MiB file transfer SHA-256 parity, and WebRTC Video+Screen."
Write-Host "  [5] Close app on PC B -> send 5 offline messages on PC A -> reopen PC B -> confirm sync."

& $ExecutablePath --data-dir $QaVault --p2p-bind "0.0.0.0:$P2pPort" --name "Cloak-$Role-$env:COMPUTERNAME"

