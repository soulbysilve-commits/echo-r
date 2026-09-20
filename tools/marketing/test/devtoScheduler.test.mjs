import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { loadFacts, factById } from '../lib/facts.mjs';
import { runOnce, runDevToCycle } from '../operator.mjs';
import { publishToChannel } from '../lib/multiChannelPublish.mjs';
import { draftDevToArticle } from '../lib/crossChannelDraft.mjs';
import { ensureActivationBoundary, getActivationBoundary } from '../lib/activation.mjs';
import { recordAuthCheck, recordCanary, getChannelState } from '../lib/channelState.mjs';
import { ensureLedgerV2Schema } from '../lib/ledger.mjs';
import { normalizeChannelEnableFlags, withIsolatedLiveEnv } from './testEnvIsolation.mjs';

normalizeChannelEnableFlags();

function tempEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-devto-sched-'));
  const dbPath = join(dir, 'test.db');
  const factsPath = join(dir, 'facts.md');
  return { dir, dbPath, factsPath };
}

function factBlock(id, { claim, verifiedAt, status = 'VERIFIED', sourcePath = 'some_module_v1.py' }) {
  return `
## ${id}
PRODUCT: ECHO Agent
STATUS: ${status}
CLAIM: ${claim}
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: ${sourcePath}
SOURCE_EVIDENCE: relevant tests pass.
VERIFIED_AT: ${verifiedAt}
PUBLIC_SAFE: true
NOTES:
`;
}

const TECHNICAL_CLAIM = 'ECHO Agent\'s continuity-verification architecture recomputes an identity signal from durable write-ahead-log evidence rather than trusting a self-reported claim.';
const NON_TECHNICAL_CLAIM = 'We refreshed the pricing page on the website today.';

function technicalFact(id, verifiedAt) {
  return factBlock(id, { claim: TECHNICAL_CLAIM, verifiedAt });
}
function nonTechnicalFact(id, verifiedAt) {
  return factBlock(id, { claim: NON_TECHNICAL_CLAIM, verifiedAt });
}

function devtoReady(db, { atOrAfter } = {}) {
  recordAuthCheck(db, 'devto', { authValid: true, accountIdentifier: '@veritasforge_ai', permissionsSufficient: true });
  recordCanary(db, 'devto', { passed: true, externalId: '4669152', externalUrl: 'https://dev.to/x/canary' });
  if (atOrAfter) ensureActivationBoundary(db, atOrAfter, 'devto');
}

function fakeDevtoFetch({ onCreate } = {}) {
  let calls = 0;
  return async (url, opts) => {
    if (url.includes('/articles') && opts?.method === 'POST') {
      calls++;
      const body = JSON.parse(opts.body);
      onCreate?.(body);
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: 9000000 + calls, url: `https://dev.to/veritasforge_ai/x-${9000000 + calls}`, published: true }),
        text: async () => '{}',
      };
    }
    throw new Error(`UNEXPECTED_URL_IN_TEST: ${url}`);
  };
}

async function withLive(fn) {
  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  process.env.MARKETING_MODE = 'LIVE';
  process.env.ECHO_MARKETING_AUTOMATION_ENABLED = 'true';
  try {
    return await fn();
  } finally {
    process.env.MARKETING_MODE = prevMode;
    process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
  }
}

test('activate devto: sets a fresh, independent per-channel boundary, never copied from the global/other-channel/canary/first-article timestamps, and is idempotent', () => {
  const { dir, dbPath } = tempEnv();
  try {
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z'); // unrelated global boundary
    ensureActivationBoundary(db, '2021-01-01T00:00:00.000Z', 'bluesky'); // unrelated sibling channel boundary

    const first = ensureActivationBoundary(db, undefined, 'devto'); // fresh, generated now
    assert.equal(first.created, true);
    assert.notEqual(first.boundary, '2020-01-01T00:00:00.000Z');
    assert.notEqual(first.boundary, '2021-01-01T00:00:00.000Z');

    const second = ensureActivationBoundary(db, undefined, 'devto');
    assert.equal(second.created, false);
    assert.equal(second.boundary, first.boundary, 'activate devto must be idempotent — never move an already-set boundary');

    assert.equal(getActivationBoundary(db, 'bluesky'), '2021-01-01T00:00:00.000Z', 'devto activation must never touch a sibling channel boundary');
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('devto eligibility: a fact whose VERIFIED_AT predates DEVTO_LIVE_NOT_BEFORE is blocked, even with everything else eligible', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-101', '2026-09-01'));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-15T00:00:00.000Z' }); // boundary AFTER the fact's VERIFIED_AT
    closeDb(db);

    await withLive(async () => {
      const fetchImpl = fakeDevtoFetch();
      const result = await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, fetchImpl });
      // A pre-activation fact is now filtered out at candidate-selection time
      // itself (lib/candidateSelection.mjs) rather than selected and then
      // rejected by publishToChannel() — with only this one (permanently
      // ineligible) fact available, no candidate is selected at all, so the
      // cycle reports the generic NO_POST rather than the fact-specific
      // BASELINE_SKIPPED. The safety property under test (zero publication
      // for a pre-activation fact) is unchanged; only the specific status
      // string for "nothing to do" changed.
      assert.equal(result.status, 'NO_POST');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('devto eligibility: a fact whose VERIFIED_AT is exactly at the boundary is eligible (boundary is inclusive)', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    const boundary = '2026-09-15T00:00:00.000Z';
    writeFileSync(factsPath, technicalFact('FACT-102', boundary));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: boundary });
    closeDb(db);

    await withLive(async () => {
      const fetchImpl = fakeDevtoFetch();
      const result = await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, fetchImpl });
      assert.equal(result.status, 'PUBLISHED');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('devto eligibility: a fact whose VERIFIED_AT is after the boundary is eligible subject to remaining gates', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-103', '2026-09-20'));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-15T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      const fetchImpl = fakeDevtoFetch();
      const result = await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, fetchImpl });
      assert.equal(result.status, 'PUBLISHED');
      assert.ok(result.externalId);
      assert.ok(result.externalUrl);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('devto eligibility: AUTH_VALID=false blocks publication', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-104', '2026-09-20'));
    const db = openDb(dbPath);
    // No recordAuthCheck at all — auth_valid stays 0/false.
    recordCanary(db, 'devto', { passed: true, externalId: '4669152', externalUrl: 'https://dev.to/x/canary' });
    ensureActivationBoundary(db, '2026-09-01T00:00:00.000Z', 'devto');
    closeDb(db);

    await withLive(async () => {
      let called = false;
      const fetchImpl = async (...a) => { called = true; return fakeDevtoFetch()(...a); };
      const result = await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, fetchImpl });
      assert.equal(result.status, 'DRY_RUN_OK');
      assert.match(result.reason, /AUTH_INVALID/);
      assert.equal(called, false);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('devto eligibility: CANARY_PASS=false blocks publication', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-105', '2026-09-20'));
    const db = openDb(dbPath);
    recordAuthCheck(db, 'devto', { authValid: true, accountIdentifier: '@veritasforge_ai', permissionsSufficient: true });
    // No recordCanary — canary_passed stays 0/false.
    ensureActivationBoundary(db, '2026-09-01T00:00:00.000Z', 'devto');
    closeDb(db);

    await withLive(async () => {
      let called = false;
      const fetchImpl = async (...a) => { called = true; return fakeDevtoFetch()(...a); };
      const result = await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, fetchImpl });
      assert.equal(result.status, 'DRY_RUN_OK');
      assert.match(result.reason, /CANARY_NOT_PASSED/);
      assert.equal(called, false);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('devto eligibility: MARKETING_DEVTO_ENABLED=false blocks publication even with everything else eligible', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-106', '2026-09-20'));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      let called = false;
      const fetchImpl = async (...a) => { called = true; return fakeDevtoFetch()(...a); };
      const result = await runDevToCycle({ dbPath, factsPath, env: {}, fetchImpl }); // no MARKETING_DEVTO_ENABLED
      assert.equal(result.status, 'DRY_RUN_OK');
      assert.match(result.reason, /not enabled/);
      assert.equal(called, false);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('devto eligibility: PUBLIC_MARKETING_MODE=DRY_RUN blocks publication regardless of every other gate', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  try {
    writeFileSync(factsPath, technicalFact('FACT-107', '2026-09-20'));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    process.env.MARKETING_MODE = 'DRY_RUN';
    let called = false;
    const fetchImpl = async (...a) => { called = true; return fakeDevtoFetch()(...a); };
    const result = await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, fetchImpl });
    assert.equal(result.status, 'DRY_RUN_OK');
    assert.match(result.reason, /DRY_RUN mode/);
    assert.equal(called, false);
  } finally {
    process.env.MARKETING_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('technical-substance gate: a non-technical fact is refused (NO_DRAFT), never published, DEV.to never becomes a generic announcement mirror', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, nonTechnicalFact('FACT-108', '2026-09-20'));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      let called = false;
      const fetchImpl = async (...a) => { called = true; return fakeDevtoFetch()(...a); };
      const result = await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, fetchImpl });
      assert.equal(result.status, 'NO_DRAFT');
      assert.equal(called, false);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('technical event + all gates pass => exactly one eligible article is published, with real id/url recorded', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-109', '2026-09-20'));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      let createCalls = 0;
      const fetchImpl = fakeDevtoFetch({ onCreate: () => { createCalls++; } });
      const result = await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, fetchImpl });
      assert.equal(result.status, 'PUBLISHED');
      assert.equal(createCalls, 1);
      assert.ok(result.externalId);
      assert.ok(result.externalUrl);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('max 1 article per run: even with multiple eligible technical facts pending, one run publishes exactly one', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, [
      factBlock('FACT-110', { claim: `${TECHNICAL_CLAIM} (variant one, architecture)`, verifiedAt: '2026-09-20' }),
      factBlock('FACT-111', { claim: `${TECHNICAL_CLAIM} (variant two, architecture)`, verifiedAt: '2026-09-21' }),
    ].join('\n'));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      let createCalls = 0;
      const fetchImpl = fakeDevtoFetch({ onCreate: () => { createCalls++; } });
      await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, fetchImpl });
      assert.equal(createCalls, 1, 'exactly one create-article call per run, never a backlog burst');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('max 2 articles per week: a third eligible fact in the same week is blocked by the frequency guard', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, [
      factBlock('FACT-112', { claim: `${TECHNICAL_CLAIM} variant A architecture`, verifiedAt: '2026-09-20' }),
      factBlock('FACT-113', { claim: `${TECHNICAL_CLAIM} variant B architecture`, verifiedAt: '2026-09-20' }),
      factBlock('FACT-114', { claim: `${TECHNICAL_CLAIM} variant C architecture`, verifiedAt: '2026-09-20' }),
    ].join('\n'));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      let createCalls = 0;
      const fetchImpl = fakeDevtoFetch({ onCreate: () => { createCalls++; } });
      const first = await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, fetchImpl });
      assert.equal(first.status, 'PUBLISHED');
      const second = await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, fetchImpl });
      assert.equal(second.status, 'PUBLISHED');
      const third = await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, fetchImpl });
      assert.equal(third.status, 'DRY_RUN_OK');
      assert.match(third.reason, /weekly cap 2 reached/);
      assert.equal(createCalls, 2, 'the weekly cap must block the third create-article call entirely');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rerun does not duplicate: publishing the same fact twice is idempotent, zero additional create-article calls', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-115', '2026-09-20'));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      let createCalls = 0;
      const fetchImpl = fakeDevtoFetch({ onCreate: () => { createCalls++; } });
      const first = await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, fetchImpl });
      assert.equal(first.status, 'PUBLISHED');
      // Same fact registry, same content — runDevToCycle would normally skip an
      // already-covered fact and find NO_POST; call publishToChannel directly
      // with the SAME parsed fact (not hand-reconstructed, so the draft text
      // and content_hash are byte-identical) to prove the underlying
      // idempotency too.
      const db2 = openDb(dbPath);
      const fact = factById(loadFacts(factsPath), 'FACT-115');
      const rerun = await publishToChannel(db2, 'devto', fact, draftDevToArticle, {
        env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, eventId: 'FACT-115', canonicalContentId: 'FACT-115', fetchImpl,
      });
      closeDb(db2);
      assert.equal(rerun.status, 'PUBLISHED');
      assert.equal(rerun.idempotent, true);
      assert.equal(createCalls, 1, 'a rerun for the same fact must never create a second article');

      const cycleRerun = await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, fetchImpl });
      assert.equal(cycleRerun.status, 'NO_POST', 'the fact is already covered — no new candidate to select');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('long-form cross-channel stagger: the same canonical_content_id published to another channel moments ago blocks a DEV.to publish', async () => {
  const { dir, dbPath } = tempEnv();
  try {
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    // Simulate qiita having just published the SAME canonical content.
    ensureLedgerV2Schema(db);
    db.prepare(
      `INSERT INTO publication_ledger (publication_id, channel, content_hash, risk_class, approval_state, published_at, external_id, external_url, created_at, canonical_content_id)
       VALUES ('qiita-1', 'qiita', 'hash-qiita-1', 'AUTO', 'AUTO_APPROVED', ?, 'q1', 'https://qiita.com/x/q1', ?, 'FACT-116')`
    ).run(new Date().toISOString(), new Date().toISOString());
    closeDb(db);

    const fact = { id: 'FACT-116', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED', CLAIM: TECHNICAL_CLAIM, SOURCE_REPOSITORY: 'ECHODiscord版', SOURCE_PATH: 'x.py', SOURCE_EVIDENCE: 'tests pass', VERIFIED_AT: '2026-09-20', PUBLIC_SAFE: 'true', NOTES: '' };

    await withLive(async () => {
      let called = false;
      const fetchImpl = async (...a) => { called = true; return fakeDevtoFetch()(...a); };
      const db2 = openDb(dbPath);
      const result = await publishToChannel(db2, 'devto', fact, draftDevToArticle, {
        env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, eventId: fact.id, canonicalContentId: 'FACT-116', fetchImpl,
      });
      closeDb(db2);
      assert.equal(result.status, 'DRY_RUN_OK');
      assert.match(result.reason, /long-form staggering/);
      assert.equal(called, false, 'a staggered long-form publish must never reach the connector');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('long-form cross-channel stagger: after the stagger window has elapsed, DEV.to publication is allowed', async () => {
  const { dir, dbPath } = tempEnv();
  try {
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago, > 5min stagger window
    ensureLedgerV2Schema(db);
    db.prepare(
      `INSERT INTO publication_ledger (publication_id, channel, content_hash, risk_class, approval_state, published_at, external_id, external_url, created_at, canonical_content_id)
       VALUES ('qiita-2', 'qiita', 'hash-qiita-2', 'AUTO', 'AUTO_APPROVED', ?, 'q2', 'https://qiita.com/x/q2', ?, 'FACT-117')`
    ).run(longAgo, longAgo);
    closeDb(db);

    const fact = { id: 'FACT-117', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED', CLAIM: TECHNICAL_CLAIM, SOURCE_REPOSITORY: 'ECHODiscord版', SOURCE_PATH: 'x.py', SOURCE_EVIDENCE: 'tests pass', VERIFIED_AT: '2026-09-20', PUBLIC_SAFE: 'true', NOTES: '' };

    await withLive(async () => {
      const fetchImpl = fakeDevtoFetch();
      const db2 = openDb(dbPath);
      const result = await publishToChannel(db2, 'devto', fact, draftDevToArticle, {
        env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, eventId: fact.id, canonicalContentId: 'FACT-117', fetchImpl,
      });
      closeDb(db2);
      assert.equal(result.status, 'PUBLISHED');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('first-public-article approval does not globalize: HUMAN_APPROVED on article 4669298\'s row has zero effect on a different fact\'s normal AUTO_PUBLIC eligibility', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-118', '2026-09-20'));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    // Simulate the real first-article's row: a different, unrelated content hash, HUMAN_APPROVED and published.
    db.prepare(
      `INSERT INTO publication_ledger (publication_id, channel, content_hash, risk_class, approval_state, published_at, external_id, external_url, created_at)
       VALUES ('first-article', 'devto', 'unrelated-hash-4669298', 'HUMAN_APPROVAL_REQUIRED', 'HUMAN_APPROVED', ?, '4669298', 'https://dev.to/x/4669298', ?)`
    ).run(new Date().toISOString(), new Date().toISOString());
    closeDb(db);

    await withLive(async () => {
      // The pre-existing HUMAN_APPROVED/published first-article row must have
      // zero bearing on this completely different fact's eligibility —
      // publishToChannel() never reads any OTHER row's approval_state, only
      // this fact's own evidence/policy/risk-class plus the standard
      // AUTO_PUBLIC gates. Fully enabled/eligible here on purpose: if the
      // first article's approval had "leaked" into general eligibility, there
      // would be nothing left to distinguish from a normal eligible run.
      const fetchImpl = fakeDevtoFetch();
      const result = await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, fetchImpl });
      assert.equal(result.status, 'PUBLISHED');
      assert.equal(String(result.externalId), '9000001', 'a genuinely new article, never reusing 4669298\'s id');

      // And the first-article's own row is completely undisturbed.
      const db2 = openDb(dbPath);
      const firstArticleRow = db2.prepare('SELECT * FROM publication_ledger WHERE publication_id = ?').get('first-article');
      closeDb(db2);
      assert.equal(firstArticleRow.approval_state, 'HUMAN_APPROVED');
      assert.equal(firstArticleRow.external_id, '4669298');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no historical backlog release: multiple pre-boundary facts + a boundary set at first activation => zero publications for the backlog', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, [
      factBlock('FACT-119', { claim: `${TECHNICAL_CLAIM} architecture A`, verifiedAt: '2026-01-01' }),
      factBlock('FACT-120', { claim: `${TECHNICAL_CLAIM} architecture B`, verifiedAt: '2026-02-01' }),
      factBlock('FACT-121', { claim: `${TECHNICAL_CLAIM} architecture C`, verifiedAt: '2026-03-01' }),
    ].join('\n'));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-16T00:00:00.000Z' }); // activation happens "today", long after all 3 historical facts
    closeDb(db);

    await withLive(async () => {
      let called = false;
      const fetchImpl = async (...a) => { called = true; return fakeDevtoFetch()(...a); };
      // All 3 backlog facts are permanently pre-activation, so
      // lib/candidateSelection.mjs's selectCandidateForChannel() recognizes
      // the ENTIRE backlog as ineligible up front, on every cycle — no
      // candidate is ever selected, so the cycle reports the generic
      // NO_POST rather than burning through the backlog one fact-specific
      // BASELINE_SKIPPED per cycle the way the old selection logic did.
      // The real safety property under test is unchanged and still
      // asserted below: no historical backlog fact ever reaches the
      // connector after activation.
      for (let i = 0; i < 3; i++) {
        const result = await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' }, fetchImpl });
        assert.equal(result.status, 'NO_POST');
      }
      assert.equal(called, false, 'no historical backlog fact may ever reach the connector after first activation');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runOnce() wires devto in structurally, same shape as bluesky/mastodon, without real network calls in a clean test env', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, nonTechnicalFact('FACT-122', '2026-09-20')); // deliberately non-technical: no real publish should even be attempted
    await withIsolatedLiveEnv(async () => {
      const result = await runOnce({ dbPath, factsPath });
      assert.ok('devto' in result, 'runOnce() result must include a devto key, same shape as bluesky/mastodon');
      assert.ok(['NO_FACTS', 'NO_POST', 'NO_DRAFT', 'DRY_RUN_OK', 'ERROR'].includes(result.devto.status));
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('zero real network calls anywhere in this file — every fetchImpl is a local mock, and withIsolatedLiveEnv trips on any that escapes', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-123', '2026-09-20'));
    await withIsolatedLiveEnv(async () => {
      const result = await runDevToCycle({ dbPath, factsPath, env: { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' } }); // no fetchImpl override — falls back to global fetch, which withIsolatedLiveEnv trips
      // DRY_RUN mode (process.env.MARKETING_MODE not set to LIVE here) means this never even reaches the connector.
      assert.equal(result.status, 'DRY_RUN_OK');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
