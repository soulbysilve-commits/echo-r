// Orchestrates: evidence -> redaction gate -> script -> (YMM4 render if the
// bridge is reachable, else an import-ready package) -> private YouTube
// upload -> X follow-up draft. Restart-safe and idempotent: every stage's
// outcome is persisted to `demo_runs`, keyed by demoRunId, so re-running
// `video create <id>` after a crash resumes rather than redoing finished work.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildPublicSafeBundle } from './evidence.mjs';
import { generateVideoScript, validateScript } from './videoScript.mjs';
import { getItems, deleteItemsOnLayers, addVoiceLine, saveProject, CHARACTER_NAME } from './ymm4Bridge.mjs';
import { statePath } from './paths.mjs';
import { recordIntent, markPublished, markFailed } from './ledger.mjs';
import { toWslPath } from './winPath.mjs';
import * as youtube from '../connectors/youtube.mjs';

const execFileAsync = promisify(execFile);

// The one and only directory recurring auto-encode may ever write to/read
// from. Deliberately a constant, not configurable via env — widening this
// is a code change, not a runtime flag, exactly so it can't be loosened by
// mistake via environment drift.
export const MARKETING_PROJECT_ROOT = 'VeritasForgeMarketing';
export const FORBIDDEN_PROJECT_NAME = 'noemoralive.ymmp';
// Hard-deny mandate (recurring-video mandate section 14, reaffirmed by the
// YMM4 unattended-startup mandate section 9): "Reject any project path
// containing or matching: NoemoraLive.ymmp / Noemora / Noemora_mod_core".
// The exact-basename check above already catches the literal project file;
// this substring check is the broader, defense-in-depth backstop for any
// path that merely contains "Noemora" anywhere — e.g. a maliciously/
// accidentally nested "...\VeritasForgeMarketing\projects\Noemora_mod_core\
// x.ymmp", which the "under MARKETING_PROJECT_ROOT" check alone would NOT
// catch. Also covers "Noemora_mod_core" as a substring already, since that
// itself contains "noemora".
export const FORBIDDEN_PATH_PATTERN = /noemora/i;

/**
 * The one shared Noemora hard-deny check — every write/render/process-
 * launch path that touches a project path must call this, never re-derive
 * its own copy of the pattern (mandate: reject paths containing "Noemora",
 * "NoemoraLive.ymmp", or "Noemora_mod_core" — all three are substrings of
 * "noemora", so one case-insensitive substring test covers all three).
 * Read-only evidence inspection is exempt by construction: this function is
 * only ever called at write/render/process-launch call sites, never from
 * any read-only inspection path.
 */
export function isForbiddenProjectPath(projectPath) {
  const normalized = String(projectPath ?? '').replace(/\\/g, '/');
  if (basename(normalized).toLowerCase() === FORBIDDEN_PROJECT_NAME) return true;
  if (FORBIDDEN_PATH_PATTERN.test(normalized)) return true;
  return false;
}

export function ymm4DemoAllowed(env = process.env) {
  return env.MARKETING_YMM4_DEMO_ALLOWED === 'true';
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS demo_runs (
  demo_run_id       TEXT PRIMARY KEY,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  evidence_status   TEXT,
  script_path       TEXT,
  render_status     TEXT,
  render_path       TEXT,
  youtube_video_id  TEXT,
  youtube_url       TEXT,
  privacy_status    TEXT,
  x_followup_status TEXT
);

CREATE TABLE IF NOT EXISTS render_lock (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  demo_run_id TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  started_at  TEXT NOT NULL
);
`;

// Columns added for productionization (transcode + review queue). Added via
// ALTER TABLE, not a DROP/CREATE — the table already holds real production
// history (this session's own verified video) that must never be lost.
const V2_COLUMNS = {
  title: 'TEXT',
  master_path: 'TEXT',
  master_sha256: 'TEXT',
  master_size: 'INTEGER',
  publication_path: 'TEXT',
  publication_sha256: 'TEXT',
  publication_size: 'INTEGER',
  transcode_ratio: 'REAL',
  thumbnail_path: 'TEXT',
  claims_json: 'TEXT',
  evidence_refs_json: 'TEXT',
  review_status: "TEXT NOT NULL DEFAULT 'PENDING'",
  reviewed_at: 'TEXT',
  public_url: 'TEXT',
  quality_check_status: 'TEXT',
  story_fingerprint: 'TEXT',
  source_event_ids: 'TEXT',
  source_fact_ids: 'TEXT',
  publication_duration: 'REAL',
};

const RENDER_STALE_MS = 60 * 60 * 1000; // a render lock older than this with a dead pid is recoverable

export function ensureVideoPipelineSchema(db) {
  db.exec(SCHEMA);
  const existingCols = new Set(db.prepare('PRAGMA table_info(demo_runs)').all().map((c) => c.name));
  for (const [name, type] of Object.entries(V2_COLUMNS)) {
    if (!existingCols.has(name)) {
      db.exec(`ALTER TABLE demo_runs ADD COLUMN ${name} ${type}`);
    }
  }
}

export function upsertDemoRun(db, demoRunId, fields) {
  ensureVideoPipelineSchema(db);
  const existing = db.prepare('SELECT * FROM demo_runs WHERE demo_run_id = ?').get(demoRunId);
  const now = new Date().toISOString();
  if (!existing) {
    db.prepare('INSERT INTO demo_runs (demo_run_id, created_at, updated_at) VALUES (?, ?, ?)').run(demoRunId, now, now);
  }
  const cols = Object.keys(fields);
  if (cols.length > 0) {
    const setClause = cols.map((c) => `${c} = ?`).join(', ');
    db.prepare(`UPDATE demo_runs SET updated_at = ?, ${setClause} WHERE demo_run_id = ?`).run(now, ...cols.map((c) => fields[c]), demoRunId);
  }
  return db.prepare('SELECT * FROM demo_runs WHERE demo_run_id = ?').get(demoRunId);
}

export function getDemoRun(db, demoRunId) {
  ensureVideoPipelineSchema(db);
  return db.prepare('SELECT * FROM demo_runs WHERE demo_run_id = ?').get(demoRunId);
}

export function latestDemoRun(db) {
  ensureVideoPipelineSchema(db);
  return db.prepare('SELECT * FROM demo_runs ORDER BY updated_at DESC LIMIT 1').get();
}

/** Same stale-lock-recovery pattern as lib/lock.mjs's operator lock, in its own table. */
export function acquireRenderLock(db, demoRunId) {
  ensureVideoPipelineSchema(db);
  const existing = db.prepare('SELECT * FROM render_lock WHERE id = 1').get();
  const now = new Date().toISOString();
  if (existing) {
    const age = Date.now() - Date.parse(existing.started_at);
    let alive = true;
    try { process.kill(existing.pid, 0); } catch { alive = false; }
    if (age <= RENDER_STALE_MS || alive) {
      return { acquired: false, reason: 'RENDER_IN_PROGRESS', holder: existing };
    }
    db.prepare('DELETE FROM render_lock WHERE id = 1').run();
  }
  db.prepare('INSERT INTO render_lock (id, demo_run_id, pid, started_at) VALUES (1, ?, ?, ?)').run(demoRunId, process.pid, now);
  return { acquired: true };
}

/**
 * Read-only render-lock status — same staleness rule as acquireRenderLock,
 * but never mutates the table (no delete of a stale row, no insert). Used
 * by status/readiness reporting, which must never have a side effect on the
 * real lock a render is (or isn't) using.
 */
export function isRenderLockAvailable(db) {
  ensureVideoPipelineSchema(db);
  const existing = db.prepare('SELECT * FROM render_lock WHERE id = 1').get();
  if (!existing) return true;
  const age = Date.now() - Date.parse(existing.started_at);
  let alive = true;
  try { process.kill(existing.pid, 0); } catch { alive = false; }
  return age > RENDER_STALE_MS && !alive;
}

export function releaseRenderLock(db, demoRunId) {
  const existing = db.prepare('SELECT * FROM render_lock WHERE id = 1').get();
  if (existing && existing.demo_run_id === demoRunId) {
    db.prepare('DELETE FROM render_lock WHERE id = 1').run();
    return true;
  }
  return false;
}

/**
 * Runs the pipeline as far as it can safely go. `env`/`fetchImpl`/
 * `execFileImpl` are injectable for tests. Only reached once a video
 * candidate has already passed the score threshold (mandate section 10 —
 * the daily scan/score stage never calls this), so this is the one place
 * self-recovery (mandate section 7) may safely launch YMM4: one bounded
 * ensureYmm4ForVideoJob() attempt, never a restart loop, never touching a
 * process it doesn't own or a forbidden (Noemora) project.
 */
export async function createVideo(db, demoRunId, { factIds = [], rawLogLines = [], screenshotPaths = [], facts, env = process.env, fetchImpl = fetch, execFileImpl, ymm4ReadyImpl } = {}) {
  ensureVideoPipelineSchema(db);
  const outDir = statePath('videos', demoRunId);
  mkdirSync(outDir, { recursive: true });

  const evidenceResult = buildPublicSafeBundle({ demoRunId, factIds, rawLogLines, screenshotPaths });
  if (!evidenceResult.ok) {
    upsertDemoRun(db, demoRunId, { evidence_status: evidenceResult.status });
    return { ok: false, stage: 'evidence', status: evidenceResult.status, reason: evidenceResult.reason, findings: evidenceResult.findings };
  }
  upsertDemoRun(db, demoRunId, { evidence_status: 'PUBLIC_SAFE' });

  const script = generateVideoScript(evidenceResult.bundle, facts ?? []);
  const scriptCheck = validateScript(script, evidenceResult.bundle);
  if (!scriptCheck.ok) {
    upsertDemoRun(db, demoRunId, { render_status: 'SCRIPT_INVALID' });
    return { ok: false, stage: 'script', status: 'SCRIPT_INVALID', violations: scriptCheck.violations };
  }
  const scriptPath = join(outDir, 'video_script.json');
  writeFileSync(scriptPath, JSON.stringify(script, null, 2));
  upsertDemoRun(db, demoRunId, { script_path: scriptPath });

  const lock = acquireRenderLock(db, demoRunId);
  if (!lock.acquired) {
    return { ok: false, stage: 'render', status: lock.reason, holder: lock.holder };
  }

  try {
    // MARKETING_YMM4_DEMO_ALLOWED is the master gate for ALL automated YMM4
    // interaction (see ymm4DemoAllowed()/canAutoEncode()) — not just the
    // final headless encode. When it's not true, this must never touch the
    // real Windows process/bridge at all (no process check, no auto-start
    // attempt), exactly as canAutoEncode() already refuses the encode step
    // itself. Checked BEFORE calling ymm4ReadyImpl so a test/caller that
    // hasn't authorized YMM4 interaction can never trigger one merely by
    // reaching this stage with a real candidate selected.
    if (!ymm4DemoAllowed(env)) {
      const packagePath = join(outDir, 'IMPORT_README.md');
      writeFileSync(packagePath, importReadyReadme(demoRunId, scriptPath, { status: 'YMM4_DEMO_NOT_ALLOWED', reason: 'MARKETING_YMM4_DEMO_ALLOWED is not true' }));
      upsertDemoRun(db, demoRunId, { render_status: 'YMM4_DEMO_NOT_ALLOWED' });
      return {
        ok: true, stage: 'render', status: 'YMM4_DEMO_NOT_ALLOWED',
        message: 'MARKETING_YMM4_DEMO_ALLOWED is not true — YMM4 is never checked/started while automated interaction is not authorized. Import-ready package written; see IMPORT_README.md for the manual step.',
        scriptPath, packagePath,
      };
    }

    // Lazy dynamic import: lib/ymm4Startup.mjs itself imports from this
    // module (isForbiddenProjectPath/MARKETING_PROJECT_ROOT) — a static
    // top-level import here would be circular. Resolved lazily at call
    // time, by which point both modules are fully loaded either way.
    const ready = ymm4ReadyImpl
      ? await ymm4ReadyImpl(db, { env, fetchImpl, execFileImpl })
      : await (await import('./ymm4Startup.mjs')).ensureYmm4ForVideoJob(db, { env, fetchImpl, execFileImpl });
    if (!ready.ok) {
      const packagePath = join(outDir, 'IMPORT_README.md');
      writeFileSync(packagePath, importReadyReadme(demoRunId, scriptPath, ready.detail ?? ready));
      upsertDemoRun(db, demoRunId, { render_status: ready.status ?? 'YMM4_BRIDGE_UNREACHABLE' });
      return {
        ok: true, stage: 'render', status: ready.status ?? 'YMM4_BRIDGE_UNREACHABLE',
        message: 'YMM4 is not available (checked, and one bounded safe auto-start/recovery attempt already made — see docs/marketing/YMM4_STARTUP_AUDIT.md). Import-ready package written; see IMPORT_README.md for the manual step.',
        scriptPath, packagePath, detail: ready.detail,
      };
    }

    // Bridge IS reachable: a human has opened YMM4 with the plugin active.
    // This function itself still only reports readiness — actually driving
    // assembly (clearing the timeline, inserting narration, saving to a
    // dedicated per-run path) is assembleProjectViaLiveBridge() below, kept
    // as a separate call so createVideo()'s existing contract/behavior is
    // unchanged for any caller relying on it exactly as before.
    upsertDemoRun(db, demoRunId, { render_status: 'BRIDGE_REACHABLE_READY_FOR_ASSEMBLY' });
    return {
      ok: true, stage: 'render', status: 'BRIDGE_REACHABLE_READY_FOR_ASSEMBLY',
      message: 'YMM4 bridge is reachable. Call assembleProjectViaLiveBridge() next to actually drive project assembly against a dedicated marketing project.',
      scriptPath, script,
    };
  } finally {
    releaseRenderLock(db, demoRunId);
  }
}

const YMM4_FPS = 60; // confirmed via GET /api/project/fps against the live project

/**
 * Drives actual project assembly against the live bridge: clears whatever
 * is currently on the timeline (so successive automatic runs never mix
 * different stories' content — mandate section 7: "do not reuse the
 * current canary project for future videos"), inserts this run's
 * narration, and saves to a NEW dedicated path. Never touches
 * NoemoraLive.ymmp or any path outside MARKETING_PROJECT_ROOT — callers
 * are expected to have already checked that via canAutoEncode()-style
 * validation of `projectPath`, but this function re-checks the forbidden
 * filename itself as a second, independent guard.
 */
export async function assembleProjectViaLiveBridge(script, projectPath, { env = process.env, fetchImpl = fetch } = {}) {
  // basename() from node:path is POSIX-mode by default on Linux, where a
  // literal backslash is not a separator — a raw Windows path would pass
  // through unsplit and this check would silently never match. Normalize
  // separators first (same fix already applied in canAutoEncode()).
  if (isForbiddenProjectPath(projectPath)) {
    return { ok: false, error: 'refusing to assemble into a forbidden project path (NoemoraLive.ymmp / Noemora / Noemora_mod_core reference)' };
  }

  const existing = await getItems({ env, fetchImpl });
  if (existing.ok && existing.items.length > 0) {
    const layers = [...new Set(existing.items.map((i) => i.layer))];
    const cleared = await deleteItemsOnLayers(layers, { env, fetchImpl });
    if (!cleared.ok) return { ok: false, stage: 'clear', error: cleared.message ?? cleared.errorClass };
  }

  const inserted = [];
  for (const line of script.lines) {
    const character = CHARACTER_NAME[line.speaker];
    if (!character) return { ok: false, stage: 'insert', error: `unknown speaker "${line.speaker}" has no CHARACTER_NAME mapping` };
    const frame = Math.round(line.start_hint * YMM4_FPS);
    const result = await addVoiceLine({ character, text: line.text, frame, layer: 0 }, { env, fetchImpl });
    if (!result.ok) return { ok: false, stage: 'insert', error: result.message ?? result.errorClass, insertedSoFar: inserted.length };
    inserted.push(result);
  }

  const saved = await saveProject(projectPath, { env, fetchImpl });
  if (!saved.ok) return { ok: false, stage: 'save', error: saved.message ?? saved.errorClass, insertedCount: inserted.length };

  return { ok: true, projectPath, insertedCount: inserted.length };
}

/**
 * Generates the X follow-up draft for a YouTube video — but ONLY once that
 * video is actually public (mandate section 20: "after a real YouTube video
 * becomes approved/public"), never for a private/unlisted upload. Returns
 * null (not a draft) if the precondition isn't met, rather than a draft
 * with a placeholder/fabricated URL.
 */
export function craftYoutubeCrossPost(demoRun, { siteUrl } = {}) {
  if (!demoRun?.youtube_video_id || !demoRun?.youtube_url) return null;
  if (demoRun.privacy_status !== 'public') return null;
  let text = `ECHO Agentに実際のタスクをやらせました。\n\n編集用に作ったデモではなく、実行ログ付きの実タスクです。\n\n▶ ${demoRun.youtube_url}`;
  if (siteUrl) {
    const utm = `utm_source=x&utm_medium=organic&utm_campaign=echo_agent_video_${demoRun.demo_run_id}&utm_content=youtube_public_followup`;
    const separator = siteUrl.includes('?') ? '&' : '?';
    text += `\n\n${siteUrl}${separator}${utm}`;
  }
  return { channel: 'x', text, factIds: [], claimStrength: 'neutral', actionType: 'x_video_followup' };
}

/**
 * Decision-only (no side effects, no locking): may `projectPath` be driven
 * through the recurring, unattended headless-encode path? Every condition
 * must independently hold — this exists specifically so the boundary
 * around what auto-encode is allowed to touch is one auditable function,
 * not scattered inline checks.
 */
export function canAutoEncode({ projectPath, demoAllowed, evidenceStatus, privacyGatePass, alreadyRendered, env = process.env }) {
  const reasons = [];
  const normalized = String(projectPath ?? '').replace(/\\/g, '/');
  if (!normalized.includes(`/${MARKETING_PROJECT_ROOT}/`) && !normalized.includes(`${MARKETING_PROJECT_ROOT}/`)) {
    reasons.push(`project path is not under ${MARKETING_PROJECT_ROOT}`);
  }
  if (isForbiddenProjectPath(projectPath)) {
    reasons.push('project path is a forbidden reference (NoemoraLive.ymmp / Noemora / Noemora_mod_core)');
  }
  if (!(demoAllowed ?? ymm4DemoAllowed(env))) {
    reasons.push('MARKETING_YMM4_DEMO_ALLOWED is not true');
  }
  if (evidenceStatus !== 'PUBLIC_SAFE') {
    reasons.push(`evidence status is ${evidenceStatus}, not PUBLIC_SAFE`);
  }
  if (!privacyGatePass) {
    reasons.push('privacy gate did not pass');
  }
  if (alreadyRendered) {
    reasons.push('a render already exists for this demo run — refusing to duplicate');
  }
  return { allowed: reasons.length === 0, reasons };
}

/**
 * Real ffmpeg frame grab (not a placeholder) from partway through the
 * publication copy — used for the review-queue thumbnail field.
 */
export async function generateThumbnail(videoPath, outPath, { atSeconds = 2, execFileImpl = execFileAsync } = {}) {
  if (existsSync(outPath)) return { ok: true, created: false, outPath };
  try {
    await execFileImpl('ffmpeg', ['-y', '-ss', String(atSeconds), '-i', videoPath, '-frames:v', '1', outPath]);
    return { ok: existsSync(outPath), created: true, outPath };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * Populates the review-queue-facing fields (title/claims/evidence refs) on
 * a demo_runs row from the fact registry, so `video approve` can show a
 * reviewer exactly what's being claimed and what backs it.
 */
export function populateReviewMetadata(db, demoRunId, { title, factIds = [], facts = [] }) {
  const claims = facts.filter((f) => factIds.includes(f.id)).map((f) => ({ factId: f.id, claim: f.CLAIM, status: f.STATUS }));
  return upsertDemoRun(db, demoRunId, {
    title: title ?? null,
    claims_json: JSON.stringify(claims),
    evidence_refs_json: JSON.stringify(factIds),
  });
}

export function reviewQueue(db) {
  ensureVideoPipelineSchema(db);
  return db.prepare('SELECT * FROM demo_runs WHERE youtube_video_id IS NOT NULL ORDER BY created_at DESC').all();
}

export function allDemoRuns(db) {
  ensureVideoPipelineSchema(db);
  return db.prepare('SELECT * FROM demo_runs ORDER BY created_at DESC').all();
}

/**
 * Preview-then-confirm approval (mandate section 5: "do not combine
 * accidental approval with generation"). Without `confirm: true` this only
 * returns what a reviewer would see — title, private URL, claims, evidence
 * — and makes no state change at all. Refuses outright if the video is not
 * (at least by our last recorded knowledge) private, since approving a
 * video that's already public for some other reason would defeat the point
 * of a pre-publish review gate.
 */
export function approveVideo(db, demoRunId, { confirm = false } = {}) {
  const row = getDemoRun(db, demoRunId);
  if (!row) return { ok: false, error: `unknown demo run: ${demoRunId}` };

  const preview = {
    demoRunId,
    title: row.title,
    privateUrl: row.youtube_url,
    recordedPrivacyStatus: row.privacy_status,
    claims: row.claims_json ? JSON.parse(row.claims_json) : [],
    evidenceRefs: row.evidence_refs_json ? JSON.parse(row.evidence_refs_json) : [],
    currentReviewStatus: row.review_status,
  };

  if (row.privacy_status !== 'private') {
    return { ok: false, error: `recorded privacy_status is "${row.privacy_status}", not "private" — refusing to approve`, preview };
  }
  if (!confirm) {
    return { ok: true, approved: false, preview, message: 'Preview only. Re-run with confirm: true (CLI: --confirm) to transition to APPROVED.' };
  }

  upsertDemoRun(db, demoRunId, { review_status: 'APPROVED', reviewed_at: new Date().toISOString() });
  return { ok: true, approved: true, preview };
}

export function rejectVideo(db, demoRunId, { status = 'REJECTED' } = {}) {
  if (status !== 'REJECTED' && status !== 'NEEDS_EDIT') {
    return { ok: false, error: 'status must be REJECTED or NEEDS_EDIT' };
  }
  const row = getDemoRun(db, demoRunId);
  if (!row) return { ok: false, error: `unknown demo run: ${demoRunId}` };
  upsertDemoRun(db, demoRunId, { review_status: status, reviewed_at: new Date().toISOString() });
  return { ok: true, reviewStatus: status };
}

/**
 * Decision-only gate for making a video public: APPROVED review state and a
 * real uploaded video are both required. Does not itself call any YouTube
 * API — the caller (CLI) does that only after this returns allowed:true,
 * using youtube.mjs's own separate confirmPublic requirement as a second,
 * independent check.
 */
// Paths confirmed working this session (see docs/marketing/YMM4_AUTOMATION_AUDIT.md
// and the authorized headless encode this pipeline already ran once
// manually) — overridable for tests, not meant to vary in real use.
export const DEFAULT_YMM4_EXE = 'C:\\Users\\Silver\\Apps\\YukkuriMovieMaker4\\YukkuriMovieMaker.exe';
const DEFAULT_RENDER_SCRIPT = 'C:\\Users\\Silver\\NoemoraYMMBridge\\ymm4_cli_render_worker_v1.ps1';

/**
 * The recurring, unattended path to a headless encode — gated by
 * canAutoEncode() (every condition must hold) and the same render lock
 * `createVideo()` uses, so an automatic call and a manual `video create`
 * call can never race each other. Reuses the EXACT verified mechanism
 * (ymm4_cli_render_worker_v1.ps1, Start-Process --encode) — never a new
 * render path invented for automation.
 *
 * MARKETING_YMM4_DEMO_ALLOWED defaults to false and is not flipped by any
 * code in this repository — enabling it is a deliberate, separate decision
 * from enabling YouTube uploads, since it lets FUTURE unattended runs
 * launch a real process on the operator's Windows desktop without a fresh
 * per-run human authorization, unlike every headless encode performed so
 * far in this project's history.
 */
export async function autoEncodeProject(db, demoRunId, {
  projectPath, outputDir, env = process.env, execFileImpl = execFileAsync,
  ymm4Exe = DEFAULT_YMM4_EXE, renderScript = DEFAULT_RENDER_SCRIPT,
} = {}) {
  ensureVideoPipelineSchema(db);
  const row = getDemoRun(db, demoRunId);
  const gate = canAutoEncode({
    projectPath,
    demoAllowed: ymm4DemoAllowed(env),
    evidenceStatus: row?.evidence_status,
    privacyGatePass: row?.evidence_status === 'PUBLIC_SAFE',
    alreadyRendered: !!row?.render_path,
    env,
  });
  if (!gate.allowed) {
    return { ok: false, stage: 'auto_encode_gate', reasons: gate.reasons };
  }

  const lock = acquireRenderLock(db, demoRunId);
  if (!lock.acquired) {
    return { ok: false, stage: 'render', status: lock.reason, holder: lock.holder };
  }

  try {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
    const outputFile = `${outputDir}\\marketing_${demoRunId}_${ts}.mp4`;
    const stdoutFile = `${outputDir}\\encode_stdout_${ts}.log`;
    const stderrFile = `${outputDir}\\encode_stderr_${ts}.log`;

    let exitCode;
    try {
      const result = await execFileImpl('powershell.exe', [
        '-NoProfile', '-File', renderScript,
        '-Exe', ymm4Exe, '-InputProject', projectPath, '-OutputFile', outputFile,
        '-StdoutFile', stdoutFile, '-StderrFile', stderrFile,
      ]);
      exitCode = result?.code ?? 0;
    } catch (err) {
      exitCode = err?.code ?? 1;
      upsertDemoRun(db, demoRunId, { render_status: `AUTO_ENCODE_FAILED: exit ${exitCode}: ${err?.message ?? err}` });
      return { ok: false, stage: 'render', exitCode, error: String(err?.message ?? err) };
    }

    upsertDemoRun(db, demoRunId, {
      render_status: `AUTO_ENCODE_PASS: exit ${exitCode}`,
      master_path: outputFile,
    });
    return { ok: true, stage: 'render', exitCode, outputFile, stdoutFile, stderrFile };
  } finally {
    releaseRenderLock(db, demoRunId);
  }
}

export function canPublishPublic(db, demoRunId) {
  const row = getDemoRun(db, demoRunId);
  if (!row) return { allowed: false, reason: `unknown demo run: ${demoRunId}` };
  if (row.review_status !== 'APPROVED') return { allowed: false, reason: `review_status is "${row.review_status}", not APPROVED`, row };
  if (!row.youtube_video_id) return { allowed: false, reason: 'no uploaded video on this demo run', row };
  if (row.privacy_status === 'public') return { allowed: false, reason: 'already public — refusing to re-publish', row };
  return { allowed: true, row };
}

/**
 * The recurring, automatic private-upload step (mandate section 10: "this
 * is now authorized automatically... Do NOT make the video: unlisted or
 * public without human approval"). Reuses the exact ledger idempotency
 * pattern canaryYoutube() already uses (recordIntent/markPublished/
 * markFailed) rather than inventing a second publication-tracking
 * mechanism, and hardcodes privacyStatus: 'private' — there is no
 * parameter to make this call upload anything else.
 */
export async function uploadPrivateVideo(db, demoRunId, { env = process.env, fetchImpl = fetch, readFileImpl, youtubeImpl = youtube } = {}) {
  ensureVideoPipelineSchema(db);
  const row = getDemoRun(db, demoRunId);
  if (!row) return { ok: false, stage: 'upload', error: `unknown demo run: ${demoRunId}` };
  if (!row.publication_path) return { ok: false, stage: 'upload', error: 'no publication_path recorded — run transcode first' };
  if (row.quality_check_status && !row.quality_check_status.startsWith('PASS')) {
    return { ok: false, stage: 'upload', error: `quality_check_status is "${row.quality_check_status}", not PASS — refusing to upload` };
  }
  if (row.youtube_video_id) {
    return { ok: true, stage: 'upload', alreadyUploaded: true, externalId: row.youtube_video_id, externalUrl: row.youtube_url };
  }

  const title = row.title ?? `Veritas Forge — ${demoRunId}`;
  const row2 = recordIntent(db, {
    channel: 'youtube', text: `${title}::${demoRunId}`, riskClass: 'AUTO', approvalState: 'AUTO_PRIVATE', contentType: 'demo_video',
  });
  const draft = {
    // row.publication_path is recorded Windows-style (human/Windows-side
    // reference) — translated here to the WSL POSIX path this process's own
    // readFile actually needs (see lib/winPath.mjs). toWslPath() passes an
    // already-POSIX path through unchanged, so this is safe for any caller.
    filePath: toWslPath(row.publication_path), title,
    description: 'Autonomous Veritas Forge marketing demo video. Uploaded PRIVATE pending human review.',
    privacyStatus: 'private',
  };
  const result = await youtubeImpl.publish(draft, { dryRun: false, env, fetchImpl, readFileImpl });
  if (!result.ok) {
    markFailed(db, row2.publication_id, result.error ?? 'unknown');
    return { ok: false, stage: 'upload', error: result.error ?? 'PUBLISH_FAILED' };
  }
  if (result.privacyStatus !== 'private') {
    markFailed(db, row2.publication_id, `upload response privacyStatus was "${result.privacyStatus}", not "private"`);
    return { ok: false, stage: 'upload', error: `refusing to record an upload whose reported privacyStatus is "${result.privacyStatus}", not "private"` };
  }
  markPublished(db, row2.publication_id, { externalId: result.externalId, externalUrl: result.externalUrl, result: 'AUTO_PRIVATE_UPLOAD_OK' });

  upsertDemoRun(db, demoRunId, {
    youtube_video_id: result.externalId, youtube_url: result.externalUrl, privacy_status: 'private',
  });
  return { ok: true, stage: 'upload', externalId: result.externalId, externalUrl: result.externalUrl, privacyStatus: 'private' };
}

function importReadyReadme(demoRunId, scriptPath, ymm4Detail) {
  const status = ymm4Detail?.status ?? ymm4Detail?.health?.status ?? 'UNKNOWN';
  const reason = ymm4Detail?.reason ?? ymm4Detail?.health?.reason ?? 'no further detail available';
  return `# Import-ready package — ${demoRunId}\n\n` +
    `YMM4 was not available for automatic rendering when this ran (status: ${status} — ${reason}).\n` +
    `A bounded safe auto-start/recovery attempt was already made (see docs/marketing/YMM4_STARTUP_AUDIT.md) and did not succeed — this pipeline never retries beyond that one attempt, and never touches a Noemora project or a process it doesn't own.\n\n` +
    `## Manual step required\n\n` +
    `1. Check YMM4 process/bridge state: node tools/marketing/cli.mjs ymm4 status\n` +
    `2. If needed, open YMM4 yourself with a DEDICATED marketing project (never NoemoraLive.ymmp), or let the Windows-login startup task do it.\n` +
    `3. Re-run: node tools/marketing/cli.mjs video create ${demoRunId}\n\n` +
    `Script for this run: ${scriptPath}\n`;
}
