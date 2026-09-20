// Deterministic YMM4 health check + durable process-ownership state (YMM4
// unattended-startup mandate sections 3, 8, 12). Never infers health merely
// from process existence — every status is derived from a real, direct
// check: process table, bridge HTTP reachability, and (via the bridge's
// own /api/project — confirmed real response shape `{vmType, projectName,
// projectPath}` from the vendored plugin source, McpHttpServer.cs
// GetProjectInfo()) which project is actually loaded.
import { findYmm4Processes, hasBlockingDialog } from './ymm4Process.mjs';
import { checkReachable, getProjectInfo, getProjectIdentity } from './ymm4Bridge.mjs';
import { isForbiddenProjectPath } from './videoPipeline.mjs';
import { psFetch } from './psHttpRelay.mjs';

export const HEALTH = {
  // Alias kept so external status vocabulary (docs/ops reports) can use
  // either name — HEALTHY is the name every existing call site/test uses.
  HEALTHY: 'HEALTHY',
  NOT_RUNNING: 'NOT_RUNNING',
  RUNNING_BRIDGE_DOWN: 'RUNNING_BRIDGE_DOWN',
  WRONG_PROJECT: 'WRONG_PROJECT',
  STARTING: 'STARTING',
  ERROR: 'ERROR',
  // Bridge reachable, no internal error, application genuinely responsive
  // (MainViewModel resolved) — just nothing loaded. Distinct from STARTING:
  // this is immediately usable, never needs a bounded wait/recheck.
  READY_NO_PROJECT: 'READY_NO_PROJECT',
  // Bridge reachable but /api/project fails AND a window-title enumeration
  // positively matched a known real blocking dialog (see
  // docs/marketing/YMM4_STARTUP_AUDIT.md). Distinct from STARTING: this
  // will never resolve on its own — it needs a human.
  BLOCKED_DIALOG: 'BLOCKED_DIALOG',
};

// Task-vocabulary alias: HEALTHY here is exactly "HEALTHY_PROJECT_LOADED".
// (BRIDGE_DOWN is intentionally NOT aliased to one HEALTH value — it maps
// to NOT_RUNNING when no process exists at all, or RUNNING_BRIDGE_DOWN when
// the process exists but the HTTP bridge itself doesn't answer; collapsing
// those into one alias would lose real information the existing tests and
// ensureYmm4Ready() branches both depend on.)
export const HEALTHY_PROJECT_LOADED = HEALTH.HEALTHY;

function normalizeProjectPath(p) {
  return String(p ?? '').replace(/\\/g, '/').toLowerCase();
}

/**
 * The one real, deterministic health check. `expectedProjectPath`, when
 * given, makes WRONG_PROJECT stricter (the loaded project must match
 * exactly, not merely "not Noemora") — used when the caller specifically
 * needs the marketing idle/working project, not just "anything safe."
 * Without it, WRONG_PROJECT still fires for any Noemora project (the hard
 * safety floor), but a different-but-safe marketing project is HEALTHY.
 */
export async function checkYmm4Health({
  env = process.env, fetchImpl = psFetch, execFileImpl, expectedProjectPath,
  hasBlockingDialogImpl = hasBlockingDialog, getProjectIdentityImpl = getProjectIdentity,
} = {}) {
  const procResult = await findYmm4Processes({ execFileImpl });
  if (!procResult.ok) {
    return { status: HEALTH.ERROR, reason: `process check failed: ${procResult.error}`, checkedAt: new Date().toISOString() };
  }
  if (procResult.processes.length === 0) {
    return { status: HEALTH.NOT_RUNNING, processes: [], checkedAt: new Date().toISOString() };
  }

  const reach = await checkReachable({ env, fetchImpl });
  if (!reach.reachable) {
    return { status: HEALTH.RUNNING_BRIDGE_DOWN, processes: procResult.processes, checkedAt: new Date().toISOString() };
  }

  const info = await getProjectInfo({ env, fetchImpl });
  if (!info.ok) {
    return {
      status: HEALTH.ERROR, reason: 'bridge reachable but /api/project failed',
      processes: procResult.processes, checkedAt: new Date().toISOString(),
    };
  }
  // The plugin itself can respond HTTP 200 with a body like
  // {"error": "MainViewModel取得失敗"} when the HTTP server is up but the
  // application isn't actually ready yet — confirmed for real: a process
  // still behind a blocking startup dialog (e.g. YMM4's own crash-recovery
  // prompt) answers /api/status but /api/project comes back exactly this
  // way, with no projectPath at all. This shape is genuinely ambiguous on
  // its own — it also occurs during ordinary transient startup — so it is
  // never inferred as a dialog; a window-title enumeration must positively
  // confirm a known real dialog before this reports BLOCKED_DIALOG. Absent
  // that positive confirmation, it stays STARTING (bounded wait), same as
  // before.
  if (info.error) {
    const pid = procResult.processes[0]?.pid;
    const dialogCheck = pid != null
      ? await hasBlockingDialogImpl(pid, { execFileImpl })
      : { blocked: false, checked: false, titles: [] };
    if (dialogCheck.blocked) {
      return {
        status: HEALTH.BLOCKED_DIALOG, reason: `a known blocking dialog is on screen: ${dialogCheck.titles.join(' | ')}`,
        blockingTitles: dialogCheck.titles, processes: procResult.processes, checkedAt: new Date().toISOString(),
      };
    }
    return {
      status: HEALTH.STARTING, reason: `bridge reachable but not yet usable (${info.error})`,
      processes: procResult.processes, checkedAt: new Date().toISOString(),
    };
  }
  // info.error is absent, so GetMainViewModel() resolved — the application
  // itself is genuinely responsive. From here, project identity is NEVER
  // taken from info.projectPath/info.vmType (confirmed broken on this
  // build — see getProjectInfo()'s doc comment in ymm4Bridge.mjs); the
  // authoritative signal is getProjectIdentity(), which reads the real
  // IsEmptyProject/ProjectFilePath properties via /api/reflect/get.
  if (!info.vmType) {
    return {
      status: HEALTH.STARTING, reason: 'bridge reachable but response shape unexpected (no vmType, no error)',
      processes: procResult.processes, checkedAt: new Date().toISOString(),
    };
  }
  const identity = await getProjectIdentityImpl({ env, fetchImpl });
  if (!identity.ok) {
    return {
      status: HEALTH.ERROR, reason: `bridge/application responsive but project identity check failed: ${identity.message ?? identity.errorClass}`,
      processes: procResult.processes, checkedAt: new Date().toISOString(),
    };
  }
  if (identity.isEmpty) {
    return {
      status: HEALTH.READY_NO_PROJECT, reason: 'bridge reachable, application responsive, IsEmptyProject=true (authoritative signal)',
      processes: procResult.processes, checkedAt: new Date().toISOString(),
    };
  }
  // A project/document IS loaded (IsEmptyProject=false) but has no
  // resolvable file path (e.g. a brand-new, never-saved project) — fail
  // closed rather than guess. We need a verifiable path to apply the
  // Noemora hard-deny check and to gate autonomous render eligibility; a
  // name alone is never enough to weaken that protection.
  if (!identity.projectPath) {
    return {
      status: HEALTH.ERROR,
      reason: 'a project/document appears loaded (IsEmptyProject=false) but no file path could be verified — refusing to treat as safe without a verifiable path',
      processes: procResult.processes, checkedAt: new Date().toISOString(),
    };
  }
  const currentProject = identity.projectPath;
  if (isForbiddenProjectPath(currentProject)) {
    return {
      status: HEALTH.WRONG_PROJECT, currentProject, reason: 'a forbidden (Noemora) project is loaded — marketing automation must never touch it',
      processes: procResult.processes, checkedAt: new Date().toISOString(),
    };
  }
  if (expectedProjectPath && normalizeProjectPath(currentProject) !== normalizeProjectPath(expectedProjectPath)) {
    return {
      status: HEALTH.WRONG_PROJECT, currentProject, expectedProjectPath,
      processes: procResult.processes, checkedAt: new Date().toISOString(),
    };
  }

  return { status: HEALTH.HEALTHY, currentProject, processes: procResult.processes, checkedAt: new Date().toISOString() };
}

// --- Durable process-ownership state (mandate section 8) ---
// Single-row pattern, same shape/spirit as lib/videoPipeline.mjs's
// render_lock — one marketing db, no second persistence mechanism.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ymm4_process_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  pid             INTEGER,
  owner           TEXT,     -- 'MARKETING' | 'USER'
  started_at      TEXT,
  project         TEXT,
  bridge_status   TEXT,
  last_checked_at TEXT
);
`;

// Added for the top-level `status` command to reuse the exact enriched
// health-state label the live `ymm4 status`/`ymm4 ensure` commands compute
// (see lib/ymm4IdleTemplate.mjs's deriveHealthState/
// computeAutonomousRenderReadiness) without itself making any live
// process/bridge call — same ALTER-TABLE migration pattern as
// videoPipeline.mjs's V2_COLUMNS (never a DROP/CREATE; existing durable
// records must survive). Deliberately a SEPARATE column from
// `bridge_status`, never overwriting it — `bridge_status` stays the raw
// TRANSPORT status (HEALTHY/READY_NO_PROJECT/...), `health_state` is the
// higher-level, further-verified concept (HEALTHY_PROJECT_LOADED/
// HEALTHY_EMPTY_MARKETING_SESSION/...); the two must never be conflated.
const V2_COLUMNS = { health_state: 'TEXT' };

export function ensureYmm4StateSchema(db) {
  db.exec(SCHEMA);
  const existingCols = new Set(db.prepare('PRAGMA table_info(ymm4_process_state)').all().map((c) => c.name));
  for (const [name, type] of Object.entries(V2_COLUMNS)) {
    if (!existingCols.has(name)) {
      db.exec(`ALTER TABLE ymm4_process_state ADD COLUMN ${name} ${type}`);
    }
  }
}

export function getYmm4ProcessState(db) {
  ensureYmm4StateSchema(db);
  return db.prepare('SELECT * FROM ymm4_process_state WHERE id = 1').get() ?? null;
}

/**
 * Records what the marketing system currently believes about the YMM4
 * process — called after every real health check and after every
 * start/terminate action, so the durable record never silently goes stale.
 * `healthState` is optional (most call sites only ever compute the raw
 * transport `bridgeStatus`, e.g. ensureYmm4Ready's internal recording) —
 * when omitted it defaults to mirroring `bridgeStatus`, so `health_state`
 * never silently carries over a stale value from an earlier, different
 * check; only the one caller that actually ran the extra empty-session
 * verification (cli.mjs's `ymm4 status`) passes the enriched
 * HEALTHY_EMPTY_MARKETING_SESSION label explicitly.
 */
export function recordYmm4ProcessState(db, { pid, owner, startedAt, project, bridgeStatus, healthState }) {
  ensureYmm4StateSchema(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ymm4_process_state (id, pid, owner, started_at, project, bridge_status, health_state, last_checked_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       pid = excluded.pid, owner = excluded.owner, started_at = excluded.started_at,
       project = excluded.project, bridge_status = excluded.bridge_status, health_state = excluded.health_state, last_checked_at = excluded.last_checked_at`
  ).run(pid ?? null, owner ?? null, startedAt ?? null, project ?? null, bridgeStatus ?? null, healthState ?? bridgeStatus ?? null, now);
}

export function clearYmm4ProcessState(db) {
  ensureYmm4StateSchema(db);
  db.prepare('DELETE FROM ymm4_process_state WHERE id = 1').run();
}
