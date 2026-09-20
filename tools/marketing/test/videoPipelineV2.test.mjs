import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import {
  canAutoEncode, ymm4DemoAllowed, generateThumbnail, populateReviewMetadata,
  craftYoutubeCrossPost, getDemoRun, MARKETING_PROJECT_ROOT, isForbiddenProjectPath,
} from '../lib/videoPipeline.mjs';

const execFileAsync = promisify(execFile);

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-pipeline-v2-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

// --- isForbiddenProjectPath (YMM4 unattended-startup mandate section 9:
// "Before every write/render: reject paths containing: Noemora /
// NoemoraLive.ymmp / Noemora_mod_core") — the ONE shared check every
// write/render/process-launch call site reuses, tested directly here so
// every caller's coverage doesn't have to re-derive the same cases. ---

test('isForbiddenProjectPath rejects the exact NoemoraLive.ymmp basename', () => {
  assert.equal(isForbiddenProjectPath('C:\\Users\\Silver\\NoemoraYMM4\\NoemoraLive.ymmp'), true);
});

test('isForbiddenProjectPath rejects NoemoraLive.ymmp case-insensitively', () => {
  assert.equal(isForbiddenProjectPath('C:\\Users\\Silver\\NoemoraYMM4\\noemoralive.YMMP'.toUpperCase().replace('.YMMP', '.ymmp')), true);
  assert.equal(isForbiddenProjectPath('c:\\users\\silver\\noemoraymm4\\noemoralive.ymmp'), true);
});

test('isForbiddenProjectPath rejects any path merely containing "Noemora", not just the exact live project', () => {
  assert.equal(isForbiddenProjectPath('C:\\Users\\Silver\\VeritasForgeMarketing\\projects\\Noemora_mod_core\\x.ymmp'), true);
  assert.equal(isForbiddenProjectPath('C:\\Users\\Silver\\SomeNoemoraBackup\\project.ymmp'), true);
});

test('isForbiddenProjectPath rejects "Noemora_mod_core" explicitly (it is a substring of the general pattern, confirmed directly)', () => {
  assert.equal(isForbiddenProjectPath('C:\\Users\\Silver\\Noemora_mod_core\\evidence.ymmp'), true);
});

test('isForbiddenProjectPath allows a real marketing project path', () => {
  assert.equal(isForbiddenProjectPath('C:\\Users\\Silver\\VeritasForgeMarketing\\marketing_idle.ymmp'), false);
});

test('isForbiddenProjectPath treats null/undefined/empty as not-forbidden (callers must still separately require a valid marketing-root path)', () => {
  assert.equal(isForbiddenProjectPath(null), false);
  assert.equal(isForbiddenProjectPath(undefined), false);
  assert.equal(isForbiddenProjectPath(''), false);
});

// --- ymm4DemoAllowed ---

test('ymm4DemoAllowed defaults to false (fail closed)', () => {
  assert.equal(ymm4DemoAllowed({}), false);
  assert.equal(ymm4DemoAllowed({ MARKETING_YMM4_DEMO_ALLOWED: 'true' }), true);
  assert.equal(ymm4DemoAllowed({ MARKETING_YMM4_DEMO_ALLOWED: 'yes' }), false);
});

// --- canAutoEncode ---

const GOOD = {
  projectPath: `C:\\Users\\Silver\\${MARKETING_PROJECT_ROOT}\\marketing_canary.ymmp`,
  demoAllowed: true, evidenceStatus: 'PUBLIC_SAFE', privacyGatePass: true, alreadyRendered: false,
};

test('canAutoEncode allows when every condition holds', () => {
  const result = canAutoEncode(GOOD);
  assert.equal(result.allowed, true, JSON.stringify(result.reasons));
});

test('canAutoEncode refuses a project outside VeritasForgeMarketing', () => {
  const result = canAutoEncode({ ...GOOD, projectPath: 'C:\\Users\\Silver\\SomewhereElse\\project.ymmp' });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.includes('VeritasForgeMarketing')));
});

test('canAutoEncode refuses NoemoraLive.ymmp explicitly, even hypothetically placed under the marketing root', () => {
  const result = canAutoEncode({ ...GOOD, projectPath: `C:\\Users\\Silver\\${MARKETING_PROJECT_ROOT}\\NoemoraLive.ymmp` });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.includes('NoemoraLive')));
});

test('canAutoEncode refuses when DEMO_ALLOWED is not true', () => {
  const result = canAutoEncode({ ...GOOD, demoAllowed: false });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.includes('MARKETING_YMM4_DEMO_ALLOWED')));
});

test('canAutoEncode refuses when evidence is not PUBLIC_SAFE', () => {
  const result = canAutoEncode({ ...GOOD, evidenceStatus: 'VIDEO_PUBLICATION_BLOCKED' });
  assert.equal(result.allowed, false);
});

test('canAutoEncode refuses when the privacy gate has not passed', () => {
  const result = canAutoEncode({ ...GOOD, privacyGatePass: false });
  assert.equal(result.allowed, false);
});

test('canAutoEncode refuses a duplicate render for the same demo run', () => {
  const result = canAutoEncode({ ...GOOD, alreadyRendered: true });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.includes('duplicate')));
});

test('canAutoEncode refuses a Noemora reference nested inside VeritasForgeMarketing, not just the exact NoemoraLive.ymmp basename (mandate section 14 hard-deny)', () => {
  const result = canAutoEncode({ ...GOOD, projectPath: `C:\\Users\\Silver\\${MARKETING_PROJECT_ROOT}\\projects\\Noemora_mod_core\\evil.ymmp` });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.toLowerCase().includes('noemora')));
});

test('canAutoEncode refuses any case variant of "noemora" anywhere in the path', () => {
  const result = canAutoEncode({ ...GOOD, projectPath: `C:\\Users\\Silver\\${MARKETING_PROJECT_ROOT}\\projects\\NOEMORA_backup\\x.ymmp` });
  assert.equal(result.allowed, false);
});

test('canAutoEncode accumulates ALL failing reasons, not just the first', () => {
  const result = canAutoEncode({ projectPath: 'C:\\wrong\\path.ymmp', demoAllowed: false, evidenceStatus: 'BLOCKED', privacyGatePass: false, alreadyRendered: true });
  assert.equal(result.allowed, false);
  assert.equal(result.reasons.length, 5);
});

// --- generateThumbnail (real ffmpeg) ---

test('generateThumbnail extracts a real frame from a real video', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-thumb-'));
  try {
    const videoPath = join(dir, 'video.mp4');
    await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2', videoPath]);
    const thumbPath = join(dir, 'thumb.jpg');
    const result = await generateThumbnail(videoPath, thumbPath, { atSeconds: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.ok(existsSync(thumbPath));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, { timeout: 30000 });

test('generateThumbnail does not regenerate an already-existing thumbnail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-thumb-'));
  try {
    const videoPath = join(dir, 'video.mp4');
    // atSeconds must be within the video's duration, or the frame grab
    // silently produces nothing — a real gotcha this test caught once already.
    await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2', videoPath]);
    const thumbPath = join(dir, 'thumb.jpg');
    const first = await generateThumbnail(videoPath, thumbPath, { atSeconds: 1 });
    assert.equal(first.ok, true);
    assert.ok(existsSync(thumbPath));

    let called = false;
    const second = await generateThumbnail(videoPath, thumbPath, { atSeconds: 1, execFileImpl: async () => { called = true; } });
    assert.equal(second.created, false);
    assert.equal(called, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, { timeout: 30000 });

// --- populateReviewMetadata ---

test('populateReviewMetadata records only claims for fact ids actually referenced by this demo run', () => {
  const { dir, db } = tempDb();
  try {
    const facts = [
      { id: 'FACT-001', CLAIM: 'claim one', STATUS: 'VERIFIED' },
      { id: 'FACT-002', CLAIM: 'claim two', STATUS: 'PARTIAL' },
      { id: 'FACT-003', CLAIM: 'unrelated claim', STATUS: 'VERIFIED' },
    ];
    populateReviewMetadata(db, 'demo1', { title: 'Test Video', factIds: ['FACT-001', 'FACT-002'], facts });
    const row = getDemoRun(db, 'demo1');
    assert.equal(row.title, 'Test Video');
    assert.equal(row.review_status, 'PENDING');
    const claims = JSON.parse(row.claims_json);
    assert.equal(claims.length, 2);
    assert.deepEqual(JSON.parse(row.evidence_refs_json), ['FACT-001', 'FACT-002']);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- craftYoutubeCrossPost with UTM ---

test('craftYoutubeCrossPost appends a UTM-tagged site link when provided', () => {
  const demoRun = { demo_run_id: 'demo1', youtube_video_id: 'v1', youtube_url: 'https://youtu.be/v1', privacy_status: 'public' };
  const draft = craftYoutubeCrossPost(demoRun, { siteUrl: 'https://echo-r.veritasforge.net/echo-agent' });
  assert.ok(draft.text.includes('utm_source=x'));
  assert.ok(draft.text.includes('utm_campaign=echo_agent_video_demo1'));
  assert.ok(draft.text.includes('https://youtu.be/v1'));
});

test('craftYoutubeCrossPost still works without a siteUrl (backward compatible)', () => {
  const demoRun = { demo_run_id: 'demo1', youtube_video_id: 'v1', youtube_url: 'https://youtu.be/v1', privacy_status: 'public' };
  const draft = craftYoutubeCrossPost(demoRun);
  assert.ok(!draft.text.includes('utm_source'));
});
