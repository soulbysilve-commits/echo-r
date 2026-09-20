import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { ensureActivationBoundary, getActivationBoundary } from '../lib/activation.mjs';
import { publishToChannel } from '../lib/multiChannelPublish.mjs';
import { draftMastodonPost } from '../lib/crossChannelDraft.mjs';
import { recordAuthCheck, recordCanary } from '../lib/channelState.mjs';

// Same architecture/coverage as blueskyActivationBoundary.test.mjs — the
// per-channel activation boundary mechanism (lib/activation.mjs's
// channel_live_not_before:<channel> key) is fully generic, so this file
// proves it holds for Mastodon specifically, never copied from the global
// PUBLIC_LIVE_NOT_BEFORE, the Mastodon canary timestamp, the Bluesky
// boundary, or any historical event timestamp.

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-mastodon-boundary-test-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

function markPassed(db, channel) {
  recordAuthCheck(db, channel, { authValid: true, accountIdentifier: `@${channel}-test`, permissionsSufficient: true });
  recordCanary(db, channel, { passed: true, externalId: 'canary-ext-id', externalUrl: 'https://example.com/canary' });
}

const BOUNDARY = '2026-09-16T00:00:00.000Z';

function factWithVerifiedAt(id, verifiedAt) {
  return {
    id, PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED',
    CLAIM: 'ECHO Agent\'s verifier rejects a claimed task success when there is no supporting evidence.',
    SOURCE_REPOSITORY: 'ECHODiscord版', SOURCE_PATH: 'echo_agent_verifier_v1.py',
    SOURCE_EVIDENCE: 'test passes', VERIFIED_AT: verifiedAt, PUBLIC_SAFE: 'true', NOTES: '',
  };
}

const ORIGINAL_ENV = { ...process.env };
function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

const LIVE_ENV = { MARKETING_MASTODON_ENABLED: 'true', MASTODON_BASE_URL: 'https://mastodon.social', MASTODON_ACCESS_TOKEN: 'tok' };

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

test('MASTODON_LIVE_NOT_BEFORE: an old historical event (fact.VERIFIED_AT well before the boundary) is blocked, never auto-published', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, undefined, 'mastodon'); // uses "now" as the boundary (real default)
    const channelBoundary = getActivationBoundary(db, 'mastodon');
    markPassed(db, 'mastodon');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const oldFact = factWithVerifiedAt('FACT-OLD', '2020-01-01T00:00:00.000Z');
    assert.ok(oldFact.VERIFIED_AT < channelBoundary);
    const result = await publishToChannel(db, 'mastodon', oldFact, draftMastodonPost, { env: LIVE_ENV, fetchImpl: mastodonFetchMock() });
    assert.equal(result.status, 'BASELINE_SKIPPED');
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('MASTODON_LIVE_NOT_BEFORE: an event exactly ONE MILLISECOND before the boundary is blocked', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, BOUNDARY, 'mastodon');
    markPassed(db, 'mastodon');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const justBefore = new Date(Date.parse(BOUNDARY) - 1).toISOString();
    const fact = factWithVerifiedAt('FACT-JUST-BEFORE', justBefore);
    const result = await publishToChannel(db, 'mastodon', fact, draftMastodonPost, { env: LIVE_ENV, fetchImpl: mastodonFetchMock() });
    assert.equal(result.status, 'BASELINE_SKIPPED');
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('MASTODON_LIVE_NOT_BEFORE: an event exactly AT the boundary is eligible (subject to other gates) -> PUBLISHED, and its content carries the AI disclosure', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, BOUNDARY, 'mastodon');
    markPassed(db, 'mastodon');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const fact = factWithVerifiedAt('FACT-AT-BOUNDARY', BOUNDARY);
    const result = await publishToChannel(db, 'mastodon', fact, draftMastodonPost, { env: LIVE_ENV, fetchImpl: mastodonFetchMock() });
    assert.equal(result.status, 'PUBLISHED');
    assert.match(draftMastodonPost(fact).text, /AI-assisted/i);
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('MASTODON_LIVE_NOT_BEFORE: an event after the boundary is eligible (subject to other gates)', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, BOUNDARY, 'mastodon');
    markPassed(db, 'mastodon');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const after = new Date(Date.parse(BOUNDARY) + 1).toISOString();
    const fact = factWithVerifiedAt('FACT-AFTER', after);
    const result = await publishToChannel(db, 'mastodon', fact, draftMastodonPost, { env: LIVE_ENV, fetchImpl: mastodonFetchMock() });
    assert.equal(result.status, 'PUBLISHED');
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('MASTODON_LIVE_NOT_BEFORE: the initial channel boundary is never copied from the global PUBLIC_LIVE_NOT_BEFORE, the real Mastodon canary timestamp, or the Bluesky boundary', () => {
  const { dir, db } = tempDb();
  try {
    // Global boundary, an old-looking value.
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    // A Bluesky boundary, distinct from Mastodon's.
    ensureActivationBoundary(db, '2021-06-15T00:00:00.000Z', 'bluesky');
    // The real Mastodon canary's own recorded timestamp — must never be
    // reused as the activation boundary either.
    recordCanary(db, 'mastodon', { passed: true, externalId: '117277737810877370', externalUrl: 'https://mastodon.social/@Veritas_Forge/117277737810877370' });

    const before = new Date();
    const { boundary: mastodonBoundary, created } = ensureActivationBoundary(db, undefined, 'mastodon');
    const after = new Date();

    assert.equal(created, true);
    assert.notEqual(mastodonBoundary, '2020-01-01T00:00:00.000Z', 'must never copy the global boundary');
    assert.notEqual(mastodonBoundary, '2021-06-15T00:00:00.000Z', 'must never copy another channel\'s boundary');
    const parsed = Date.parse(mastodonBoundary);
    assert.ok(parsed >= before.getTime() && parsed <= after.getTime(), 'must be set to "now" at activation time, not any historical timestamp');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('MASTODON_LIVE_NOT_BEFORE: re-running activation never moves an already-set channel boundary (idempotent)', () => {
  const { dir, db } = tempDb();
  try {
    const first = ensureActivationBoundary(db, undefined, 'mastodon');
    const second = ensureActivationBoundary(db, undefined, 'mastodon');
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.boundary, second.boundary);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('MASTODON_LIVE_NOT_BEFORE: the global PUBLIC_LIVE_NOT_BEFORE boundary is completely unaffected by setting a Mastodon-specific one', () => {
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db); // global
    const globalBefore = getActivationBoundary(db);
    ensureActivationBoundary(db, undefined, 'mastodon');
    const globalAfter = getActivationBoundary(db);
    assert.equal(globalBefore, globalAfter);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('no historical backlog burst: multiple old historical facts are ALL blocked, never released in one run just because activation happened', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, BOUNDARY, 'mastodon');
    markPassed(db, 'mastodon');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const oldFacts = ['FACT-H1', 'FACT-H2', 'FACT-H3'].map((id) => factWithVerifiedAt(id, '2019-01-01T00:00:00.000Z'));
    for (const fact of oldFacts) {
      const result = await publishToChannel(db, 'mastodon', fact, draftMastodonPost, { env: LIVE_ENV, fetchImpl: mastodonFetchMock() });
      assert.equal(result.status, 'BASELINE_SKIPPED', `historical fact ${fact.id} must never auto-publish`);
    }
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});
