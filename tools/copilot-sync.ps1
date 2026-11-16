[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'copilot-sync.config.json'),
    [switch]$InstallTask,
    [switch]$UninstallTask,
    [switch]$Once,
    [switch]$Run,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$script:WorktreeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:StateRoot = Join-Path $env:LOCALAPPDATA 'CopilotSync\cloak'
$script:LogPath = Join-Path $script:StateRoot 'sync.jsonl'
$script:StatePath = Join-Path $script:StateRoot 'state.json'
$script:LockPath = Join-Path $script:StateRoot 'worker.lock'
$script:EncodingNoBom = [System.Text.UTF8Encoding]::new($false)
$script:NativeTimeoutSeconds = 45

New-Item -ItemType Directory -Force -Path $script:StateRoot | Out-Null
$script:State = [ordered]@{
    lastSnapshotDigest = ''
    lastSnapshotAt = ''
    lastSuccessfulPush = ''
    lastError = ''
}
if (Test-Path -LiteralPath $script:StatePath) {
    try {
        $stored = Get-Content -LiteralPath $script:StatePath -Raw | ConvertFrom-Json
        foreach ($property in @($script:State.Keys)) {
            if ($stored.PSObject.Properties.Name -contains $property) {
                $script:State[$property] = $stored.$property
            }
        }
    } catch {
        throw 'Sync state is unreadable; preserve the state file and inspect it before restarting.'
    }
}

function Write-Log {
    param(
        [Parameter(Mandatory)][string]$Event,
        [Parameter(Mandatory)][string]$Status,
        [string]$Branch = '',
        [string]$Commit = '',
        [string]$Reason = ''
    )
    $entry = [ordered]@{
        timestamp = (Get-Date).ToUniversalTime().ToString('o')
        event = $Event
        status = $Status
        branch = $Branch
        commit = $Commit
        reason = $Reason
    }
    $line = ($entry | ConvertTo-Json -Compress) + [Environment]::NewLine
    [System.IO.File]::AppendAllText($script:LogPath, $line, $script:EncodingNoBom)
}

function Save-State {
    $json = $script:State | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($script:StatePath, $json + [Environment]::NewLine, $script:EncodingNoBom)
}

function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments,
        [int]$TimeoutSeconds = $script:NativeTimeoutSeconds
    )
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.Arguments = ($Arguments | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }) -join ' '
    $startInfo.WorkingDirectory = $script:WorktreeRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
    $startInfo.EnvironmentVariables['GCM_INTERACTIVE'] = 'Never'
    $startInfo.EnvironmentVariables['GH_PROMPT_DISABLED'] = '1'
    $startInfo.EnvironmentVariables['GIT_OPTIONAL_LOCKS'] = '0'

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'native-process-start-failed' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $process.Kill() } catch {}
        throw 'native-process-timeout'
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        StdOut = $stdout.TrimEnd()
        StdErr = $stderr.TrimEnd()
    }
}

function Invoke-Git {
    param([Parameter(Mandatory)][string[]]$Arguments)
    Invoke-Native -Executable 'git' -Arguments $Arguments
}

function Get-RequiredGitText {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $result = Invoke-Git -Arguments $Arguments
    if ($result.ExitCode -ne 0) { throw 'git-command-failed' }
    return $result.StdOut.Trim()
}

function Test-GitAncestor {
    param([Parameter(Mandatory)][string]$Ancestor, [Parameter(Mandatory)][string]$Descendant)
    $result = Invoke-Git -Arguments @('merge-base', '--is-ancestor', $Ancestor, $Descendant)
    return $result.ExitCode -eq 0
}

function Get-BranchRows {
    $format = '%(refname:short)|%(objectname:short)|%(committerdate:iso8601-strict)|%(upstream:short)'
    $result = Invoke-Git -Arguments @('for-each-ref', "--format=$format", 'refs/heads')
    if ($result.ExitCode -ne 0) { throw 'branch-enumeration-failed' }

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($line in ($result.StdOut -split "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $parts = $line -split '\|', 4
        if ($parts.Count -lt 4) { continue }
        $branch = $parts[0]
        $upstream = $parts[3]
        if ([string]::IsNullOrWhiteSpace($upstream)) {
            $candidate = "refs/remotes/$($script:Config.remoteName)/$branch"
            $hasRef = Invoke-Git -Arguments @('show-ref', '--verify', '--quiet', $candidate)
            if ($hasRef.ExitCode -eq 0) { $upstream = "$($script:Config.remoteName)/$branch" }
        }

        $ahead = 0
        $behind = 0
        $relation = 'no-upstream'
        if (-not [string]::IsNullOrWhiteSpace($upstream)) {
            $aheadResult = Invoke-Git -Arguments @('rev-list', '--count', "$upstream..$branch")
            $behindResult = Invoke-Git -Arguments @('rev-list', '--count', "$branch..$upstream")
            if ($aheadResult.ExitCode -eq 0 -and $behindResult.ExitCode -eq 0) {
                $ahead = [int]$aheadResult.StdOut.Trim()
                $behind = [int]$behindResult.StdOut.Trim()
                if ($ahead -gt 0 -and $behind -gt 0) { $relation = 'diverged' }
                elseif ($ahead -gt 0) { $relation = 'ahead' }
                elseif ($behind -gt 0) { $relation = 'behind' }
                else { $relation = 'synced' }
            } else {
                $relation = 'unknown'
            }
        }
        $owner = 'Unassigned'
        if ($script:Config.agentBranchOwners.PSObject.Properties.Name -contains $branch) {
            $owner = $script:Config.agentBranchOwners.$branch
        }
        if ($owner -eq 'Unassigned') { continue }
        $rows.Add([pscustomobject]@{
            Branch = $branch
            Commit = $parts[1]
            CommitDate = $parts[2]
            Upstream = $upstream
            Ahead = $ahead
            Behind = $behind
            Relation = $relation
            Owner = $owner
        })
    }
    return $rows.ToArray()
}

function Get-WorkerTaskStatus {
    $task = Get-ScheduledTask -TaskName $script:Config.taskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($task) { return [string]$task.State }
    return 'Not installed'
}

function Get-SnapshotDigest {
    param([object[]]$Rows, [string]$WorkerTaskStatus)
    $lines = @($Rows | Where-Object { $_.Branch -ne $script:Config.documentationBranch } |
        Sort-Object Branch | ForEach-Object {
            "$($_.Branch)|$($_.Commit)|$($_.Upstream)|$($_.Ahead)|$($_.Behind)|$($_.Relation)"
        })
    $lines += "worker-task|$WorkerTaskStatus"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
    $sha = [System.Security.Cryptography.SHA256]::HashData($bytes)
    return [Convert]::ToHexString($sha).ToLowerInvariant()
}

function Write-GeneratedStatus {
    param([object[]]$Rows, [string]$CheckedAt, [string]$WorkerTaskStatus)
    $mainRow = $Rows | Where-Object Branch -eq 'main' | Select-Object -First 1
    $docRow = $Rows | Where-Object Branch -eq $script:Config.documentationBranch | Select-Object -First 1
    $otherAhead = @($Rows | Where-Object {
        $_.Branch -ne $script:Config.documentationBranch -and $_.Ahead -gt 0
    })
    $lastPush = if ($script:State.lastSuccessfulPush) { $script:State.lastSuccessfulPush } else { 'None recorded' }
    $lastError = if ($script:State.lastError) { $script:State.lastError } else { 'None recorded' }
    $mainCommit = if ($mainRow) { $mainRow.Commit } else { 'unknown' }
    $mainAhead = if ($mainRow) { [string]$mainRow.Ahead } else { 'unknown' }
    $docCommit = if ($docRow) { $docRow.Commit } else { 'unknown' }
    $blocked = if ($otherAhead.Count) {
        ($otherAhead | ForEach-Object { "$($_.Branch) ($($_.Ahead) ahead; review required)" }) -join ', '
    } else { 'None observed' }

    $activityLines = @(
        '# Agent activity',
        '',
        "<!-- Generated by tools/copilot-sync.ps1. Do not edit by hand. -->",
        '',
        "Last check: $CheckedAt (commit metadata only; no process heartbeat).",
        '',
        '| Branch owner | Branch | Last commit | Commit date | Upstream state | Activity certainty |',
        '|---|---|---|---|---|---|'
    )
    foreach ($row in ($Rows | Sort-Object Branch)) {
        $activityLines += "| $($row.Owner) | ``$($row.Branch)`` | ``$($row.Commit)`` | $($row.CommitDate) | $($row.Relation) ($($row.Ahead) ahead / $($row.Behind) behind) | Commit evidence only; live activity unknown |"
    }
    $activityLines += ''
    $activityLines += 'No recent commit is not evidence that an agent is idle.'

    $liveLines = @(
        '# Live status',
        '',
        '<!-- Generated by tools/copilot-sync.ps1. Exact poll times are in the local JSONL log. -->',
        '',
        "- Last checked: $CheckedAt",
        "- Latest local main commit: ``$mainCommit`` ($mainAhead ahead of its configured upstream when present)",
        "- Copilot documentation branch commit: ``$docCommit``",
        "- Local pending non-Copilot branches: $blocked",
        "- Last successful push (local state): $lastPush",
        "- Worker task: $WorkerTaskStatus",
        "- Worker last error: $lastError",
        '',
        'This status reports Git refs only; it does not inspect or stage other agents'' working files.'
    )

    $syncLines = @(
        '# GitHub synchronization status',
        '',
        '<!-- Generated by tools/copilot-sync.ps1. Exact poll times are in the local JSONL log. -->',
        '',
        "- Checked: $CheckedAt",
        "- Remote: ``$($script:Config.remoteName)``; expected public repository: ``$($script:Config.repositorySlug)``",
        "- Permitted push branch: ``$($script:Config.documentationBranch)`` only",
        "- Documentation branch commit: ``$docCommit``",
        "- Local main: ``$mainCommit`` ($mainAhead ahead)",
        "- Last successful push (local state): $lastPush",
        "- Worker task: $WorkerTaskStatus",
        "- Last error: $lastError",
        "- Blocked branches requiring manual privacy review: $blocked",
        '',
        'The worker never pushes source branches, stages other worktrees, merges, or force-pushes.'
    )

    $documents = @{
        'docs/copilot/AGENT_ACTIVITY.md' = ($activityLines -join "`n") + "`n"
        'docs/copilot/LIVE_STATUS.md' = ($liveLines -join "`n") + "`n"
        'docs/copilot/GITHUB_SYNC_STATUS.md' = ($syncLines -join "`n") + "`n"
    }
    foreach ($relativePath in $documents.Keys) {
        $fullPath = Join-Path $script:WorktreeRoot ($relativePath -replace '/', '\')
        $text = $documents[$relativePath]
        [System.IO.File]::WriteAllText($fullPath, $text, $script:EncodingNoBom)
    }
}

function Test-SensitiveText {
    param([Parameter(Mandatory)][string]$Text)
    $patterns = @(
        '(?i)\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b',
        '(?i)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----',
        '(?im)\b(?:password|passwd|secret|api[_-]?key)\b\s*[:=]\s*["'']?[^"''\s,;]{12,}',
        '(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b',
        '(?<!\d)(?:\+?\d[\s().-]*){10,15}(?!\d)'
    )
    $safeCopilotAddress = '223556219+Copilot@users.noreply.github.com'
    $candidate = $Text.Replace($safeCopilotAddress, '')
    $candidate = [regex]::Replace(
        $candidate,
        '(?<!\d)\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?)?(?!\d)',
        ''
    )
    foreach ($pattern in $patterns) {
        if ([regex]::IsMatch($candidate, $pattern)) { return $true }
    }
    return $false
}

function Test-PushCandidate {
    param([switch]$NoRemoteMetadata)
    $branch = (Get-RequiredGitText -Arguments @('branch', '--show-current')).Trim()
    if ($branch -ne $script:Config.documentationBranch) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'branch-not-allowlisted'; Base = ''; Ahead = 0 }
    }

    $remoteUrl = Get-RequiredGitText -Arguments @('remote', 'get-url', $script:Config.remoteName)
    if ($remoteUrl -ne $script:Config.expectedRemoteUrl) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'remote-url-mismatch'; Base = ''; Ahead = 0 }
    }

    $mainBase = $script:Config.bootstrapBaseRef
    $bootstrapCheck = Invoke-Git -Arguments @('cat-file', '-e', "$($script:Config.bootstrapBaseCommit)^{commit}")
    if ($bootstrapCheck.ExitCode -ne 0 -or
        -not (Test-GitAncestor -Ancestor $script:Config.bootstrapBaseCommit -Descendant 'HEAD')) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'bootstrap-base-not-ancestor'; Base = ''; Ahead = 0 }
    }

    $branchRef = "refs/remotes/$($script:Config.remoteName)/$($script:Config.documentationBranch)"
    $remoteBranchCheck = Invoke-Git -Arguments @('show-ref', '--verify', '--quiet', $branchRef)
    $base = if ($remoteBranchCheck.ExitCode -eq 0) {
        "$($script:Config.remoteName)/$($script:Config.documentationBranch)"
    } else {
        $mainBase
    }
    if (-not (Test-GitAncestor -Ancestor $base -Descendant 'HEAD')) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'remote-branch-diverged-or-ahead'; Base = $base; Ahead = 0 }
    }

    $aheadResult = Invoke-Git -Arguments @('rev-list', '--count', "$base..HEAD")
    if ($aheadResult.ExitCode -ne 0) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'ahead-count-failed'; Base = $base; Ahead = 0 }
    }
    $ahead = [int]$aheadResult.StdOut.Trim()
    if ($ahead -eq 0) {
        return [pscustomobject]@{ Allowed = $true; Reason = 'no-commits-to-push'; Base = $base; Ahead = 0 }
    }

    $nameResult = Invoke-Git -Arguments @('diff', '--name-only', '--no-renames', "$base..HEAD")
    if ($nameResult.ExitCode -ne 0) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'changed-path-scan-failed'; Base = $base; Ahead = $ahead }
    }
    $paths = @($nameResult.StdOut -split "`r?`n" | Where-Object { $_ })
    if ($paths.Count -eq 0) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'empty-change-set'; Base = $base; Ahead = $ahead }
    }
    foreach ($path in $paths) {
        $allowedPath = $false
        foreach ($pattern in $script:Config.allowedPathPatterns) {
            if ($path -match $pattern) { $allowedPath = $true; break }
        }
        if (-not $allowedPath) {
            return [pscustomobject]@{ Allowed = $false; Reason = 'path-not-allowlisted'; Base = $base; Ahead = $ahead }
        }
    }

    $nameStatus = Invoke-Git -Arguments @('diff', '--numstat', '--no-renames', "$base..HEAD")
    if ($nameStatus.ExitCode -ne 0) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'file-size-scan-failed'; Base = $base; Ahead = $ahead }
    }
    foreach ($line in ($nameStatus.StdOut -split "`r?`n")) {
        if (-not $line) { continue }
        $parts = $line -split "`t", 3
        if ($parts.Count -lt 3 -or $parts[0] -eq '-' -or $parts[1] -eq '-') {
            return [pscustomobject]@{ Allowed = $false; Reason = 'binary-change-blocked'; Base = $base; Ahead = $ahead }
        }
        $size = Invoke-Git -Arguments @('cat-file', '-s', "HEAD:$($parts[2])")
        if ($size.ExitCode -eq 0 -and [int64]$size.StdOut -gt [int64]$script:Config.maxAllowedFileBytes) {
            return [pscustomobject]@{ Allowed = $false; Reason = 'file-too-large'; Base = $base; Ahead = $ahead }
        }
    }

    $checkResult = Invoke-Git -Arguments @('diff', '--check', "$base..HEAD")
    if ($checkResult.ExitCode -ne 0) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'whitespace-check-failed'; Base = $base; Ahead = $ahead }
    }

    $patch = Invoke-Git -Arguments @('diff', '--no-ext-diff', '--unified=0', "$base..HEAD")
    if ($patch.ExitCode -ne 0 -or $patch.StdOut.Length -gt [int]$script:Config.maxDiffCharacters) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'diff-unavailable-or-too-large'; Base = $base; Ahead = $ahead }
    }
    $addedText = @($patch.StdOut -split "`r?`n" |
        Where-Object { $_.StartsWith('+') -and -not $_.StartsWith('+++') } |
        ForEach-Object { $_.Substring(1) }) -join "`n"
    if (Test-SensitiveText -Text $addedText) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'sensitive-content-pattern'; Base = $base; Ahead = $ahead }
    }

    $commits = Invoke-Git -Arguments @('rev-list', '--reverse', "$base..HEAD")
    if ($commits.ExitCode -ne 0) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'commit-list-failed'; Base = $base; Ahead = $ahead }
    }
    foreach ($commit in ($commits.StdOut -split "`r?`n" | Where-Object { $_ })) {
        $message = Invoke-Git -Arguments @('show', '-s', '--format=%B', $commit)
        if ($message.ExitCode -ne 0 -or
            $message.StdOut -notmatch "(?im)^$([regex]::Escape($script:Config.requiredCommitTrailer))\s*$" -or
            (Test-SensitiveText -Text $message.StdOut)) {
            return [pscustomobject]@{ Allowed = $false; Reason = 'commit-review-trailer-or-message-check'; Base = $base; Ahead = $ahead }
        }
    }

    if (-not $NoRemoteMetadata) {
        $metadata = Invoke-Native -Executable 'gh' -Arguments @(
            'repo', 'view', $script:Config.repositorySlug, '--json', 'visibility,viewerPermission'
        )
        if ($metadata.ExitCode -ne 0) {
            return [pscustomobject]@{ Allowed = $false; Reason = 'github-metadata-check-failed'; Base = $base; Ahead = $ahead }
        }
        try { $repoInfo = $metadata.StdOut | ConvertFrom-Json } catch {
            return [pscustomobject]@{ Allowed = $false; Reason = 'github-metadata-invalid'; Base = $base; Ahead = $ahead }
        }
        if ($repoInfo.visibility -ne $script:Config.expectedVisibility) {
            return [pscustomobject]@{ Allowed = $false; Reason = 'repository-visibility-mismatch'; Base = $base; Ahead = $ahead }
        }
        if ($repoInfo.viewerPermission -notin @('ADMIN', 'WRITE', 'MAINTAIN')) {
            return [pscustomobject]@{ Allowed = $false; Reason = 'push-permission-not-confirmed'; Base = $base; Ahead = $ahead }
        }
    }
    return [pscustomobject]@{ Allowed = $true; Reason = 'validated'; Base = $base; Ahead = $ahead }
}

function Commit-GeneratedSnapshot {
    $cached = Invoke-Git -Arguments @('diff', '--cached', '--quiet')
    if ($cached.ExitCode -ne 0) {
        return [pscustomobject]@{ Created = $false; Reason = 'preexisting-index-changes' }
    }
    $paths = @($script:Config.generatedStatusPaths)
    $stage = Invoke-Git -Arguments (@('add', '--') + $paths)
    if ($stage.ExitCode -ne 0) {
        return [pscustomobject]@{ Created = $false; Reason = 'status-stage-failed' }
    }
    $stagedNames = Invoke-Git -Arguments @('diff', '--cached', '--name-only')
    if ($stagedNames.ExitCode -ne 0) {
        return [pscustomobject]@{ Created = $false; Reason = 'staged-path-check-failed' }
    }
    $actual = @($stagedNames.StdOut -split "`r?`n" | Where-Object { $_ } | Sort-Object)
    $unexpected = @($actual | Where-Object { $_ -notin $paths })
    if ($actual.Count -eq 0 -or $unexpected.Count -gt 0) {
        return [pscustomobject]@{ Created = $false; Reason = 'staged-paths-not-exact' }
    }
    $stagedCheck = Invoke-Git -Arguments @('diff', '--cached', '--check')
    if ($stagedCheck.ExitCode -ne 0) {
        return [pscustomobject]@{ Created = $false; Reason = 'staged-whitespace-check-failed' }
    }
    $stagedDiff = Invoke-Git -Arguments @('diff', '--cached', '--no-ext-diff', '--unified=0')
    $addedText = @($stagedDiff.StdOut -split "`r?`n" |
        Where-Object { $_.StartsWith('+') -and -not $_.StartsWith('+++') } |
        ForEach-Object { $_.Substring(1) }) -join "`n"
    if ($stagedDiff.ExitCode -ne 0 -or (Test-SensitiveText -Text $addedText)) {
        return [pscustomobject]@{ Created = $false; Reason = 'generated-status-scan-failed' }
    }
    $commit = Invoke-Git -Arguments @(
        '-c', 'user.name=Copilot',
        '-c', 'user.email=223556219+Copilot@users.noreply.github.com',
        'commit',
        '-m', 'docs: refresh machine synchronization status',
        '-m', $script:Config.requiredCommitTrailer,
        '-m', 'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>'
    )
    if ($commit.ExitCode -ne 0) {
        return [pscustomobject]@{ Created = $false; Reason = 'generated-status-commit-failed' }
    }
    $head = Get-RequiredGitText -Arguments @('rev-parse', '--short', 'HEAD')
    return [pscustomobject]@{ Created = $true; Reason = 'committed'; Commit = $head }
}

function Try-PushDocumentation {
    param([switch]$DryRunMode)
    $candidate = Test-PushCandidate
    if (-not $candidate.Allowed) {
        Write-Log -Event 'push-check' -Status 'blocked' -Branch $script:Config.documentationBranch -Reason $candidate.Reason
        return [pscustomobject]@{ Status = 'blocked'; Transient = $false; Reason = $candidate.Reason }
    }
    if ($candidate.Ahead -eq 0) {
        Write-Log -Event 'push-check' -Status 'up-to-date' -Branch $script:Config.documentationBranch
        return [pscustomobject]@{ Status = 'up-to-date'; Transient = $false; Reason = '' }
    }
    if ($DryRunMode) {
        Write-Log -Event 'push-check' -Status 'dry-run-eligible' -Branch $script:Config.documentationBranch -Reason "$($candidate.Ahead) reviewed documentation commit(s)"
        return [pscustomobject]@{ Status = 'dry-run-eligible'; Transient = $false; Reason = '' }
    }

    $push = Invoke-Git -Arguments @(
        'push', '--set-upstream', '--porcelain', $script:Config.remoteName,
        "HEAD:refs/heads/$($script:Config.documentationBranch)"
    )
    if ($push.ExitCode -ne 0) {
        Write-Log -Event 'push' -Status 'failed' -Branch $script:Config.documentationBranch -Reason 'git-push-failed; retry scheduled'
        return [pscustomobject]@{ Status = 'failed'; Transient = $true; Reason = 'git-push-failed' }
    }
    $head = Get-RequiredGitText -Arguments @('rev-parse', '--short', 'HEAD')
    $script:State.lastSuccessfulPush = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')
    $script:State.lastError = ''
    Write-Log -Event 'push' -Status 'succeeded' -Branch $script:Config.documentationBranch -Commit $head -Reason 'fast-forward-push-succeeded'
    return [pscustomobject]@{ Status = 'succeeded'; Transient = $false; Reason = 'fast-forward-push-succeeded' }
}

function Invoke-SyncCycle {
    param([switch]$DryRunMode)
    $checkedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')
    $transientFailure = $false

    $fetch = Invoke-Git -Arguments @('fetch', '--no-tags', $script:Config.remoteName)
    if ($fetch.ExitCode -ne 0) {
        $script:State.lastError = 'remote-fetch-failed'
        Write-Log -Event 'fetch' -Status 'failed' -Branch $script:Config.documentationBranch -Reason 'remote-fetch-failed; retry scheduled'
        Save-State
        return [pscustomobject]@{ Transient = $true; Status = 'fetch-failed' }
    }

    $rows = @(Get-BranchRows)
    $workerTaskStatus = Get-WorkerTaskStatus
    $digest = Get-SnapshotDigest -Rows $rows -WorkerTaskStatus $workerTaskStatus
    $snapshotChanged = $digest -ne [string]$script:State.lastSnapshotDigest
    $pending = @($rows | Where-Object {
        $_.Branch -ne $script:Config.documentationBranch -and $_.Ahead -gt 0
    } | ForEach-Object {
        [pscustomobject]@{
            branch = $_.Branch
            latestCommit = $_.Commit
            commitDate = $_.CommitDate
            ahead = $_.Ahead
            relation = $_.Relation
            publication = 'blocked: branch is not allowlisted; privacy review required'
        }
    })
    $pendingJson = $pending | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText((Join-Path $script:StateRoot 'pending-review.json'), $pendingJson + "`n", $script:EncodingNoBom)

    if ($snapshotChanged -and -not $DryRunMode) {
        $script:State.lastSnapshotAt = $checkedAt
        Write-GeneratedStatus -Rows $rows -CheckedAt $checkedAt -WorkerTaskStatus $workerTaskStatus
        $commitResult = Commit-GeneratedSnapshot
        if ($commitResult.Created) {
            Write-Log -Event 'status-snapshot' -Status 'committed' -Branch $script:Config.documentationBranch -Commit $commitResult.Commit -Reason 'deterministic branch metadata only'
            $script:State.lastSnapshotDigest = $digest
        } elseif ($commitResult.Reason -eq 'no-content-change') {
            $script:State.lastSnapshotDigest = $digest
        } else {
            $script:State.lastError = $commitResult.Reason
            Write-Log -Event 'status-snapshot' -Status 'blocked' -Branch $script:Config.documentationBranch -Reason $commitResult.Reason
        }
    }

    $pushResult = Try-PushDocumentation -DryRunMode:$DryRunMode
    if ($pushResult.Transient) {
        $transientFailure = $true
        $script:State.lastError = $pushResult.Reason
    } elseif ($pushResult.Status -eq 'blocked') {
        $script:State.lastError = $pushResult.Reason
    }

    if (-not $DryRunMode) {
        $currentRows = @(Get-BranchRows)
        Write-GeneratedStatus -Rows $currentRows -CheckedAt $checkedAt -WorkerTaskStatus $workerTaskStatus
        if (-not $transientFailure -and $pushResult.Status -ne 'blocked') {
            $script:State.lastError = ''
        }
        Save-State
    }
    Write-Log -Event 'cycle' -Status $(if ($transientFailure) { 'retry' } else { 'complete' }) -Branch $script:Config.documentationBranch -Reason $(if ($DryRunMode) { 'dry-run' } else { 'periodic-check' })
    return [pscustomobject]@{
        Transient = $transientFailure
        Status = if ($transientFailure) { 'retry' } else { $pushResult.Status }
    }
}

function Install-WorkerTask {
    $existing = Get-ScheduledTask -TaskName $script:Config.taskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($existing) { throw 'A task with this exact name already exists; inspect it instead of overwriting it.' }
    $principalName = "$env:USERDOMAIN\$env:USERNAME"
    $scriptPath = Join-Path $PSScriptRoot 'copilot-sync.ps1'
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Run"
    $enginePath = (Get-Process -Id $PID).Path
    $action = New-ScheduledTaskAction -Execute $enginePath -Argument $arguments -WorkingDirectory $script:WorktreeRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $principalName
    $principal = New-ScheduledTaskPrincipal -UserId $principalName -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -MultipleInstances IgnoreNew `
        -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 2)
    Register-ScheduledTask -TaskName $script:Config.taskName -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Safe, docs-only GitHub synchronization for Demmonics/cloak.' | Out-Null
    Start-ScheduledTask -TaskName $script:Config.taskName -TaskPath '\'
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        $task = Get-ScheduledTask -TaskName $script:Config.taskName -TaskPath '\'
        if ($task.State -eq 'Running') {
            Write-Log -Event 'task' -Status 'running' -Reason 'user-level logon task started'
            return
        }
    }
    throw 'Task was registered but did not reach Running state; inspect Task Scheduler before retrying.'
}

function Remove-WorkerTask {
    $existing = Get-ScheduledTask -TaskName $script:Config.taskName -TaskPath '\' -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Log -Event 'task' -Status 'not-installed'
        return
    }
    if ($existing.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $script:Config.taskName -TaskPath '\'
    }
    Unregister-ScheduledTask -TaskName $script:Config.taskName -TaskPath '\' -Confirm:$false
    Write-Log -Event 'task' -Status 'stopped-and-removed'
}

if ($InstallTask) {
    Install-WorkerTask
    exit 0
}
if ($UninstallTask) {
    Remove-WorkerTask
    exit 0
}
if (-not $Once -and -not $Run) {
    throw 'Specify -InstallTask, -UninstallTask, -Once, or -Run.'
}

$lockStream = $null
try {
    try {
        $lockStream = [System.IO.File]::Open(
            $script:LockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    } catch {
        Write-Log -Event 'lock' -Status 'already-running-or-unavailable' -Reason 'exclusive lock could not be acquired'
        exit 0
    }

    if ($Once) {
        $cycle = Invoke-SyncCycle -DryRunMode:$DryRun
        if ($cycle.Transient) { exit 2 }
        exit 0
    }

    $delaySeconds = [int]$script:Config.pollSeconds
    while ($true) {
        try {
            $cycle = Invoke-SyncCycle
            if ($cycle.Transient) {
                $delaySeconds = [Math]::Min([int]$script:Config.maxRetrySeconds, [Math]::Max([int]$script:Config.pollSeconds, $delaySeconds * 2))
            } else {
                $delaySeconds = [int]$script:Config.pollSeconds
            }
        } catch {
            $script:State.lastError = 'unhandled-cycle-error'
            Save-State
            Write-Log -Event 'cycle' -Status 'retry' -Branch $script:Config.documentationBranch -Reason 'unhandled-error; details intentionally omitted'
            $delaySeconds = [Math]::Min([int]$script:Config.maxRetrySeconds, [Math]::Max([int]$script:Config.pollSeconds, $delaySeconds * 2))
        }
        Start-Sleep -Seconds $delaySeconds
    }
} finally {
    if ($lockStream) { $lockStream.Dispose() }
}
