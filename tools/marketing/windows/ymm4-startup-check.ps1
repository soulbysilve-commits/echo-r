# YMM4 unattended-startup check (mandate section 6). Runs as a Windows
# Task Scheduler task at user login. Deliberately a standalone, native
# PowerShell script with NO dependency on WSL/Node — WSL is not guaranteed
# to be running yet at Windows login, so this cannot shell out into the
# marketing repo's own JS logic. It duplicates (intentionally, not
# accidentally) the same safe-auto-start contract that
# tools/marketing/lib/ymm4Startup.mjs implements for JS-side callers:
#   - never touch a Noemora project
#   - never start a second GUI instance
#   - bounded wait, no endless restart loop
#   - write a durable status record the WSL-side marketing operator can
#     read (via its /mnt/c mount) without this script needing to know
#     anything about WSL
#
# Confirmed real paths (see docs/marketing/YMM4_AUTOMATION_AUDIT.md and
# lib/videoPipeline.mjs's DEFAULT_YMM4_EXE):
$Ymm4Exe = 'C:\Users\Silver\Apps\YukkuriMovieMaker4\YukkuriMovieMaker.exe'
$MarketingRoot = 'C:\Users\Silver\VeritasForgeMarketing'
$IdleProject = Join-Path $MarketingRoot 'marketing_idle.ymmp'
# Preferred over $IdleProject when present (2026-09-16 clean-idle-template
# pass): $IdleProject was bootstrapped from whatever was loaded at the time,
# which turned out to be real demo/canary content, not blank. This file is
# only ever created once, by the JS-side `ymm4 idle-template create`
# command, via the app's own real CreateProject()/SaveProject() — never
# hand-constructed here. This script only checks that it EXISTS (cheap, no
# WSL/Node dependency); the authoritative zero-items CLEAN verification is
# JS-side (see tools/marketing/lib/ymm4IdleTemplate.mjs's
# checkIdleTemplateClean, used by `ymm4 status`/`ymm4 ensure`) — safe here
# because nothing else ever writes to this exact filename.
$BlankIdleProject = Join-Path $MarketingRoot 'marketing_idle_blank.ymmp'
$CanaryProject = Join-Path $MarketingRoot 'marketing_canary.ymmp'
$StatusFile = Join-Path $MarketingRoot 'ymm4_startup_status.json'
$BridgeBase = 'http://localhost:8765'
$ProcessName = 'YukkuriMovieMaker'

# Mandate section 6, step 1: wait briefly after login before doing anything,
# so this doesn't compete with the rest of the user's own login startup.
Start-Sleep -Seconds 20

function Write-Status {
    param([string]$Status, [string]$Reason, $Pid_ = $null, [string]$Project = $null)
    $obj = @{
        status      = $Status
        reason      = $Reason
        pid         = $Pid_
        project     = $Project
        checked_at  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        owner       = 'MARKETING'
    }
    try {
        New-Item -ItemType Directory -Path $MarketingRoot -Force -ErrorAction SilentlyContinue | Out-Null
        ($obj | ConvertTo-Json -Compress) | Set-Content -Path $StatusFile -Encoding UTF8
    } catch {
        # Never let a status-write failure crash the script — the exit
        # code / stdout is still the authoritative record for Task
        # Scheduler's own history even if the file write fails.
    }
}

function Test-ForbiddenProject {
    param([string]$Path)
    if ([string]::IsNullOrEmpty($Path)) { return $false }
    return $Path -imatch 'noemora'
}

function Get-BridgeStatus {
    try {
        $resp = Invoke-WebRequest -Uri "$BridgeBase/api/status" -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -ne 200) { return $null }
        return $true
    } catch {
        return $false
    }
}

function Get-BridgeProject {
    try {
        $resp = Invoke-WebRequest -Uri "$BridgeBase/api/project" -UseBasicParsing -TimeoutSec 3
        $data = $resp.Content | ConvertFrom-Json
        return $data.projectPath
    } catch {
        return $null
    }
}

# --- Step 2: is marketing YMM4 already available? (mandate: avoid duplicate process) ---
$existing = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
if ($existing) {
    $bridgeUp = Get-BridgeStatus
    if ($bridgeUp -eq $true) {
        $proj = Get-BridgeProject
        if (Test-ForbiddenProject $proj) {
            # A real Noemora session (or something referencing it) is
            # already open — this is a real user's work, never touched.
            Write-Status -Status 'WRONG_PROJECT' -Reason 'a Noemora project is already loaded; not touched' -Pid_ $existing[0].Id -Project $proj
            Write-Output 'WRONG_PROJECT: an existing instance has a Noemora project loaded — leaving it alone.'
            exit 0
        }
        if ([string]::IsNullOrEmpty($proj)) {
            # Confirmed real behavior: the plugin's HTTP server can be up
            # (bridge "reachable") while the application itself is not yet
            # usable — e.g. stuck behind YMM4's own blocking startup dialog
            # (a crash-recovery prompt after an unclean prior shutdown).
            # Never treat this as healthy, and never restart/duplicate a
            # process that may just be waiting on a human.
            Write-Status -Status 'STARTING' -Reason 'bridge reachable but no project loaded yet (may be behind a startup dialog needing human attention)' -Pid_ $existing[0].Id
            Write-Output 'STARTING: process and bridge are up but no project is loaded yet — it may be waiting on a human (e.g. a crash-recovery dialog). Not restarting it.'
            exit 0
        }
        Write-Status -Status 'HEALTHY' -Reason 'already running and healthy at login-check time' -Pid_ $existing[0].Id -Project $proj
        Write-Output "HEALTHY: YMM4 already running (pid $($existing[0].Id)) with bridge reachable."
        exit 0
    }
    # Process exists but bridge isn't up yet — could just be starting, or a
    # user-launched instance without the plugin. Never kill/restart
    # something this script did not itself just start.
    Write-Status -Status 'RUNNING_BRIDGE_DOWN' -Reason 'process running but bridge not reachable; not restarting an instance this script did not start' -Pid_ $existing[0].Id
    Write-Output 'RUNNING_BRIDGE_DOWN: YMM4 process exists but the bridge is not reachable. Not restarting it.'
    exit 0
}

# --- Step 3: not running -> safe to start exactly one instance (mandate section 4/5) ---
$launchProject = if (Test-Path $BlankIdleProject) { $BlankIdleProject } elseif (Test-Path $IdleProject) { $IdleProject } else { $CanaryProject }
if (Test-ForbiddenProject $launchProject) {
    Write-Status -Status 'ERROR' -Reason 'computed launch project path is forbidden; refusing to start'
    Write-Output 'ERROR: computed launch project is forbidden — this should never happen given the hardcoded paths above.'
    exit 1
}
if (-not (Test-Path $launchProject)) {
    Write-Status -Status 'ERROR' -Reason "neither idle nor canary marketing project exists on disk ($launchProject)"
    Write-Output "ERROR: no marketing project file exists at $launchProject — cannot bootstrap a first launch. Create one manually or via: node tools/marketing/cli.mjs ymm4 ensure"
    exit 1
}

$proc = Start-Process -FilePath $Ymm4Exe -ArgumentList "`"$launchProject`"" -PassThru

# --- Step 4: bounded wait for process alive + bridge reachable (mandate: no endless restart loop) ---
$deadline = (Get-Date).AddSeconds(60)
$healthy = $false
$finalProject = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    $bridgeUp = Get-BridgeStatus
    if ($bridgeUp -eq $true) {
        $finalProject = Get-BridgeProject
        if (Test-ForbiddenProject $finalProject) {
            Write-Status -Status 'WRONG_PROJECT' -Reason 'unexpected Noemora project loaded after launch' -Pid_ $proc.Id -Project $finalProject
            Write-Output 'WRONG_PROJECT: unexpected state after launch — never expected, investigate manually.'
            exit 1
        }
        if ([string]::IsNullOrEmpty($finalProject)) {
            # Bridge HTTP is up but no project is actually loaded yet — e.g.
            # stuck behind YMM4's own startup dialog (confirmed real: a
            # crash-recovery prompt after an unclean prior shutdown blocks
            # this exact way). Keep polling within the same bounded window
            # rather than declaring success; a human may need to act.
            continue
        }
        $healthy = $true
        break
    }
}

if ($healthy) {
    Write-Status -Status 'HEALTHY' -Reason 'started by this task and became healthy' -Pid_ $proc.Id -Project $finalProject
    Write-Output "HEALTHY: started YMM4 (pid $($proc.Id)), bridge became reachable within the wait window."
    exit 0
} elseif (-not [string]::IsNullOrEmpty($finalProject) -or (Get-BridgeStatus) -eq $true) {
    Write-Status -Status 'STARTING' -Reason 'bridge reachable but no project loaded within the wait window — may need a human (e.g. a crash-recovery dialog)' -Pid_ $proc.Id -Project $launchProject
    Write-Output 'STARTING: YMM4 and its bridge came up but no project loaded in time — it likely needs human attention (check for a dialog on screen). Not retrying automatically.'
    exit 1
} else {
    Write-Status -Status 'TIMEOUT' -Reason 'started but bridge/plugin did not become reachable within 60s' -Pid_ $proc.Id -Project $launchProject
    Write-Output 'TIMEOUT: YMM4 started but the bridge did not become reachable in time. Not retrying — see YMM4_UNAVAILABLE handling in the marketing pipeline.'
    exit 1
}
