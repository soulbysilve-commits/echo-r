// Safe auto-start + bounded self-recovery orchestration for YMM4 (YMM4
// unattended-startup mandate sections 4, 5, 7, 8). Ties together
// lib/ymm4Process.mjs (real Windows process control), lib/ymm4Health.mjs
// (deterministic health + durable ownership state), and lib/ymm4Bridge.mjs
// (the existing, unchanged HTTP client) into the one function the rest of
// the pipeline calls: ensureYmm4Ready().
//
// Hard rules enforced throughout (never relaxed by any caller):
//   - never touches a forbidden (Noemora) project path (isForbiddenProjectPath)
//   - never starts a second GUI instance if one is already running
//   - never kills/restarts a process this system did not itself start
//     (YMM4_PROCESS_OWNER must be 'MARKETING', checked against the LIVE
//     process table, not just the durable record — mandate section 14:
//     "stale PID")
//   - at most ONE bounded recovery attempt per call — no restart loops
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findYmm4Processes, startYmm4Process, isPidLiveYmm4 } from './ymm4Process.mjs';
import { checkYmm4Health, HEALTH, getYmm4ProcessState, recordYmm4ProcessState, ensureYmm4StateSchema } from './ymm4Health.mjs';
import { saveProject } from './ymm4Bridge.mjs';
import { isForbiddenProjectPath, MARKETING_PROJECT_ROOT } from './videoPipeline.mjs';
import { toWslPath } from './winPath.mjs';
import { psFetch } from './psHttpRelay.mjs';

const execFileAsync = promisify(execFile);

export const DEFAULT_MARKETING_IDLE_PROJECT = `C:\\Users\\Silver\\${MARKETING_PROJECT_ROOT}\\marketing_idle.ymmp`;
// Existing, already-real, already-rendered-from project — used ONLY as a
// one-time bootstrap seed for the very first launch, when marketing_idle.
// ymmp does not exist yet. Mandate section 5: "Never use the canary project
// as the permanent idle project" — this module never treats it as the
// idle project going forward, only as launch content for the one bootstrap
// launch that then immediately saves a real, separate marketing_idle.ymmp.
export const DEFAULT_MARKETING_CANARY_PROJECT = `C:\\Users\\Silver\\${MARKETING_PROJECT_ROOT}\\marketing_canary.ymmp`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameProjectPath(a, b) {
  return String(a ?? '').replace(/\\/g, '/').toLowerCase() === String(b ?? '').replace(/\\/g, '/').toLowerCase();
}

// --- Startup lock (mandate section 4: "Use a process lock / startup
// lock" / section 14: "duplicate startup request") — same stale-lock-
// recovery shape as videoPipeline.mjs's render_lock, in its own table so a
// crashed marketing operator process (not the YMM4 process itself) never
// leaves this lock stuck forever. ---
const LOCK_SCHEMA = `
CREATE TABLE IF NOT EXISTS ymm4_startup_lock (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  node_pid   INTEGER NOT NULL,
  started_at TEXT NOT NULL
);
`;
const STARTUP_LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes — generous for a GUI launch + bounded wait

export function acquireYmm4StartupLock(db) {
  db.exec(LOCK_SCHEMA);
  const existing = db.prepare('SELECT * FROM ymm4_startup_lock WHERE id = 1').get();
  const now = new Date().toISOString();
  if (existing) {
    const age = Date.now() - Date.parse(existing.started_at);
    let alive = true;
    try { process.kill(existing.node_pid, 0); } catch { alive = false; }
    if (age <= STARTUP_LOCK_STALE_MS || alive) {
      return { acquired: false, reason: 'STARTUP_IN_PROGRESS', holder: existing };
    }
    db.prepare('DELETE FROM ymm4_startup_lock WHERE id = 1').run();
  }
  db.prepare('INSERT INTO ymm4_startup_lock (id, node_pid, started_at) VALUES (1, ?, ?)').run(process.pid, now);
  return { acquired: true };
}

export function releaseYmm4StartupLock(db) {
  db.exec(LOCK_SCHEMA);
  db.prepare('DELETE FROM ymm4_startup_lock WHERE id = 1').run();
}

/**
 * Creates the dedicated marketing idle project if it doesn't exist yet, by
 * saving whatever's currently loaded (via the already-verified SaveProject
 * mechanism) to a NEW path — never by hand-constructing a .ymmp file.
 * Requires the bridge to already be reachable (a bootstrap chicken-and-egg:
 * the first-ever launch must use an already-real project, see
 * DEFAULT_MARKETING_CANARY_PROJECT, so there's something loaded to save).
 */
export async function ensureMarketingIdleProjectFile(idleProjectPath, {
  env = process.env, fetchImpl = psFetch, existsImpl = existsSync,
} = {}) {
  if (isForbiddenProjectPath(idleProjectPath)) {
    return { ok: false, error: 'refusing to create a forbidden (Noemora) idle project path' };
  }
  if (existsImpl(toWslPath(idleProjectPath))) {
    return { ok: true, created: false, idleProjectPath };
  }
  const saved = await saveProject(idleProjectPath, { env, fetchImpl });
  if (!saved.ok) {
    return { ok: false, error: saved.message ?? saved.errorClass ?? 'saveProject failed', idleProjectPath };
  }
  return { ok: true, created: true, idleProjectPath };
}

/**
 * The one entry point everything else calls. Never more than one bounded
 * launch-and-wait attempt; never touches a process it doesn't own; never
 * touches a forbidden project. Returns { ready, status, ... } — `status`
 * uses the same HEALTH vocabulary plus 'STARTUP_IN_PROGRESS'/'TIMEOUT' for
 * the two auto-start-specific outcomes.
 */
export async function ensureYmm4Ready(db, {
  env = process.env, fetchImpl = psFetch, execFileImpl = execFileAsync,
  idleProjectPath = DEFAULT_MARKETING_IDLE_PROJECT,
  canaryProjectPath = DEFAULT_MARKETING_CANARY_PROJECT,
  waitTimeoutMs = 60_000, pollIntervalMs = 3_000, bridgeRecheckDelayMs = 5_000,
  existsImpl = existsSync, sleepImpl = sleep, hasBlockingDialogImpl, getProjectIdentityImpl,
} = {}) {
  ensureYmm4StateSchema(db);
  const priorState = getYmm4ProcessState(db);

  const health = await checkYmm4Health({ env, fetchImpl, execFileImpl, hasBlockingDialogImpl, getProjectIdentityImpl });

  if (health.status === HEALTH.HEALTHY) {
    const pid = health.processes[0]?.pid ?? null;
    // Preserve MARKETING ownership if we already believed we owned this
    // exact live PID; otherwise (first time seeing it, or a different PID
    // than we last recorded) it's not ours to claim ownership of.
    const owner = (priorState?.owner === 'MARKETING' && String(priorState?.pid) === String(pid)) ? 'MARKETING' : 'USER';
    recordYmm4ProcessState(db, { pid, owner, startedAt: priorState?.started_at ?? null, project: health.currentProject, bridgeStatus: HEALTH.HEALTHY });
    return { ready: true, status: HEALTH.HEALTHY, health, owner, pid };
  }

  if (health.status === HEALTH.WRONG_PROJECT) {
    // Never auto-correct — could be a real user Noemora session, or any
    // other project a human deliberately has open. Read-only inspection
    // remains fine; this function never writes/renders/switches projects.
    recordYmm4ProcessState(db, {
      pid: health.processes?.[0]?.pid ?? null, owner: priorState?.owner ?? 'USER',
      startedAt: priorState?.started_at ?? null, project: health.currentProject, bridgeStatus: HEALTH.WRONG_PROJECT,
    });
    return { ready: false, status: HEALTH.WRONG_PROJECT, health, reason: 'a Noemora or unexpected project is loaded; refusing to touch it' };
  }

  if (health.status === HEALTH.READY_NO_PROJECT) {
    // Bridge is genuinely usable, just nothing loaded — never launch a
    // second GUI here. Bootstrap the dedicated idle project via the
    // already-verified SaveProject mechanism, then re-check for real
    // rather than assuming Save made it the live current project.
    const bootstrap = await ensureMarketingIdleProjectFile(idleProjectPath, { env, fetchImpl, existsImpl });
    if (!bootstrap.ok) {
      recordYmm4ProcessState(db, {
        pid: health.processes?.[0]?.pid ?? null, owner: priorState?.owner ?? 'USER',
        startedAt: priorState?.started_at ?? null, project: null, bridgeStatus: HEALTH.READY_NO_PROJECT,
      });
      return { ready: false, status: HEALTH.READY_NO_PROJECT, health, idleBootstrap: bootstrap, reason: `idle project bootstrap failed: ${bootstrap.error}` };
    }
    const recheck = await checkYmm4Health({ env, fetchImpl, execFileImpl, expectedProjectPath: idleProjectPath, hasBlockingDialogImpl, getProjectIdentityImpl });
    const pid = recheck.processes?.[0]?.pid ?? health.processes?.[0]?.pid ?? null;
    const owner = (priorState?.owner === 'MARKETING' && String(priorState?.pid) === String(pid)) ? 'MARKETING' : 'USER';
    // `project` here must be the REAL live value only (null if nothing is
    // actually loaded) — never the idle path we merely intended/attempted
    // to bootstrap. Falling back to idleProjectPath here previously made a
    // saved-but-not-loaded file look like a live loaded project in the
    // durable record and in `ymm4 status` output.
    recordYmm4ProcessState(db, {
      pid, owner, startedAt: priorState?.started_at ?? null,
      project: recheck.currentProject ?? null, bridgeStatus: recheck.status,
    });
    if (recheck.status === HEALTH.HEALTHY) {
      return { ready: true, status: HEALTH.HEALTHY, health: recheck, owner, pid, idleBootstrap: bootstrap };
    }
    return {
      ready: false, status: recheck.status, health: recheck, owner, pid, idleBootstrap: bootstrap,
      reason: 'idle project file was saved, but the live bridge does not yet report it as the loaded project',
    };
  }

  if (health.status === HEALTH.BLOCKED_DIALOG) {
    // Fail closed — never guessed, never dismissed automatically. A human
    // needs to look at the exact reported window title(s) and act.
    recordYmm4ProcessState(db, {
      pid: health.processes?.[0]?.pid ?? null, owner: priorState?.owner ?? 'USER',
      startedAt: priorState?.started_at ?? null, project: null, bridgeStatus: HEALTH.BLOCKED_DIALOG,
    });
    return { ready: false, status: HEALTH.BLOCKED_DIALOG, health, reason: health.reason, humanActionRequired: true };
  }

  if (health.status === HEALTH.RUNNING_BRIDGE_DOWN || health.status === HEALTH.STARTING) {
    // Bounded ONE recheck after a short wait (the plugin/application may
    // still be initializing — including a process genuinely stuck behind a
    // blocking startup dialog of its own, confirmed real: YMM4's own
    // crash-recovery prompt leaves /api/status reachable but /api/project
    // unusable) — never kill/restart a process we may not even own, and
    // critically never fall through to the NOT_RUNNING/auto-start branch
    // below, which would start a SECOND instance on top of this one.
    await sleepImpl(bridgeRecheckDelayMs);
    const recheck = await checkYmm4Health({ env, fetchImpl, execFileImpl, hasBlockingDialogImpl, getProjectIdentityImpl });
    if (recheck.status === HEALTH.HEALTHY) {
      const pid = recheck.processes[0]?.pid ?? null;
      const owner = (priorState?.owner === 'MARKETING' && String(priorState?.pid) === String(pid)) ? 'MARKETING' : 'USER';
      recordYmm4ProcessState(db, { pid, owner, startedAt: priorState?.started_at ?? null, project: recheck.currentProject, bridgeStatus: HEALTH.HEALTHY });
      return { ready: true, status: HEALTH.HEALTHY, health: recheck, owner, pid };
    }
    recordYmm4ProcessState(db, {
      pid: recheck.processes?.[0]?.pid ?? null, owner: priorState?.owner ?? 'USER',
      startedAt: priorState?.started_at ?? null, project: recheck.currentProject ?? null, bridgeStatus: recheck.status,
    });
    return { ready: false, status: recheck.status, health: recheck, reason: 'YMM4 is running but not yet usable — not safe to kill/restart automatically (it may be waiting on a human, e.g. a crash-recovery prompt)' };
  }

  if (health.status === HEALTH.ERROR) {
    return { ready: false, status: HEALTH.ERROR, health, reason: health.reason };
  }

  // HEALTH.NOT_RUNNING — the only status this function will actually start
  // a new process for.
  const lock = acquireYmm4StartupLock(db);
  if (!lock.acquired) {
    return { ready: false, status: 'STARTUP_IN_PROGRESS', reason: 'another startup attempt is already in progress', holder: lock.holder };
  }
  try {
    // Re-check after acquiring the lock — a concurrent attempt may have
    // just finished starting it.
    const recheckAfterLock = await checkYmm4Health({ env, fetchImpl, execFileImpl, hasBlockingDialogImpl, getProjectIdentityImpl });
    if (recheckAfterLock.status === HEALTH.HEALTHY) {
      const pid = recheckAfterLock.processes[0]?.pid ?? null;
      recordYmm4ProcessState(db, { pid, owner: 'USER', startedAt: priorState?.started_at ?? null, project: recheckAfterLock.currentProject, bridgeStatus: HEALTH.HEALTHY });
      return { ready: true, status: HEALTH.HEALTHY, health: recheckAfterLock, owner: 'USER', pid };
    }
    if (recheckAfterLock.status !== HEALTH.NOT_RUNNING) {
      // Something changed state (e.g. a user opened it, or it's now
      // WRONG_PROJECT/RUNNING_BRIDGE_DOWN) between our first check and
      // acquiring the lock — do not launch a second instance on top of it.
      return { ready: false, status: recheckAfterLock.status, health: recheckAfterLock, reason: 'state changed before a safe launch could begin; not starting a second instance' };
    }

    const launchProjectPath = existsImpl(toWslPath(idleProjectPath)) ? idleProjectPath : canaryProjectPath;
    if (isForbiddenProjectPath(launchProjectPath)) {
      return { ready: false, status: HEALTH.ERROR, reason: 'computed launch project path is forbidden — refusing to start' };
    }
    const started = await startYmm4Process({ projectPath: launchProjectPath, execFileImpl });
    if (!started.ok) {
      return { ready: false, status: HEALTH.ERROR, reason: started.error };
    }

    const deadline = Date.now() + waitTimeoutMs;
    let finalHealth = { status: HEALTH.STARTING };
    while (Date.now() < deadline) {
      await sleepImpl(pollIntervalMs);
      finalHealth = await checkYmm4Health({ env, fetchImpl, execFileImpl, expectedProjectPath: launchProjectPath, hasBlockingDialogImpl, getProjectIdentityImpl });
      if (finalHealth.status === HEALTH.HEALTHY || finalHealth.status === HEALTH.WRONG_PROJECT) break;
    }

    if (finalHealth.status !== HEALTH.HEALTHY) {
      recordYmm4ProcessState(db, {
        pid: started.pid, owner: 'MARKETING', startedAt: started.startedAt,
        project: finalHealth.currentProject ?? launchProjectPath, bridgeStatus: finalHealth.status,
      });
      return { ready: false, status: finalHealth.status === HEALTH.STARTING ? 'TIMEOUT' : finalHealth.status, health: finalHealth, pid: started.pid, reason: 'timed out waiting for YMM4/bridge to become healthy after launch' };
    }

    recordYmm4ProcessState(db, { pid: started.pid, owner: 'MARKETING', startedAt: started.startedAt, project: finalHealth.currentProject, bridgeStatus: HEALTH.HEALTHY });

    // First-ever bootstrap: we launched with the canary project because
    // marketing_idle.ymmp didn't exist yet — save a real, separate copy of
    // whatever's now loaded AS the dedicated idle project, so every future
    // launch uses it instead (mandate section 5).
    let idleBootstrap = null;
    if (!sameProjectPath(launchProjectPath, idleProjectPath) && !existsImpl(toWslPath(idleProjectPath))) {
      idleBootstrap = await ensureMarketingIdleProjectFile(idleProjectPath, { env, fetchImpl, existsImpl });
    }

    return { ready: true, status: HEALTH.HEALTHY, health: finalHealth, pid: started.pid, owner: 'MARKETING', justStarted: true, idleBootstrap };
  } finally {
    releaseYmm4StartupLock(db);
  }
}

/**
 * Self-recovery wrapper for use immediately before an automatic video job
 * (mandate section 7) — ONE bounded ensureYmm4Ready() call, translated to
 * the exact vocabulary that stage of the pipeline expects.
 */
export async function ensureYmm4ForVideoJob(db, opts = {}) {
  const result = await ensureYmm4Ready(db, opts);
  if (!result.ready) {
    return { ok: false, status: 'YMM4_UNAVAILABLE', detail: result };
  }
  return { ok: true, status: 'YMM4_READY', detail: result };
}

/**
 * Stale-PID detection (mandate section 14): true if the durable record
 * claims a MARKETING-owned PID that is no longer actually a live YMM4
 * process. Callers should treat this the same as NOT_RUNNING, never as
 * HEALTHY, and never assume the durable record alone without this check.
 */
export async function isDurableStateStale(db, opts = {}) {
  const state = getYmm4ProcessState(db);
  if (!state?.pid) return false;
  const live = await isPidLiveYmm4(state.pid, opts);
  return !live;
}
