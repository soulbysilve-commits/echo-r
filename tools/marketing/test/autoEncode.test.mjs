import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { autoEncodeProject, upsertDemoRun, acquireRenderLock, getDemoRun, MARKETING_PROJECT_ROOT } from '../lib/videoPipeline.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-autoencode-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

const PROJECT_PATH = `C:\\Users\\Silver\\${MARKETING_PROJECT_ROOT}\\marketing_canary.ymmp`;

test('autoEncodeProject refuses to run at all (never even acquires the lock or shells out) when MARKETING_YMM4_DEMO_ALLOWED is unset — the safe-by-default state', async () => {
  const { dir, db } = tempDb();
  try {
    upsertDemoRun(db, 'demo1', { evidence_status: 'PUBLIC_SAFE' });
    let called = false;
    const result = await autoEncodeProject(db, 'demo1', {
      projectPath: PROJECT_PATH, outputDir: 'C:\\out', env: {},
      execFileImpl: async () => { called = true; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'auto_encode_gate');
    assert.equal(called, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('autoEncodeProject refuses a Noemora project even with DEMO_ALLOWED=true', async () => {
  const { dir, db } = tempDb();
  try {
    upsertDemoRun(db, 'demo1', { evidence_status: 'PUBLIC_SAFE' });
    let called = false;
    const result = await autoEncodeProject(db, 'demo1', {
      projectPath: 'C:\\Users\\Silver\\NoemoraYMM4\\NoemoraLive.ymmp', outputDir: 'C:\\out',
      env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
      execFileImpl: async () => { called = true; },
    });
    assert.equal(result.ok, false);
    assert.equal(called, false, 'must never shell out for a Noemora project, no matter the flag');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('autoEncodeProject refuses when evidence is not PUBLIC_SAFE, even with DEMO_ALLOWED=true', async () => {
  const { dir, db } = tempDb();
  try {
    upsertDemoRun(db, 'demo1', { evidence_status: 'VIDEO_PUBLICATION_BLOCKED' });
    const result = await autoEncodeProject(db, 'demo1', {
      projectPath: PROJECT_PATH, outputDir: 'C:\\out', env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
      execFileImpl: async () => { throw new Error('should not be called'); },
    });
    assert.equal(result.ok, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('autoEncodeProject refuses a duplicate render for a demo run that already has one', async () => {
  const { dir, db } = tempDb();
  try {
    upsertDemoRun(db, 'demo1', { evidence_status: 'PUBLIC_SAFE', render_path: 'C:\\already\\rendered.mp4' });
    const result = await autoEncodeProject(db, 'demo1', {
      projectPath: PROJECT_PATH, outputDir: 'C:\\out', env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
      execFileImpl: async () => { throw new Error('should not be called'); },
    });
    assert.equal(result.ok, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('autoEncodeProject respects the render lock — refuses if a render is already in progress', async () => {
  const { dir, db } = tempDb();
  try {
    upsertDemoRun(db, 'demo1', { evidence_status: 'PUBLIC_SAFE' });
    acquireRenderLock(db, 'other-demo-run'); // simulate a render already in flight
    const result = await autoEncodeProject(db, 'demo1', {
      projectPath: PROJECT_PATH, outputDir: 'C:\\out', env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
      execFileImpl: async () => { throw new Error('should not be called'); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'render');
    assert.equal(result.status, 'RENDER_IN_PROGRESS');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('autoEncodeProject with everything allowed shells out exactly once via the existing verified script, and records the result', async () => {
  const { dir, db } = tempDb();
  try {
    upsertDemoRun(db, 'demo1', { evidence_status: 'PUBLIC_SAFE' });
    let capturedArgs;
    const result = await autoEncodeProject(db, 'demo1', {
      projectPath: PROJECT_PATH, outputDir: 'C:\\out', env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
      execFileImpl: async (cmd, args) => { capturedArgs = args; return { code: 0 }; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.ok(capturedArgs.includes('ymm4_cli_render_worker_v1.ps1'.replace(/^/, '')) || capturedArgs.some((a) => a.includes('ymm4_cli_render_worker_v1.ps1')));
    assert.ok(capturedArgs.includes(PROJECT_PATH));
    const row = getDemoRun(db, 'demo1');
    assert.ok(row.render_status.includes('AUTO_ENCODE_PASS'));
    assert.equal(row.master_path, result.outputFile);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('autoEncodeProject releases the render lock even when the encode process fails', async () => {
  const { dir, db } = tempDb();
  try {
    upsertDemoRun(db, 'demo1', { evidence_status: 'PUBLIC_SAFE' });
    const result = await autoEncodeProject(db, 'demo1', {
      projectPath: PROJECT_PATH, outputDir: 'C:\\out', env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
      execFileImpl: async () => { const e = new Error('encode failed'); e.code = 1; throw e; },
    });
    assert.equal(result.ok, false);
    const lockRow = db.prepare('SELECT * FROM render_lock WHERE id = 1').get();
    assert.equal(lockRow, undefined, 'lock must be released even on failure');
    const row = getDemoRun(db, 'demo1');
    assert.ok(row.render_status.includes('AUTO_ENCODE_FAILED'));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});
