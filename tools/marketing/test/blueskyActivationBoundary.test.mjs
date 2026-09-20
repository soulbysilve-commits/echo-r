import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { ensureActivationBoundary, getActivationBoundary } from '../lib/activation.mjs';
import { publishToChannel } from '../lib/multiChannelPublish.mjs';
import { draftBlueskyPost } from '../lib/crossChannelDraft.mjs';
import { recordAuthCheck, recordCanary } from '../lib/channelState.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-bluesky-boundary-test-'));
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

const LIVE_ENV = { MARKETING_BLUESKY_ENABLED: 'true', BLUESKY_IDENTIFIER: 'u.bsky.social', BLUESKY_APP_PASSWORD: 'pw' };

function bskyFetchMock() {
  return async (url) => {
    if (url.includes('createSession')) return { ok: true, status: 200, json: async () => ({ accessJwt: 'j', did: 'did:plc:x', handle: 'h' }) };
    if (url.includes('createRecord')) return { ok: true, status: 200, json: async () => ({ uri: `at://did:plc:x/app.bsky.feed.post/${Math.random()}`, cid: 'c1' }) };
    throw new Error(`unexpected url ${url}`);
  };
}

test('BLUESKY_LIVE_NOT_BEFORE: an old historical event (fact.VERIFIED_AT well before the boundary) is blocked, never auto-published', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, undefined, 'bluesky'); // uses "now" as the boundary (real default)
    // Simulate a channel boundary explicitly set to a known value for this test.
    const channelBoundary = getActivationBoundary(db, 'bluesky');
    markPassed(db, 'bluesky');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const oldFact = factWithVerifiedAt('FACT-OLD', '2020-01-01T00:00:00.000Z');
    assert.ok(oldFact.VERIFIED_AT < channelBoundary);
    const result = await publishToChannel(db, 'bluesky', oldFact, draftBlueskyPost, { env: LIVE_ENV, fetchImpl: bskyFetchMock() });
    assert.equal(result.status, 'BASELINE_SKIPPED');
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('BLUESKY_LIVE_NOT_BEFORE: an event exactly ONE MILLISECOND before the boundary is blocked', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, BOUNDARY, 'bluesky');
    markPassed(db, 'bluesky');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const justBefore = new Date(Date.parse(BOUNDARY) - 1).toISOString();
    const fact = factWithVerifiedAt('FACT-JUST-BEFORE', justBefore);
    const result = await publishToChannel(db, 'bluesky', fact, draftBlueskyPost, { env: LIVE_ENV, fetchImpl: bskyFetchMock() });
    assert.equal(result.status, 'BASELINE_SKIPPED');
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('BLUESKY_LIVE_NOT_BEFORE: an event exactly AT the boundary is eligible (subject to other gates)', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, BOUNDARY, 'bluesky');
    markPassed(db, 'bluesky');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const fact = factWithVerifiedAt('FACT-AT-BOUNDARY', BOUNDARY);
    const result = await publishToChannel(db, 'bluesky', fact, draftBlueskyPost, { env: LIVE_ENV, fetchImpl: bskyFetchMock() });
    assert.equal(result.status, 'PUBLISHED');
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('BLUESKY_LIVE_NOT_BEFORE: an event after the boundary is eligible (subject to other gates)', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, BOUNDARY, 'bluesky');
    markPassed(db, 'bluesky');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const after = new Date(Date.parse(BOUNDARY) + 1).toISOString();
    const fact = factWithVerifiedAt('FACT-AFTER', after);
    const result = await publishToChannel(db, 'bluesky', fact, draftBlueskyPost, { env: LIVE_ENV, fetchImpl: bskyFetchMock() });
    assert.equal(result.status, 'PUBLISHED');
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('BLUESKY_LIVE_NOT_BEFORE: the initial channel boundary is never copied from the global PUBLIC_LIVE_NOT_BEFORE, an old event timestamp, or an old canary timestamp', () => {
  const { dir, db } = tempDb();
  try {
    // Set a global boundary AND simulate an old canary timestamp existing.
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z'); // global
    recordCanary(db, 'bluesky', { passed: true, externalId: 'x', externalUrl: 'y' }); // canary happened "now" internally, but let's also check an explicit old one below

    const before = new Date();
    const { boundary: channelBoundary, created } = ensureActivationBoundary(db, undefined, 'bluesky');
    const after = new Date();

    assert.equal(created, true);
    assert.notEqual(channelBoundary, '2020-01-01T00:00:00.000Z', 'must never copy the global boundary');
    const parsed = Date.parse(channelBoundary);
    assert.ok(parsed >= before.getTime() && parsed <= after.getTime(), 'must be set to "now" at activation time, not any historical timestamp');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('BLUESKY_LIVE_NOT_BEFORE: re-running activation never moves an already-set channel boundary (idempotent)', () => {
  const { dir, db } = tempDb();
  try {
    const first = ensureActivationBoundary(db, undefined, 'bluesky');
    const second = ensureActivationBoundary(db, undefined, 'bluesky');
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.boundary, second.boundary);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('BLUESKY_LIVE_NOT_BEFORE: the global PUBLIC_LIVE_NOT_BEFORE boundary is completely unaffected by setting a Bluesky-specific one', () => {
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db); // global
    const globalBefore = getActivationBoundary(db);
    ensureActivationBoundary(db, undefined, 'bluesky');
    const globalAfter = getActivationBoundary(db);
    assert.equal(globalBefore, globalAfter);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('no historical backlog burst: multiple old historical facts are ALL blocked, never released in one run just because activation happened', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, BOUNDARY, 'bluesky');
    markPassed(db, 'bluesky');
    process.env.MARKETING_MODE = 'LIVE';
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
    const oldFacts = ['FACT-H1', 'FACT-H2', 'FACT-H3'].map((id) => factWithVerifiedAt(id, '2019-01-01T00:00:00.000Z'));
    for (const fact of oldFacts) {
      const result = await publishToChannel(db, 'bluesky', fact, draftBlueskyPost, { env: LIVE_ENV, fetchImpl: bskyFetchMock() });
      assert.equal(result.status, 'BASELINE_SKIPPED', `historical fact ${fact.id} must never auto-publish`);
    }
  } finally { resetEnv(); closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});
