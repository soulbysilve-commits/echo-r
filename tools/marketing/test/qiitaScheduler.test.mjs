import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { loadFacts, factById } from '../lib/facts.mjs';
import { runOnce, runQiitaCycle } from '../operator.mjs';
import { publishToChannel } from '../lib/multiChannelPublish.mjs';
import { draftQiitaArticle } from '../lib/crossChannelDraft.mjs';
import { ensureActivationBoundary, getActivationBoundary } from '../lib/activation.mjs';
import { recordAuthCheck, recordCanary } from '../lib/channelState.mjs';
import { ensureLedgerV2Schema } from '../lib/ledger.mjs';
import { normalizeChannelEnableFlags, withIsolatedLiveEnv } from './testEnvIsolation.mjs';

normalizeChannelEnableFlags();

function tempEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-qiita-sched-'));
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
const NON_TECHNICAL_CLAIM = '公式サイトの料金ページを本日更新しました。';

function technicalFact(id, verifiedAt) {
  return factBlock(id, { claim: TECHNICAL_CLAIM, verifiedAt });
}
function nonTechnicalFact(id, verifiedAt) {
  return factBlock(id, { claim: NON_TECHNICAL_CLAIM, verifiedAt });
}

function qiitaReady(db, { atOrAfter } = {}) {
  recordAuthCheck(db, 'qiita', { authValid: true, accountIdentifier: '@Veritas_Forge', permissionsSufficient: true });
  recordCanary(db, 'qiita', { passed: true, externalId: '24d097823c81f2914e9b', externalUrl: 'https://qiita.com/Veritas_Forge/private/24d097823c81f2914e9b' });
  if (atOrAfter) ensureActivationBoundary(db, atOrAfter, 'qiita');
}

function fakeQiitaFetch({ onCreate } = {}) {
  let calls = 0;
  return async (url, opts) => {
    if (url.includes('/items') && opts?.method === 'POST') {
      calls++;
      const body = JSON.parse(opts.body);
      onCreate?.(body);
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: `q${9000000 + calls}`, url: `https://qiita.com/Veritas_Forge/items/q${9000000 + calls}`, private: false }),
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

const QIITA_ENV = { MARKETING_QIITA_ENABLED: 'true', QIITA_ACCESS_TOKEN: 'test-qiita-key' };

test('activate qiita: sets a fresh, independent per-channel boundary, never copied from global/other-channel/canary/first-article timestamps, and is idempotent', () => {
  const { dir, dbPath } = tempEnv();
  try {
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z'); // unrelated global boundary
    ensureActivationBoundary(db, '2021-01-01T00:00:00.000Z', 'devto'); // unrelated sibling channel boundary

    const first = ensureActivationBoundary(db, undefined, 'qiita'); // fresh, generated now
    assert.equal(first.created, true);
    assert.notEqual(first.boundary, '2020-01-01T00:00:00.000Z');
    assert.notEqual(first.boundary, '2021-01-01T00:00:00.000Z');

    const second = ensureActivationBoundary(db, undefined, 'qiita');
    assert.equal(second.created, false);
    assert.equal(second.boundary, first.boundary, 'activate qiita must be idempotent — never move an already-set boundary');

    assert.equal(getActivationBoundary(db, 'devto'), '2021-01-01T00:00:00.000Z', 'qiita activation must never touch a sibling channel boundary');
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('qiita eligibility: a fact whose VERIFIED_AT predates QIITA_LIVE_NOT_BEFORE is blocked, even with everything else eligible', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-201', '2026-09-01'));
    const db = openDb(dbPath);
    qiitaReady(db, { atOrAfter: '2026-09-15T00:00:00.000Z' }); // boundary AFTER the fact's VERIFIED_AT
    closeDb(db);

    await withLive(async () => {
      const fetchImpl = fakeQiitaFetch();
      const result = await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
      // A pre-activation fact is now filtered out at candidate-selection
      // time itself (lib/candidateSelection.mjs) rather than selected and
      // then rejected by publishToChannel() — with only this one
      // (permanently ineligible) fact available, no candidate is selected
      // at all, so the cycle reports the generic NO_POST rather than the
      // fact-specific BASELINE_SKIPPED. The safety property under test
      // (zero publication for a pre-activation fact) is unchanged.
      assert.equal(result.status, 'NO_POST');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('qiita eligibility: a fact whose VERIFIED_AT is exactly at the boundary passes the boundary gate (inclusive)', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    const boundary = '2026-09-15T00:00:00.000Z';
    writeFileSync(factsPath, technicalFact('FACT-202', boundary));
    const db = openDb(dbPath);
    qiitaReady(db, { atOrAfter: boundary });
    closeDb(db);

    await withLive(async () => {
      const fetchImpl = fakeQiitaFetch();
      const result = await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
      assert.equal(result.status, 'PUBLISHED');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('qiita eligibility: a fact whose VERIFIED_AT is after the boundary is eligible subject to remaining gates', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-203', '2026-09-20'));
    const db = openDb(dbPath);
    qiitaReady(db, { atOrAfter: '2026-09-15T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      const fetchImpl = fakeQiitaFetch();
      const result = await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
      assert.equal(result.status, 'PUBLISHED');
      assert.ok(result.externalId);
      assert.ok(result.externalUrl);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('qiita eligibility: AUTH_VALID=false blocks publication', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-204', '2026-09-20'));
    const db = openDb(dbPath);
    // No recordAuthCheck at all — auth_valid stays 0/false.
    recordCanary(db, 'qiita', { passed: true, externalId: '24d097823c81f2914e9b', externalUrl: 'https://qiita.com/Veritas_Forge/private/24d097823c81f2914e9b' });
    ensureActivationBoundary(db, '2026-09-01T00:00:00.000Z', 'qiita');
    closeDb(db);

    await withLive(async () => {
      let called = false;
      const fetchImpl = async (...a) => { called = true; return fakeQiitaFetch()(...a); };
      const result = await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
      assert.equal(result.status, 'DRY_RUN_OK');
      assert.match(result.reason, /AUTH_INVALID/);
      assert.equal(called, false);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('qiita eligibility: CANARY_PASS=false blocks publication', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-205', '2026-09-20'));
    const db = openDb(dbPath);
    recordAuthCheck(db, 'qiita', { authValid: true, accountIdentifier: '@Veritas_Forge', permissionsSufficient: true });
    // No recordCanary — canary_passed stays 0/false.
    ensureActivationBoundary(db, '2026-09-01T00:00:00.000Z', 'qiita');
    closeDb(db);

    await withLive(async () => {
      let called = false;
      const fetchImpl = async (...a) => { called = true; return fakeQiitaFetch()(...a); };
      const result = await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
      assert.equal(result.status, 'DRY_RUN_OK');
      assert.match(result.reason, /CANARY_NOT_PASSED/);
      assert.equal(called, false);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('qiita eligibility: MARKETING_QIITA_ENABLED=false blocks publication even with everything else eligible', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-206', '2026-09-20'));
    const db = openDb(dbPath);
    qiitaReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      let called = false;
      const fetchImpl = async (...a) => { called = true; return fakeQiitaFetch()(...a); };
      const result = await runQiitaCycle({ dbPath, factsPath, env: { QIITA_ACCESS_TOKEN: 'test-qiita-key' }, fetchImpl }); // no MARKETING_QIITA_ENABLED
      assert.equal(result.status, 'DRY_RUN_OK');
      assert.match(result.reason, /not enabled/);
      assert.equal(called, false);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('qiita eligibility: PUBLIC_MARKETING_MODE=DRY_RUN blocks publication regardless of every other gate', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  const prevMode = process.env.MARKETING_MODE;
  try {
    writeFileSync(factsPath, technicalFact('FACT-207', '2026-09-20'));
    const db = openDb(dbPath);
    qiitaReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    process.env.MARKETING_MODE = 'DRY_RUN';
    let called = false;
    const fetchImpl = async (...a) => { called = true; return fakeQiitaFetch()(...a); };
    const result = await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
    assert.equal(result.status, 'DRY_RUN_OK');
    assert.match(result.reason, /DRY_RUN mode/);
    assert.equal(called, false);
  } finally {
    process.env.MARKETING_MODE = prevMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('technical-substance gate: a non-technical fact is refused (NO_DRAFT), never published — Qiita never becomes a generic announcement mirror', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, nonTechnicalFact('FACT-208', '2026-09-20'));
    const db = openDb(dbPath);
    qiitaReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      let called = false;
      const fetchImpl = async (...a) => { called = true; return fakeQiitaFetch()(...a); };
      const result = await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
      assert.equal(result.status, 'NO_DRAFT');
      assert.equal(called, false);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unsupported claim (fabricated metric language) is blocked by the shared policy gate, never published', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, factBlock('FACT-209', { claim: `${TECHNICAL_CLAIM} This is 42% faster than before.`, verifiedAt: '2026-09-20' }));
    const db = openDb(dbPath);
    qiitaReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      let called = false;
      const fetchImpl = async (...a) => { called = true; return fakeQiitaFetch()(...a); };
      const result = await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
      assert.equal(result.status, 'BLOCKED');
      assert.ok(result.violations.includes('FABRICATED_METRIC'));
      assert.equal(called, false);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('technical valid content + all gates pass => exactly one eligible Qiita publication, with real id/url recorded, in natural Japanese', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-210', '2026-09-20'));
    const db = openDb(dbPath);
    qiitaReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      let createCalls = 0;
      let capturedBody;
      const fetchImpl = fakeQiitaFetch({ onCreate: (body) => { createCalls++; capturedBody = body; } });
      const result = await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
      assert.equal(result.status, 'PUBLISHED');
      assert.equal(createCalls, 1);
      assert.ok(result.externalId);
      assert.ok(result.externalUrl);
      assert.match(capturedBody.title, /[぀-ヿ一-鿿]/, 'Qiita long-form content must default to natural Japanese');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('max 1 article per run: even with multiple eligible technical facts pending, one run publishes exactly one', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, [
      factBlock('FACT-211', { claim: `${TECHNICAL_CLAIM} variant one architecture`, verifiedAt: '2026-09-20' }),
      factBlock('FACT-212', { claim: `${TECHNICAL_CLAIM} variant two architecture`, verifiedAt: '2026-09-21' }),
    ].join('\n'));
    const db = openDb(dbPath);
    qiitaReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      let createCalls = 0;
      const fetchImpl = fakeQiitaFetch({ onCreate: () => { createCalls++; } });
      await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
      assert.equal(createCalls, 1, 'exactly one create-item call per run, never a backlog burst');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('max 2 articles per week: a third eligible fact in the same week is blocked by the frequency guard', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, [
      factBlock('FACT-213', { claim: `${TECHNICAL_CLAIM} variant A architecture`, verifiedAt: '2026-09-20' }),
      factBlock('FACT-214', { claim: `${TECHNICAL_CLAIM} variant B architecture`, verifiedAt: '2026-09-20' }),
      factBlock('FACT-215', { claim: `${TECHNICAL_CLAIM} variant C architecture`, verifiedAt: '2026-09-20' }),
    ].join('\n'));
    const db = openDb(dbPath);
    qiitaReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      let createCalls = 0;
      const fetchImpl = fakeQiitaFetch({ onCreate: () => { createCalls++; } });
      const first = await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
      assert.equal(first.status, 'PUBLISHED');
      const second = await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
      assert.equal(second.status, 'PUBLISHED');
      const third = await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
      assert.equal(third.status, 'DRY_RUN_OK');
      assert.match(third.reason, /weekly cap 2 reached/);
      assert.equal(createCalls, 2, 'the weekly cap must block the third create-item call entirely');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rerun does not duplicate: publishing the same fact twice is idempotent, zero additional create-item calls', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-216', '2026-09-20'));
    const db = openDb(dbPath);
    qiitaReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      let createCalls = 0;
      const fetchImpl = fakeQiitaFetch({ onCreate: () => { createCalls++; } });
      const first = await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
      assert.equal(first.status, 'PUBLISHED');

      const db2 = openDb(dbPath);
      const fact = factById(loadFacts(factsPath), 'FACT-216');
      const rerun = await publishToChannel(db2, 'qiita', fact, draftQiitaArticle, {
        env: QIITA_ENV, eventId: 'FACT-216', canonicalContentId: 'FACT-216', fetchImpl,
      });
      closeDb(db2);
      assert.equal(rerun.status, 'PUBLISHED');
      assert.equal(rerun.idempotent, true);
      assert.equal(createCalls, 1, 'a rerun for the same fact must never create a second article');

      const cycleRerun = await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
      assert.equal(cycleRerun.status, 'NO_POST', 'the fact is already covered — no new candidate to select');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('long-form cross-channel stagger with DEV.to: the same canonical_content_id published to devto moments ago blocks a Qiita publish', async () => {
  const { dir, dbPath } = tempEnv();
  try {
    const db = openDb(dbPath);
    qiitaReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    ensureLedgerV2Schema(db);
    db.prepare(
      `INSERT INTO publication_ledger (publication_id, channel, content_hash, risk_class, approval_state, published_at, external_id, external_url, created_at, canonical_content_id)
       VALUES ('devto-1', 'devto', 'hash-devto-1', 'AUTO', 'AUTO_APPROVED', ?, 'd1', 'https://dev.to/x/d1', ?, 'FACT-217')`
    ).run(new Date().toISOString(), new Date().toISOString());
    closeDb(db);

    const fact = { id: 'FACT-217', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED', CLAIM: TECHNICAL_CLAIM, SOURCE_REPOSITORY: 'ECHODiscord版', SOURCE_PATH: 'x.py', SOURCE_EVIDENCE: 'tests pass', VERIFIED_AT: '2026-09-20', PUBLIC_SAFE: 'true', NOTES: '' };

    await withLive(async () => {
      let called = false;
      const fetchImpl = async (...a) => { called = true; return fakeQiitaFetch()(...a); };
      const db2 = openDb(dbPath);
      const result = await publishToChannel(db2, 'qiita', fact, draftQiitaArticle, {
        env: QIITA_ENV, eventId: fact.id, canonicalContentId: 'FACT-217', fetchImpl,
      });
      closeDb(db2);
      assert.equal(result.status, 'DRY_RUN_OK');
      assert.match(result.reason, /long-form staggering/);
      assert.equal(called, false, 'a staggered long-form publish must never reach the connector');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('long-form cross-channel stagger with Zenn: the same canonical_content_id published to zenn moments ago blocks a Qiita publish', async () => {
  const { dir, dbPath } = tempEnv();
  try {
    const db = openDb(dbPath);
    qiitaReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    ensureLedgerV2Schema(db);
    db.prepare(
      `INSERT INTO publication_ledger (publication_id, channel, content_hash, risk_class, approval_state, published_at, external_id, external_url, created_at, canonical_content_id)
       VALUES ('zenn-1', 'zenn', 'hash-zenn-1', 'AUTO', 'AUTO_APPROVED', ?, 'z1', 'https://zenn.dev/x/z1', ?, 'FACT-218')`
    ).run(new Date().toISOString(), new Date().toISOString());
    closeDb(db);

    const fact = { id: 'FACT-218', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED', CLAIM: TECHNICAL_CLAIM, SOURCE_REPOSITORY: 'ECHODiscord版', SOURCE_PATH: 'x.py', SOURCE_EVIDENCE: 'tests pass', VERIFIED_AT: '2026-09-20', PUBLIC_SAFE: 'true', NOTES: '' };

    await withLive(async () => {
      let called = false;
      const fetchImpl = async (...a) => { called = true; return fakeQiitaFetch()(...a); };
      const db2 = openDb(dbPath);
      const result = await publishToChannel(db2, 'qiita', fact, draftQiitaArticle, {
        env: QIITA_ENV, eventId: fact.id, canonicalContentId: 'FACT-218', fetchImpl,
      });
      closeDb(db2);
      assert.equal(result.status, 'DRY_RUN_OK');
      assert.match(result.reason, /long-form staggering/);
      assert.equal(called, false, 'a staggered long-form publish must never reach the connector, even against a Zenn (git-sync-only) row');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('first-article HUMAN_APPROVED state does not approve later Qiita content: an unrelated fact still needs the full normal AUTO_PUBLIC pipeline', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-219', '2026-09-20'));
    const db = openDb(dbPath);
    qiitaReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    // Simulate the real first-article's row: qiita:identity-continuity-gate:v1, HUMAN_APPROVED and published.
    db.prepare(
      `INSERT INTO publication_ledger (publication_id, channel, content_hash, risk_class, approval_state, published_at, external_id, external_url, created_at)
       VALUES ('first-article', 'qiita', 'unrelated-hash-4383d41dc6c13b2ddab9', 'HUMAN_APPROVAL_REQUIRED', 'HUMAN_APPROVED', ?, '4383d41dc6c13b2ddab9', 'https://qiita.com/Veritas_Forge/items/4383d41dc6c13b2ddab9', ?)`
    ).run(new Date().toISOString(), new Date().toISOString());
    closeDb(db);

    await withLive(async () => {
      // Fully enabled/eligible on purpose: if the first article's approval
      // had "leaked" into general eligibility, there'd be nothing left to
      // distinguish from a normal eligible run.
      const fetchImpl = fakeQiitaFetch();
      const result = await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
      assert.equal(result.status, 'PUBLISHED');
      assert.notEqual(String(result.externalId), '4383d41dc6c13b2ddab9', 'a genuinely new article, never reusing the first article\'s id');

      const db2 = openDb(dbPath);
      const firstArticleRow = db2.prepare('SELECT * FROM publication_ledger WHERE publication_id = ?').get('first-article');
      closeDb(db2);
      assert.equal(firstArticleRow.approval_state, 'HUMAN_APPROVED');
      assert.equal(firstArticleRow.external_id, '4383d41dc6c13b2ddab9');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the private canary item never enters the public AUTO_PUBLIC publication path', () => {
  // The canary's own idempotency key/content (lib/canary.mjs's CANARY_TEXT_QIITA)
  // is structurally disjoint from anything draftQiitaArticle() ever produces
  // (draftQiitaArticle always derives its title/body from a FACT-* registry
  // entry) — so the AUTO_PUBLIC pipeline can never select or publish the
  // canary's own content as a scheduled article.
  const facts = loadFacts(new URL('../../../docs/marketing/VERITAS_FORGE_PUBLIC_FACTS.md', import.meta.url).pathname);
  for (const fact of facts) {
    const draft = draftQiitaArticle(fact);
    if (!draft) continue;
    assert.notEqual(draft.title, 'Veritas Forge API Publication Canary');
  }
});

test('no historical backlog release: multiple pre-boundary facts + a boundary set at first activation => zero publications for the backlog', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, [
      factBlock('FACT-220', { claim: `${TECHNICAL_CLAIM} architecture A`, verifiedAt: '2026-01-01' }),
      factBlock('FACT-221', { claim: `${TECHNICAL_CLAIM} architecture B`, verifiedAt: '2026-02-01' }),
      factBlock('FACT-222', { claim: `${TECHNICAL_CLAIM} architecture C`, verifiedAt: '2026-03-01' }),
    ].join('\n'));
    const db = openDb(dbPath);
    qiitaReady(db, { atOrAfter: '2026-09-16T00:00:00.000Z' }); // activation happens "today", long after all 3 historical facts
    closeDb(db);

    await withLive(async () => {
      let called = false;
      const fetchImpl = async (...a) => { called = true; return fakeQiitaFetch()(...a); };
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
        const result = await runQiitaCycle({ dbPath, factsPath, env: QIITA_ENV, fetchImpl });
        assert.equal(result.status, 'NO_POST');
      }
      assert.equal(called, false, 'no historical backlog fact may ever reach the connector after first activation');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runOnce() includes qiita exactly once, structurally consistent with bluesky/mastodon/devto, without real network calls in a clean test env', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, nonTechnicalFact('FACT-223', '2026-09-20')); // deliberately non-technical: no real publish should even be attempted
    await withIsolatedLiveEnv(async () => {
      const result = await runOnce({ dbPath, factsPath });
      assert.ok('qiita' in result, 'runOnce() result must include a qiita key, same shape as bluesky/mastodon/devto');
      assert.ok(['NO_FACTS', 'NO_POST', 'NO_DRAFT', 'DRY_RUN_OK', 'ERROR'].includes(result.qiita.status));
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('zero real network calls anywhere in this file — every fetchImpl is a local mock, and withIsolatedLiveEnv trips on any that escapes', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFact('FACT-224', '2026-09-20'));
    await withIsolatedLiveEnv(async () => {
      const result = await runQiitaCycle({ dbPath, factsPath, env: { MARKETING_QIITA_ENABLED: 'true' } }); // no fetchImpl override — falls back to global fetch, which withIsolatedLiveEnv trips
      // DRY_RUN mode (process.env.MARKETING_MODE not set to LIVE here) means this never even reaches the connector.
      assert.equal(result.status, 'DRY_RUN_OK');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
