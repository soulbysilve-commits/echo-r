import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { findYmm4Processes, startYmm4Process, terminateYmm4Process, isPidLiveYmm4 } from '../lib/ymm4Process.mjs';
import { checkYmm4Health, HEALTH, getYmm4ProcessState, recordYmm4ProcessState } from '../lib/ymm4Health.mjs';
import {
  ensureYmm4Ready, ensureYmm4ForVideoJob, acquireYmm4StartupLock, releaseYmm4StartupLock,
  ensureMarketingIdleProjectFile, isDurableStateStale, DEFAULT_MARKETING_IDLE_PROJECT, DEFAULT_MARKETING_CANARY_PROJECT,
} from '../lib/ymm4Startup.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-ymm4-test-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

// Every execFileImpl mock below dispatches on the actual PowerShell command
// text, exactly like the real Get-Process/Start-Process/Stop-Process calls
// lib/ymm4Process.mjs issues — so a test can assert e.g. "Stop-Process was
// never called" without ever touching a real process.
function processMock({ initiallyRunning = [], onStart } = {}) {
  let running = [...initiallyRunning];
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push({ cmd, args });
    const script = (args ?? []).join(' ');
    if (script.includes('Get-Process')) {
      if (running.length === 0) return { stdout: '' };
      const payload = running.length === 1 ? running[0] : running;
      return { stdout: JSON.stringify(payload) };
    }
    if (script.includes('Start-Process')) {
      const pid = onStart ? onStart() : (Math.max(0, ...running.map((r) => r.Id)) + 1);
      running.push({ Id: pid, StartTime: new Date().toISOString() });
      return { stdout: JSON.stringify({ Id: pid }) };
    }
    if (script.includes('Stop-Process')) {
      const m = script.match(/-Id (\d+)/);
      const pid = m ? Number(m[1]) : null;
      running = running.filter((r) => r.Id !== pid);
      return { stdout: '' };
    }
    throw new Error(`processMock: unexpected command: ${script}`);
  };
  return { exec, calls, getRunning: () => running };
}

// Confirmed real (2026-09-16 project-identity-detection audit, against the
// live plugin/app): /api/project's projectName/projectPath are ALWAYS
// empty, even with a real project loaded — the plugin's GetProjectInfo()
// looks for "ProjectName"/"ProjectPath" properties that don't exist on
// this MainViewModel build; only vmType/error are real signals from that
// endpoint now. The authoritative project-loaded/path signal comes from
// /api/reflect/get on "IsEmptyProject" (bool) and "ProjectFilePath"
// (string, real property confirmed live) — this mock mirrors that split
// exactly, deriving both from the same `projectPath` param every existing
// test already passes, so callers don't need to know about the split.
function fetchMock({ reachable = true, projectPath = 'C:\\Users\\Silver\\VeritasForgeMarketing\\marketing_idle.ymmp', stuckBehindDialog = false } = {}) {
  return async (url, opts) => {
    if (url.endsWith('/api/status')) {
      if (!reachable) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ version: '1.0' }) };
    }
    if (url.endsWith('/api/project')) {
      if (!reachable) throw new Error('ECONNREFUSED');
      // Confirmed real behavior: the plugin can answer HTTP 200 with an
      // {error: "..."} body (no projectPath) when the application itself
      // isn't ready yet — e.g. stuck behind YMM4's own blocking startup
      // dialog. Distinct from a real HTTP/connection failure.
      if (stuckBehindDialog) return { ok: true, status: 200, json: async () => ({ error: 'MainViewModel取得失敗' }) };
      return { ok: true, status: 200, json: async () => ({ vmType: 'YukkuriMovieMaker.ViewModels.MainViewModel', projectName: '', projectPath: '' }) };
    }
    if (url.endsWith('/api/reflect/get')) {
      if (!reachable || stuckBehindDialog) throw new Error('fetchMock: /api/reflect/get should never be reached while unreachable/blocked');
      const body = JSON.parse(opts.body);
      if (body.target === 'Main' && body.path === 'IsEmptyProject') {
        return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.Boolean', value: !projectPath }) };
      }
      if (body.target === 'Main' && body.path === 'ProjectFilePath') {
        return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.String', value: projectPath ?? '' }) };
      }
      throw new Error(`fetchMock: unexpected reflect/get path: ${body.path}`);
    }
    throw new Error(`fetchMock: unexpected url: ${url}`);
  };
}

// --- lib/ymm4Process.mjs ---

test('findYmm4Processes: no process running -> empty list', async () => {
  const { exec } = processMock({ initiallyRunning: [] });
  const result = await findYmm4Processes({ execFileImpl: exec });
  assert.equal(result.ok, true);
  assert.deepEqual(result.processes, []);
});

test('findYmm4Processes: one process running -> one entry', async () => {
  const { exec } = processMock({ initiallyRunning: [{ Id: 4242, StartTime: '2026-01-01T00:00:00Z' }] });
  const result = await findYmm4Processes({ execFileImpl: exec });
  assert.equal(result.processes.length, 1);
  assert.equal(result.processes[0].pid, 4242);
});

test('findYmm4Processes: a process-check failure is ERROR, never treated as NOT_RUNNING', async () => {
  const exec = async () => { throw new Error('powershell.exe not found'); };
  const result = await findYmm4Processes({ execFileImpl: exec });
  assert.equal(result.ok, false);
});

test('startYmm4Process refuses a forbidden (Noemora) project path without ever calling Start-Process', async () => {
  const { exec, calls } = processMock();
  const result = await startYmm4Process({ projectPath: 'C:\\Users\\Silver\\NoemoraYMM4\\NoemoraLive.ymmp', execFileImpl: exec });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test('startYmm4Process refuses a nested Noemora_mod_core reference too', async () => {
  const { exec, calls } = processMock();
  const result = await startYmm4Process({ projectPath: 'C:\\Users\\Silver\\VeritasForgeMarketing\\Noemora_mod_core\\x.ymmp', execFileImpl: exec });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test('startYmm4Process launches with the given project and returns a real pid', async () => {
  const { exec } = processMock({ onStart: () => 5555 });
  const result = await startYmm4Process({ projectPath: 'C:\\Users\\Silver\\VeritasForgeMarketing\\marketing_idle.ymmp', execFileImpl: exec });
  assert.equal(result.ok, true);
  assert.equal(result.pid, 5555);
});

// Regression lock for the 2026-09-16 project-open contract audit: the
// launch shape (bare positional project path, no --project/--open switch)
// must keep matching Windows' own registered .ymmp file-association open
// command (confirmed read-only via HKCR\YukkuriMovieMaker4.Project\shell\
// open\command == `"...\YukkuriMovieMaker.exe" "%1"`) — NOT a guessed API.
test('startYmm4Process: launch argument is a bare positional project path, matching the confirmed Windows .ymmp file-association open command shape (no switch/flag)', async () => {
  const { exec, calls } = processMock({ onStart: () => 6001 });
  await startYmm4Process({ projectPath: 'C:\\Users\\Silver\\VeritasForgeMarketing\\marketing_idle.ymmp', execFileImpl: exec });
  const startCall = calls.find((c) => c.args.join(' ').includes('Start-Process'));
  const script = startCall.args.join(' ');
  assert.ok(script.includes("-ArgumentList 'C:\\Users\\Silver\\VeritasForgeMarketing\\marketing_idle.ymmp'"), 'must pass the project path as a bare -ArgumentList value, not behind a flag like --project/--open');
  assert.ok(!/--project|--open/.test(script), 'must never invent an unconfirmed --project/--open switch');
});

test('isPidLiveYmm4 reflects the real process table, not the durable record', async () => {
  const { exec } = processMock({ initiallyRunning: [{ Id: 111, StartTime: '2026-01-01T00:00:00Z' }] });
  assert.equal(await isPidLiveYmm4(111, { execFileImpl: exec }), true);
  assert.equal(await isPidLiveYmm4(999, { execFileImpl: exec }), false);
});

// --- lib/ymm4Health.mjs ---

test('checkYmm4Health: NOT_RUNNING when no process exists', async () => {
  const { exec } = processMock({ initiallyRunning: [] });
  const health = await checkYmm4Health({ execFileImpl: exec, fetchImpl: fetchMock() });
  assert.equal(health.status, HEALTH.NOT_RUNNING);
});

test('checkYmm4Health: RUNNING_BRIDGE_DOWN when the process exists but the bridge is unreachable', async () => {
  const { exec } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
  const health = await checkYmm4Health({ execFileImpl: exec, fetchImpl: fetchMock({ reachable: false }) });
  assert.equal(health.status, HEALTH.RUNNING_BRIDGE_DOWN);
});

test('checkYmm4Health: HEALTHY when process running, bridge reachable, and a safe project is loaded', async () => {
  const { exec } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
  const health = await checkYmm4Health({ execFileImpl: exec, fetchImpl: fetchMock({ reachable: true, projectPath: 'C:\\Users\\Silver\\VeritasForgeMarketing\\marketing_idle.ymmp' }) });
  assert.equal(health.status, HEALTH.HEALTHY);
});

test('checkYmm4Health: WRONG_PROJECT when a Noemora project is loaded — the hard safety floor', async () => {
  const { exec } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
  const health = await checkYmm4Health({ execFileImpl: exec, fetchImpl: fetchMock({ reachable: true, projectPath: 'C:\\Users\\Silver\\NoemoraYMM4\\NoemoraLive.ymmp' }) });
  assert.equal(health.status, HEALTH.WRONG_PROJECT);
});

test('checkYmm4Health: WRONG_PROJECT when a different-but-safe project is loaded and an exact expectedProjectPath was required', async () => {
  const { exec } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
  const health = await checkYmm4Health({
    execFileImpl: exec, fetchImpl: fetchMock({ reachable: true, projectPath: 'C:\\Users\\Silver\\VeritasForgeMarketing\\some_other_project.ymmp' }),
    expectedProjectPath: 'C:\\Users\\Silver\\VeritasForgeMarketing\\marketing_idle.ymmp',
  });
  assert.equal(health.status, HEALTH.WRONG_PROJECT);
});

test('checkYmm4Health: ERROR (never HEALTHY) when the process check itself fails', async () => {
  const exec = async () => { throw new Error('powershell.exe crashed'); };
  const health = await checkYmm4Health({ execFileImpl: exec, fetchImpl: fetchMock() });
  assert.equal(health.status, HEALTH.ERROR);
});

test('checkYmm4Health: STARTING (never HEALTHY) when the bridge is reachable but stuck behind a blocking dialog — a real, confirmed scenario', async () => {
  const { exec } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
  const health = await checkYmm4Health({ execFileImpl: exec, fetchImpl: fetchMock({ reachable: true, stuckBehindDialog: true }) });
  assert.equal(health.status, HEALTH.STARTING);
});

test('checkYmm4Health: STARTING when /api/project returns no projectPath at all, even without an explicit error field', async () => {
  const { exec } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/status')) return { ok: true, status: 200, json: async () => ({ version: '1.0' }) };
    if (url.endsWith('/api/project')) return { ok: true, status: 200, json: async () => ({}) };
    throw new Error(`unexpected: ${url}`);
  };
  const health = await checkYmm4Health({ execFileImpl: exec, fetchImpl });
  assert.equal(health.status, HEALTH.STARTING);
});

// --- READY_NO_PROJECT vs BLOCKED_DIALOG (previously both collapsed into
// STARTING, purely from projectPath being falsy) ---

test('checkYmm4Health: READY_NO_PROJECT when bridge reachable, no internal error, application resolved (vmType present), and the AUTHORITATIVE signal (IsEmptyProject via /api/reflect/get) says truly empty — never inferred from /api/project\'s broken projectPath field', async () => {
  const { exec } = processMock({ initiallyRunning: [{ Id: 10636, StartTime: 'x' }] });
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/api/status')) return { ok: true, status: 200, json: async () => ({ status: 'running', version: '1.0.0', port: 8765 }) };
    if (url.endsWith('/api/project')) return { ok: true, status: 200, json: async () => ({ vmType: 'YukkuriMovieMaker.ViewModels.MainViewModel', projectName: '', projectPath: '' }) };
    if (url.endsWith('/api/reflect/get')) {
      const body = JSON.parse(opts.body);
      if (body.path === 'IsEmptyProject') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.Boolean', value: true }) };
      if (body.path === 'ProjectFilePath') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.String', value: '' }) };
      throw new Error(`unexpected reflect/get path: ${body.path}`);
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const health = await checkYmm4Health({ execFileImpl: exec, fetchImpl });
  assert.equal(health.status, HEALTH.READY_NO_PROJECT);
});

// Regression lock for the exact real bug found live 2026-09-16: /api/project
// reports empty projectName/projectPath EVEN THOUGH a real project
// (marketing_idle.ymmp) is genuinely loaded, because the plugin's
// GetProjectInfo() looks up non-existent "ProjectName"/"ProjectPath"
// properties. The authoritative IsEmptyProject=false + ProjectFilePath
// (via /api/reflect/get, which auto-unwraps the real ProjectFilePath
// ReactiveProperty) must still correctly report HEALTHY_PROJECT_LOADED.
test('checkYmm4Health: HEALTHY_PROJECT_LOADED even when /api/project reports empty projectPath, as long as the authoritative signal (IsEmptyProject=false + ProjectFilePath) confirms a real marketing project is loaded', async () => {
  const { exec } = processMock({ initiallyRunning: [{ Id: 31496, StartTime: 'x' }] });
  const realLoadedPath = 'C:\\Users\\Silver\\VeritasForgeMarketing\\marketing_idle.ymmp';
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/api/status')) return { ok: true, status: 200, json: async () => ({ status: 'running' }) };
    // Confirmed broken on this build — always empty, even with a project loaded.
    if (url.endsWith('/api/project')) return { ok: true, status: 200, json: async () => ({ vmType: 'YukkuriMovieMaker.ViewModels.MainViewModel', projectName: '', projectPath: '' }) };
    if (url.endsWith('/api/reflect/get')) {
      const body = JSON.parse(opts.body);
      if (body.path === 'IsEmptyProject') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.Boolean', value: false }) };
      if (body.path === 'ProjectFilePath') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.String', value: realLoadedPath }) };
      throw new Error(`unexpected reflect/get path: ${body.path}`);
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const health = await checkYmm4Health({ execFileImpl: exec, fetchImpl });
  assert.equal(health.status, HEALTH.HEALTHY);
  assert.equal(health.currentProject, realLoadedPath);
});

test('checkYmm4Health: a Noemora project loaded is still hard-denied even though /api/project itself never reveals it (WRONG_PROJECT, never HEALTHY)', async () => {
  const { exec } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
  const noemoraPath = 'C:\\Users\\Silver\\NoemoraYMM4\\NoemoraLive.ymmp';
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/api/status')) return { ok: true, status: 200, json: async () => ({ status: 'running' }) };
    if (url.endsWith('/api/project')) return { ok: true, status: 200, json: async () => ({ vmType: 'YukkuriMovieMaker.ViewModels.MainViewModel', projectName: '', projectPath: '' }) };
    if (url.endsWith('/api/reflect/get')) {
      const body = JSON.parse(opts.body);
      if (body.path === 'IsEmptyProject') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.Boolean', value: false }) };
      if (body.path === 'ProjectFilePath') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.String', value: noemoraPath }) };
      throw new Error(`unexpected reflect/get path: ${body.path}`);
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const health = await checkYmm4Health({ execFileImpl: exec, fetchImpl });
  assert.equal(health.status, HEALTH.WRONG_PROJECT);
  assert.equal(health.currentProject, noemoraPath);
});

// Task requirement: "if only the project name is available, do NOT weaken
// Noemora protection... fail closed if path identity cannot be safely
// established." A project genuinely loaded (IsEmptyProject=false) but with
// no resolvable file path (e.g. a brand-new, unsaved project) must never
// be treated as safe/HEALTHY.
test('checkYmm4Health: project identity ambiguous (IsEmptyProject=false but no resolvable ProjectFilePath) -> ERROR, fails closed, never HEALTHY', async () => {
  const { exec } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/api/status')) return { ok: true, status: 200, json: async () => ({ status: 'running' }) };
    if (url.endsWith('/api/project')) return { ok: true, status: 200, json: async () => ({ vmType: 'YukkuriMovieMaker.ViewModels.MainViewModel', projectName: '', projectPath: '' }) };
    if (url.endsWith('/api/reflect/get')) {
      const body = JSON.parse(opts.body);
      if (body.path === 'IsEmptyProject') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.Boolean', value: false }) };
      if (body.path === 'ProjectFilePath') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.String', value: '' }) };
      throw new Error(`unexpected reflect/get path: ${body.path}`);
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const health = await checkYmm4Health({ execFileImpl: exec, fetchImpl });
  assert.equal(health.status, HEALTH.ERROR);
  assert.equal(health.currentProject, undefined);
});

test('checkYmm4Health: ERROR when the authoritative project-identity check itself fails (bridge/reflect call errors), never silently treated as READY_NO_PROJECT or HEALTHY', async () => {
  const { exec } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/status')) return { ok: true, status: 200, json: async () => ({ status: 'running' }) };
    if (url.endsWith('/api/project')) return { ok: true, status: 200, json: async () => ({ vmType: 'YukkuriMovieMaker.ViewModels.MainViewModel', projectName: '', projectPath: '' }) };
    throw new Error(`unexpected url: ${url}`);
  };
  // Injected directly (bypassing the real reflectGet's retry/backoff) — this
  // test is about checkYmm4Health's error handling, not about retry timing.
  const getProjectIdentityImpl = async () => ({ ok: false, errorClass: 'TRANSIENT', message: 'ECONNRESET' });
  const health = await checkYmm4Health({ execFileImpl: exec, fetchImpl, getProjectIdentityImpl });
  assert.equal(health.status, HEALTH.ERROR);
});

test('checkYmm4Health: BLOCKED_DIALOG only fires when a window-title enumeration positively matches a known real dialog — never inferred from projectPath alone', async () => {
  const { exec } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
  const hasBlockingDialogImpl = async (pid) => ({
    blocked: true, checked: true,
    titles: ['異常終了を検知しました。バックアップからプロジェクトを復元しますか？'],
  });
  const health = await checkYmm4Health({
    execFileImpl: exec, fetchImpl: fetchMock({ reachable: true, stuckBehindDialog: true }), hasBlockingDialogImpl,
  });
  assert.equal(health.status, HEALTH.BLOCKED_DIALOG);
  assert.ok(health.blockingTitles.some((t) => t.includes('異常終了')));
});

test('checkYmm4Health: the ambiguous "no projectPath, has error" shape stays STARTING (not BLOCKED_DIALOG) when the window check cannot positively confirm a dialog', async () => {
  const { exec } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
  const hasBlockingDialogImpl = async () => ({ blocked: false, checked: true, titles: ['ゆっくりMovieMaker v4.56.1.0'] });
  const health = await checkYmm4Health({
    execFileImpl: exec, fetchImpl: fetchMock({ reachable: true, stuckBehindDialog: true }), hasBlockingDialogImpl,
  });
  assert.equal(health.status, HEALTH.STARTING);
});

test('durable ownership state persists and reads back', () => {
  const { dir, db } = tempDb();
  try {
    recordYmm4ProcessState(db, { pid: 42, owner: 'MARKETING', startedAt: '2026-01-01T00:00:00Z', project: 'marketing_idle.ymmp', bridgeStatus: 'HEALTHY' });
    const state = getYmm4ProcessState(db);
    assert.equal(state.pid, 42);
    assert.equal(state.owner, 'MARKETING');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- lib/ymm4Startup.mjs: ensureYmm4Ready ---

test('ensureYmm4Ready: already HEALTHY (marketing YMM4 already running) -> ready immediately, no launch attempted', async () => {
  const { dir, db } = tempDb();
  try {
    const { exec, calls } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
    const result = await ensureYmm4Ready(db, { execFileImpl: exec, fetchImpl: fetchMock({ reachable: true }) });
    assert.equal(result.ready, true);
    assert.equal(result.status, HEALTH.HEALTHY);
    assert.ok(!calls.some((c) => c.args.join(' ').includes('Start-Process')), 'must never launch a second instance when already healthy');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('ensureYmm4Ready: not running -> safely auto-starts, waits, becomes healthy, records MARKETING ownership', async () => {
  const { dir, db } = tempDb();
  try {
    const { exec } = processMock({ initiallyRunning: [], onStart: () => 7001 });
    const result = await ensureYmm4Ready(db, {
      execFileImpl: exec, fetchImpl: fetchMock({ reachable: true }),
      existsImpl: () => true, // idleProjectPath "exists" so it's used directly, no canary bootstrap needed
      pollIntervalMs: 1, waitTimeoutMs: 100,
    });
    assert.equal(result.ready, true);
    assert.equal(result.owner, 'MARKETING');
    assert.equal(result.pid, 7001);
    const state = getYmm4ProcessState(db);
    assert.equal(state.owner, 'MARKETING');
    assert.equal(state.pid, 7001);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('ensureYmm4Ready: not running, idle project missing -> bootstraps via the canary project, then saves a real idle project', async () => {
  const { dir, db } = tempDb();
  try {
    const { exec } = processMock({ initiallyRunning: [], onStart: () => 7002 });
    let savedTo = null;
    let currentLoadedPath = DEFAULT_MARKETING_CANARY_PROJECT; // launched with canary as the argument
    const fetchImpl = async (url, opts) => {
      if (url.endsWith('/api/status')) return { ok: true, status: 200, json: async () => ({ version: '1.0' }) };
      if (url.endsWith('/api/project')) return { ok: true, status: 200, json: async () => ({ vmType: 'YukkuriMovieMaker.ViewModels.MainViewModel', projectName: '', projectPath: '' }) };
      if (url.endsWith('/api/reflect/get')) {
        const body = JSON.parse(opts.body);
        if (body.path === 'IsEmptyProject') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.Boolean', value: !currentLoadedPath }) };
        if (body.path === 'ProjectFilePath') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.String', value: currentLoadedPath ?? '' }) };
        throw new Error(`unexpected reflect/get path: ${body.path}`);
      }
      if (url.endsWith('/api/reflect/invoke')) {
        const body = JSON.parse(opts.body);
        if (body.method === 'SaveProject') { savedTo = body.args[0]; currentLoadedPath = body.args[0]; }
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      throw new Error(`unexpected url: ${url}`);
    };
    const result = await ensureYmm4Ready(db, {
      execFileImpl: exec, fetchImpl,
      existsImpl: () => false, // neither idle nor (irrelevant) project "exists" on disk yet
      pollIntervalMs: 1, waitTimeoutMs: 100,
    });
    assert.equal(result.ready, true);
    assert.equal(result.justStarted, true);
    assert.equal(savedTo, DEFAULT_MARKETING_IDLE_PROJECT, 'must save a dedicated idle project, never leave the canary as the permanent idle project');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('ensureYmm4Ready: not running, launch never becomes healthy -> not ready, reports the real last-observed status (never loops forever)', async () => {
  const { dir, db } = tempDb();
  try {
    const { exec } = processMock({ initiallyRunning: [], onStart: () => 7003 });
    // Bridge never comes up even though the process "started" — the bounded
    // poll loop gives up after waitTimeoutMs and reports the real,
    // genuinely-observed status (RUNNING_BRIDGE_DOWN — the process IS up,
    // the bridge is not), which is more honest than a generic TIMEOUT.
    const result = await ensureYmm4Ready(db, {
      execFileImpl: exec, fetchImpl: fetchMock({ reachable: false }),
      existsImpl: () => true,
      pollIntervalMs: 1, waitTimeoutMs: 20,
    });
    assert.equal(result.ready, false);
    assert.equal(result.status, HEALTH.RUNNING_BRIDGE_DOWN);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('ensureYmm4Ready: waitTimeoutMs so short no poll ever completes -> generic TIMEOUT fallback, never loops forever', async () => {
  const { dir, db } = tempDb();
  try {
    const { exec } = processMock({ initiallyRunning: [], onStart: () => 7004 });
    const result = await ensureYmm4Ready(db, {
      execFileImpl: exec, fetchImpl: fetchMock({ reachable: false }),
      existsImpl: () => true,
      pollIntervalMs: 1, waitTimeoutMs: 0, // deadline already passed before the first poll -> loop body never runs
    });
    assert.equal(result.ready, false);
    assert.equal(result.status, 'TIMEOUT');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('ensureYmm4Ready: READY_NO_PROJECT -> bootstraps marketing_idle.ymmp via SaveProject, rechecks for real, becomes HEALTHY_PROJECT_LOADED — never launches a second GUI', async () => {
  const { dir, db } = tempDb();
  try {
    const { exec, calls } = processMock({ initiallyRunning: [{ Id: 10636, StartTime: 'x' }] });
    let savedTo = null;
    let projectPathAfterSave = '';
    const fetchImpl = async (url, opts) => {
      if (url.endsWith('/api/status')) return { ok: true, status: 200, json: async () => ({ status: 'running', version: '1.0.0', port: 8765 }) };
      if (url.endsWith('/api/project')) {
        return { ok: true, status: 200, json: async () => ({ vmType: 'YukkuriMovieMaker.ViewModels.MainViewModel', projectName: '', projectPath: '' }) };
      }
      if (url.endsWith('/api/reflect/get')) {
        const body = JSON.parse(opts.body);
        if (body.path === 'IsEmptyProject') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.Boolean', value: !projectPathAfterSave }) };
        if (body.path === 'ProjectFilePath') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.String', value: projectPathAfterSave }) };
        throw new Error(`unexpected reflect/get path: ${body.path}`);
      }
      if (url.endsWith('/api/reflect/invoke')) {
        const body = JSON.parse(opts.body);
        if (body.method === 'SaveProject') {
          savedTo = body.args[0];
          projectPathAfterSave = body.args[0]; // real SaveProject/Save-As semantics: it becomes the current project
        }
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      throw new Error(`unexpected url: ${url}`);
    };
    const result = await ensureYmm4Ready(db, {
      execFileImpl: exec, fetchImpl, existsImpl: () => false, // marketing_idle.ymmp does not exist on disk yet
    });
    assert.equal(savedTo, DEFAULT_MARKETING_IDLE_PROJECT);
    assert.equal(result.ready, true);
    assert.equal(result.status, HEALTH.HEALTHY);
    assert.ok(!calls.some((c) => c.args.join(' ').includes('Start-Process')), 'READY_NO_PROJECT must never launch a second GUI');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('ensureYmm4Ready: READY_NO_PROJECT bootstrap saves the file, but if the live bridge still does not report it loaded, reports the real status honestly (never a false HEALTHY)', async () => {
  const { dir, db } = tempDb();
  try {
    const { exec } = processMock({ initiallyRunning: [{ Id: 10636, StartTime: 'x' }] });
    const fetchImpl = async (url, opts) => {
      if (url.endsWith('/api/status')) return { ok: true, status: 200, json: async () => ({ status: 'running' }) };
      if (url.endsWith('/api/project')) return { ok: true, status: 200, json: async () => ({ vmType: 'YukkuriMovieMaker.ViewModels.MainViewModel', projectName: '', projectPath: '' }) };
      if (url.endsWith('/api/reflect/get')) {
        const body = JSON.parse(opts.body);
        // Deliberately stays empty forever, even after SaveProject "succeeds" below —
        // simulates the file being written but the live app never actually reporting it loaded.
        if (body.path === 'IsEmptyProject') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.Boolean', value: true }) };
        if (body.path === 'ProjectFilePath') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.String', value: '' }) };
        throw new Error(`unexpected reflect/get path: ${body.path}`);
      }
      if (url.endsWith('/api/reflect/invoke')) return { ok: true, status: 200, json: async () => ({ success: true }) };
      throw new Error(`unexpected url: ${url}`);
    };
    const result = await ensureYmm4Ready(db, { execFileImpl: exec, fetchImpl, existsImpl: () => false });
    assert.equal(result.ready, false);
    assert.equal(result.status, HEALTH.READY_NO_PROJECT, 'must not fake HEALTHY just because SaveProject reported success');
    assert.equal(result.health.currentProject ?? null, null, 'live project must be reported null when the bridge truly has nothing loaded');

    // Regression: this branch previously fell back to idleProjectPath in
    // the durable record whenever the recheck still showed nothing loaded,
    // which made a saved-but-not-loaded file look like a live loaded
    // project in `ymm4 status` output.
    const state = getYmm4ProcessState(db);
    assert.equal(state.project, null, 'must never persist the idle/intended path as if it were the live loaded project');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- status semantics: live project vs idle/configured project must never be conflated ---

test('checkYmm4Health: READY_NO_PROJECT result never sets currentProject — there is no live project to report', async () => {
  const { exec } = processMock({ initiallyRunning: [{ Id: 10636, StartTime: 'x' }] });
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/api/status')) return { ok: true, status: 200, json: async () => ({ status: 'running' }) };
    if (url.endsWith('/api/project')) return { ok: true, status: 200, json: async () => ({ vmType: 'YukkuriMovieMaker.ViewModels.MainViewModel', projectName: '', projectPath: '' }) };
    if (url.endsWith('/api/reflect/get')) {
      const body = JSON.parse(opts.body);
      if (body.path === 'IsEmptyProject') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.Boolean', value: true }) };
      if (body.path === 'ProjectFilePath') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.String', value: '' }) };
      throw new Error(`unexpected reflect/get path: ${body.path}`);
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const health = await checkYmm4Health({ execFileImpl: exec, fetchImpl });
  assert.equal(health.status, HEALTH.READY_NO_PROJECT);
  assert.equal(health.currentProject ?? null, null, 'READY_NO_PROJECT must report the live project as null, distinct from the configured idle path');
});

test('DEFAULT_MARKETING_IDLE_PROJECT is a fixed, known path — the configured idle project is reported separately from whatever is actually live', () => {
  assert.equal(DEFAULT_MARKETING_IDLE_PROJECT, 'C:\\Users\\Silver\\VeritasForgeMarketing\\marketing_idle.ymmp');
});

test('ensureYmm4Ready: not running, idle project already exists on disk -> launches YukkuriMovieMaker.exe with the idle project path as the argument, not the canary', async () => {
  const { dir, db } = tempDb();
  try {
    const { exec, calls } = processMock({ initiallyRunning: [], onStart: () => 8001 });
    const result = await ensureYmm4Ready(db, {
      execFileImpl: exec, fetchImpl: fetchMock({ reachable: true, projectPath: DEFAULT_MARKETING_IDLE_PROJECT }),
      existsImpl: () => true, pollIntervalMs: 1, waitTimeoutMs: 100,
    });
    assert.equal(result.ready, true);
    const startCall = calls.find((c) => c.args.join(' ').includes('Start-Process'));
    assert.ok(startCall, 'expected exactly one Start-Process call');
    assert.ok(startCall.args.join(' ').includes(DEFAULT_MARKETING_IDLE_PROJECT),
      'the marketing-owned auto-start must pass the idle project path as the launch argument when it exists on disk');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('ensureYmm4Ready: BLOCKED_DIALOG -> fails closed, reports human action required, never launches or kills anything', async () => {
  const { dir, db } = tempDb();
  try {
    const { exec, calls } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
    const hasBlockingDialogImpl = async () => ({
      blocked: true, checked: true, titles: ['異常終了を検知しました。バックアップからプロジェクトを復元しますか？'],
    });
    const result = await ensureYmm4Ready(db, {
      execFileImpl: exec, fetchImpl: fetchMock({ reachable: true, stuckBehindDialog: true }), hasBlockingDialogImpl,
    });
    assert.equal(result.ready, false);
    assert.equal(result.status, HEALTH.BLOCKED_DIALOG);
    assert.equal(result.humanActionRequired, true);
    assert.ok(!calls.some((c) => c.args.join(' ').includes('Start-Process')), 'BLOCKED_DIALOG must never launch a second GUI');
    assert.ok(!calls.some((c) => c.args.join(' ').includes('Stop-Process')), 'BLOCKED_DIALOG must never kill the blocked process');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('ensureYmm4Ready: WRONG_PROJECT (Noemora loaded) -> never auto-corrects, never starts a second instance', async () => {
  const { dir, db } = tempDb();
  try {
    const { exec, calls } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
    const result = await ensureYmm4Ready(db, {
      execFileImpl: exec, fetchImpl: fetchMock({ reachable: true, projectPath: 'C:\\Users\\Silver\\NoemoraYMM4\\NoemoraLive.ymmp' }),
    });
    assert.equal(result.ready, false);
    assert.equal(result.status, HEALTH.WRONG_PROJECT);
    assert.ok(!calls.some((c) => c.args.join(' ').includes('Start-Process')));
    assert.ok(!calls.some((c) => c.args.join(' ').includes('Stop-Process')), 'must never kill a real Noemora session');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('ensureYmm4Ready: RUNNING_BRIDGE_DOWN, one bounded recheck still down -> not ready, never kills the process', async () => {
  const { dir, db } = tempDb();
  try {
    const { exec, calls } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
    const result = await ensureYmm4Ready(db, {
      execFileImpl: exec, fetchImpl: fetchMock({ reachable: false }),
      bridgeRecheckDelayMs: 1,
    });
    assert.equal(result.ready, false);
    assert.equal(result.status, HEALTH.RUNNING_BRIDGE_DOWN);
    assert.ok(!calls.some((c) => c.args.join(' ').includes('Stop-Process')));
    assert.ok(!calls.some((c) => c.args.join(' ').includes('Start-Process')), 'must never start a second instance on top of a running-but-down one');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('ensureYmm4Ready: STARTING (stuck behind a real blocking dialog) -> not ready, and critically never falls through to launching a second instance', async () => {
  const { dir, db } = tempDb();
  try {
    const { exec, calls } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
    const result = await ensureYmm4Ready(db, {
      execFileImpl: exec, fetchImpl: fetchMock({ reachable: true, stuckBehindDialog: true }),
      bridgeRecheckDelayMs: 1,
    });
    assert.equal(result.ready, false);
    assert.equal(result.status, HEALTH.STARTING);
    assert.ok(!calls.some((c) => c.args.join(' ').includes('Start-Process')), 'a process merely stuck behind a dialog must never get a second instance started on top of it');
    assert.ok(!calls.some((c) => c.args.join(' ').includes('Stop-Process')));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('ensureYmm4Ready: RUNNING_BRIDGE_DOWN then recovers on the bounded recheck -> ready', async () => {
  const { dir, db } = tempDb();
  try {
    const { exec } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
    let calls = 0;
    const fetchImpl = async (url, opts) => {
      calls += 1;
      if (calls <= 1 && url.endsWith('/api/status')) throw new Error('ECONNREFUSED'); // down on first check
      if (url.endsWith('/api/status')) return { ok: true, status: 200, json: async () => ({ version: '1.0' }) };
      if (url.endsWith('/api/project')) return { ok: true, status: 200, json: async () => ({ vmType: 'YukkuriMovieMaker.ViewModels.MainViewModel', projectName: '', projectPath: '' }) };
      if (url.endsWith('/api/reflect/get')) {
        const body = JSON.parse(opts.body);
        if (body.path === 'IsEmptyProject') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.Boolean', value: false }) };
        if (body.path === 'ProjectFilePath') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.String', value: DEFAULT_MARKETING_IDLE_PROJECT }) };
        throw new Error(`unexpected reflect/get path: ${body.path}`);
      }
      throw new Error(`unexpected url: ${url}`);
    };
    const result = await ensureYmm4Ready(db, { execFileImpl: exec, fetchImpl, bridgeRecheckDelayMs: 1 });
    assert.equal(result.ready, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('ensureYmm4Ready: a user-owned already-running healthy instance is used but never claimed as MARKETING-owned', async () => {
  const { dir, db } = tempDb();
  try {
    const { exec } = processMock({ initiallyRunning: [{ Id: 999, StartTime: 'x' }] });
    const result = await ensureYmm4Ready(db, { execFileImpl: exec, fetchImpl: fetchMock({ reachable: true }) });
    assert.equal(result.ready, true);
    assert.equal(result.owner, 'USER', 'a pre-existing instance this call did not start must never be claimed as MARKETING-owned');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('ensureYmm4Ready: duplicate concurrent startup requests -> the second gets STARTUP_IN_PROGRESS, never a second launch', async () => {
  const { dir, db } = tempDb();
  try {
    const lock1 = acquireYmm4StartupLock(db);
    assert.equal(lock1.acquired, true);
    const lock2 = acquireYmm4StartupLock(db);
    assert.equal(lock2.acquired, false);
    assert.equal(lock2.reason, 'STARTUP_IN_PROGRESS');
    releaseYmm4StartupLock(db);
    const lock3 = acquireYmm4StartupLock(db);
    assert.equal(lock3.acquired, true, 'released lock must be re-acquirable');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('ensureYmm4ForVideoJob translates a not-ready result to YMM4_UNAVAILABLE', async () => {
  const { dir, db } = tempDb();
  try {
    const { exec } = processMock({ initiallyRunning: [] });
    const result = await ensureYmm4ForVideoJob(db, {
      execFileImpl: exec, fetchImpl: fetchMock({ reachable: false }),
      existsImpl: () => true, pollIntervalMs: 1, waitTimeoutMs: 10,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'YMM4_UNAVAILABLE');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('ensureYmm4ForVideoJob translates a ready result to YMM4_READY', async () => {
  const { dir, db } = tempDb();
  try {
    const { exec } = processMock({ initiallyRunning: [{ Id: 1, StartTime: 'x' }] });
    const result = await ensureYmm4ForVideoJob(db, { execFileImpl: exec, fetchImpl: fetchMock({ reachable: true }) });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'YMM4_READY');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- stale PID / crash-restart recovery (mandate section 14) ---

test('isDurableStateStale: true when the durable record claims a pid that is no longer really running', async () => {
  const { dir, db } = tempDb();
  try {
    recordYmm4ProcessState(db, { pid: 12345, owner: 'MARKETING', startedAt: '2026-01-01T00:00:00Z', project: 'x', bridgeStatus: 'HEALTHY' });
    const { exec } = processMock({ initiallyRunning: [] }); // the real process table disagrees — it crashed
    assert.equal(await isDurableStateStale(db, { execFileImpl: exec }), true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('isDurableStateStale: false when the recorded pid is genuinely still live', async () => {
  const { dir, db } = tempDb();
  try {
    recordYmm4ProcessState(db, { pid: 12345, owner: 'MARKETING', startedAt: '2026-01-01T00:00:00Z', project: 'x', bridgeStatus: 'HEALTHY' });
    const { exec } = processMock({ initiallyRunning: [{ Id: 12345, StartTime: 'x' }] });
    assert.equal(await isDurableStateStale(db, { execFileImpl: exec }), false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('crash/restart recovery: a stale MARKETING-owned durable record never fools checkYmm4Health into reporting HEALTHY — it always re-checks the real process table', async () => {
  const { dir, db } = tempDb();
  try {
    recordYmm4ProcessState(db, { pid: 12345, owner: 'MARKETING', startedAt: '2026-01-01T00:00:00Z', project: DEFAULT_MARKETING_IDLE_PROJECT, bridgeStatus: 'HEALTHY' });
    const { exec } = processMock({ initiallyRunning: [] }); // crashed since the last record
    const health = await checkYmm4Health({ execFileImpl: exec, fetchImpl: fetchMock({ reachable: true }) });
    assert.equal(health.status, HEALTH.NOT_RUNNING);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- ensureMarketingIdleProjectFile ---

test('ensureMarketingIdleProjectFile: a no-op (no write) when the file already exists', async () => {
  let saveInvoked = false;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/reflect/invoke')) { saveInvoked = true; return { ok: true, status: 200, json: async () => ({ success: true }) }; }
    throw new Error(`unexpected: ${url}`);
  };
  const result = await ensureMarketingIdleProjectFile(DEFAULT_MARKETING_IDLE_PROJECT, { fetchImpl, existsImpl: () => true });
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(saveInvoked, false);
});

test('ensureMarketingIdleProjectFile: refuses to create a forbidden (Noemora) idle project path', async () => {
  const result = await ensureMarketingIdleProjectFile('C:\\Users\\Silver\\NoemoraYMM4\\NoemoraLive.ymmp', { fetchImpl: async () => { throw new Error('must not be called'); }, existsImpl: () => false });
  assert.equal(result.ok, false);
});
