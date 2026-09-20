import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { runOnce, status } from '../operator.mjs';
import { redact } from '../lib/redact.mjs';
import { validateAnalytics, upsertMemory } from '../lib/memory.mjs';
import { connectors } from '../connectors/index.mjs';
import { draftXPostEn } from '../lib/draft.mjs';
import { ingestEvent } from '../lib/events.mjs';
import { upsertDemoRun } from '../lib/videoPipeline.mjs';
import { ensureActivationBoundary, getActivationBoundary } from '../lib/activation.mjs';
import { recordYmm4ProcessState } from '../lib/ymm4Health.mjs';
import { HEALTHY_EMPTY_MARKETING_SESSION, DEFAULT_MARKETING_IDLE_TEMPLATE, checkIdleTemplateClean, computeAutonomousRenderReadiness } from '../lib/ymm4IdleTemplate.mjs';
import { isRenderLockAvailable } from '../lib/videoPipeline.mjs';
import { recordAuthCheck as recordChannelAuthCheck, recordCanary } from '../lib/channelState.mjs';
import { normalizeChannelEnableFlags, withIsolatedLiveEnv } from './testEnvIsolation.mjs';

// Every runOnce()/status() call in this file now also runs the source-scan
// stage (recurring-video mandate follow-up: automatic event ingestion).
// Point every adapter at a guaranteed-nonexistent path so tests never scan
// the real product repos (slow, non-deterministic, and irrelevant to what
// these tests check) — each adapter's own try/catch around a missing path
// returns [] immediately. Set on process.env (not per-call `env` objects)
// so it applies even to tests that pass their own restricted `env` — see
// sourceAdapters/*.mjs defaultRepoRoot()'s process.env fallback.
process.env.ECHO_AGENT_REPO_ROOT = '/nonexistent/marketing-test-stub/echo-agent';
process.env.ECHO_APP_REPO_ROOT = '/nonexistent/marketing-test-stub/echo-app';
process.env.NOEMORA_REPO_ROOT = '/nonexistent/marketing-test-stub/noemora';
process.env.OFFICIAL_SITE_REPO_ROOT = '/nonexistent/marketing-test-stub/official-site';
// Same reasoning, for the local development observer's own (deliberately
// separate) *_DEV_ROOT vars — see lib/devObserver.mjs. Without this, every
// runOnce()/status() call in this file would also run real `git`
// subprocesses against this machine's real sibling repos.
process.env.ECHO_AGENT_DEV_ROOT = '/nonexistent/marketing-test-stub/echo-agent-dev';
process.env.ECHO_APP_DEV_ROOT = '/nonexistent/marketing-test-stub/echo-app-dev';
process.env.NOEMORA_DEV_ROOT = '/nonexistent/marketing-test-stub/noemora-dev';
process.env.OFFICIAL_SITE_DEV_ROOT = '/nonexistent/marketing-test-stub/official-site-dev';

// Same reasoning, for a different ambient hazard: several tests below assert
// "channel not explicitly enabled -> stays DRY_RUN" by simply never setting
// MARKETING_X_ENABLED, relying on it being unset. This project's own
// production shell (this file may run inside it) sets these flags true for
// real for whatever channels are actually live, which would silently flip
// those tests' premise. See testEnvIsolation.mjs — each test that wants a
// flag set/true still sets it itself and restores its own prior value
// afterward, so this only removes ambient pollution, never a test's intent.
normalizeChannelEnableFlags();

function tempEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-op-test-'));
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

test('DRY_RUN mode never calls a connector and performs no external writes', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    process.env.MARKETING_MODE = 'DRY_RUN';
    delete process.env.ECHO_MARKETING_AUTOMATION_ENABLED;

    let connectorCalled = false;
    const originalPublish = connectors.x.publish;
    connectors.x.publish = async (...args) => { connectorCalled = true; return originalPublish(...args); };

    const result = await runOnce({ dbPath, factsPath });
    assert.equal(result.status, 'DRY_RUN_OK');
    assert.equal(connectorCalled, false);

    connectors.x.publish = originalPublish;
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kill switch (ECHO_MARKETING_AUTOMATION_ENABLED=false) blocks publication even in LIVE mode', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'false';

    const result = await runOnce({ dbPath, factsPath });
    assert.equal(result.status, 'DRY_RUN_OK'); // falls back to dry-run behavior when automation disabled
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('safe-activation: a fact whose VERIFIED_AT predates PUBLIC_LIVE_NOT_BEFORE never auto-publishes, even with LIVE mode + kill switch + channel all enabled', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  const prevXEnabled = process.env.MARKETING_X_ENABLED;
  try {
    writeFileSync(factsPath, VERIFIED_FACT); // VERIFIED_AT: 2026-09-01
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2026-09-15T00:00:00.000Z'); // activation AFTER the fact's own VERIFIED_AT
    // Pre-LIVE hardening: X now also requires a durably-recorded passed
    // auth-check + canary before it can even reach the activation-boundary
    // check (parity with every other AUTO_PUBLIC channel's publishToChannel()
    // gate) — seed both so this test still isolates the ONE thing it's
    // actually testing (the activation boundary), same convention already
    // used by blueskyActivationBoundary.test.mjs's markPassed() helper.
    recordChannelAuthCheck(db, 'x', { authValid: true, accountIdentifier: '@x-test', permissionsSufficient: true });
    recordCanary(db, 'x', { passed: true, externalId: 'canary-ext-id', externalUrl: 'https://example.com/canary' });
    closeDb(db);

    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    process.env.MARKETING_X_ENABLED = 'true';

    let connectorCalled = false;
    const originalPublish = connectors.x.publish;
    connectors.x.publish = async (...args) => { connectorCalled = true; return originalPublish(...args); };

    const result = await runOnce({ dbPath, factsPath });
    // A pre-activation fact is now filtered out at candidate-selection time
    // itself (lib/candidateSelection.mjs) rather than selected and then
    // rejected by runOnceInner's own gate — with only this one (permanently
    // ineligible) fact available, no candidate is selected at all, so the
    // run reports the generic NO_POST rather than the fact-specific
    // BASELINE_SKIPPED. The real safety property under test is unchanged
    // and asserted right below: the connector is never reached.
    assert.equal(result.status, 'NO_POST');
    assert.equal(connectorCalled, false, 'a pre-activation candidate must never reach the connector, even fully LIVE-eligible otherwise');

    connectors.x.publish = originalPublish;
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    if (prevXEnabled === undefined) delete process.env.MARKETING_X_ENABLED; else process.env.MARKETING_X_ENABLED = prevXEnabled;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('safe-activation: a fact whose VERIFIED_AT is AFTER PUBLIC_LIVE_NOT_BEFORE is eligible for normal LIVE handling', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  const prevXEnabled = process.env.MARKETING_X_ENABLED;
  try {
    writeFileSync(factsPath, VERIFIED_FACT.replace('VERIFIED_AT: 2026-09-01', 'VERIFIED_AT: 2026-09-20'));
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2026-09-15T00:00:00.000Z'); // activation BEFORE this fact's VERIFIED_AT
    // Pre-LIVE hardening: reaching "the real live path" now also requires a
    // durably-recorded passed auth-check + canary (parity with every other
    // AUTO_PUBLIC channel) — seeded here so the candidate can get past that
    // gate too and reach the connector, same as it could before this check
    // existed. CONNECTION_REQUIRED below still faithfully represents "auth/
    // canary/activation/frequency/stagger all cleared, but no real
    // credentials are configured at call time."
    recordChannelAuthCheck(db, 'x', { authValid: true, accountIdentifier: '@x-test', permissionsSufficient: true });
    recordCanary(db, 'x', { passed: true, externalId: 'canary-ext-id', externalUrl: 'https://example.com/canary' });
    closeDb(db);

    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    process.env.MARKETING_X_ENABLED = 'true';
    // No X_API_KEY etc. configured — same as the CONNECTION_REQUIRED test
    // below, this just proves the candidate reached the real live path
    // (past the activation gate), not that it actually published.
    // withIsolatedLiveEnv: scrubs real connector credentials the ambient
    // shell may carry and trips on any real network call — see its
    // definition above for why this is needed here.
    const result = await withIsolatedLiveEnv(() => runOnce({ dbPath, factsPath }));
    assert.equal(result.status, 'CONNECTION_REQUIRED');
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    if (prevXEnabled === undefined) delete process.env.MARKETING_X_ENABLED; else process.env.MARKETING_X_ENABLED = prevXEnabled;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureActivationBoundary is idempotent — a second call never moves an already-set boundary', () => {
  const { dir, dbPath } = tempEnv();
  try {
    const db = openDb(dbPath);
    const first = ensureActivationBoundary(db, '2026-09-15T00:00:00.000Z');
    const second = ensureActivationBoundary(db, '2026-09-16T00:00:00.000Z'); // later call, different timestamp
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.boundary, '2026-09-15T00:00:00.000Z');
    assert.equal(getActivationBoundary(db), '2026-09-15T00:00:00.000Z');
    closeDb(db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status() reports PUBLIC_LIVE_NOT_BEFORE once set, and null before activation', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const before = status({ dbPath, factsPath });
    assert.equal(before.PUBLIC_LIVE_NOT_BEFORE, null);

    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2026-09-15T00:00:00.000Z');
    closeDb(db);

    const after = status({ dbPath, factsPath });
    assert.equal(after.PUBLIC_LIVE_NOT_BEFORE, '2026-09-15T00:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unconfigured channel reports CONNECTION_REQUIRED without throwing, in LIVE mode with the channel explicitly enabled', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  const prevXEnabled = process.env.MARKETING_X_ENABLED;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    // Pre-LIVE hardening: seed a durably-recorded passed auth-check + canary
    // for x — this test is about the CONNECTOR's own "not configured"
    // behavior specifically (credentials rotated/removed after a prior
    // successful auth-check + canary is a believable real scenario), not
    // about whether that new durable-proof gate itself blocks first.
    const seedDb = openDb(dbPath);
    recordChannelAuthCheck(seedDb, 'x', { authValid: true, accountIdentifier: '@x-test', permissionsSufficient: true });
    recordCanary(seedDb, 'x', { passed: true, externalId: 'canary-ext-id', externalUrl: 'https://example.com/canary' });
    closeDb(seedDb);

    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    process.env.MARKETING_X_ENABLED = 'true'; // pre-live hardening: still needs the per-channel flag
    // No X_API_KEY etc. are set in this test environment.
    // withIsolatedLiveEnv: scrubs real connector credentials the ambient
    // shell may carry and trips on any real network call.
    const result = await withIsolatedLiveEnv(() => runOnce({ dbPath, factsPath }));
    assert.equal(result.status, 'CONNECTION_REQUIRED');
    assert.equal(result.channel, 'x');
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    if (prevXEnabled === undefined) delete process.env.MARKETING_X_ENABLED; else process.env.MARKETING_X_ENABLED = prevXEnabled;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LIVE mode + global kill switch true is NOT enough on its own — a channel without its own enable flag stays DRY_RUN', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    // MARKETING_X_ENABLED deliberately left unset/false.
    let connectorCalled = false;
    const originalPublish = connectors.x.publish;
    connectors.x.publish = async (...args) => { connectorCalled = true; return originalPublish(...args); };

    // withIsolatedLiveEnv: the ambient shell may carry MARKETING_X_ENABLED=
    // true for real (this project's own production env does); scrub it so
    // this test's "deliberately left unset" premise is actually true, and
    // trip on any real network call that would mean it wasn't.
    const result = await withIsolatedLiveEnv(() => runOnce({ dbPath, factsPath }));
    assert.equal(result.status, 'DRY_RUN_OK');
    assert.equal(connectorCalled, false, 'the connector must never be reached when the per-channel flag is off, even with MODE=LIVE and the global switch on');

    connectors.x.publish = originalPublish;
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('operator LIVE branch is credential-independent — fake-real-looking ambient secrets never leak into the result, zero real network either way', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  const prevXEnabled = process.env.MARKETING_X_ENABLED;
  const prevXKey = process.env.X_API_KEY;
  const prevXSecret = process.env.X_API_SECRET;
  const prevXToken = process.env.X_ACCESS_TOKEN;
  const prevXTokenSecret = process.env.X_ACCESS_TOKEN_SECRET;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    // Pre-LIVE hardening: seed a durably-recorded passed auth-check + canary
    // for x so the run reaches the connector (same reasoning as the
    // CONNECTION_REQUIRED test above — this test is about credential
    // isolation at connector-call time, not about the new durable-proof gate).
    const seedDb = openDb(dbPath);
    recordChannelAuthCheck(seedDb, 'x', { authValid: true, accountIdentifier: '@x-test', permissionsSufficient: true });
    recordCanary(seedDb, 'x', { passed: true, externalId: 'canary-ext-id', externalUrl: 'https://example.com/canary' });
    closeDb(seedDb);

    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    process.env.MARKETING_X_ENABLED = 'true';
    // Simulate exactly what a shell carrying real production secrets looks
    // like to this test — fake-real-looking values set directly on
    // process.env, the way a sourced secrets.env actually does it. Nothing
    // here distinguishes these from genuine credentials by inspection alone
    // (isAuthConfigured() only checks presence, never validates format).
    process.env.X_API_KEY = 'test-real-looking-key';
    process.env.X_API_SECRET = 'test-real-looking-secret';
    process.env.X_ACCESS_TOKEN = 'test-real-looking-token';
    process.env.X_ACCESS_TOKEN_SECRET = 'test-real-looking-token-secret';

    // withIsolatedLiveEnv scrubs the above before runOnce() ever sees them —
    // the operator must fall back to its honest CONNECTION_REQUIRED
    // behavior exactly as if the shell had been clean, and the fetch
    // tripwire proves nothing escaped to the real network in the meantime.
    const result = await withIsolatedLiveEnv(() => runOnce({ dbPath, factsPath }));
    assert.equal(result.status, 'CONNECTION_REQUIRED');
    assert.equal(result.channel, 'x');
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    if (prevXEnabled === undefined) delete process.env.MARKETING_X_ENABLED; else process.env.MARKETING_X_ENABLED = prevXEnabled;
    if (prevXKey === undefined) delete process.env.X_API_KEY; else process.env.X_API_KEY = prevXKey;
    if (prevXSecret === undefined) delete process.env.X_API_SECRET; else process.env.X_API_SECRET = prevXSecret;
    if (prevXToken === undefined) delete process.env.X_ACCESS_TOKEN; else process.env.X_ACCESS_TOKEN = prevXToken;
    if (prevXTokenSecret === undefined) delete process.env.X_ACCESS_TOKEN_SECRET; else process.env.X_ACCESS_TOKEN_SECRET = prevXTokenSecret;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a HUMAN_APPROVAL_REQUIRED action is recorded as pending and never auto-published, even in LIVE mode', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';

    let connectorCalled = false;
    const originalPublish = connectors.x.publish;
    connectors.x.publish = async (...args) => { connectorCalled = true; return originalPublish(...args); };

    // Simulate a high-risk draft (e.g. a pricing-adjacent post) reaching the operator.
    const highRiskDraft = (fact) => ({
      channel: 'x', text: `New pricing for ${fact.PRODUCT}`, factIds: [fact.id],
      claimStrength: 'neutral', actionType: 'price_change',
    });

    const result = await runOnce({ dbPath, factsPath, draftFn: highRiskDraft });
    assert.equal(result.status, 'PENDING_APPROVAL');
    assert.equal(connectorCalled, false);

    const db = openDb(dbPath);
    const row = db.prepare("SELECT * FROM publication_ledger WHERE risk_class = 'HUMAN_APPROVAL_REQUIRED'").get();
    assert.ok(row);
    assert.equal(row.approval_state, 'PENDING_HUMAN_APPROVAL');
    assert.equal(row.published_at, null);
    closeDb(db);

    connectors.x.publish = originalPublish;
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drafted content text is derived directly from the backing fact\'s CLAIM, not free-generated', () => {
  const fact = {
    id: 'FACT-001', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED',
    CLAIM: 'ECHO Agent can checkpoint a task and resume it after a process restart.',
  };
  const draft = draftXPostEn(fact);
  assert.ok(draft.text.includes(fact.CLAIM), 'draft text must contain the exact verified claim text');
  assert.deepEqual(draft.factIds, [fact.id]);
});

test('secrets are redacted before logging/storage', () => {
  const raw = 'Posting with STRIPE_WEBHOOK_SECRET=whsec_abc123def456 and api_key: sk-THISISASECRETKEY1234';
  const clean = redact(raw);
  assert.ok(!clean.includes('whsec_abc123def456'));
  assert.ok(!clean.includes('sk-THISISASECRETKEY1234'));
  assert.ok(clean.includes('[REDACTED]'));
});

test('Stripe secret keys (underscore format, not the OpenAI-style hyphen format) are also redacted', () => {
  // Regression test: sk_live_/sk_test_ (Stripe's real format) is a distinct
  // shape from sk-... (OpenAI-style) and was NOT covered until this test
  // (written for the video-evidence redaction pipeline) caught the gap.
  const raw = 'DEBUG: STRIPE_SECRET_KEY=sk_live_abc123def456ghi789 pk_live_publishablekey1234567890';
  const clean = redact(raw);
  assert.ok(!clean.includes('sk_live_abc123def456ghi789'));
  assert.ok(!clean.includes('pk_live_publishablekey1234567890'));
});

test('malformed analytics data is rejected and does not corrupt marketing memory', () => {
  const { dir, dbPath } = tempEnv();
  try {
    const db = openDb(dbPath);
    const bad = upsertMemory(db, { content_id: 'c1', ctr: 5, clicks: -3, impressions: 'lots' });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.length >= 3);
    const rows = db.prepare('SELECT COUNT(*) c FROM marketing_memory').get().c;
    assert.equal(rows, 0);

    const good = upsertMemory(db, { content_id: 'c1', ctr: 0.05, clicks: 3, impressions: 100 });
    assert.equal(good.ok, true);
    closeDb(db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateAnalytics requires a content_id', () => {
  const errors = validateAnalytics({ impressions: 10 });
  assert.ok(errors.includes('content_id: required'));
});

// --- daily video-pipeline wiring (recurring-video mandate section 12) ---

test('runOnce is extended with a video cycle result (NO_VIDEO, correctly) without changing the text-content result shape', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const result = await runOnce({ dbPath, factsPath });
    assert.equal(result.status, 'DRY_RUN_OK'); // unchanged text-content behavior
    assert.ok(result.video, 'runOnce must also report a video cycle result');
    assert.equal(result.video.ok, true);
    assert.equal(result.video.status, 'NO_VIDEO');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runOnce\'s video cycle respects MAX_AUTO_VIDEOS_PER_DAY even though the text-content cycle has its own separate cap', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevCap = process.env.MARKETING_MAX_AUTO_VIDEOS_PER_DAY;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    process.env.MARKETING_MAX_AUTO_VIDEOS_PER_DAY = '1';

    const db = openDb(dbPath);
    upsertDemoRun(db, 'already-uploaded-today', { youtube_video_id: 'v1', privacy_status: 'private' });
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e1', payload: { rawLogLines: ['[00:01] GOAL ACCEPTED', '[00:02] VERIFIER — PASS'], factIds: ['FACT-001'] } });
    closeDb(db);

    const result = await runOnce({ dbPath, factsPath });
    assert.equal(result.video.status, 'DAILY_VIDEO_CAP_REACHED');
    assert.equal(result.video.autoVideosToday, 1);
  } finally {
    if (prevCap === undefined) delete process.env.MARKETING_MAX_AUTO_VIDEOS_PER_DAY;
    else process.env.MARKETING_MAX_AUTO_VIDEOS_PER_DAY = prevCap;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a scheduled rerun of runOnce is idempotent and safe: a candidate event consumed by the first video cycle is never re-scored by a second (mandate section 18)', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const db = openDb(dbPath);
    ingestEvent(db, {
      eventType: 'BUG_FIXED', dedupeKey: 'e1',
      payload: {
        rawLogLines: ['[00:02] GOAL ACCEPTED', '[00:06] PLAN CREATED', '[00:31] STEP FAILED', '[00:32] VERIFIER — REJECT', '[00:55] RETRY', '[01:20] STEP PASS', '[01:22] VERIFIER — PASS'],
        factIds: ['FACT-001'],
      },
    });
    closeDb(db);

    // Neither call is authorized to actually render (MARKETING_YMM4_DEMO_ALLOWED
    // unset), so both stop at a gated, honest failure well before touching
    // YMM4/YouTube — this test is about the SELECTION step's idempotency,
    // not the render pipeline.
    const first = await runOnce({ dbPath, factsPath });
    assert.notEqual(first.video.status, 'NO_VIDEO', 'the first run must actually find and select the seeded candidate');

    const second = await runOnce({ dbPath, factsPath });
    assert.equal(second.video.status, 'NO_VIDEO', 'the event was already consumed by the first run — a rerun must not re-select or re-render the same story');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runOnce\'s daily cycle also runs the source scan (mandate section 14) and reports it alongside the video cycle result', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const result = await runOnce({ dbPath, factsPath });
    assert.ok(Array.isArray(result.video.sourceScan), 'daily cycle must report a per-source scan result array');
    assert.equal(result.video.sourceScan.length, 4, 'one result per adapter (echo-agent, echo-app, noemora, official-site)');
    for (const scan of result.video.sourceScan) {
      assert.equal(scan.rawRecords, 0, 'the stubbed nonexistent repo roots must find nothing');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- status() extension (mandate section 16 & 17) ---

test('status() reports the recurring-video fields with safe, honest defaults when nothing has run yet', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const result = status({ dbPath, factsPath, env: {} });

    assert.match(result.AUTO_VIDEO_SELECTION, /IMPLEMENTED/);
    assert.equal(typeof result.VIDEO_MIN_SCORE, 'number');
    assert.equal(result.LATEST_VIDEO_CANDIDATE, null);
    assert.equal(result.LATEST_VIDEO_SCORE, null);

    assert.equal(result.YMM4_DEMO_ALLOWED, false);
    assert.match(result.YMM4_AUTO_RENDER_READY, /BLOCKED/);

    assert.equal(typeof result.YOUTUBE_PENDING_REVIEW_COUNT, 'number');
    assert.equal(result.LATEST_PRIVATE_VIDEO, null);
    assert.equal(result.LATEST_PRIVATE_VIDEO_URL, null);

    assert.equal(result.MAX_AUTO_VIDEOS_PER_DAY, 1);
    assert.equal(result.AUTO_VIDEOS_TODAY, 0);
    assert.equal(typeof result.VIDEO_DISK_GUARD, 'string');

    assert.equal(result.PUBLIC_MARKETING_MODE, result.MARKETING_MODE);
    assert.equal(result.PRIVATE_VIDEO_PIPELINE_MODE, 'LIVE_GATED_BY_YMM4_DEMO_ALLOWED_FALSE');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status() reports PRIVATE_VIDEO_PIPELINE_MODE=LIVE when MARKETING_YMM4_DEMO_ALLOWED=true, independent of PUBLIC_MARKETING_MODE staying DRY_RUN', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const result = status({ dbPath, factsPath, env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' } });
    assert.equal(result.YMM4_DEMO_ALLOWED, true);
    assert.equal(result.PRIVATE_VIDEO_PIPELINE_MODE, 'LIVE');
    assert.equal(result.PUBLIC_MARKETING_MODE, 'DRY_RUN');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status() with MARKETING_YMM4_DEMO_ALLOWED=true and MARKETING_YOUTUBE_ENABLED=true never reports the gate as false — the exact combination flagged as an inconsistency in a prior report (env not loaded when status() was invoked manually, not a code bug, but now pinned by a regression test)', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const result = status({ dbPath, factsPath, env: { MARKETING_YMM4_DEMO_ALLOWED: 'true', MARKETING_YOUTUBE_ENABLED: 'true' } });
    assert.equal(result.YMM4_DEMO_ALLOWED, true);
    assert.equal(result.PRIVATE_VIDEO_PIPELINE_MODE, 'LIVE');
    assert.notEqual(result.PRIVATE_VIDEO_PIPELINE_MODE, 'LIVE_GATED_BY_YMM4_DEMO_ALLOWED_FALSE');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A clean, zero-item .ymmp fixture (see lib/ymm4IdleTemplate.mjs's
// countProjectItems doc comment for the real file shape) — injected via
// status()'s idleTemplateExistsImpl/idleTemplateReadFileImpl so these tests
// never depend on whether a real blank template happens to exist on the
// machine running them.
function cleanIdleTemplateFsMock() {
  const wslPath = '/mnt/c/Users/Silver/VeritasForgeMarketing/marketing_idle_blank.ymmp';
  const content = '﻿' + JSON.stringify({ FilePath: '', Timelines: [{ ID: 't0', Items: [] }] });
  return {
    idleTemplateExistsImpl: (p) => p === wslPath,
    idleTemplateReadFileImpl: (p) => { if (p !== wslPath) throw new Error(`ENOENT: ${p}`); return content; },
  };
}

test('status(): a verified HEALTHY_EMPTY_MARKETING_SESSION reuses the SAME canonical readiness computation as `ymm4 status` — reports YMM4_READY_FOR_AUTONOMOUS_RENDER=true (never inferred from transport READY_NO_PROJECT alone)', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const db = openDb(dbPath);
    recordYmm4ProcessState(db, {
      pid: 50188, owner: 'MARKETING', startedAt: null, project: null,
      bridgeStatus: 'READY_NO_PROJECT', healthState: HEALTHY_EMPTY_MARKETING_SESSION,
    });
    closeDb(db);

    const result = status({
      dbPath, factsPath, env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
      ...cleanIdleTemplateFsMock(),
    });
    assert.equal(result.YMM4_TRANSPORT_STATE, 'READY_NO_PROJECT');
    assert.equal(result.YMM4_HEALTH_STATE, HEALTHY_EMPTY_MARKETING_SESSION);
    assert.equal(result.YMM4_READY_FOR_AUTONOMOUS_RENDER, true, JSON.stringify(result.YMM4_READY_FOR_AUTONOMOUS_RENDER_REASONS));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status(): raw transport READY_NO_PROJECT alone, without a verified HEALTHY_EMPTY_MARKETING_SESSION, never silently reports render-ready', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const db = openDb(dbPath);
    // health_state deliberately omitted (mirrors bridgeStatus) — no empty-
    // session verification ever ran for this durable record.
    recordYmm4ProcessState(db, { pid: 50188, owner: 'MARKETING', startedAt: null, project: null, bridgeStatus: 'READY_NO_PROJECT' });
    closeDb(db);

    const result = status({
      dbPath, factsPath, env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
      ...cleanIdleTemplateFsMock(),
    });
    assert.equal(result.YMM4_TRANSPORT_STATE, 'READY_NO_PROJECT');
    assert.equal(result.YMM4_HEALTH_STATE, 'READY_NO_PROJECT');
    assert.equal(result.YMM4_READY_FOR_AUTONOMOUS_RENDER, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status(): YMM4_READY_FOR_AUTONOMOUS_RENDER is byte-for-byte the same result computeAutonomousRenderReadiness() itself produces for the same inputs — proves no second, re-derived copy of the readiness logic exists', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const db = openDb(dbPath);
    recordYmm4ProcessState(db, {
      pid: 50188, owner: 'MARKETING', startedAt: null, project: null,
      bridgeStatus: 'READY_NO_PROJECT', healthState: HEALTHY_EMPTY_MARKETING_SESSION,
    });
    closeDb(db);

    const env = { MARKETING_YMM4_DEMO_ALLOWED: 'true' };
    const fsMock = cleanIdleTemplateFsMock();
    const result = status({ dbPath, factsPath, env, ...fsMock });

    const db2 = openDb(dbPath);
    const directResult = computeAutonomousRenderReadiness({
      healthState: HEALTHY_EMPTY_MARKETING_SESSION,
      liveProjectPath: null,
      demoAllowed: true,
      idleTemplateClean: checkIdleTemplateClean(DEFAULT_MARKETING_IDLE_TEMPLATE, {
        existsImpl: fsMock.idleTemplateExistsImpl, readFileImpl: fsMock.idleTemplateReadFileImpl,
      }).clean,
      renderLockAvailable: isRenderLockAvailable(db2),
    });
    closeDb(db2);

    assert.equal(result.YMM4_READY_FOR_AUTONOMOUS_RENDER, directResult.ready);
    assert.deepEqual(result.YMM4_READY_FOR_AUTONOMOUS_RENDER_REASONS, directResult.reasons);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status(): YMM4_IS_EMPTY_PROJECT is true exactly when the durable transport status is READY_NO_PROJECT, matching ymm4 status\'s own definition', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const db = openDb(dbPath);
    recordYmm4ProcessState(db, { pid: 50188, owner: 'MARKETING', startedAt: null, project: null, bridgeStatus: 'READY_NO_PROJECT' });
    closeDb(db);
    const result = status({ dbPath, factsPath, env: {}, ...cleanIdleTemplateFsMock() });
    assert.equal(result.YMM4_IS_EMPTY_PROJECT, true);
    assert.equal(result.YMM4_PROJECT, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status(): YMM4_IS_EMPTY_PROJECT is false when a real project is loaded', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const db = openDb(dbPath);
    recordYmm4ProcessState(db, { pid: 50188, owner: 'MARKETING', startedAt: null, project: 'C:\\Users\\Silver\\VeritasForgeMarketing\\marketing_idle.ymmp', bridgeStatus: 'HEALTHY' });
    closeDb(db);
    const result = status({ dbPath, factsPath, env: {}, ...cleanIdleTemplateFsMock() });
    assert.equal(result.YMM4_IS_EMPTY_PROJECT, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status(): after a real Bluesky canary passes, BLUESKY.AUTH=AUTH_VALID / BLUESKY.CANARY=true / BLUESKY.ENABLED=false / BLUESKY.LIVE_READY=false (enabled flag still off)', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const db = openDb(dbPath);
    recordChannelAuthCheck(db, 'bluesky', { authValid: true, accountIdentifier: '@veritasforge.bsky.social', permissionsSufficient: true });
    recordCanary(db, 'bluesky', { passed: true, externalId: 'at://did:plc:abc/app.bsky.feed.post/canary1', externalUrl: 'https://bsky.app/profile/veritasforge.bsky.social/post/canary1' });
    closeDb(db);

    // Credentials must be present in env for AUTH to read as AUTH_VALID
    // (durable auth_valid=true alone is not enough — AUTH reflects a
    // currently-configured credential whose last check passed, never a
    // stale record for credentials that are no longer even present).
    const CREDS = { BLUESKY_IDENTIFIER: 'veritasforge.bsky.social', BLUESKY_APP_PASSWORD: 'app-pass' };
    const result = status({ dbPath, factsPath, env: CREDS }); // MARKETING_BLUESKY_ENABLED deliberately not set
    assert.equal(result.BLUESKY.AUTH, 'AUTH_VALID');
    assert.equal(result.BLUESKY.CANARY, true);
    assert.equal(result.BLUESKY.ENABLED, false);
    assert.equal(result.BLUESKY.LIVE_READY, false);
    assert.equal(result.BLUESKY.BLOCKER, 'CHANNEL_DISABLED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status(): with AUTH_VALID + CANARY passed + MARKETING_BLUESKY_ENABLED=true, BLUESKY.LIVE_READY becomes true (subject to no other blocker)', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const db = openDb(dbPath);
    recordChannelAuthCheck(db, 'bluesky', { authValid: true, accountIdentifier: '@veritasforge.bsky.social', permissionsSufficient: true });
    recordCanary(db, 'bluesky', { passed: true, externalId: 'at://did:plc:abc/app.bsky.feed.post/canary1', externalUrl: 'https://bsky.app/profile/veritasforge.bsky.social/post/canary1' });
    closeDb(db);

    const result = status({
      dbPath, factsPath,
      env: { MARKETING_BLUESKY_ENABLED: 'true', BLUESKY_IDENTIFIER: 'veritasforge.bsky.social', BLUESKY_APP_PASSWORD: 'app-pass' },
    });
    assert.equal(result.BLUESKY.LIVE_READY, true);
    assert.equal(result.BLUESKY.BLOCKER, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status(): Zenn is never reported in AUTO_PUBLIC_CHANNELS (its MODE is AUTO_DRAFT, not AUTO_PUBLIC — it has no write API)', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const result = status({ dbPath, factsPath, env: {} });
    assert.ok(!result.AUTO_PUBLIC_CHANNELS.includes('zenn'));
    assert.deepEqual(result.AUTO_PUBLIC_CHANNELS.sort(), ['bluesky', 'devto', 'mastodon', 'qiita'].sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status(): Zenn appears in AUTO_DRAFT_CHANNELS, distinct from AUTO_PUBLIC_CHANNELS', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const result = status({ dbPath, factsPath, env: {} });
    assert.deepEqual(result.AUTO_DRAFT_CHANNELS, ['zenn']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status(): no credential values ever appear in the output — channel blocks report booleans/enums only, never a raw env var value', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const secretEnv = {
      BLUESKY_IDENTIFIER: 'user.bsky.social', BLUESKY_APP_PASSWORD: 'super-secret-app-password-xyz',
      MASTODON_ACCESS_TOKEN: 'super-secret-mastodon-token', DEVTO_API_KEY: 'super-secret-devto-key',
      QIITA_ACCESS_TOKEN: 'super-secret-qiita-token', HASHNODE_API_KEY: 'super-secret-hashnode-key',
      LINKEDIN_ACCESS_TOKEN: 'super-secret-linkedin-token',
    };
    const result = status({ dbPath, factsPath, env: secretEnv });
    const serialized = JSON.stringify(result);
    for (const secretValue of Object.values(secretEnv)) {
      assert.ok(!serialized.includes(secretValue), `leaked credential value: ${secretValue}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status() reports per-source health fields with NO_EVIDENCE defaults before any scan has run', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const result = status({ dbPath, factsPath, env: {} });
    assert.match(result.AUTO_SOURCE_INGESTION, /IMPLEMENTED/);
    for (const prefix of ['ECHO_AGENT', 'ECHO_APP', 'NOEMORA', 'OFFICIAL_SITE']) {
      assert.equal(result[`${prefix}_SOURCE`], 'NO_EVIDENCE');
      assert.equal(result[`${prefix}_LAST_SCAN`], null);
      assert.equal(result[`${prefix}_EVENTS_FOUND`], 0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status() reports PASS for a source once it has actually ingested a real event', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    await runOnce({ dbPath, factsPath }); // seeds cursors for all 4 (stubbed) sources, finds nothing
    const db = openDb(dbPath);
    // Simulate a real ingested event from echo-app without needing a real git repo.
    const { ingestEvent } = await import('../lib/events.mjs');
    ingestEvent(db, { eventType: 'NEW_FEATURE_VERIFIED', sourceRepo: 'ECHOapp', dedupeKey: 'fp-1', payload: {} });
    closeDb(db);

    const result = status({ dbPath, factsPath, env: {} });
    assert.equal(result.ECHO_APP_SOURCE, 'PASS');
    assert.equal(result.ECHO_APP_EVENTS_FOUND, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status() never mutates marketing_events just by being queried (dryRun preview, not a real selection)', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const db = openDb(dbPath);
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e1', payload: { rawLogLines: ['[00:01] GOAL ACCEPTED', '[00:02] VERIFIER — PASS'], factIds: ['FACT-001'] } });
    closeDb(db);

    status({ dbPath, factsPath, env: {} });
    status({ dbPath, factsPath, env: {} });

    const db2 = openDb(dbPath);
    const stillUnprocessed = db2.prepare('SELECT COUNT(*) c FROM marketing_events WHERE processed_at IS NULL').get().c;
    closeDb(db2);
    assert.equal(stillUnprocessed, 1, 'repeated status() calls must never consume the candidate event');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- status() YMM4 process/bridge fields (unattended-startup mandate
// section 12) — read from the durable ymm4_process_state record, never a
// live process/HTTP check (same pattern as X/YouTube auth in status()). ---

test('status() reports YMM4_PROCESS=UNKNOWN and null owner/pid/project before any health check has ever run', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const result = status({ dbPath, factsPath });
    assert.match(result.YMM4_PROCESS, /UNKNOWN/);
    assert.equal(result.YMM4_PROCESS_OWNER, null);
    assert.equal(result.YMM4_PROCESS_PID, null);
    assert.equal(result.YMM4_PROJECT, null);
    assert.equal(result.YMM4_BRIDGE, 'UNKNOWN');
    assert.equal(result.YMM4_BRIDGE_PORT, 8765);
    assert.equal(result.YMM4_READY_FOR_AUTONOMOUS_RENDER, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status() reflects the durable ymm4_process_state record once a health check has recorded one, without making a live check itself', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const { recordYmm4ProcessState } = await import('../lib/ymm4Health.mjs');
    const db = openDb(dbPath);
    recordYmm4ProcessState(db, { pid: 4321, owner: 'MARKETING', startedAt: '2026-01-01T00:00:00Z', project: 'C:\\Users\\Silver\\VeritasForgeMarketing\\marketing_idle.ymmp', bridgeStatus: 'HEALTHY' });
    closeDb(db);

    const result = status({ dbPath, factsPath, env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' } });
    assert.match(result.YMM4_PROCESS, /RUNNING/);
    assert.equal(result.YMM4_PROCESS_OWNER, 'MARKETING');
    assert.equal(result.YMM4_PROCESS_PID, 4321);
    assert.equal(result.YMM4_BRIDGE, 'HEALTHY');
    assert.equal(result.YMM4_PROJECT, 'C:\\Users\\Silver\\VeritasForgeMarketing\\marketing_idle.ymmp');
    assert.equal(result.YMM4_READY_FOR_AUTONOMOUS_RENDER, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status(): VIDEO_PIPELINE_LIVE-equivalent (YMM4_DEMO_ALLOWED=true) does NOT imply YMM4 is currently running', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const result = status({ dbPath, factsPath, env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' } });
    assert.equal(result.YMM4_DEMO_ALLOWED, true);
    assert.equal(result.YMM4_PROCESS_PID, null, 'no health check has run, so no process should be reported as running');
    assert.equal(result.YMM4_READY_FOR_AUTONOMOUS_RENDER, false, 'demo-allowed alone is not readiness — the process must actually be confirmed HEALTHY');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Bluesky wired into the existing daily operator (runOnce) ---

test('runOnce(): includes a bluesky cycle result alongside the existing text/video cycles, DRY_RUN mode never calls the real Bluesky connector', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    process.env.MARKETING_MODE = 'DRY_RUN';
    delete process.env.ECHO_MARKETING_AUTOMATION_ENABLED;

    let blueskyFetchCalled = false;
    const result = await runOnce({ dbPath, factsPath, env: { MARKETING_BLUESKY_ENABLED: 'true' }, fetchImpl: async () => { blueskyFetchCalled = true; } });

    assert.ok('bluesky' in result, 'runOnce() must report a bluesky cycle result');
    assert.equal(result.bluesky.status, 'DRY_RUN_OK');
    assert.equal(blueskyFetchCalled, false);
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runOnce(): a real Bluesky publish only happens when LIVE + kill switch + enabled + AUTH_VALID + CANARY passed + past the activation boundary all hold', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';

    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z'); // global boundary, before VERIFIED_FACT's date
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', 'bluesky'); // channel boundary, also before
    recordChannelAuthCheck(db, 'bluesky', { authValid: true, accountIdentifier: '@veritasforge.bsky.social', permissionsSufficient: true });
    recordCanary(db, 'bluesky', { passed: true, externalId: 'canary1', externalUrl: 'https://bsky.app/x' });
    closeDb(db);

    let blueskyPublishCalled = false;
    const fetchImpl = async (url) => {
      blueskyPublishCalled = true;
      if (url.includes('createSession')) return { ok: true, status: 200, json: async () => ({ accessJwt: 'j', did: 'did:plc:x', handle: 'veritasforge.bsky.social' }) };
      if (url.includes('createRecord')) return { ok: true, status: 200, json: async () => ({ uri: 'at://did:plc:x/app.bsky.feed.post/real1', cid: 'c1' }) };
      throw new Error(`unexpected url ${url}`);
    };
    const result = await runOnce({
      dbPath, factsPath,
      env: { MARKETING_BLUESKY_ENABLED: 'true', BLUESKY_IDENTIFIER: 'veritasforge.bsky.social', BLUESKY_APP_PASSWORD: 'pw' },
      fetchImpl,
    });

    assert.equal(result.bluesky.status, 'PUBLISHED');
    assert.equal(blueskyPublishCalled, true);
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runOnce(): a rerun does not duplicate the Bluesky publish (idempotent) even though the text-content cycle also has its own separate idempotency', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';

    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', 'bluesky');
    recordChannelAuthCheck(db, 'bluesky', { authValid: true, accountIdentifier: '@veritasforge.bsky.social', permissionsSufficient: true });
    recordCanary(db, 'bluesky', { passed: true, externalId: 'canary1', externalUrl: 'https://bsky.app/x' });
    closeDb(db);

    let publishCalls = 0;
    const fetchImpl = async (url) => {
      publishCalls++;
      if (url.includes('createSession')) return { ok: true, status: 200, json: async () => ({ accessJwt: 'j', did: 'did:plc:x', handle: 'veritasforge.bsky.social' }) };
      if (url.includes('createRecord')) return { ok: true, status: 200, json: async () => ({ uri: 'at://did:plc:x/app.bsky.feed.post/real1', cid: 'c1' }) };
      throw new Error(`unexpected url ${url}`);
    };
    const env = { MARKETING_BLUESKY_ENABLED: 'true', BLUESKY_IDENTIFIER: 'veritasforge.bsky.social', BLUESKY_APP_PASSWORD: 'pw' };
    const first = await runOnce({ dbPath, factsPath, env, fetchImpl });
    const second = await runOnce({ dbPath, factsPath, env, fetchImpl });

    assert.equal(first.bluesky.status, 'PUBLISHED');
    // Second run: the SAME fact is now alreadyCoveredByChannel for bluesky
    // (a real ledger row already exists), so no NEW candidate is even
    // selected — no second createRecord call.
    assert.equal(second.bluesky.status, 'NO_POST');
    assert.equal(publishCalls, 2, 'exactly the 2 real calls (session + createRecord) from the FIRST run only');
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status(): BLUESKY/MASTODON/DEVTO.SCHEDULER_WIRED=true and each LIVE_NOT_BEFORE reflects its own, independent per-channel activation boundary', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    const db = openDb(dbPath);
    const { boundary: blueskyBoundary } = ensureActivationBoundary(db, undefined, 'bluesky');
    const { boundary: mastodonBoundary } = ensureActivationBoundary(db, undefined, 'mastodon');
    const { boundary: devtoBoundary } = ensureActivationBoundary(db, undefined, 'devto');
    closeDb(db);
    const result = status({ dbPath, factsPath, env: {} });
    assert.equal(result.BLUESKY.SCHEDULER_WIRED, true);
    assert.equal(result.BLUESKY.LIVE_NOT_BEFORE, blueskyBoundary);
    assert.equal(result.MASTODON.SCHEDULER_WIRED, true);
    assert.equal(result.MASTODON.LIVE_NOT_BEFORE, mastodonBoundary);
    assert.equal(result.DEVTO.SCHEDULER_WIRED, true);
    assert.equal(result.DEVTO.LIVE_NOT_BEFORE, devtoBoundary);
    assert.notEqual(blueskyBoundary, mastodonBoundary, 'each channel boundary must be set independently, never copied from another channel');
    assert.notEqual(blueskyBoundary, devtoBoundary, 'devto boundary must never be copied from another channel');
    assert.notEqual(mastodonBoundary, devtoBoundary, 'devto boundary must never be copied from another channel');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runOnce(): max 1 Bluesky publish per run — only the single best eligible candidate is ever processed in one call', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  try {
    // Two eligible facts — only one may be selected/published per run.
    writeFileSync(factsPath, VERIFIED_FACT + `
## FACT-002
PRODUCT: ECHO Agent
STATUS: VERIFIED
CLAIM: ECHO Agent's memory layer never silently drops a write once acknowledged.
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: echo_agent_memory_v1.py
SOURCE_EVIDENCE: test_ack_write_survives_crash passes
VERIFIED_AT: 2026-09-02
PUBLIC_SAFE: true
`);
    process.env.MARKETING_MODE = 'DRY_RUN';
    let createRecordCalls = 0;
    const fetchImpl = async (url) => { if (url.includes('createRecord')) createRecordCalls++; };
    const result = await runOnce({ dbPath, factsPath, env: { MARKETING_BLUESKY_ENABLED: 'true' }, fetchImpl });
    assert.ok('bluesky' in result);
    assert.equal(createRecordCalls, 0, 'DRY_RUN never posts at all, structurally confirming at most one candidate is even considered');
  } finally {
    process.env.MARKETING_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Mastodon wired into the existing daily operator (runOnce) — same
// architecture as the Bluesky block above (mandate: unattended scheduler
// activation task). ---

function mastodonFetchMock() {
  return async (url) => {
    if (url.includes('/api/v1/accounts/verify_credentials')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'acct1', username: 'Veritas_Forge' }) };
    }
    if (url.includes('/api/v1/statuses')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: String(Math.random()), url: 'https://mastodon.social/@Veritas_Forge/x' }) };
    }
    throw new Error(`unexpected url ${url}`);
  };
}

test('runOnce(): includes a mastodon cycle result alongside the existing text/video/bluesky cycles, DRY_RUN mode never calls the real Mastodon connector', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    process.env.MARKETING_MODE = 'DRY_RUN';
    delete process.env.ECHO_MARKETING_AUTOMATION_ENABLED;

    let mastodonFetchCalled = false;
    const result = await runOnce({ dbPath, factsPath, env: { MARKETING_MASTODON_ENABLED: 'true' }, fetchImpl: async () => { mastodonFetchCalled = true; } });

    assert.ok('mastodon' in result, 'runOnce() must report a mastodon cycle result');
    assert.equal(result.mastodon.status, 'DRY_RUN_OK');
    assert.equal(mastodonFetchCalled, false);
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runOnce(): a real Mastodon publish only happens when LIVE + kill switch + enabled + AUTH_VALID + CANARY passed + past the activation boundary all hold', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';

    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z'); // global boundary, before VERIFIED_FACT's date
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', 'mastodon'); // channel boundary, also before
    recordChannelAuthCheck(db, 'mastodon', { authValid: true, accountIdentifier: '@Veritas_Forge', permissionsSufficient: true });
    recordCanary(db, 'mastodon', { passed: true, externalId: 'canary1', externalUrl: 'https://mastodon.social/@Veritas_Forge/canary1' });
    closeDb(db);

    let mastodonPublishCalled = false;
    const fetchImpl = async (...args) => { mastodonPublishCalled = true; return mastodonFetchMock()(...args); };
    const result = await runOnce({
      dbPath, factsPath,
      env: { MARKETING_MASTODON_ENABLED: 'true', MASTODON_BASE_URL: 'https://mastodon.social', MASTODON_ACCESS_TOKEN: 'tok' },
      fetchImpl,
    });

    assert.equal(result.mastodon.status, 'PUBLISHED');
    assert.equal(mastodonPublishCalled, true);
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runOnce(): a rerun does not duplicate the Mastodon publish (idempotent) even though the text-content/Bluesky cycles also have their own separate idempotency', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  try {
    writeFileSync(factsPath, VERIFIED_FACT);
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';

    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', 'mastodon');
    recordChannelAuthCheck(db, 'mastodon', { authValid: true, accountIdentifier: '@Veritas_Forge', permissionsSufficient: true });
    recordCanary(db, 'mastodon', { passed: true, externalId: 'canary1', externalUrl: 'https://mastodon.social/@Veritas_Forge/canary1' });
    closeDb(db);

    let publishCalls = 0;
    const fetchImpl = async (...args) => { publishCalls++; return mastodonFetchMock()(...args); };
    const env = { MARKETING_MASTODON_ENABLED: 'true', MASTODON_BASE_URL: 'https://mastodon.social', MASTODON_ACCESS_TOKEN: 'tok' };
    const first = await runOnce({ dbPath, factsPath, env, fetchImpl });
    const second = await runOnce({ dbPath, factsPath, env, fetchImpl });

    assert.equal(first.mastodon.status, 'PUBLISHED');
    // Second run: the SAME fact is now alreadyCoveredByChannel for mastodon
    // (a real ledger row already exists), so no NEW candidate is even
    // selected — no second statuses POST.
    assert.equal(second.mastodon.status, 'NO_POST');
    assert.equal(publishCalls, 1, 'exactly the 1 real call (statuses POST) from the FIRST run only');
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runOnce(): max 1 Mastodon publish per run — only the single best eligible candidate is ever processed in one call', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  try {
    // Two eligible facts — only one may be selected/published per run.
    writeFileSync(factsPath, VERIFIED_FACT + `
## FACT-002
PRODUCT: ECHO Agent
STATUS: VERIFIED
CLAIM: ECHO Agent's memory layer never silently drops a write once acknowledged.
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: echo_agent_memory_v1.py
SOURCE_EVIDENCE: test_ack_write_survives_crash passes
VERIFIED_AT: 2026-09-02
PUBLIC_SAFE: true
`);
    process.env.MARKETING_MODE = 'DRY_RUN';
    let statusesPostCalls = 0;
    const fetchImpl = async (url) => { if (url.includes('/api/v1/statuses')) statusesPostCalls++; };
    const result = await runOnce({ dbPath, factsPath, env: { MARKETING_MASTODON_ENABLED: 'true' }, fetchImpl });
    assert.ok('mastodon' in result);
    assert.equal(statusesPostCalls, 0, 'DRY_RUN never posts at all, structurally confirming at most one candidate is even considered');
  } finally {
    process.env.MARKETING_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  }
});
