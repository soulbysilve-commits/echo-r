import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { ingestEvent } from '../lib/events.mjs';
import { getDemoRun, upsertDemoRun } from '../lib/videoPipeline.mjs';
import { runAutomaticVideoPipeline, runDailyVideoStage, autoVideosToday } from '../lib/videoAutomation.mjs';
import { toWslPath } from '../lib/winPath.mjs';

const execFileAsync = promisify(execFile);

const FACTS = [
  { id: 'FACT-009', CLAIM: 'ECHO Agent gates sensitive actions based on an identity-continuity signal, recomputed from on-disk evidence.', STATUS: 'VERIFIED' },
];

const FULL_ARC_LINES = [
  '[00:02] GOAL ACCEPTED',
  '[00:06] PLAN CREATED — 5 STEPS',
  '[00:31] STEP 3 FAILED',
  '[00:32] VERIFIER — REJECT',
  '[00:34] CHECKPOINT AVAILABLE',
  '[00:55] RETRY',
  '[01:20] STEP 3 PASS',
  '[01:22] VERIFIER — PASS',
];

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-automation-test-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

// Every test below that needs to get PAST createVideo()'s YMM4-ready check
// injects ymm4ReadyImpl directly — the same dependency-injection point
// lib/ymm4Startup.mjs's real ensureYmm4ForVideoJob is normally reached
// through — so it NEVER falls through to the real default (real
// execFileImpl/powershell.exe process checks, which could attempt a real
// Start-Process on the actual Windows desktop) and never cross-contaminates
// with an execFileImpl mock that's scoped to the render-encode call only.
function ymm4ReadyMock() {
  return async () => ({ ok: true, status: 'YMM4_READY', detail: { status: 'HEALTHY' } });
}
function ymm4NotReadyMock(status = 'YMM4_UNAVAILABLE', detail = { status: 'NOT_RUNNING', reason: 'test: not ready' }) {
  return async () => ({ ok: false, status, detail });
}

function bridgeFetchImpl() {
  return async (url, opts) => {
    if (url.endsWith('/api/status')) return { ok: true, status: 200, json: async () => ({ version: '1.0' }) };
    if (url.endsWith('/api/items')) return { ok: true, status: 200, json: async () => ({ items: [], count: 0 }) };
    if (url.endsWith('/api/items/voice')) {
      const body = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ success: true, character: body.character, frame: body.frame, layer: body.layer, length: 10, endFrame: body.frame + 10 }) };
    }
    if (url.endsWith('/api/reflect/invoke')) return { ok: true, status: 200, json: async () => ({ success: true }) };
    throw new Error(`unexpected bridge url in test: ${url}`);
  };
}

test('runAutomaticVideoPipeline returns NO_VIDEO (correctly, not a failure) when nothing qualifies', async () => {
  const { dir, db } = tempDb();
  try {
    const result = await runAutomaticVideoPipeline(db, { facts: FACTS });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'NO_VIDEO');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('runAutomaticVideoPipeline stops honestly at YMM4_UNAVAILABLE without faking a render', async () => {
  const { dir, db } = tempDb();
  try {
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e1', payload: { rawLogLines: FULL_ARC_LINES, factIds: ['FACT-009'] } });
    const result = await runAutomaticVideoPipeline(db, {
      facts: FACTS,
      env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
      fetchImpl: async () => { throw new Error('should not be called — ymm4ReadyImpl is mocked'); },
      ymm4ReadyImpl: ymm4NotReadyMock(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'YMM4_UNAVAILABLE');
    assert.ok(result.demoRunId);
    const row = getDemoRun(db, result.demoRunId);
    assert.equal(row.story_fingerprint.length, 64);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('runAutomaticVideoPipeline stops at YMM4_DEMO_NOT_ALLOWED when MARKETING_YMM4_DEMO_ALLOWED is not true, never checking/starting YMM4 or launching a process at all', async () => {
  const { dir, db } = tempDb();
  try {
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e1', payload: { rawLogLines: FULL_ARC_LINES, factIds: ['FACT-009'] } });
    let execCalled = false;
    let ymm4ReadyCalled = false;
    const result = await runAutomaticVideoPipeline(db, {
      facts: FACTS,
      env: {}, // MARKETING_YMM4_DEMO_ALLOWED unset -> the master gate must refuse, before even checking YMM4
      fetchImpl: bridgeFetchImpl(),
      ymm4ReadyImpl: async () => { ymm4ReadyCalled = true; return { ok: true, status: 'YMM4_READY' }; },
      execFileImpl: async () => { execCalled = true; return { code: 0 }; },
    });
    assert.equal(result.ok, true, 'YMM4_DEMO_NOT_ALLOWED is a correct, honest stop, not a failure');
    assert.equal(result.status, 'YMM4_DEMO_NOT_ALLOWED');
    assert.equal(ymm4ReadyCalled, false, 'must never even check YMM4 readiness when the demo-allowed gate is closed');
    assert.equal(execCalled, false, 'must never launch the encode process when the demo-allowed gate is closed');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('runAutomaticVideoPipeline proceeds through assembly + encode when authorized, then stops honestly at TRANSCODE_FAILED for a nonexistent master file (never fakes a transcode)', async () => {
  const { dir, db } = tempDb();
  try {
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e1', payload: { rawLogLines: FULL_ARC_LINES, factIds: ['FACT-009'] } });
    let encodeCalls = 0;
    const result = await runAutomaticVideoPipeline(db, {
      facts: FACTS,
      env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
      fetchImpl: bridgeFetchImpl(),
      ymm4ReadyImpl: ymm4ReadyMock(),
      execFileImpl: async (cmd) => {
        if (cmd === 'powershell.exe') { encodeCalls += 1; return { code: 0 }; }
        throw new Error(`unexpected exec in test: ${cmd}`);
      },
    });
    assert.equal(encodeCalls, 1, 'exactly one encode process must be launched');
    assert.equal(result.ok, false);
    assert.equal(result.status, 'TRANSCODE_FAILED');
    assert.match(result.detail.error, /master file not found/);

    const row = getDemoRun(db, result.demoRunId);
    assert.match(row.render_status, /AUTO_ENCODE_PASS/);
    assert.ok(row.master_path.includes(result.demoRunId));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- MAX_AUTO_VIDEOS_PER_DAY (runDailyVideoStage) ---

test('autoVideosToday counts only demo runs that actually reached a private upload today', () => {
  const { dir, db } = tempDb();
  try {
    assert.equal(autoVideosToday(db), 0);
    upsertDemoRun(db, 'd1', { youtube_video_id: 'v1', privacy_status: 'private' });
    assert.equal(autoVideosToday(db), 1);
    // A run that never got as far as an upload must not count.
    upsertDemoRun(db, 'd2', { render_status: 'AUTO_ENCODE_PASS' });
    assert.equal(autoVideosToday(db), 1);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('runDailyVideoStage refuses to even attempt selection once MAX_AUTO_VIDEOS_PER_DAY is reached, leaving the event unconsumed for tomorrow', async () => {
  const { dir, db } = tempDb();
  try {
    upsertDemoRun(db, 'already-today', { youtube_video_id: 'v1', privacy_status: 'private' });
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e1', payload: { rawLogLines: FULL_ARC_LINES, factIds: ['FACT-009'] } });

    const result = await runDailyVideoStage(db, {
      facts: FACTS, env: { MARKETING_MAX_AUTO_VIDEOS_PER_DAY: '1' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'DAILY_VIDEO_CAP_REACHED');
    assert.equal(result.autoVideosToday, 1);
    assert.equal(result.cap, 1);

    const stillUnprocessed = db.prepare('SELECT COUNT(*) c FROM marketing_events WHERE processed_at IS NULL').get().c;
    assert.equal(stillUnprocessed, 1, 'the cap must be checked BEFORE selection consumes the candidate event');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('runDailyVideoStage proceeds normally (NO_VIDEO, correctly) when under the daily cap', async () => {
  const { dir, db } = tempDb();
  try {
    const result = await runDailyVideoStage(db, { facts: FACTS, env: { MARKETING_MAX_AUTO_VIDEOS_PER_DAY: '1' } });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'NO_VIDEO');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- disk guard (SKIP_VIDEO_LOW_DISK) ---

test('runAutomaticVideoPipeline stops honestly at SKIP_VIDEO_LOW_DISK and never launches the encode process when the disk guard fails', async () => {
  const { dir, db } = tempDb();
  try {
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e1', payload: { rawLogLines: FULL_ARC_LINES, factIds: ['FACT-009'] } });
    let execCalled = false;
    const result = await runAutomaticVideoPipeline(db, {
      facts: FACTS,
      // An unreachably high MIN_FREE_DISK_SPACE_BYTES forces the guard to fail
      // even though real disk space is plentiful — deterministic without
      // needing to actually fill a disk.
      env: { MARKETING_YMM4_DEMO_ALLOWED: 'true', MARKETING_MIN_FREE_DISK_SPACE_BYTES: String(Number.MAX_SAFE_INTEGER) },
      fetchImpl: bridgeFetchImpl(),
      ymm4ReadyImpl: ymm4ReadyMock(),
      execFileImpl: async () => { execCalled = true; return { code: 0 }; },
    });
    assert.equal(result.ok, true, 'SKIP_VIDEO_LOW_DISK is a correct, safe stop — not a failure');
    assert.equal(result.status, 'SKIP_VIDEO_LOW_DISK');
    assert.equal(execCalled, false, 'must never launch the encode process once the disk guard fails');
    assert.equal(result.diskGuard.ok, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- real end-to-end success path (WSL path-translation regression) ---

async function makeRealVideo(path, { seconds = 3 } = {}) {
  // testsrc (a moving test pattern), not a solid color: a solid-color
  // source compresses to near-nothing at the publication stage's CRF 20
  // 1080p re-encode and can trip the quality gate's "abnormally small"
  // check — matching the pattern already proven to pass in
  // test/videoQuality.test.mjs's "passes a normal, valid video" case.
  await execFileAsync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', path,
  ]);
}

test('runAutomaticVideoPipeline reaches PRIVATE_VIDEO_READY_FOR_REVIEW end-to-end against REAL ffmpeg/ffprobe, proving Windows-style render paths are correctly translated for every Linux-side stage (transcode, verify, quality gate, thumbnail, upload read)', async () => {
  const { dir, db } = tempDb();
  // Nested under the real, already-confirmed-writable VeritasForgeMarketing
  // directory on the actual Windows C: drive (via its WSL /mnt/c mount) so
  // the Windows-style outputDir this test passes in round-trips through
  // toWslPath() to a real, writable location — the same real disk
  // autoEncodeProject's real render output uses.
  const winDirBase = '/mnt/c/Users/Silver/VeritasForgeMarketing';
  const winDir = mkdtempSync(join(winDirBase, 'test_e2e-'));
  try {
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e1', payload: { rawLogLines: FULL_ARC_LINES, factIds: ['FACT-009'] } });

    // Simulate autoEncodeProject's real effect (a real master file written
    // at a WINDOWS-STYLE path) without actually invoking powershell.exe —
    // by writing the file at the WSL-mounted location that a literal
    // "C:\..." path (constructed the same way autoEncodeProject builds it)
    // would translate to, then handing that same Windows-style string
    // through the pipeline exactly as autoEncodeProject would return it.
    let capturedOutputFile;
    const execFileImpl = async (cmd, args) => {
      if (cmd === 'powershell.exe') {
        const outputFileArg = args[args.indexOf('-OutputFile') + 1];
        capturedOutputFile = outputFileArg;
        await makeRealVideo(toWslPath(outputFileArg), { seconds: 5 });
        return { code: 0 };
      }
      // ffmpeg/ffprobe (transcode, verify, quality gate, thumbnail) fall
      // through to the REAL binaries — this is the point of the test.
      return execFileAsync(cmd, args);
    };

    let publishedDraft;
    const youtubeImpl = {
      publish: async (draft) => {
        publishedDraft = draft;
        // Prove the upload stage actually reads a real, existing POSIX file.
        assert.ok(existsSync(draft.filePath), `upload draft.filePath must exist on disk: ${draft.filePath}`);
        return { ok: true, externalId: 'e2e-vid-1', externalUrl: 'https://youtu.be/e2e-vid-1', privacyStatus: 'private' };
      },
    };

    const result = await runAutomaticVideoPipeline(db, {
      facts: FACTS,
      env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
      fetchImpl: bridgeFetchImpl(),
      ymm4ReadyImpl: ymm4ReadyMock(),
      execFileImpl,
      youtubeImpl,
      outputDir: toWinDir(winDir),
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, 'PRIVATE_VIDEO_READY_FOR_REVIEW');
    assert.equal(result.youtubeVideoId, 'e2e-vid-1');
    assert.ok(capturedOutputFile.startsWith(toWinDir(winDir)));
    assert.ok(publishedDraft);

    const row = getDemoRun(db, result.demoRunId);
    assert.match(row.master_path, /^[A-Za-z]:\\/, 'master_path recorded in the DB must stay Windows-style (human/Windows-side reference)');
    assert.match(row.publication_path, /^[A-Za-z]:\\/, 'publication_path recorded in the DB must stay Windows-style');
    assert.ok(row.quality_check_status.startsWith('PASS'));
    assert.ok(typeof row.publication_duration === 'number' && row.publication_duration > 0, 'real ffprobe duration must be persisted');
    assert.ok(row.thumbnail_path && existsSync(row.thumbnail_path), 'a real thumbnail must be generated and its path recorded');

    // Review notification (mandate section 15).
    assert.ok(result.notification?.path && existsSync(result.notification.path));
    const notificationText = readFileSync(result.notification.path, 'utf8');
    assert.match(notificationText, /VIDEO_READY_FOR_REVIEW/);
    assert.match(notificationText, /Private URL: https:\/\/youtu\.be\/e2e-vid-1/);
    assert.match(notificationText, new RegExp(`Demo Run ID: ${result.demoRunId}`));
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(winDir, { recursive: true, force: true });
  }
});

// Builds a fake-but-plausible "C:\...\<tmpdir-tail>" string whose
// toWslPath() translation is the REAL temp directory on this machine, so
// the test writes/reads real files without needing an actual Windows C:
// drive segment beyond what toWslPath() already assumes (/mnt/c/...).
// Reuses the real /mnt/c mount (confirmed present in this environment) by
// nesting the temp dir under it instead of faking the translation.
function toWinDir(posixDir) {
  // posixDir looks like /tmp/marketing-e2e-win-XXXXXX — not under /mnt/c, so
  // build the matching "C:\..." form the OTHER way: create the temp dir
  // under /mnt/c to begin with, then this is just the reverse mapping.
  const m = /^\/mnt\/([a-z])\/(.*)$/.exec(posixDir);
  if (!m) throw new Error(`test setup error: expected winDir under /mnt/<drive>, got ${posixDir}`);
  const [, drive, rest] = m;
  return `${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`;
}
