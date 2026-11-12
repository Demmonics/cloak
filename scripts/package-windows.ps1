$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $RepoRoot

$env:CARGO_HTTP_MULTIPLEXING = 'false'

Write-Host '[package] Building release desktop & setup binaries...'
cargo +stable-x86_64-pc-windows-gnu build --release -p cloak-desktop --bins
if ($LASTEXITCODE -ne 0) {
  throw "Release build failed with exit code $LASTEXITCODE"
}

$ReleaseDir = Join-Path $RepoRoot 'target\release'
$DesktopExe = Join-Path $ReleaseDir 'cloak-desktop.exe'
$SetupExe = Join-Path $ReleaseDir 'cloak-setup.exe'
if (!(Test-Path $DesktopExe) -or !(Test-Path $SetupExe)) {
  throw 'Missing cloak-desktop.exe or cloak-setup.exe in target/release'
}

$OutDir = Join-Path $RepoRoot 'dist-windows'
$PortableDir = Join-Path $OutDir 'portable'
if (Test-Path $PortableDir) {
  Remove-Item -Recurse -Force $PortableDir
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path $PortableDir | Out-Null

# 1. Portable Zip Bundle
Copy-Item $DesktopExe (Join-Path $PortableDir 'cloak-desktop.exe') -Force
@'
@echo off
setlocal
"%~dp0cloak-desktop.exe" --data-dir "%~dp0cloak-data" %*
'@ | Set-Content -Path (Join-Path $PortableDir 'Launch-Cloak-Portable.bat') -Encoding Ascii

@'
Cloak Desktop — Portable Edition (win64)
=========================================
Run Launch-Cloak-Portable.bat (or cloak-desktop.exe directly).
Local SQLite vault, DPAPI secret sealing key, and attachments are stored inside .\cloak-data\
'@ | Set-Content -Path (Join-Path $PortableDir 'README-PORTABLE.txt') -Encoding Ascii

$PortableZip = Join-Path $OutDir 'Cloak-Portable-win64.zip'
if (Test-Path $PortableZip) {
  Remove-Item $PortableZip -Force
}
Compress-Archive -Path (Join-Path $PortableDir '*') -DestinationPath $PortableZip -CompressionLevel Optimal

# 2. Single-File Native Installer (cloak-setup.exe + payload + u64 len + "CLOAKPKG1")
$InstallerPath = Join-Path $OutDir 'Cloak-Setup-x64.exe'
$setupBytes = [System.IO.File]::ReadAllBytes($SetupExe)
$desktopBytes = [System.IO.File]::ReadAllBytes($DesktopExe)
$lenBytes = [System.BitConverter]::GetBytes([uint64]$desktopBytes.Length)
if (![System.BitConverter]::IsLittleEndian) {
  [System.Array]::Reverse($lenBytes)
}
$magicBytes = [System.Text.Encoding]::ASCII.GetBytes('CLOAKPKG1')

$fs = [System.IO.File]::Open($InstallerPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
try {
  $fs.Write($setupBytes, 0, $setupBytes.Length)
  $fs.Write($desktopBytes, 0, $desktopBytes.Length)
  $fs.Write($lenBytes, 0, $lenBytes.Length)
  $fs.Write($magicBytes, 0, $magicBytes.Length)
} finally {
  $fs.Dispose()
}

# 3. Checksums & Size Report
$sums = @()
foreach ($file in @($DesktopExe, $InstallerPath, $PortableZip)) {
  $hash = (Get-FileHash -Path $file -Algorithm SHA256).Hash
  $sizeMiB = [Math]::Round((Get-Item $file).Length / 1MB, 2)
  $name = [System.IO.Path]::GetFileName($file)
  $sums += "$hash  $name ($sizeMiB MiB)"
  Write-Host "[package] $name -> $sizeMiB MiB (SHA256: $hash)"
}
$sums | Set-Content -Path (Join-Path $OutDir 'SHA256SUMS.txt') -Encoding Ascii
Write-Host "[package] Done -> $OutDir"

