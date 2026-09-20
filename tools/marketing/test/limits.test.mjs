import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS, withTimeout, isNestedInvocation, checkDiskGuard, getLimits, RunDurationExceededError } from '../lib/limits.mjs';
import { runOnce } from '../operator.mjs';
import { normalizeChannelEnableFlags, withIsolatedLiveEnv } from './testEnvIsolation.mjs';

// See test/operator.test.mjs for why — keeps runOnce()'s source-scan stage
// from touching the real product repos during this file's tests.
process.env.ECHO_AGENT_REPO_ROOT = '/nonexistent/marketing-test-stub/echo-agent';
process.env.ECHO_APP_REPO_ROOT = '/nonexistent/marketing-test-stub/echo-app';
process.env.NOEMORA_REPO_ROOT = '/nonexistent/marketing-test-stub/noemora';
process.env.OFFICIAL_SITE_REPO_ROOT = '/nonexistent/marketing-test-stub/official-site';
process.env.ECHO_AGENT_DEV_ROOT = '/nonexistent/marketing-test-stub/echo-agent-dev';
process.env.ECHO_APP_DEV_ROOT = '/nonexistent/marketing-test-stub/echo-app-dev';
process.env.NOEMORA_DEV_ROOT = '/nonexistent/marketing-test-stub/noemora-dev';
process.env.OFFICIAL_SITE_DEV_ROOT = '/nonexistent/marketing-test-stub/official-site-dev';

// Same reasoning as operator.test.mjs (see testEnvIsolation.mjs): normalize
// per-channel enable flags once so the ambient shell's real
// MARKETING_<CHANNEL>_ENABLED=true can't affect this file's runOnce() calls.
normalizeChannelEnableFlags();

test('isNestedInvocation reflects MARKETING_OPERATOR_RUNNING', () => {
  assert.equal(isNestedInvocation({}), false);
  assert.equal(isNestedInvocation({ MARKETING_OPERATOR_RUNNING: '1' }), true);
  assert.equal(isNestedInvocation({ MARKETING_OPERATOR_RUNNING: '0' }), false);
});

test('withTimeout rejects and is classified once the bound elapses', async () => {
  const slow = new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(() => withTimeout(slow, 20, 'test-op'), /RunDurationExceededError|exceeded MAX_RUN_DURATION_MS/);
});

test('withTimeout resolves normally when the promise finishes first', async () => {
  const fast = Promise.resolve('done');
  const result = await withTimeout(fast, 1000, 'test-op');
  assert.equal(result, 'done');
});

test('runOnce refuses to run when MARKETING_OPERATOR_RUNNING=1 (recursion guard)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-limits-test-'));
  try {
    const prev = process.env.MARKETING_OPERATOR_RUNNING;
    process.env.MARKETING_OPERATOR_RUNNING = '1';
    // Deterministic + no real network regardless of ambient shell state,
    // even though the recursion guard itself fires before any mode check.
    const result = await withIsolatedLiveEnv(() => runOnce({ dbPath: join(dir, 'x.db'), factsPath: join(dir, 'f.md') }));
    assert.equal(result.status, 'RECURSION_BLOCKED');
    if (prev === undefined) delete process.env.MARKETING_OPERATOR_RUNNING;
    else process.env.MARKETING_OPERATOR_RUNNING = prev;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LIMITS default to conservative, documented values', () => {
  assert.equal(LIMITS.MAX_STORIES_PER_RUN, 1);
  assert.equal(LIMITS.MAX_DRAFTS_PER_RUN, 1);
  assert.ok(LIMITS.MAX_EXTERNAL_POSTS_PER_DAY > 0);
  assert.ok(LIMITS.MAX_RUN_DURATION_MS > 0);
});

test('video pipeline resource-guard limits default to conservative, documented values', () => {
  const limits = getLimits({});
  assert.equal(limits.MAX_AUTO_VIDEOS_PER_DAY, 1);
  assert.ok(limits.MAX_VIDEO_PIPELINE_RUNTIME_MS > 0);
  assert.ok(limits.MAX_RENDER_RUNTIME_MS > 0);
  assert.ok(limits.MAX_MASTER_DISK_USAGE_BYTES > 0);
  assert.ok(limits.MIN_FREE_DISK_SPACE_BYTES > 0);
});

test('every video limit is overridable via its env var', () => {
  const limits = getLimits({
    MARKETING_MAX_AUTO_VIDEOS_PER_DAY: '3',
    MARKETING_MIN_FREE_DISK_SPACE_BYTES: '12345',
  });
  assert.equal(limits.MAX_AUTO_VIDEOS_PER_DAY, 3);
  assert.equal(limits.MIN_FREE_DISK_SPACE_BYTES, 12345);
});

test('RunDurationExceededError carries its own .name (a bare class extends Error does NOT get this for free)', () => {
  const err = new RunDurationExceededError('x');
  assert.equal(err.name, 'RunDurationExceededError');
  assert.ok(err instanceof RunDurationExceededError);
  assert.ok(err instanceof Error);
});

test('checkDiskGuard passes for a real path with real free space (this repo\'s own tmp filesystem)', () => {
  const result = checkDiskGuard('/tmp', { MARKETING_MIN_FREE_DISK_SPACE_BYTES: '1' });
  assert.equal(result.ok, true);
  assert.ok(result.freeBytes > 0);
});

test('checkDiskGuard fails closed (never "plenty of space") for a path that cannot be statted', () => {
  const result = checkDiskGuard('/definitely/does/not/exist/at/all', {});
  assert.equal(result.ok, false);
  assert.equal(result.freeBytes, null);
  assert.match(result.reason, /SKIP_VIDEO_LOW_DISK/);
});

test('checkDiskGuard reports SKIP_VIDEO_LOW_DISK when MIN_FREE_DISK_SPACE_BYTES is set absurdly high', () => {
  const result = checkDiskGuard('/tmp', { MARKETING_MIN_FREE_DISK_SPACE_BYTES: String(Number.MAX_SAFE_INTEGER) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /SKIP_VIDEO_LOW_DISK/);
});

const VERIFIED_FACT = `
## FACT-001
PRODUCT: ECHO Agent
STATUS: VERIFIED
CLAIM: test claim one.
SOURCE_REPOSITORY: r
SOURCE_PATH: p
SOURCE_EVIDENCE: e
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES:

## FACT-002
PRODUCT: ECHO Agent
STATUS: VERIFIED
CLAIM: test claim two.
SOURCE_REPOSITORY: r
SOURCE_PATH: p
SOURCE_EVIDENCE: e
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES:
`;

test('MAX_EXTERNAL_POSTS_PER_DAY stops further AUTO publication once reached, even with more eligible facts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-limits-cap-'));
  const dbPath = join(dir, 'x.db');
  const factsPath = join(dir, 'f.md');
  const prevCap = process.env.MARKETING_MAX_EXTERNAL_POSTS_PER_DAY;
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    process.env.MARKETING_MAX_EXTERNAL_POSTS_PER_DAY = '1';
    // This test only exercises the daily-cap guard, which is checked before
    // the LIVE/DRY_RUN branch — force the safe default deterministically so
    // an ambient MARKETING_MODE=LIVE shell can't change that, and scrub
    // credentials + trip the network wire as a second, independent layer.
    process.env.MARKETING_MODE = 'DRY_RUN';
    delete process.env.ECHO_MARKETING_AUTOMATION_ENABLED;

    // Pre-seed one already-published post today, to sit exactly at the cap of 1.
    const { openDb, closeDb } = await import('../lib/db.mjs');
    const { recordIntent, markPublished } = await import('../lib/ledger.mjs');
    const db = openDb(dbPath);
    const row = recordIntent(db, { channel: 'x', text: 'unrelated already-published post', riskClass: 'AUTO', approvalState: 'AUTO_APPROVED', contentType: 'x_post' });
    markPublished(db, row.publication_id, { result: 'OK' });
    closeDb(db);

    const result = await withIsolatedLiveEnv(() => runOnce({ dbPath, factsPath }));
    assert.equal(result.status, 'DAILY_CAP_REACHED');
  } finally {
    if (prevCap === undefined) delete process.env.MARKETING_MAX_EXTERNAL_POSTS_PER_DAY;
    else process.env.MARKETING_MAX_EXTERNAL_POSTS_PER_DAY = prevCap;
    if (prevMode === undefined) delete process.env.MARKETING_MODE; else process.env.MARKETING_MODE = prevMode;
    if (prevAuto === undefined) delete process.env.ECHO_MARKETING_AUTOMATION_ENABLED; else process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- YMM4 idle-resource policy config (unattended-startup mandate section
// 11): conservative defaults, metadata/settings only this pass. ---

test('getLimits: YMM4_KEEP_ALIVE_AFTER_RENDER defaults to true (an instance marketing started may stay alive for later work)', () => {
  const limits = getLimits({});
  assert.equal(limits.YMM4_KEEP_ALIVE_AFTER_RENDER, true);
});

test('getLimits: YMM4_IDLE_TIMEOUT_MS has a conservative (1 hour) default', () => {
  const limits = getLimits({});
  assert.equal(limits.YMM4_IDLE_TIMEOUT_MS, 60 * 60 * 1000);
});

test('getLimits: YMM4_KEEP_ALIVE_AFTER_RENDER can be overridden to false, and YMM4_IDLE_TIMEOUT_MS is tunable', () => {
  const limits = getLimits({ MARKETING_YMM4_KEEP_ALIVE_AFTER_RENDER: 'false', MARKETING_YMM4_IDLE_TIMEOUT_MS: '900000' });
  assert.equal(limits.YMM4_KEEP_ALIVE_AFTER_RENDER, false);
  assert.equal(limits.YMM4_IDLE_TIMEOUT_MS, 900000);
});
