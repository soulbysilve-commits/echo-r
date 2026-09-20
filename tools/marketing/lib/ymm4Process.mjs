// Windows-side YMM4 GUI process lifecycle (YMM4 unattended-startup mandate
// sections 1, 4, 8). Every function here talks to the REAL Windows process
// table via `powershell.exe` (reached through WSL interop — the same
// mechanism lib/psHttpRelay.mjs already uses for HTTP, and lib/
// videoPipeline.mjs's autoEncodeProject() already uses for the headless
// render), never a simulation.
//
// Confirmed real paths (see docs/marketing/YMM4_AUTOMATION_AUDIT.md and
// direct verification this pass):
//   exe:  C:\Users\Silver\Apps\YukkuriMovieMaker4\YukkuriMovieMaker.exe
//   marketing project root: C:\Users\Silver\VeritasForgeMarketing\
//
// Launching the GUI with a project file as a plain positional argument is
// now CONFIRMED (2026-09-16 project-open contract audit), not merely
// assumed:
//   - Windows' own registered .ymmp file-association open command (read
//     read-only from HKCR\YukkuriMovieMaker4.Project\shell\open\command)
//     is exactly `"...\YukkuriMovieMaker.exe" "%1"` — a bare positional
//     argument, identical in shape to what startYmm4Process() already
//     builds. This is the real, OS-registered mechanism, not a guess.
//   - The installed build's own Resources/ChangeLog.txt documents this as
//     an intentional, long-standing feature (e.g. "ymmpファイルをダブルク
//     リックしてYMM4を起動できるようにした（ファイルに関連付けした）" —
//     "made it possible to launch YMM4 by double-clicking a .ymmp file",
//     plus a later entry adding a new-window-vs-current-window choice for
//     when an instance is already running — i.e. genuine single-instance
//     IPC forwarding for a SECOND launch request, confirmed by a separate
//     changelog entry about inter-process communication between multiple
//     launches of the same install directory).
// What's still real and unresolved: a FIRST/only launch (no existing
// instance) can still fail to actually open the argv project — confirmed
// live 2026-09-16: PID 10636's own real CommandLine (via
// Get-CimInstance Win32_Process, not the intended script args) did carry
// marketing_canary.ymmp positionally, yet the bridge reported no project
// loaded. Best-evidence explanation: this same build's own crash-recovery
// prompt (ChangeLog.txt: "異常終了を検知した際にバックアップからの復元を
// 提案するようにした" — confirmed live via read-only window-title
// enumeration in a prior session, exact text in ymm4Startup.mjs's
// KNOWN_BLOCKING_DIALOG_TITLE_PATTERNS) blocks the normal startup sequence
// — including argv project-open — before it runs, and does not retroactively
// resume it once a human later dismisses the dialog. This is why
// lib/ymm4Health.mjs's WRONG_PROJECT/READY_NO_PROJECT/BLOCKED_DIALOG
// distinctions exist: after any launch, health is verified by asking the
// bridge what project is ACTUALLY loaded, never assumed from the launch
// succeeding.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_YMM4_EXE, isForbiddenProjectPath } from './videoPipeline.mjs';

const execFileAsync = promisify(execFile);

export const YMM4_PROCESS_NAME = 'YukkuriMovieMaker';

// Confirmed real text of YMM4's own crash-recovery prompt (see
// docs/marketing/YMM4_STARTUP_AUDIT.md, 2026-09-15 — read via this exact
// read-only mechanism, EnumWindows/GetWindowText, no input sent). Matching
// on this lets checkYmm4Health distinguish a genuinely-idle-but-usable
// bridge (READY_NO_PROJECT) from one stuck behind a real blocking dialog
// (BLOCKED_DIALOG) instead of guessing from projectPath alone.
const KNOWN_BLOCKING_DIALOG_TITLE_PATTERNS = [/異常終了を検知しました/, /バックアップからプロジェクトを復元/];

/**
 * Read-only Win32 window-title enumeration for every VISIBLE top-level
 * window owned by `pid` — never sends input (no SendMessage/click/focus
 * calls), matching the safety boundary already established in the audit:
 * detecting a blocking dialog is fine, dismissing one is a human decision.
 */
export async function findVisibleWindowTitles(pid, { execFileImpl = execFileAsync } = {}) {
  const script = `
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class Ymm4WinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint procId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public static List<string> GetTitlesForPid(uint pid) {
    var result = new List<string>();
    EnumWindows((hWnd, lParam) => {
      uint winPid;
      GetWindowThreadProcessId(hWnd, out winPid);
      if (winPid == pid && IsWindowVisible(hWnd)) {
        int len = GetWindowTextLength(hWnd);
        if (len > 0) {
          var sb = new StringBuilder(len + 1);
          GetWindowText(hWnd, sb, sb.Capacity);
          result.Add(sb.ToString());
        }
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Ymm4WinEnum]::GetTitlesForPid(${Number(pid)}) | ForEach-Object { Write-Output $_ }
exit 0
`;
  try {
    const { stdout } = await execFileImpl('powershell.exe', ['-NoProfile', '-Command', script]);
    const titles = (stdout ?? '').toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return { ok: true, titles };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), titles: [] };
  }
}

export function matchesKnownBlockingDialog(titles) {
  return titles.some((t) => KNOWN_BLOCKING_DIALOG_TITLE_PATTERNS.some((p) => p.test(t)));
}

/**
 * Positive-evidence-only dialog check: true ONLY when a window title
 * matches a confirmed-real blocking dialog pattern. A failed/empty
 * enumeration returns false (never treated as proof of a dialog) — callers
 * must still fall back to the safe STARTING status, never to a false
 * HEALTHY/READY_NO_PROJECT, when this can't positively confirm either way.
 */
export async function hasBlockingDialog(pid, opts = {}) {
  const result = await findVisibleWindowTitles(pid, opts);
  if (!result.ok) return { blocked: false, checked: false, titles: [] };
  return { blocked: matchesKnownBlockingDialog(result.titles), checked: true, titles: result.titles };
}

/**
 * Real process lookup — never inferred from anything else (mandate section
 * 3: "Do not infer health merely from process existence" cuts both ways:
 * existence is necessary but not sufficient for HEALTHY, but this function
 * itself must still be a real, direct check, not a guess).
 */
export async function findYmm4Processes({ execFileImpl = execFileAsync } = {}) {
  try {
    // Confirmed real PowerShell behavior in this environment: even with
    // -ErrorAction SilentlyContinue, a non-terminating "no such process"
    // condition still leaves the powershell.exe process's own exit code
    // non-zero unless the script explicitly ends with `exit 0` — which
    // execFile() otherwise (correctly) treats as a command failure, even
    // though "no process found" is a completely normal, successful result
    // here. The explicit `exit 0` is required, not decorative.
    const { stdout } = await execFileImpl('powershell.exe', [
      '-NoProfile', '-Command',
      `Get-Process -Name '${YMM4_PROCESS_NAME}' -ErrorAction SilentlyContinue | Select-Object Id,StartTime | ConvertTo-Json -Compress; exit 0`,
    ]);
    const text = (stdout ?? '').toString().trim();
    if (!text) return { ok: true, processes: [] };
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return {
      ok: true,
      processes: rows.map((r) => ({ pid: r.Id, startTime: r.StartTime ?? null })),
    };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), processes: [] };
  }
}

/**
 * Read-only real Windows command line for `pid` (mandate: "Do not rely only
 * on durable state" — the durable `ymm4_process_state.project` record is
 * this system's own belief about what it launched with; this reads the
 * actual OS process table instead, via `Get-CimInstance Win32_Process`,
 * which is the one WMI class that exposes the full launch argv —
 * `Get-Process` alone does not). Never sends input, never terminates
 * anything — pure inspection, same safety boundary as
 * findVisibleWindowTitles.
 */
export async function getProcessCommandLine(pid, { execFileImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileImpl('powershell.exe', [
      '-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine; exit 0`,
    ]);
    const commandLine = (stdout ?? '').toString().trim();
    return { ok: true, commandLine: commandLine || null };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), commandLine: null };
  }
}

/**
 * True only if `commandLine` contains `targetPath` as a genuine substring
 * (case-insensitive, slash-normalized — the same normalization every other
 * project-path comparison in this codebase uses). Never a fuzzy/partial
 * match on just the basename, which could be fooled by a same-named file
 * in a different (e.g. Noemora) directory.
 */
export function commandLineContainsPath(commandLine, targetPath) {
  if (!commandLine || !targetPath) return false;
  const normalize = (s) => String(s).replace(/\\/g, '/').toLowerCase();
  return normalize(commandLine).includes(normalize(targetPath));
}

/**
 * True only if `pid` is CURRENTLY a real running YukkuriMovieMaker process —
 * used to detect a stale/reused PID before trusting durable ownership state
 * (mandate section 14: "stale PID").
 */
export async function isPidLiveYmm4(pid, opts = {}) {
  const result = await findYmm4Processes(opts);
  if (!result.ok) return false;
  return result.processes.some((p) => String(p.pid) === String(pid));
}

/**
 * Launches ONE new YMM4 GUI instance against `projectPath`. Refuses outright
 * (never calls Start-Process) for any forbidden (Noemora) path — the same
 * shared check every other write/render path uses (mandate section 9).
 * Never verifies success here beyond "the process object was created" —
 * callers MUST follow up with a real health check (lib/ymm4Health.mjs)
 * before treating this as ready.
 */
export async function startYmm4Process({ exePath = DEFAULT_YMM4_EXE, projectPath, execFileImpl = execFileAsync } = {}) {
  if (!projectPath) return { ok: false, error: 'projectPath is required' };
  if (isForbiddenProjectPath(projectPath)) {
    return { ok: false, error: 'refusing to start YMM4 with a forbidden project path (NoemoraLive.ymmp / Noemora / Noemora_mod_core)' };
  }
  try {
    // Single-quoted PowerShell string literals: '' escapes a literal single
    // quote. Windows paths never contain a literal single quote in this
    // codebase's own conventions, but escaping defensively costs nothing.
    const psExe = exePath.replace(/'/g, "''");
    const psProject = projectPath.replace(/'/g, "''");
    const { stdout } = await execFileImpl('powershell.exe', [
      '-NoProfile', '-Command',
      `$p = Start-Process -FilePath '${psExe}' -ArgumentList '${psProject}' -PassThru; ` +
      `(@{ Id = $p.Id } | ConvertTo-Json -Compress)`,
    ]);
    const parsed = JSON.parse((stdout ?? '').toString().trim());
    if (!parsed?.Id) return { ok: false, error: 'Start-Process did not return a process Id' };
    return { ok: true, pid: parsed.Id, exePath, projectPath, startedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * Terminates a specific PID — ONLY ever call this for a PID the caller has
 * already confirmed (via durable state, mandate section 8) is
 * YMM4_PROCESS_OWNER=MARKETING. This function itself does not consult
 * ownership — that decision belongs to the caller (lib/ymm4Startup.mjs),
 * so this stays a plain, honest "kill this specific PID" primitive rather
 * than silently re-deriving a safety decision two different ways.
 */
export async function terminateYmm4Process(pid, { execFileImpl = execFileAsync } = {}) {
  if (!pid) return { ok: false, error: 'pid is required' };
  try {
    await execFileImpl('powershell.exe', [
      '-NoProfile', '-Command',
      `Stop-Process -Id ${Number(pid)} -Force -ErrorAction Stop`,
    ]);
    return { ok: true, pid };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}
