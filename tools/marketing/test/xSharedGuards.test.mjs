// Pre-LIVE hardening (PR-audit follow-up): X's legacy runOnceInner path now
// participates in the same shared frequency-guard / stagger / AUTH_VALID+
// CANARY_PASSED / per-channel-activation-boundary mechanisms every other
// AUTO_PUBLIC channel's publishToChannel() already enforced (see
// lib/multiChannelPublish.mjs, lib/frequencyGuards.mjs, lib/activation.mjs).
// This file covers exactly the new X-specific integration points — the
// underlying mechanisms themselves are already covered generically by
// frequencyGuards.test.mjs / blueskyActivationBoundary.test.mjs /
// mastodonActivationBoundary.test.mjs / multiChannelPublish.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { runOnce } from '../operator.mjs';
import { connectors } from '../connectors/index.mjs';
import { recordIntent, markPublished } from '../lib/ledger.mjs';
import { ensureActivationBoundary, getActivationBoundary } from '../lib/activation.mjs';
import { recordAuthCheck, recordCanary } from '../lib/channelState.mjs';
import { normalizeChannelEnableFlags, withIsolatedLiveEnv } from './testEnvIsolation.mjs';

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
  const dir = mkdtempSync(join(tmpdir(), 'marketing-x-guards-test-'));
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

function markXPassed(db) {
  recordAuthCheck(db, 'x', { authValid: true, accountIdentifier: '@x-test', permissionsSufficient: true });
  recordCanary(db, 'x', { passed: true, externalId: 'canary-ext-id', externalUrl: 'https://example.com/canary' });
}

function liveEnvVars() {
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  const prevXEnabled = process.env.MARKETING_X_ENABLED;
  const prevXCap = process.env.MARKETING_X_MAX_PER_DAY;
  process.env.MARKETING_MODE = 'LIVE';
  process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
  process.env.MARKETING_X_ENABLED = 'true';
  return () => {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    if (prevXEnabled === undefined) delete process.env.MARKETING_X_ENABLED; else process.env.MARKETING_X_ENABLED = prevXEnabled;
    if (prevXCap === undefined) delete process.env.MARKETING_X_MAX_PER_DAY; else process.env.MARKETING_X_MAX_PER_DAY = prevXCap;
  };
}

test('X now respects a per-channel frequency guard (MARKETING_X_MAX_PER_DAY), in addition to its pre-existing cross-channel daily cap', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const restore = liveEnvVars();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z'); // well before VERIFIED_AT
    markXPassed(db);
    closeDb(db);
    process.env.MARKETING_X_MAX_PER_DAY = '0'; // explicit override: never auto-publish to x today

    let connectorCalled = false;
    const originalPublish = connectors.x.publish;
    connectors.x.publish = async (...a) => { connectorCalled = true; return originalPublish(...a); };
    try {
      const result = await withIsolatedLiveEnv(() => runOnce({ dbPath, factsPath }));
      assert.equal(result.status, 'DRY_RUN_OK');
      assert.equal(connectorCalled, false, 'the per-channel frequency guard must block before the connector is ever reached');
    } finally {
      connectors.x.publish = originalPublish;
    }
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('X now respects checkStagger() — blocked when another channel already published for the exact same event within the stagger window', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const restore = liveEnvVars();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    markXPassed(db);
    // Simulate "another channel already published moments ago for this
    // exact event" without also tripping X's own pre-existing, unrelated
    // alreadyCovered() dedup (which matches on source_evidence content, not
    // event_id) — a different source_evidence, but the SAME event_id
    // ('FACT-001', the fact X is about to select) isolates the NEW
    // checkStagger() integration specifically.
    const row = recordIntent(db, {
      channel: 'bluesky', text: 'a different bluesky post about something else', contentType: 'bluesky_post',
      sourceEvidence: 'FACT-999-unrelated', riskClass: 'AUTO', approvalState: 'AUTO_APPROVED', eventId: 'FACT-001',
    });
    markPublished(db, row.publication_id, { externalId: 'ext1', externalUrl: 'https://bsky.app/x', result: 'OK' });
    closeDb(db);

    let connectorCalled = false;
    const originalPublish = connectors.x.publish;
    connectors.x.publish = async (...a) => { connectorCalled = true; return originalPublish(...a); };
    try {
      const result = await withIsolatedLiveEnv(() => runOnce({ dbPath, factsPath }));
      assert.equal(result.status, 'DRY_RUN_OK');
      assert.ok(result.draft, 'a draft must still have been produced (the candidate was selected, then blocked by stagger)');
      assert.equal(connectorCalled, false, 'staggering must block before the connector is ever reached');
    } finally {
      connectors.x.publish = originalPublish;
    }
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('X respects its OWN per-channel activation boundary (channel_live_not_before:x), independent of the global boundary', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const restore = liveEnvVars();
  try {
    writeFileSync(factsPath, VERIFIED_FACT); // VERIFIED_AT: 2026-09-01
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z'); // global boundary: well before the fact — would NOT block alone
    ensureActivationBoundary(db, '2026-09-15T00:00:00.000Z', 'x'); // x's OWN boundary: AFTER the fact
    markXPassed(db);
    closeDb(db);

    let connectorCalled = false;
    const originalPublish = connectors.x.publish;
    connectors.x.publish = async (...a) => { connectorCalled = true; return originalPublish(...a); };
    try {
      const result = await withIsolatedLiveEnv(() => runOnce({ dbPath, factsPath }));
      // A pre-activation fact is now filtered out at candidate-selection
      // time itself (lib/candidateSelection.mjs) rather than selected and
      // then rejected downstream — with only this one (permanently
      // ineligible) fact available, no candidate is selected at all, so
      // the run reports the generic NO_POST rather than BASELINE_SKIPPED.
      // The real property under test — x's own channel boundary blocks
      // even though the global boundary alone would not — is unchanged:
      // this fact IS post-global-boundary and would otherwise have been
      // selected were it not for x's own stricter boundary.
      assert.equal(result.status, 'NO_POST', 'x\'s own channel boundary must block even though the global boundary alone would not');
      assert.equal(connectorCalled, false);
    } finally {
      connectors.x.publish = originalPublish;
    }
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('X is blocked (never reaches the connector) when no passed auth-check/canary has ever been durably recorded, even fully LIVE-eligible otherwise', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const restore = liveEnvVars();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    // Deliberately NOT calling markXPassed(db) — no channel_state row at all.
    closeDb(db);

    let connectorCalled = false;
    const originalPublish = connectors.x.publish;
    connectors.x.publish = async (...a) => { connectorCalled = true; return originalPublish(...a); };
    try {
      const result = await withIsolatedLiveEnv(() => runOnce({ dbPath, factsPath }));
      assert.equal(result.status, 'DRY_RUN_OK');
      assert.equal(connectorCalled, false);
    } finally {
      connectors.x.publish = originalPublish;
    }
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('X DRY_RUN mode performs zero external writes regardless of the new guards (unchanged safety property)', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    process.env.MARKETING_MODE = 'DRY_RUN';
    let connectorCalled = false;
    const originalPublish = connectors.x.publish;
    connectors.x.publish = async (...a) => { connectorCalled = true; return originalPublish(...a); };
    try {
      const result = await runOnce({ dbPath, factsPath });
      assert.equal(result.status, 'DRY_RUN_OK');
      assert.equal(connectorCalled, false);
    } finally {
      connectors.x.publish = originalPublish;
    }
  } finally {
    process.env.MARKETING_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('X rerun is idempotent — a real publish is never duplicated by a second runOnce() call for the same fact', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const restore = liveEnvVars();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    markXPassed(db);
    closeDb(db);

    let publishCalls = 0;
    const originalPublish = connectors.x.publish;
    connectors.x.publish = async () => { publishCalls++; return { ok: true, externalId: 'ext-1', externalUrl: 'https://x.com/i/web/status/ext-1' }; };
    try {
      const first = await withIsolatedLiveEnv(() => runOnce({ dbPath, factsPath }));
      const second = await withIsolatedLiveEnv(() => runOnce({ dbPath, factsPath }));
      assert.equal(first.status, 'PUBLISHED');
      assert.equal(second.status, 'NO_POST', 'the fact is already covered in the ledger — no second draft, no second publish attempt');
      assert.equal(publishCalls, 1);
    } finally {
      connectors.x.publish = originalPublish;
    }
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
