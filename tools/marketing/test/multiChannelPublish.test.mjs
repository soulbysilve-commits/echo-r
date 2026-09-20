import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { ensureActivationBoundary } from '../lib/activation.mjs';
import { publishToChannel } from '../lib/multiChannelPublish.mjs';
import { draftBlueskyPost, draftHackerNewsPost, draftDevToArticle, draftMastodonPost } from '../lib/crossChannelDraft.mjs';
import { recordAuthCheck, recordCanary } from '../lib/channelState.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-multichannel-test-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

// A real publish now additionally requires durable proof of a passed
// auth-check AND a passed canary (mandate: "AUTH_VALID=true... CANARY_PASS
// =true" are independently required scheduler-eligibility conditions) — this
// helper sets up that proof for tests that intend to reach an actual LIVE
// publish attempt.
function markChannelAuthAndCanaryPassed(db, channel) {
  recordAuthCheck(db, channel, { authValid: true, accountIdentifier: `@${channel}-test`, permissionsSufficient: true });
  recordCanary(db, channel, { passed: true, externalId: 'canary-ext-id', externalUrl: 'https://example.com/canary' });
}

const FUTURE_FACT = {
  id: 'FACT-001', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED',
  CLAIM: 'ECHO Agent\'s verifier rejects a claimed task success when there is no supporting evidence.',
  SOURCE_REPOSITORY: 'ECHODiscord版', SOURCE_PATH: 'echo_agent_verifier_v1.py',
  SOURCE_EVIDENCE: 'test passes', VERIFIED_AT: '2099-01-01', PUBLIC_SAFE: 'true', NOTES: '',
};

const ORIGINAL_ENV = { ...process.env };
function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

test('publishToChannel: DRY_RUN mode never calls the real connector', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    process.env.MARKETING_MODE = 'DRY_RUN';
    let called = false;
    const result = await publishToChannel(db, 'bluesky', FUTURE_FACT, draftBlueskyPost, {
      env: { MARKETING_BLUESKY_ENABLED: 'true' },
      fetchImpl: async () => { called = true; },
    });
    assert.equal(result.status, 'DRY_RUN_OK');
    assert.equal(called, false);
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: kill switch off blocks LIVE publish even with the channel enabled', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'false';
    const result = await publishToChannel(db, 'bluesky', FUTURE_FACT, draftBlueskyPost, { env: { MARKETING_BLUESKY_ENABLED: 'true' } });
    assert.equal(result.status, 'DRY_RUN_OK');
    assert.match(result.reason, /kill switch/);
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: channel not enabled blocks LIVE publish even with LIVE mode + kill switch on', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    markChannelAuthAndCanaryPassed(db, 'bluesky');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const result = await publishToChannel(db, 'bluesky', FUTURE_FACT, draftBlueskyPost, { env: {} });
    assert.equal(result.status, 'DRY_RUN_OK');
    assert.match(result.reason, /channel not enabled/);
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: a fact whose VERIFIED_AT predates the activation boundary never auto-publishes, even fully enabled', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    markChannelAuthAndCanaryPassed(db, 'bluesky');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const oldFact = { ...FUTURE_FACT, VERIFIED_AT: '2020-01-01' };
    const result = await publishToChannel(db, 'bluesky', oldFact, draftBlueskyPost, { env: { MARKETING_BLUESKY_ENABLED: 'true' } });
    assert.equal(result.status, 'BASELINE_SKIPPED');
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: AUTH_VALID/CANARY not yet passed blocks LIVE publish, even with everything else fully configured', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const result = await publishToChannel(db, 'bluesky', FUTURE_FACT, draftBlueskyPost, { env: { MARKETING_BLUESKY_ENABLED: 'true' } });
    assert.equal(result.status, 'DRY_RUN_OK');
    assert.match(result.reason, /AUTH_INVALID/);
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: AUTH_VALID but CANARY not passed still blocks LIVE publish', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    recordAuthCheck(db, 'bluesky', { authValid: true, accountIdentifier: '@bluesky-test', permissionsSufficient: true });
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const result = await publishToChannel(db, 'bluesky', FUTURE_FACT, draftBlueskyPost, { env: { MARKETING_BLUESKY_ENABLED: 'true' } });
    assert.equal(result.status, 'DRY_RUN_OK');
    assert.match(result.reason, /CANARY_NOT_PASSED/);
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: a HUMAN_APPROVAL_REQUIRED action (hackernews_post) is recorded PENDING_APPROVAL and never reaches the connector, even fully live', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const result = await publishToChannel(db, 'hackernews', FUTURE_FACT, draftHackerNewsPost, { env: { MARKETING_HACKERNEWS_ENABLED: 'true' } });
    assert.equal(result.status, 'PENDING_APPROVAL');
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: a real LIVE publish actually calls the connector and marks the ledger row published', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    markChannelAuthAndCanaryPassed(db, 'bluesky');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    let called = false;
    const fetchImpl = async (url) => {
      called = true;
      if (url.includes('createSession')) return { ok: true, status: 200, json: async () => ({ accessJwt: 'j', did: 'did:plc:x', handle: 'h' }) };
      if (url.includes('createRecord')) return { ok: true, status: 200, json: async () => ({ uri: 'at://did:plc:x/app.bsky.feed.post/abc', cid: 'c1' }) };
      throw new Error(`unexpected url ${url}`);
    };
    const result = await publishToChannel(db, 'bluesky', FUTURE_FACT, draftBlueskyPost, {
      env: { MARKETING_BLUESKY_ENABLED: 'true', BLUESKY_IDENTIFIER: 'u.bsky.social', BLUESKY_APP_PASSWORD: 'pw' },
      fetchImpl,
    });
    assert.equal(result.status, 'PUBLISHED');
    assert.equal(called, true);
    assert.ok(result.externalUrl.includes('bsky.app'));
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: idempotency — calling twice with the same fact/channel never publishes twice (real connector called only once)', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    markChannelAuthAndCanaryPassed(db, 'bluesky');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    let callCount = 0;
    const fetchImpl = async (url) => {
      callCount++;
      if (url.includes('createSession')) return { ok: true, status: 200, json: async () => ({ accessJwt: 'j', did: 'did:plc:x', handle: 'h' }) };
      if (url.includes('createRecord')) return { ok: true, status: 200, json: async () => ({ uri: 'at://did:plc:x/app.bsky.feed.post/abc', cid: 'c1' }) };
      throw new Error(`unexpected url ${url}`);
    };
    const env = { MARKETING_BLUESKY_ENABLED: 'true', BLUESKY_IDENTIFIER: 'u.bsky.social', BLUESKY_APP_PASSWORD: 'pw' };
    const first = await publishToChannel(db, 'bluesky', FUTURE_FACT, draftBlueskyPost, { env, fetchImpl });
    const second = await publishToChannel(db, 'bluesky', FUTURE_FACT, draftBlueskyPost, { env, fetchImpl });
    assert.equal(first.status, 'PUBLISHED');
    assert.equal(first.publicationId, second.publicationId, 'the second call must reuse the existing ledger row, never create a duplicate');
    // 2 real calls for the first publish (session + createRecord); the
    // second call's recordIntent short-circuits before ever calling publish.
    assert.equal(callCount, 2);
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: the daily frequency guard blocks a 3rd bluesky publish within 24h, even fully live/enabled', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    markChannelAuthAndCanaryPassed(db, 'bluesky');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const fetchImpl = async (url) => {
      if (url.includes('createSession')) return { ok: true, status: 200, json: async () => ({ accessJwt: 'j', did: 'did:plc:x', handle: 'h' }) };
      if (url.includes('createRecord')) return { ok: true, status: 200, json: async () => ({ uri: `at://did:plc:x/app.bsky.feed.post/${Math.random()}`, cid: 'c1' }) };
      throw new Error(`unexpected url ${url}`);
    };
    const env = { MARKETING_BLUESKY_ENABLED: 'true', BLUESKY_IDENTIFIER: 'u.bsky.social', BLUESKY_APP_PASSWORD: 'pw' };
    await publishToChannel(db, 'bluesky', { ...FUTURE_FACT, id: 'FACT-001' }, draftBlueskyPost, { env, fetchImpl });
    await publishToChannel(db, 'bluesky', { ...FUTURE_FACT, id: 'FACT-002', CLAIM: 'A second distinct claim entirely.' }, draftBlueskyPost, { env, fetchImpl });
    const third = await publishToChannel(db, 'bluesky', { ...FUTURE_FACT, id: 'FACT-003', CLAIM: 'A third distinct claim entirely.' }, draftBlueskyPost, { env, fetchImpl });
    assert.equal(third.status, 'DRY_RUN_OK');
    assert.match(third.reason, /daily cap/);
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: evidence gate — a draft generator that declines (e.g. non-technical fact for a long-form channel) is reported NO_DRAFT, never a fabricated publish', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    const nonTechnicalFact = { ...FUTURE_FACT, CLAIM: 'Looks nice now.', NOTES: '' };
    const result = await publishToChannel(db, 'devto', nonTechnicalFact, draftDevToArticle, { env: {} });
    assert.equal(result.status, 'NO_DRAFT');
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: staggering blocks a second channel publishing for the same event within the stagger window', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    markChannelAuthAndCanaryPassed(db, 'bluesky');
    markChannelAuthAndCanaryPassed(db, 'mastodon');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const fetchImpl = async (url) => {
      if (url.includes('createSession')) return { ok: true, status: 200, json: async () => ({ accessJwt: 'j', did: 'did:plc:x', handle: 'h' }) };
      if (url.includes('createRecord')) return { ok: true, status: 200, json: async () => ({ uri: 'at://did:plc:x/app.bsky.feed.post/abc', cid: 'c1' }) };
      throw new Error(`unexpected url ${url}`);
    };
    await publishToChannel(db, 'bluesky', FUTURE_FACT, draftBlueskyPost, {
      env: { MARKETING_BLUESKY_ENABLED: 'true', BLUESKY_IDENTIFIER: 'u.bsky.social', BLUESKY_APP_PASSWORD: 'pw' },
      fetchImpl, eventId: 'evt-shared',
    });
    const second = await publishToChannel(db, 'mastodon', { ...FUTURE_FACT, id: 'FACT-002', CLAIM: 'A different claim entirely for mastodon.' }, () => ({ channel: 'mastodon', text: 'hi', factIds: ['FACT-002'], claimStrength: 'shipped', actionType: 'mastodon_post' }), {
      env: { MARKETING_MASTODON_ENABLED: 'true', MASTODON_BASE_URL: 'https://m.example', MASTODON_ACCESS_TOKEN: 't' },
      eventId: 'evt-shared',
    });
    assert.equal(second.status, 'DRY_RUN_OK');
    assert.match(second.reason, /staggering/);
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- Mastodon (unattended scheduler activation) — same generic
// publishToChannel() pipeline as every gate test above, additionally
// proving Mastodon's own AI-disclosure content gate and its X/Bluesky
// cross-channel stagger interaction specifically, per the activation task. ---

const MASTODON_LIVE_ENV = { MARKETING_MASTODON_ENABLED: 'true', MASTODON_BASE_URL: 'https://mastodon.social', MASTODON_ACCESS_TOKEN: 'tok' };

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

test('publishToChannel: mastodon CANARY not passed blocks LIVE publish even with AUTH_VALID + enabled + past boundary', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    recordAuthCheck(db, 'mastodon', { authValid: true, accountIdentifier: '@Veritas_Forge', permissionsSufficient: true });
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const result = await publishToChannel(db, 'mastodon', FUTURE_FACT, draftMastodonPost, { env: MASTODON_LIVE_ENV });
    assert.equal(result.status, 'DRY_RUN_OK');
    assert.match(result.reason, /CANARY_NOT_PASSED/);
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: mastodon MARKETING_MASTODON_ENABLED=false blocks LIVE publish even with AUTH_VALID + CANARY passed + past boundary', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    markChannelAuthAndCanaryPassed(db, 'mastodon');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const result = await publishToChannel(db, 'mastodon', FUTURE_FACT, draftMastodonPost, {
      env: { MASTODON_BASE_URL: 'https://mastodon.social', MASTODON_ACCESS_TOKEN: 'tok' }, // MARKETING_MASTODON_ENABLED deliberately absent
    });
    assert.equal(result.status, 'DRY_RUN_OK');
    assert.match(result.reason, /channel not enabled/);
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: mastodon PUBLIC_MARKETING_MODE=DRY_RUN blocks a normal publish even with every other gate fully satisfied', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    markChannelAuthAndCanaryPassed(db, 'mastodon');
    process.env.MARKETING_MODE = 'DRY_RUN';
    let called = false;
    const result = await publishToChannel(db, 'mastodon', FUTURE_FACT, draftMastodonPost, {
      env: MASTODON_LIVE_ENV, fetchImpl: async () => { called = true; },
    });
    assert.equal(result.status, 'DRY_RUN_OK');
    assert.equal(called, false);
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: mastodon — all gates satisfied (AUTH_VALID + CANARY + ENABLED + LIVE + past boundary + evidence/policy/frequency/stagger) -> exactly one eligible PUBLISHED post', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    markChannelAuthAndCanaryPassed(db, 'mastodon');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    let called = false;
    const result = await publishToChannel(db, 'mastodon', FUTURE_FACT, draftMastodonPost, {
      env: MASTODON_LIVE_ENV, fetchImpl: async (...args) => { called = true; return mastodonFetchMock()(...args); },
    });
    assert.equal(result.status, 'PUBLISHED');
    assert.equal(called, true);
    assert.ok(result.externalUrl.includes('mastodon.social'));
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: mastodon daily frequency cap (<=2) blocks a 3rd publish within 24h, even fully live/enabled', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    markChannelAuthAndCanaryPassed(db, 'mastodon');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const fetchImpl = mastodonFetchMock();
    await publishToChannel(db, 'mastodon', { ...FUTURE_FACT, id: 'FACT-001' }, draftMastodonPost, { env: MASTODON_LIVE_ENV, fetchImpl });
    await publishToChannel(db, 'mastodon', { ...FUTURE_FACT, id: 'FACT-002', CLAIM: 'A second distinct claim entirely.' }, draftMastodonPost, { env: MASTODON_LIVE_ENV, fetchImpl });
    const third = await publishToChannel(db, 'mastodon', { ...FUTURE_FACT, id: 'FACT-003', CLAIM: 'A third distinct claim entirely.' }, draftMastodonPost, { env: MASTODON_LIVE_ENV, fetchImpl });
    assert.equal(third.status, 'DRY_RUN_OK');
    assert.match(third.reason, /daily cap/);
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: mastodon content missing the AI-use disclosure fails closed at the connector\'s own validation, even with every scheduler gate (AUTH/CANARY/ENABLED/LIVE/boundary) satisfied', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    markChannelAuthAndCanaryPassed(db, 'mastodon');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    let networkCalled = false;
    const noDisclosureDraft = (fact) => ({ channel: 'mastodon', text: `${fact.PRODUCT}: ${fact.CLAIM}`, factIds: [fact.id], claimStrength: 'shipped', actionType: 'mastodon_post' });
    const result = await publishToChannel(db, 'mastodon', FUTURE_FACT, noDisclosureDraft, {
      env: MASTODON_LIVE_ENV, fetchImpl: async (...args) => { networkCalled = true; return mastodonFetchMock()(...args); },
    });
    assert.equal(result.status, 'PUBLISH_FAILED');
    assert.match(result.reason, /disclosure/i);
    assert.equal(networkCalled, false, 'validate() must fail closed before any network call is even attempted');
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishToChannel: staggering blocks Mastodon publishing for the same event within the stagger window right after X publishes for it', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    markChannelAuthAndCanaryPassed(db, 'x');
    markChannelAuthAndCanaryPassed(db, 'mastodon');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const { recordIntent, markPublished } = await import('../lib/ledger.mjs');
    const row = recordIntent(db, {
      channel: 'x', text: 'an X post about FACT-001', riskClass: 'AUTO', approvalState: 'AUTO_APPROVED',
      contentType: 'x_post', eventId: 'evt-shared-x-mastodon',
    });
    markPublished(db, row.publication_id, { externalId: 'tweet1', externalUrl: 'https://x.com/i/web/status/tweet1', result: 'OK' });

    const result = await publishToChannel(db, 'mastodon', FUTURE_FACT, draftMastodonPost, {
      env: MASTODON_LIVE_ENV, eventId: 'evt-shared-x-mastodon',
    });
    assert.equal(result.status, 'DRY_RUN_OK');
    assert.match(result.reason, /staggering/);
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});
