# Installs (idempotently) the Windows Task Scheduler task that runs
# ymm4-startup-check.ps1 at user login (mandate section 6). Safe to re-run:
# unregisters any existing task with the same name first, then registers
# fresh — this only ever touches Task Scheduler's own metadata, never a
# real YMM4/Noemora process or project.
#
# Deliberately Task Scheduler over a Windows service (mandate: "Do not
# install a Windows service unless genuinely necessary") — this only needs
# to run once at interactive login (it launches a visible GUI app), not as
# a background service under a different security context.
param(
    [string]$TaskName = 'VeritasForgeMarketing-YMM4Startup',
    [string]$ScriptPath = 'C:\Users\Silver\VeritasForgeMarketing\scripts\ymm4-startup-check.ps1'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ScriptPath)) {
    Write-Output "ERROR: deployed script not found at $ScriptPath — copy tools/marketing/windows/ymm4-startup-check.ps1 there first."
    exit 1
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# No endless restart loop (mandate section 6): a single bounded run, no
# automatic restart-on-failure, and IgnoreNew so a second login event (or a
# manual re-trigger while one is still in its bounded wait) never stacks a
# second concurrent run on top of the first.
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -RestartCount 0 `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Veritas Forge Marketing: ensures a dedicated YMM4 marketing instance is available after login, without touching any Noemora project.' `
    | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
(@{ installed = $true; taskName = $TaskName; state = $task.State.ToString(); scriptPath = $ScriptPath } | ConvertTo-Json -Compress)
