// Pre-LIVE hardening (PR-audit follow-up): ONE operator_lock now protects
// the entire canonical operator run (runOnceInner/X + video + bluesky +
// mastodon + devto + qiita), not merely the legacy X portion — see
// operator.mjs's runOnce(). Before this, only runOnceInner() acquired the
// lock, so two concurrent runOnce() invocations could still run the newer
// per-channel cycles fully in parallel with no mutual exclusion at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { runOnce } from '../operator.mjs';
import { ensureActivationBoundary } from '../lib/activation.mjs';
import { recordAuthCheck, recordCanary } from '../lib/channelState.mjs';
import { normalizeChannelEnableFlags } from './testEnvIsolation.mjs';

// See test/operator.test.mjs for why — keeps runOnce()'s source-scan and
// dev-observer stages from touching real sibling repos in this file's tests.
process.env.ECHO_AGENT_REPO_ROOT = '/nonexistent/marketing-test-stub/echo-agent';
process.env.ECHO_APP_REPO_ROOT = '/nonexistent/marketing-test-stub/echo-app';
process.env.NOEMORA_REPO_ROOT = '/nonexistent/marketing-test-stub/noemora';
process.env.OFFICIAL_SITE_REPO_ROOT = '/nonexistent/marketing-test-stub/official-site';
process.env.ECHO_AGENT_DEV_ROOT = '/nonexistent/marketing-test-stub/echo-agent-dev';
process.env.ECHO_APP_DEV_ROOT = '/nonexistent/marketing-test-stub/echo-app-dev';
process.env.NOEMORA_DEV_ROOT = '/nonexistent/marketing-test-stub/noemora-dev';
process.env.OFFICIAL_SITE_DEV_ROOT = '/nonexistent/marketing-test-stub/official-site-dev';

normalizeChannelEnableFlags();

function tempEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-op-concurrency-test-'));
  const dbPath = join(dir, 'test.db');
  const factsPath = join(dir, 'facts.md');
  return { dir, dbPath, factsPath };
}

const VERIFIED_FACT = `
## FACT-001
PRODUCT: ECHO Agent
STATUS: VERIFIED
CLAIM: ECHO Agent's verifier rejects a claimed task success when there is no supporting evidence.
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: echo_agent_verifier_v1.py
SOURCE_EVIDENCE: test_fake_success_with_no_evidence_and_no_reviewer_fails_closed passes
VERIFIED_AT: 2026-09-01
PUBLIC_SAFE: true
NOTES: has demo
`;

test('runOnce(): a second concurrent invocation is SKIP_OVERLAP — the lock protects the WHOLE run, not merely the legacy X portion', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', 'bluesky');
    recordAuthCheck(db, 'bluesky', { authValid: true, accountIdentifier: '@veritasforge.bsky.social', permissionsSufficient: true });
    recordCanary(db, 'bluesky', { passed: true, externalId: 'canary1', externalUrl: 'https://bsky.app/x' });
    closeDb(db);

    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    // X deliberately left unenabled/unconfigured — its own cycle resolves
    // fast (DRY_RUN_OK) so the run's outer lock is still held specifically
    // by the SLOW bluesky cycle below when the second call fires, proving
    // the lock spans past X's own slice.
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    let blueskyCallStarted = false;
    const slowFetchImpl = async (url) => {
      blueskyCallStarted = true;
      await gate; // hold this run open until the test explicitly releases it
      if (url.includes('createSession')) return { ok: true, status: 200, json: async () => ({ accessJwt: 'j', did: 'did:plc:x', handle: 'veritasforge.bsky.social' }) };
      if (url.includes('createRecord')) return { ok: true, status: 200, json: async () => ({ uri: 'at://did:plc:x/app.bsky.feed.post/real1', cid: 'c1' }) };
      throw new Error(`unexpected url ${url}`);
    };

    const firstPromise = runOnce({
      dbPath, factsPath,
      env: { MARKETING_BLUESKY_ENABLED: 'true', BLUESKY_IDENTIFIER: 'veritasforge.bsky.social', BLUESKY_APP_PASSWORD: 'pw' },
      fetchImpl: slowFetchImpl,
    });

    // Wait until the first run has actually acquired the lock and reached
    // the slow bluesky call, not merely "some time" — polling is bounded so
    // this can never hang indefinitely if the assumption is wrong.
    const deadline = Date.now() + 5000;
    while (!blueskyCallStarted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(blueskyCallStarted, 'test setup: the first run must have reached the slow bluesky call before we test overlap');

    const second = await runOnce({ dbPath, factsPath });
    assert.equal(second.status, 'SKIP_OVERLAP');
    assert.ok(!('bluesky' in second), 'a SKIP_OVERLAP result must never report any per-channel cycle result — none of them ran');

    releaseGate();
    const first = await firstPromise;
    assert.equal(first.bluesky.status, 'PUBLISHED', 'the first run must still complete normally once unblocked');
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 15000 });

test('runOnce(): sequential calls never see stale contention — the lock is fully released before the function returns', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    process.env.MARKETING_MODE = 'DRY_RUN';
    const first = await runOnce({ dbPath, factsPath });
    const second = await runOnce({ dbPath, factsPath });
    assert.notEqual(first.status, 'SKIP_OVERLAP');
    assert.notEqual(second.status, 'SKIP_OVERLAP');
  } finally {
    process.env.MARKETING_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runOnce(): a stale lock (dead pid, older than the recovery threshold) is recovered rather than blocking forever', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    process.env.MARKETING_MODE = 'DRY_RUN';

    const db = openDb(dbPath);
    // A pid essentially guaranteed not to be alive, with a started_at well
    // past lib/lock.mjs's own STALE_MS (30 minutes) — same scenario
    // ledger_lock.test.mjs already proves acquireLock() itself recovers
    // from; this proves runOnce()'s NEW outer lock inherits that same
    // recovery behavior rather than reimplementing (and potentially
    // regressing) it.
    const longDeadPid = 2 ** 30;
    const staleStartedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    db.prepare('INSERT INTO operator_lock (id, run_id, pid, host, started_at) VALUES (1, ?, ?, ?, ?)').run(
      'stale-run', longDeadPid, 'stale-host', staleStartedAt
    );
    closeDb(db);

    const result = await runOnce({ dbPath, factsPath });
    assert.notEqual(result.status, 'SKIP_OVERLAP', 'a genuinely stale lock must be recovered, not treated as a live overlap');
  } finally {
    process.env.MARKETING_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  }
});
