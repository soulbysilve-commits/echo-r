import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { loadFacts } from '../lib/facts.mjs';
import { rankFacts } from '../lib/scoring.mjs';
import { ensureActivationBoundary } from '../lib/activation.mjs';
import { recordAuthCheck, recordCanary } from '../lib/channelState.mjs';
import {
  selectWeeklyFactSet, draftWeeklyDevToArticle, draftWeeklyQiitaArticle, publishWeeklyLongForm,
} from '../lib/weeklyLongForm.mjs';
import { runWeeklyLongFormOnce } from '../weeklyOperator.mjs';
import { normalizeChannelEnableFlags } from './testEnvIsolation.mjs';

normalizeChannelEnableFlags();

function tempEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-weekly-longform-'));
  const dbPath = join(dir, 'test.db');
  const factsPath = join(dir, 'facts.md');
  return { dir, dbPath, factsPath };
}

function factBlock(id, { product = 'ECHO Agent', claim, verifiedAt, status = 'VERIFIED', sourcePath = 'some_module_v1.py' }) {
  return `
## ${id}
PRODUCT: ${product}
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

const TECHNICAL_CLAIMS = [
  'ECHO Agent\'s continuity-verification architecture recomputes an identity signal from durable write-ahead-log evidence rather than trusting a self-reported claim.',
  'ECHO Agent\'s planner uses an idempotent retry-with-backoff protocol so a crashed task resumes from its last durable checkpoint instead of restarting from scratch.',
  'ECHO Agent\'s memory ledger uses schema migrations with a reversible encoding step, verified end-to-end against a concurrency/race-condition regression suite.',
  'ECHO Agent\'s license signer uses a deterministic serialization algorithm so signature verification never depends on key ordering.',
];
const NON_TECHNICAL_CLAIM = 'We refreshed the pricing page on the website today.';
const OTHER_PRODUCT_TECHNICAL_CLAIM = 'ECHO App\'s sync engine uses a conflict-resolution algorithm with idempotent write-ahead-log replay across devices.';

function technicalFacts(count, { verifiedAt = '2026-09-20', product = 'ECHO Agent', startIndex = 0 } = {}) {
  // parseFacts() (lib/facts.mjs) requires an id matching ^FACT-\d+$ exactly
  // -- pure digits after "FACT-" -- so ids are numeric-only here.
  return Array.from({ length: count }, (_, i) => factBlock(`FACT-9${String(startIndex + i).padStart(3, '0')}`, {
    product, claim: TECHNICAL_CLAIMS[(startIndex + i) % TECHNICAL_CLAIMS.length], verifiedAt,
  })).join('\n');
}

function devtoReady(db, { atOrAfter } = {}) {
  recordAuthCheck(db, 'devto', { authValid: true, accountIdentifier: '@veritasforge_ai', permissionsSufficient: true });
  recordCanary(db, 'devto', { passed: true, externalId: '4669152', externalUrl: 'https://dev.to/x/canary' });
  if (atOrAfter) ensureActivationBoundary(db, atOrAfter, 'devto');
}
function qiitaReady(db, { atOrAfter } = {}) {
  recordAuthCheck(db, 'qiita', { authValid: true, accountIdentifier: '@Veritas_Forge', permissionsSufficient: true });
  recordCanary(db, 'qiita', { passed: true, externalId: '24d097823c81f2914e9b', externalUrl: 'https://qiita.com/Veritas_Forge/private/24d097823c81f2914e9b' });
  if (atOrAfter) ensureActivationBoundary(db, atOrAfter, 'qiita');
}

const DEVTO_ENV = { MARKETING_DEVTO_ENABLED: 'true', DEVTO_API_KEY: 'test-devto-key' };
const QIITA_ENV = { MARKETING_QIITA_ENABLED: 'true', QIITA_ACCESS_TOKEN: 'test-qiita-key' };

function fakeDevtoFetch() {
  let calls = 0;
  return async (url, opts) => {
    if (url.includes('/articles') && opts?.method === 'POST') {
      calls++;
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: 9000000 + calls, url: `https://dev.to/veritasforge_ai/x-${9000000 + calls}`, published: true }),
        text: async () => '{}',
      };
    }
    throw new Error(`UNEXPECTED_URL_IN_TEST: ${url}`);
  };
}
function fakeQiitaFetch() {
  let calls = 0;
  return async (url, opts) => {
    if (url.includes('/items') && opts?.method === 'POST') {
      calls++;
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: `q${9000000 + calls}`, url: `https://qiita.com/Veritas_Forge/items/q${9000000 + calls}`, private: false }),
        text: async () => '{}',
      };
    }
    throw new Error(`UNEXPECTED_URL_IN_TEST: ${url}`);
  };
}
function failingDevtoFetch() {
  return async (url, opts) => {
    if (url.includes('/articles') && opts?.method === 'POST') {
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: 'server error' }), text: async () => 'server error' };
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

function rankedFrom(factsPath) {
  return rankFacts(loadFacts(factsPath));
}

// --- selectWeeklyFactSet ---

test('selectWeeklyFactSet: enough same-product technical material -> a coherent set is selected', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFacts(3));
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    const factSet = selectWeeklyFactSet(db, 'devto', rankedFrom(factsPath));
    assert.ok(factSet);
    assert.ok(factSet.length >= 2);
    assert.ok(factSet.every((f) => f.PRODUCT === 'ECHO Agent'));
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('selectWeeklyFactSet: only ONE eligible technical fact -> insufficient material -> null (NOOP)', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFacts(1) + '\n' + factBlock('FACT-8000', { claim: NON_TECHNICAL_CLAIM, verifiedAt: '2026-09-20' }));
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    const factSet = selectWeeklyFactSet(db, 'devto', rankedFrom(factsPath));
    assert.equal(factSet, null);
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('selectWeeklyFactSet: zero technical facts -> null (NOOP)', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, factBlock('FACT-8001', { claim: NON_TECHNICAL_CLAIM, verifiedAt: '2026-09-20' }) + '\n' + factBlock('FACT-8002', { claim: 'Another plain marketing sentence.', verifiedAt: '2026-09-20' }));
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    const factSet = selectWeeklyFactSet(db, 'devto', rankedFrom(factsPath));
    assert.equal(factSet, null);
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('selectWeeklyFactSet: old/pre-activation facts are excluded from the set, even when otherwise technical', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFacts(1, { verifiedAt: '2020-01-01' }) + '\n' + technicalFacts(1, { verifiedAt: '2026-09-20', startIndex: 1 }));
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2026-01-01T00:00:00.000Z'); // AFTER the first fact's VERIFIED_AT
    const factSet = selectWeeklyFactSet(db, 'devto', rankedFrom(factsPath));
    // Only ONE fact is post-activation -> below MIN_WEEKLY_FACTS -> NOOP.
    assert.equal(factSet, null);
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('selectWeeklyFactSet: a different-product technical fact never joins an unrelated set (coherence, not a random bag)', () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFacts(2) + '\n' + factBlock('FACT-8100', { product: 'ECHO App', claim: OTHER_PRODUCT_TECHNICAL_CLAIM, verifiedAt: '2026-09-20' }));
    const db = openDb(dbPath);
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    const factSet = selectWeeklyFactSet(db, 'devto', rankedFrom(factsPath));
    assert.ok(factSet);
    assert.ok(factSet.every((f) => f.PRODUCT === 'ECHO Agent'));
    assert.ok(!factSet.some((f) => f.id === 'FACT-8100'));
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- channel-native rendering ---

test('DEV.to/Qiita weekly rendering: channel-native content, not identical copy', () => {
  const { dir, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFacts(2));
    const factSet = rankedFrom(factsPath).map((r) => r.fact);
    const devtoDraft = draftWeeklyDevToArticle(factSet);
    const qiitaDraft = draftWeeklyQiitaArticle(factSet);
    assert.ok(devtoDraft);
    assert.ok(qiitaDraft);
    assert.equal(devtoDraft.channel, 'devto');
    assert.equal(qiitaDraft.channel, 'qiita');
    assert.notEqual(devtoDraft.title, qiitaDraft.title);
    assert.notEqual(devtoDraft.long_text, qiitaDraft.long_text);
    assert.match(qiitaDraft.title, /[぀-ヿ一-龯]/, 'qiita title should be Japanese');
    assert.ok(devtoDraft.tags.length <= 4, 'devto allows at most 4 tags');
    assert.ok(qiitaDraft.tags.length >= 1, 'qiita requires at least one tag');
    assert.deepEqual(devtoDraft.factIds.sort(), qiitaDraft.factIds.sort(), 'both cover the SAME underlying fact set, just rendered natively');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('draftWeeklyDevToArticle/draftWeeklyQiitaArticle: refuse (null) below MIN_WEEKLY_FACTS even if individually technical', () => {
  const { dir, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFacts(1));
    const factSet = rankedFrom(factsPath).map((r) => r.fact);
    assert.equal(draftWeeklyDevToArticle(factSet), null);
    assert.equal(draftWeeklyQiitaArticle(factSet), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- publishWeeklyLongForm: full gate pipeline ---

test('publishWeeklyLongForm: all gates satisfied -> exactly one eligible PUBLISHED weekly article', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFacts(3));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    const factSet = selectWeeklyFactSet(db, 'devto', rankedFrom(factsPath));
    assert.ok(factSet);

    await withLive(async () => {
      const result = await publishWeeklyLongForm(db, 'devto', factSet, draftWeeklyDevToArticle, { env: DEVTO_ENV, fetchImpl: fakeDevtoFetch() });
      assert.equal(result.status, 'PUBLISHED');
      assert.ok(result.externalUrl);
    });
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('publishWeeklyLongForm: duplicate article prevention -- re-running the SAME weekly set is idempotent, zero additional external writes', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFacts(3));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    const factSet = selectWeeklyFactSet(db, 'devto', rankedFrom(factsPath));

    let externalCalls = 0;
    const fetchImpl = async (...a) => { externalCalls++; return fakeDevtoFetch()(...a); };

    await withLive(async () => {
      const first = await publishWeeklyLongForm(db, 'devto', factSet, draftWeeklyDevToArticle, { env: DEVTO_ENV, fetchImpl });
      const second = await publishWeeklyLongForm(db, 'devto', factSet, draftWeeklyDevToArticle, { env: DEVTO_ENV, fetchImpl });
      assert.equal(first.status, 'PUBLISHED');
      assert.equal(second.status, 'PUBLISHED');
      assert.equal(second.idempotent, true);
      assert.equal(second.publicationId, first.publicationId);
    });
    assert.equal(externalCalls, 1, 'exactly the ONE real call from the first run only');
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('publishWeeklyLongForm: weekly cap -- a 3rd devto publish within the weekly window is blocked, zero external write', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2020-01-01T00:00:00.000Z' });

    let externalCalls = 0;
    const fetchImpl = async (...a) => { externalCalls++; return fakeDevtoFetch()(...a); };

    await withLive(async () => {
      // Two prior distinct weekly sets, both published, filling the perWeek:2 cap.
      for (const seed of [10, 20]) {
        writeFileSync(factsPath, technicalFacts(2, { startIndex: seed }));
        const set = selectWeeklyFactSet(db, 'devto', rankedFrom(factsPath));
        const result = await publishWeeklyLongForm(db, 'devto', set, draftWeeklyDevToArticle, { env: DEVTO_ENV, fetchImpl });
        assert.equal(result.status, 'PUBLISHED');
      }
      // A third, genuinely different set -- cap should now block it.
      writeFileSync(factsPath, technicalFacts(2, { startIndex: 30 }));
      const thirdSet = selectWeeklyFactSet(db, 'devto', rankedFrom(factsPath));
      const third = await publishWeeklyLongForm(db, 'devto', thirdSet, draftWeeklyDevToArticle, { env: DEVTO_ENV, fetchImpl });
      // BASELINE_SKIPPED is reserved specifically for the pre-activation
      // case (matching lib/multiChannelPublish.mjs's own status logic
      // exactly) -- a frequency-capped block, live+enabled+authed
      // otherwise, is DRY_RUN_OK, same as the daily gate's own frequency-
      // cap test (devtoScheduler.test.mjs's "max 2 articles per week").
      assert.equal(third.status, 'DRY_RUN_OK');
      assert.match(third.reason, /weekly cap/);
    });
    assert.equal(externalCalls, 2, 'only the first two real calls -- the third never reached the connector');
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('publishWeeklyLongForm: temporary channel failure (connector error) does not duplicate -- one failed ledger row, no silent retry storm', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFacts(2));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    const factSet = selectWeeklyFactSet(db, 'devto', rankedFrom(factsPath));

    await withLive(async () => {
      const result = await publishWeeklyLongForm(db, 'devto', factSet, draftWeeklyDevToArticle, { env: DEVTO_ENV, fetchImpl: failingDevtoFetch() });
      assert.equal(result.status, 'PUBLISH_FAILED');
      const row = db.prepare('SELECT * FROM publication_ledger WHERE publication_id = ?').get(result.publicationId);
      assert.ok(row);
      assert.equal(row.published_at, null);
      assert.match(row.result, /^FAILED/);
      const allRows = db.prepare('SELECT COUNT(*) c FROM publication_ledger WHERE channel = ?').get('devto');
      assert.equal(allRows.c, 1, 'exactly one ledger row for this attempt, not a duplicate');
    });
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('publishWeeklyLongForm: DRY_RUN mode never calls the real connector', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFacts(2));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    const factSet = selectWeeklyFactSet(db, 'devto', rankedFrom(factsPath));

    let called = false;
    const fetchImpl = async (...a) => { called = true; return fakeDevtoFetch()(...a); };
    const prevMode = process.env.MARKETING_MODE;
    process.env.MARKETING_MODE = 'DRY_RUN';
    try {
      const result = await publishWeeklyLongForm(db, 'devto', factSet, draftWeeklyDevToArticle, { env: DEVTO_ENV, fetchImpl });
      assert.equal(result.status, 'DRY_RUN_OK');
      assert.equal(called, false);
    } finally {
      process.env.MARKETING_MODE = prevMode;
    }
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- runWeeklyLongFormOnce: full operator entrypoint ---

test('runWeeklyLongFormOnce: end-to-end -- DEV.to publishes, and Qiita (selecting the SAME underlying fact set from this small pool) is correctly cross-channel-burst-staggered behind it, exactly like the daily operator\'s own short-form channels', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFacts(3));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    qiitaReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      const env = { ...DEVTO_ENV, ...QIITA_ENV };
      const fetchImpl = async (url, opts) => {
        if (url.includes('dev.to')) return fakeDevtoFetch()(url, opts);
        if (url.includes('qiita.com')) return fakeQiitaFetch()(url, opts);
        throw new Error(`UNEXPECTED_URL_IN_TEST: ${url}`);
      };
      const result = await runWeeklyLongFormOnce({ dbPath, factsPath, env, fetchImpl });
      // devto runs first inside runWeeklyLongFormOnce and publishes; qiita
      // draws from the same small technical-fact pool, so it independently
      // selects the IDENTICAL fact set (same canonicalContentId, derived
      // purely from the fact ids) -- lib/frequencyGuards.mjs's
      // checkCanonicalContentStagger() then correctly blocks it from
      // publishing within the 5-minute window, exactly as it already
      // blocks the daily operator's own devto/qiita cycles from bursting
      // the same canonical content simultaneously (never a weaker rule
      // for weekly than for daily).
      assert.equal(result.devto.status, 'PUBLISHED');
      assert.equal(result.qiita.status, 'DRY_RUN_OK');
      assert.match(result.qiita.reason, /stagger/i);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runWeeklyLongFormOnce: DEV.to and Qiita both publish when they select genuinely DIFFERENT fact sets (no canonical-content collision)', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    // devto has already covered the first 2 facts (as if from an earlier
    // weekly run) -- devto's own next selection skips them via
    // isPermanentlyIneligibleForChannel's alreadyPublished check, so it
    // picks a genuinely different set than qiita (which has not).
    writeFileSync(factsPath, technicalFacts(4));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    qiitaReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    const preSeedDb = openDb(dbPath);
    const preSeedFactSet = selectWeeklyFactSet(preSeedDb, 'devto', rankedFrom(factsPath)).slice(0, 2);
    await withLive(async () => {
      const fetchImpl = fakeDevtoFetch();
      const seedResult = await publishWeeklyLongForm(preSeedDb, 'devto', preSeedFactSet, draftWeeklyDevToArticle, { env: DEVTO_ENV, fetchImpl });
      assert.equal(seedResult.status, 'PUBLISHED');
    });
    closeDb(preSeedDb);

    await withLive(async () => {
      const env = { ...DEVTO_ENV, ...QIITA_ENV };
      const fetchImpl = async (url, opts) => {
        if (url.includes('dev.to')) return fakeDevtoFetch()(url, opts);
        if (url.includes('qiita.com')) return fakeQiitaFetch()(url, opts);
        throw new Error(`UNEXPECTED_URL_IN_TEST: ${url}`);
      };
      const result = await runWeeklyLongFormOnce({ dbPath, factsPath, env, fetchImpl });
      assert.equal(result.devto.status, 'PUBLISHED');
      assert.equal(result.qiita.status, 'PUBLISHED');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runWeeklyLongFormOnce: insufficient material on both channels -> NOOP, zero writes', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, factBlock('FACT-8000', { claim: NON_TECHNICAL_CLAIM, verifiedAt: '2026-09-20' }));
    const db = openDb(dbPath);
    devtoReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    qiitaReady(db, { atOrAfter: '2026-09-01T00:00:00.000Z' });
    closeDb(db);

    await withLive(async () => {
      let called = false;
      const fetchImpl = async () => { called = true; throw new Error('should never be called'); };
      const env = { ...DEVTO_ENV, ...QIITA_ENV };
      const result = await runWeeklyLongFormOnce({ dbPath, factsPath, env, fetchImpl });
      assert.equal(result.devto.status, 'NOOP');
      assert.equal(result.qiita.status, 'NOOP');
      assert.equal(called, false);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runWeeklyLongFormOnce: overlap protection -- refuses to run while the shared operator_lock is held (by daily or another weekly run)', async () => {
  const { dir, dbPath, factsPath } = tempEnv();
  try {
    writeFileSync(factsPath, technicalFacts(3));
    const db = openDb(dbPath);
    // Simulate the daily operator (or another weekly run) already holding the lock.
    db.prepare('INSERT INTO operator_lock (id, run_id, pid, host, started_at) VALUES (1, ?, ?, ?, ?)')
      .run('other-run', process.pid, 'test-host', new Date().toISOString());
    closeDb(db);

    const result = await runWeeklyLongFormOnce({ dbPath, factsPath, env: { ...DEVTO_ENV, ...QIITA_ENV } });
    assert.equal(result.status, 'SKIP_OVERLAP');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
