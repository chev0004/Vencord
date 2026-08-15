param([switch] $NoPause)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = Split-Path $PSScriptRoot -Parent
$discordRoot = Join-Path $env:LOCALAPPDATA "Discord"
$discordUpdater = Join-Path $discordRoot "Update.exe"
$rendererLog = Join-Path $env:APPDATA "discord\logs\renderer_js.log"
$installer = Join-Path $repo "dist\Installer\VencordInstallerCli.exe"
$logDirectory = Join-Path $env:LOCALAPPDATA "Vencord"
$logPath = Join-Path $logDirectory "fix-vencord.log"
$mergeStarted = $false
$mutexAcquired = $false
$transcribing = $false
$exitCode = 0
$mutex = New-Object System.Threading.Mutex($false, "Local\FixVencord")

function Write-Step([string] $Text) {
    Write-Host "`n== $Text ==" -ForegroundColor Cyan
}

function Invoke-Checked([string] $Command, [string[]] $Arguments) {
    Write-Host "> $Command $($Arguments -join ' ')" -ForegroundColor DarkGray
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

function Get-GitLines([string[]] $Arguments) {
    $output = @(& git @Arguments)
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
    return $output
}

function Get-GitText([string[]] $Arguments) {
    return ((Get-GitLines $Arguments) -join "`n").Trim()
}

function Stop-Discord {
    $processes = @(Get-Process Discord -ErrorAction SilentlyContinue)
    if ($processes.Count -gt 0) {
        $processes | Stop-Process -Force
    }

    for ($i = 0; $i -lt 15; $i++) {
        if (-not (Get-Process Discord -ErrorAction SilentlyContinue)) {
            return
        }
        Start-Sleep -Seconds 1
    }

    throw "Discord did not stop"
}

function Get-LatestDiscordApp {
    $candidate = Get-ChildItem $discordRoot -Directory -ErrorAction Stop |
        Where-Object { $_.Name -like "app-*" } |
        ForEach-Object {
            try {
                [pscustomobject]@{
                    Directory = $_
                    Version = [version]$_.Name.Substring(4)
                }
            } catch { }
        } |
        Sort-Object Version -Descending |
        Select-Object -First 1

    if (-not $candidate) {
        throw "No Discord Stable installation was found"
    }

    return $candidate.Directory
}

function Assert-Patched([string] $AppDirectory) {
    $resources = Join-Path $AppDirectory "resources"
    $active = Get-Item (Join-Path $resources "app.asar") -ErrorAction Stop
    $backup = Get-Item (Join-Path $resources "_app.asar") -ErrorAction Stop

    if ($active.Length -ge 4096 -or $backup.Length -lt 4096) {
        throw "Discord is not patched in $AppDirectory"
    }
}

function Start-Discord {
    if (-not (Test-Path $discordUpdater)) {
        throw "Discord updater was not found at $discordUpdater"
    }

    Start-Process $discordUpdater -ArgumentList "--processStart", "Discord.exe" -WindowStyle Hidden

    for ($i = 0; $i -lt 45; $i++) {
        $process = Get-Process Discord -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -like "$discordRoot\app-*\Discord.exe" } |
            Select-Object -First 1
        if ($process) {
            return $process
        }
        Start-Sleep -Seconds 1
    }

    throw "Discord did not start"
}

function Get-LogOffset {
    if (Test-Path $rendererLog) {
        return (Get-Item $rendererLog).Length
    }
    return 0
}

function Read-LogFrom([long] $Offset) {
    if (-not (Test-Path $rendererLog)) {
        return ""
    }

    $file = Get-Item $rendererLog
    if ($file.Length -lt $Offset) {
        $Offset = 0
    }

    $stream = [System.IO.File]::Open($rendererLog, "Open", "Read", "ReadWrite")
    try {
        $null = $stream.Seek($Offset, "Begin")
        $reader = New-Object System.IO.StreamReader($stream)
        try {
            return $reader.ReadToEnd()
        } finally {
            $reader.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Assert-VencordStarted([long] $LogOffset) {
    for ($i = 0; $i -lt 45; $i++) {
        if ((Read-LogFrom $LogOffset) -match "Vencord") {
            return
        }
        Start-Sleep -Seconds 1
    }

    throw "Discord started, but Vencord did not appear in the new renderer log"
}

try {
    $mutexAcquired = $mutex.WaitOne(0)
    if (-not $mutexAcquired) {
        throw "Fix Vencord is already running"
    }

    New-Item $logDirectory -ItemType Directory -Force | Out-Null
    Start-Transcript -Path $logPath -Append | Out-Null
    $transcribing = $true

    Set-Location $repo
    $env:Path = "C:\Users\chev\.bun\bin;$env:Path"
    $env:CI = "true"

    Write-Step "Checking the personal fork"
    if ((Get-GitText @("branch", "--show-current")) -ne "main") {
        throw "The current branch is not main"
    }
    if (Test-Path (Join-Path $repo ".git\MERGE_HEAD")) {
        throw "A merge is already in progress"
    }
    if ((Get-GitText @("remote", "get-url", "origin")) -notmatch "[/:]chev0004/Vencord(?:\.git)?$") {
        throw "origin is not chev0004/Vencord"
    }
    if ((Get-GitText @("remote", "get-url", "upstream")) -notmatch "[/:]Vendicated/Vencord(?:\.git)?$") {
        throw "upstream is not Vendicated/Vencord"
    }

    $dirty = Get-GitText @("status", "--porcelain=v1")
    if ($dirty) {
        throw "Uncommitted files exist. Nothing was changed. Commit them deliberately or ask Codex to review them."
    }

    Write-Step "Fetching your fork and official Vencord"
    Invoke-Checked "git" @("fetch", "origin", "--prune")
    Invoke-Checked "git" @("fetch", "upstream", "main", "--prune")

    $counts = (Get-GitText @("rev-list", "--left-right", "--count", "origin/main...HEAD")) -split "\s+"
    $remoteOnly = [int]$counts[0]
    $localOnly = [int]$counts[1]
    if ($remoteOnly -gt 0 -and $localOnly -gt 0) {
        throw "main and origin/main have diverged. Nothing was merged or pushed."
    }
    if ($remoteOnly -gt 0) {
        Invoke-Checked "git" @("merge", "--ff-only", "origin/main")
    }

    $null = & git merge-base --is-ancestor upstream/main HEAD
    $ancestorExit = $LASTEXITCODE
    if ($ancestorExit -gt 1) {
        throw "git merge-base failed with exit code $ancestorExit"
    }
    if ($ancestorExit -eq 1) {
        Write-Step "Merging official Vencord updates"
        & git merge --no-commit --no-ff upstream/main
        if ($LASTEXITCODE -ne 0) {
            $null = & git merge --abort
            throw "The upstream merge conflicted and was aborted. Ask Codex to resolve it."
        }
        $mergeStarted = Test-Path (Join-Path $repo ".git\MERGE_HEAD")

        $prohibited = Get-GitLines @("diff", "--cached", "--name-only") |
            Where-Object { $_ -match "(^|/)(AGENTS|CLAUDE|GEMINI)\.md$|(^|/)\.(claude|gemini)/|(^|/)\.env\.local$|(^|/)copilot-instructions\.md$" }
        if ($prohibited) {
            throw "The upstream merge includes agent or private-environment files and needs review: $($prohibited -join ', ')"
        }
    } else {
        Write-Host "Official Vencord is already merged." -ForegroundColor Green
    }

    Write-Step "Installing dependencies and checking compatibility"
    Invoke-Checked "pnpm" @("install", "--frozen-lockfile")
    Invoke-Checked "pnpm" @("testTsc")
    Invoke-Checked "pnpm" @("build")

    $unstaged = Get-GitText @("diff", "--name-only")
    if ($unstaged) {
        throw "The checks unexpectedly modified tracked files: $unstaged"
    }

    if ($mergeStarted) {
        Invoke-Checked "git" @("commit", "-m", "chore: sync upstream vencord")
        $mergeStarted = $false
    }

    Write-Step "Refreshing the installer and patching Discord Stable"
    Invoke-Checked "node" @("scripts/runInstaller.mjs", "--", "--version")
    if (-not (Test-Path $installer)) {
        throw "The Vencord installer was not downloaded"
    }

    Stop-Discord
    $env:VENCORD_USER_DATA_DIR = $repo
    $env:VENCORD_DEV_INSTALL = "1"
    Invoke-Checked $installer @("-install", "-branch", "stable", "-debug")
    $installedApp = Get-LatestDiscordApp
    Assert-Patched $installedApp.FullName

    $logOffset = Get-LogOffset
    $discordProcess = Start-Discord
    $runningApp = Split-Path $discordProcess.Path -Parent

    try {
        Assert-Patched $runningApp
    } catch {
        Write-Host "Discord updated while launching. Patching the new version once more." -ForegroundColor Yellow
        Stop-Discord
        Invoke-Checked $installer @("-install", "-branch", "stable", "-debug")
        $installedApp = Get-LatestDiscordApp
        Assert-Patched $installedApp.FullName
        $logOffset = Get-LogOffset
        $discordProcess = Start-Discord
        $runningApp = Split-Path $discordProcess.Path -Parent
        Assert-Patched $runningApp
    }

    Assert-VencordStarted $logOffset

    Write-Step "Pushing the tested result to your fork"
    Invoke-Checked "git" @("push", "origin", "main")
    $head = Get-GitText @("rev-parse", "HEAD")
    $remoteHead = (Get-GitText @("ls-remote", "origin", "refs/heads/main")) -split "\s+" | Select-Object -First 1
    if ($head -ne $remoteHead) {
        throw "origin/main does not match the tested local commit"
    }
    if (Get-GitText @("status", "--porcelain=v1")) {
        throw "The repository is not clean after the update"
    }

    Write-Step "Vencord is fixed"
    Write-Host "Discord: $([version](Split-Path $runningApp -Leaf).Substring(4))" -ForegroundColor Green
    Write-Host "Commit:  $head" -ForegroundColor Green
    Write-Host "Remote:  origin/main matches" -ForegroundColor Green
    Write-Host "Log:     $logPath" -ForegroundColor Green
} catch {
    $exitCode = 1
    if ($mergeStarted -and (Test-Path (Join-Path $repo ".git\MERGE_HEAD"))) {
        $null = & git merge --abort
    }
    Write-Host "`nFix Vencord stopped safely: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "No uncommitted work was auto-committed. Ask Codex to inspect the log if this needs judgment." -ForegroundColor Yellow

    if (-not (Get-Process Discord -ErrorAction SilentlyContinue) -and (Test-Path $discordUpdater)) {
        Start-Process $discordUpdater -ArgumentList "--processStart", "Discord.exe" -WindowStyle Hidden
    }
} finally {
    if ($transcribing) {
        Stop-Transcript | Out-Null
    }
    if ($mutexAcquired) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
    if (-not $NoPause) {
        $null = Read-Host "`nPress Enter to close"
    }
}

exit $exitCode
