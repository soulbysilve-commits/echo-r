import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import {
  createVideo, acquireRenderLock, releaseRenderLock, getDemoRun, upsertDemoRun, craftYoutubeCrossPost,
  assembleProjectViaLiveBridge, uploadPrivateVideo,
} from '../lib/videoPipeline.mjs';

const FACTS = [{ id: 'FACT-001', CLAIM: "ECHO Agent's verifier rejects a claimed success with no evidence." }];

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-video-test-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

test('createVideo blocks at the evidence stage if a log line fails the privacy scan', async () => {
  const { dir, db } = tempDb();
  try {
    const result = await createVideo(db, 'demo-blocked', {
      factIds: ['FACT-001'], facts: FACTS,
      rawLogLines: ['DEBUG: STRIPE_SECRET_KEY=sk_live_abc123def456ghi789'],
      fetchImpl: async () => { throw new Error('should not be called'); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'evidence');
    assert.equal(result.status, 'VIDEO_PUBLICATION_BLOCKED');
    const run = getDemoRun(db, 'demo-blocked');
    assert.equal(run.evidence_status, 'VIDEO_PUBLICATION_BLOCKED');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('createVideo with YMM4 unavailable writes an import-ready package and reports the manual step honestly (never fakes success, never touches the real desktop)', async () => {
  const { dir, db } = tempDb();
  try {
    // ymm4ReadyImpl injected directly (the same dependency-injection point
    // lib/ymm4Startup.mjs's real ensureYmm4ForVideoJob is normally reached
    // through) — this test must NEVER call real execFileImpl/powershell.exe,
    // which the default would do and could genuinely try to launch YMM4 on
    // the real Windows desktop.
    const ymm4ReadyImpl = async () => ({ ok: false, status: 'YMM4_UNAVAILABLE', detail: { status: 'NOT_RUNNING', reason: 'timed out' } });
    const result = await createVideo(db, 'demo-unreachable', {
      factIds: ['FACT-001'], facts: FACTS,
      rawLogLines: ['[00:02] GOAL ACCEPTED'],
      env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
      fetchImpl: async () => { throw new Error('should not be called — ymm4ReadyImpl is mocked'); },
      ymm4ReadyImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'YMM4_UNAVAILABLE');
    assert.ok(result.packagePath);
    assert.ok(result.scriptPath);
    const run = getDemoRun(db, 'demo-unreachable');
    assert.equal(run.render_status, 'YMM4_UNAVAILABLE');
    assert.equal(run.script_path, result.scriptPath);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('createVideo never checks/starts YMM4 at all when MARKETING_YMM4_DEMO_ALLOWED is not true — the master gate for ALL automated YMM4 interaction, not just the final encode', async () => {
  const { dir, db } = tempDb();
  try {
    let ymm4ReadyImplCalled = false;
    const result = await createVideo(db, 'demo-not-allowed', {
      factIds: ['FACT-001'], facts: FACTS,
      rawLogLines: ['[00:02] GOAL ACCEPTED'],
      env: {}, // MARKETING_YMM4_DEMO_ALLOWED unset
      fetchImpl: async () => { throw new Error('should not be called'); },
      ymm4ReadyImpl: async () => { ymm4ReadyImplCalled = true; return { ok: true, status: 'YMM4_READY' }; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'YMM4_DEMO_NOT_ALLOWED');
    assert.equal(ymm4ReadyImplCalled, false, 'the YMM4-ready check must never even run when demo-allowed is off');
    const run = getDemoRun(db, 'demo-not-allowed');
    assert.equal(run.render_status, 'YMM4_DEMO_NOT_ALLOWED');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('createVideo proceeds to render-ready state when YMM4 is ready', async () => {
  const { dir, db } = tempDb();
  try {
    const ymm4ReadyImpl = async () => ({ ok: true, status: 'YMM4_READY', detail: { status: 'HEALTHY' } });
    const result = await createVideo(db, 'demo-reachable', {
      factIds: ['FACT-001'], facts: FACTS,
      rawLogLines: ['[00:02] GOAL ACCEPTED'],
      env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
      fetchImpl: async () => { throw new Error('should not be called — ymm4ReadyImpl is mocked'); },
      ymm4ReadyImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'BRIDGE_REACHABLE_READY_FOR_ASSEMBLY');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('render lock prevents a second simultaneous render for a different demo run', () => {
  const { dir, db } = tempDb();
  try {
    const first = acquireRenderLock(db, 'demo-a');
    assert.equal(first.acquired, true);
    const second = acquireRenderLock(db, 'demo-b');
    assert.equal(second.acquired, false);
    assert.equal(second.reason, 'RENDER_IN_PROGRESS');
    releaseRenderLock(db, 'demo-a');
    const third = acquireRenderLock(db, 'demo-b');
    assert.equal(third.acquired, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('craftYoutubeCrossPost only fires once a video is actually public, never for private/unlisted', () => {
  assert.equal(craftYoutubeCrossPost(null), null);
  assert.equal(craftYoutubeCrossPost({ youtube_video_id: 'v1', youtube_url: 'https://youtu.be/v1', privacy_status: 'private' }), null);
  assert.equal(craftYoutubeCrossPost({ youtube_video_id: 'v1', youtube_url: 'https://youtu.be/v1', privacy_status: 'unlisted' }), null);
  const draft = craftYoutubeCrossPost({ youtube_video_id: 'v1', youtube_url: 'https://youtu.be/v1', privacy_status: 'public' });
  assert.ok(draft.text.includes('https://youtu.be/v1'));
  assert.equal(draft.actionType, 'x_video_followup');
});

test('createVideo releases the render lock even when the YMM4-ready check throws unexpectedly, so a later run is not blocked forever', async () => {
  const { dir, db } = tempDb();
  try {
    const ymm4ReadyImpl = async () => { throw new Error('down'); };
    await assert.rejects(() => createVideo(db, 'demo-x', {
      factIds: ['FACT-001'], facts: FACTS, rawLogLines: [],
      env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
      fetchImpl: async () => { throw new Error('should not be called'); }, ymm4ReadyImpl,
    }));
    const lockRow = db.prepare('SELECT * FROM render_lock WHERE id = 1').get();
    assert.equal(lockRow, undefined);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- assembleProjectViaLiveBridge ---

test('assembleProjectViaLiveBridge refuses to touch NoemoraLive.ymmp regardless of the given script', async () => {
  const result = await assembleProjectViaLiveBridge({ lines: [] }, 'C:\\Users\\Silver\\NoemoraLive.ymmp', { fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(result.ok, false);
  assert.match(result.error, /NoemoraLive/);
});

test('assembleProjectViaLiveBridge refuses a Noemora reference nested under VeritasForgeMarketing, not just the exact NoemoraLive.ymmp basename', async () => {
  const result = await assembleProjectViaLiveBridge(
    { lines: [] },
    'C:\\Users\\Silver\\VeritasForgeMarketing\\projects\\Noemora_mod_core\\evil.ymmp',
    { fetchImpl: async () => { throw new Error('must not be called'); } },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /[Nn]oemora/);
});

test('assembleProjectViaLiveBridge clears every occupied layer, inserts each line, and saves to the given path', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    if (url.endsWith('/api/items')) return { ok: true, status: 200, json: async () => ({ items: [{ layer: 0 }, { layer: 2 }], count: 2 }) };
    if (url.endsWith('/api/items/delete')) return { ok: true, status: 200, json: async () => ({ success: true, removed: 2 }) };
    if (url.endsWith('/api/items/voice')) return { ok: true, status: 200, json: async () => ({ success: true, character: opts && JSON.parse(opts.body).character, frame: 0, layer: 0, length: 10, endFrame: 10 }) };
    if (url.endsWith('/api/reflect/invoke')) return { ok: true, status: 200, json: async () => ({ success: true }) };
    throw new Error(`unexpected url: ${url}`);
  };
  const script = { lines: [
    { speaker: 'reimu', text: 'こんにちは', start_hint: 0 },
    { speaker: 'marisa', text: '次はこれだ', start_hint: 1.5 },
  ] };
  const result = await assembleProjectViaLiveBridge(script, 'C:\\Users\\Silver\\VeritasForgeMarketing\\projects\\demo1.ymmp', { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.insertedCount, 2);

  const deleteCall = calls.find((c) => c.url.endsWith('/api/items/delete'));
  assert.deepEqual(deleteCall.body.layers.sort(), [0, 2]);

  const voiceCalls = calls.filter((c) => c.url.endsWith('/api/items/voice'));
  assert.equal(voiceCalls.length, 2);
  assert.equal(voiceCalls[1].body.frame, 90); // 1.5s * 60fps

  const saveCall = calls.find((c) => c.url.endsWith('/api/reflect/invoke'));
  assert.deepEqual(saveCall.body.args, ['C:\\Users\\Silver\\VeritasForgeMarketing\\projects\\demo1.ymmp']);
});

test('assembleProjectViaLiveBridge fails clearly on an unknown speaker rather than inserting a wrong character', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/items')) return { ok: true, status: 200, json: async () => ({ items: [], count: 0 }) };
    throw new Error(`unexpected url: ${url}`);
  };
  const script = { lines: [{ speaker: 'nobody', text: 'x', start_hint: 0 }] };
  const result = await assembleProjectViaLiveBridge(script, 'C:\\Users\\Silver\\VeritasForgeMarketing\\projects\\demo1.ymmp', { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'insert');
});

// --- uploadPrivateVideo ---

test('uploadPrivateVideo refuses to upload when the quality check did not pass', async () => {
  const { dir, db } = tempDb();
  try {
    upsertDemoRun(db, 'demo-q', { publication_path: '/tmp/pub.mp4', quality_check_status: 'FAIL: something broken' });
    const result = await uploadPrivateVideo(db, 'demo-q', { fetchImpl: async () => { throw new Error('must not be called'); } });
    assert.equal(result.ok, false);
    assert.match(result.error, /quality_check_status/);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('uploadPrivateVideo uploads privately, records the ledger + demo_run, and is idempotent on re-run', async () => {
  const { dir, db } = tempDb();
  try {
    upsertDemoRun(db, 'demo-u', { publication_path: '/tmp/pub.mp4', quality_check_status: 'PASS (blackFraction=0.000)', title: 'A real demo' });
    let publishCalls = 0;
    const youtubeImpl = {
      publish: async () => { publishCalls += 1; return { ok: true, externalId: 'vid123', externalUrl: 'https://youtu.be/vid123', privacyStatus: 'private', title: 'A real demo' }; },
    };
    const first = await uploadPrivateVideo(db, 'demo-u', { youtubeImpl });
    assert.equal(first.ok, true);
    assert.equal(first.privacyStatus, 'private');
    const run = getDemoRun(db, 'demo-u');
    assert.equal(run.youtube_video_id, 'vid123');
    assert.equal(run.privacy_status, 'private');

    const second = await uploadPrivateVideo(db, 'demo-u', { youtubeImpl });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyUploaded, true);
    assert.equal(publishCalls, 1, 'must not upload twice');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('uploadPrivateVideo refuses to record success if the upload response reports a non-private privacyStatus', async () => {
  const { dir, db } = tempDb();
  try {
    upsertDemoRun(db, 'demo-bad', { publication_path: '/tmp/pub.mp4', quality_check_status: 'PASS', title: 'x' });
    const youtubeImpl = { publish: async () => ({ ok: true, externalId: 'v9', externalUrl: 'https://youtu.be/v9', privacyStatus: 'public', title: 'x' }) };
    const result = await uploadPrivateVideo(db, 'demo-bad', { youtubeImpl });
    assert.equal(result.ok, false);
    const run = getDemoRun(db, 'demo-bad');
    assert.equal(run.youtube_video_id, null);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});
