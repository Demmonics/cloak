$ErrorActionPreference = 'Stop'

$exe = Resolve-Path "target\release\cloak-desktop.exe"
$sizeMb = [Math]::Round((Get-Item $exe).Length / 1MB, 2)
$token = "bench-token-$([Guid]::NewGuid())"
$headers = @{ Authorization = "Bearer $token" }

$dirGui = Join-Path $env:TEMP "cloak-bench-gui-$([Guid]::NewGuid())"
$dirA = Join-Path $env:TEMP "cloak-bench-a-$([Guid]::NewGuid())"
$dirB = Join-Path $env:TEMP "cloak-bench-b-$([Guid]::NewGuid())"
New-Item -ItemType Directory -Path $dirGui, $dirA, $dirB -Force | Out-Null

$procGui = $null
$procA = $null
$procB = $null

try {
    # 1. Measure Real Native WebView2 GUI Cold Launch
    $swGui = [System.Diagnostics.Stopwatch]::StartNew()
    $procGui = Start-Process -FilePath $exe -ArgumentList @('--data-dir', $dirGui, '--p2p-bind', '127.0.0.1:0', '--http-port', '14410', '--api-token', $token, '--autoclose-ms', '3000', '--name', 'BenchGUI') -PassThru
    $readyGui = $false
    for ($i = 0; $i -lt 150; $i++) {
        try {
            $respG = Invoke-RestMethod -Uri 'http://127.0.0.1:14410/p2p/v1/status' -Headers $headers -TimeoutSec 1
            if ($respG.deviceId) { $readyGui = $true; break }
        } catch {
            Start-Sleep -Milliseconds 20
        }
    }
    $swGui.Stop()
    if (-not $readyGui) { throw 'cloak-desktop GUI did not become ready in time' }
    Start-Sleep -Milliseconds 400
    $procGui.Refresh()
    $guiWsMb = [Math]::Round($procGui.WorkingSet64 / 1MB, 2)
    $procGui.WaitForExit(5000) | Out-Null

    # 2. Measure Headless Cold Startup & Idle WorkingSet
    $swBoot = [System.Diagnostics.Stopwatch]::StartNew()
    $procA = Start-Process -FilePath $exe -ArgumentList @('--headless', '--data-dir', $dirA, '--p2p-bind', '127.0.0.1:0', '--http-port', '14411', '--api-token', $token, '--name', 'BenchAlice') -PassThru -WindowStyle Hidden
    $readyA = $false
    for ($i = 0; $i -lt 150; $i++) {
        try {
            $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:14411/p2p/v1/status' -Headers $headers -TimeoutSec 1
            if ($resp.deviceId) {
                $readyA = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 15
        }
    }
    $swBoot.Stop()
    if (-not $readyA) { throw 'cloak-desktop A did not become ready in time' }

    $procB = Start-Process -FilePath $exe -ArgumentList @('--headless', '--data-dir', $dirB, '--p2p-bind', '127.0.0.1:0', '--http-port', '14412', '--api-token', $token, '--name', 'BenchBob') -PassThru -WindowStyle Hidden
    $readyB = $false
    for ($i = 0; $i -lt 150; $i++) {
        try {
            $respB = Invoke-RestMethod -Uri 'http://127.0.0.1:14412/p2p/v1/status' -Headers $headers -TimeoutSec 1
            if ($respB.deviceId) { $readyB = $true; break }
        } catch {
            Start-Sleep -Milliseconds 15
        }
    }
    if (-not $readyB) { throw 'cloak-desktop B did not become ready in time' }

    $wsMb = [Math]::Round((Get-Process -Id $procA.Id).WorkingSet64 / 1MB, 2)

    # Create room + pair A <-> B
    $created = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:14411/p2p/v1/rooms' -Headers $headers -ContentType 'application/json' -Body '{"name":"Bench Room"}'
    $roomId = $created.room.id
    $chanId = $created.channel.id
    $ticket = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:14411/p2p/v1/rooms/$roomId/ticket" -Headers $headers -ContentType 'application/json' -Body '{}'
    $pairBody = @{ uri = $ticket.uri; connectivityMode = @{ mode = 'direct_only' } } | ConvertTo-Json -Depth 4
    $null = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:14412/p2p/v1/pair' -Headers $headers -ContentType 'application/json' -Body $pairBody

    # Measure 50 sequential encrypted SQLite + direct P2P messages
    $swMsgs = [System.Diagnostics.Stopwatch]::StartNew()
    for ($n = 1; $n -le 50; $n++) {
        $msgBody = @{ text = "benchmark-message-$n" } | ConvertTo-Json
        $null = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:14411/p2p/v1/rooms/$roomId/channels/$chanId/messages" -Headers $headers -ContentType 'application/json' -Body $msgBody
    }
    while ($true) {
        $bobMsgs = Invoke-RestMethod -Uri "http://127.0.0.1:14412/p2p/v1/rooms/$roomId/channels/$chanId/messages" -Headers $headers
        if ($bobMsgs.Count -ge 50 -or $swMsgs.ElapsedMilliseconds -gt 10000) { break }
        Start-Sleep -Milliseconds 15
    }
    $swMsgs.Stop()

    # Measure 2 MiB chunked SHA-256 P2P attachment transfer
    $blobBytes = New-Object byte[] (2 * 1024 * 1024)
    (New-Object System.Random 42).NextBytes($blobBytes)
    $swFile = [System.Diagnostics.Stopwatch]::StartNew()
    $attMeta = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:14411/p2p/v1/rooms/$roomId/files?filename=bench.bin&mimeType=application/octet-stream" -Headers $headers -Body $blobBytes
    $downloaded = $null
    for ($t = 0; $t -lt 100; $t++) {
        try {
            $downloaded = Invoke-WebRequest -Uri "http://127.0.0.1:14412/p2p/v1/files/$($attMeta.id)" -Headers $headers -UseBasicParsing
            if ($downloaded.RawContentLength -eq $blobBytes.Length) { break }
        } catch {
            Start-Sleep -Milliseconds 20
        }
    }
    $swFile.Stop()

    [PSCustomObject]@{
        ReleaseBinarySizeMiB   = $sizeMb
        NativeGuiHttpReadyMs   = [Math]::Round($swGui.Elapsed.TotalMilliseconds, 1)
        NativeGuiWorkingSetMiB = $guiWsMb
        HeadlessStartupMs      = [Math]::Round($swBoot.Elapsed.TotalMilliseconds, 1)
        HeadlessIdleRamMiB     = $wsMb
        FiftyMsgsEndToEndMs    = [Math]::Round($swMsgs.Elapsed.TotalMilliseconds, 1)
        SyncedMessagesOnPeer   = $bobMsgs.Count
        TwoMiBFileTransferMs   = [Math]::Round($swFile.Elapsed.TotalMilliseconds, 1)
        VerifiedBytesOnPeer    = if ($downloaded) { $downloaded.RawContentLength } else { 0 }
    } | Format-List
} finally {
    if ($procGui -and -not $procGui.HasExited) { Stop-Process -Id $procGui.Id -Force -ErrorAction SilentlyContinue }
    if ($procA -and -not $procA.HasExited) { Stop-Process -Id $procA.Id -Force -ErrorAction SilentlyContinue }
    if ($procB -and -not $procB.HasExited) { Stop-Process -Id $procB.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $dirGui, $dirA, $dirB
}
