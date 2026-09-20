import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { loadFacts } from '../lib/facts.mjs';
import { CANARY_QIITA_TITLE, CANARY_QIITA_BODY } from '../lib/canary.mjs';
import {
  buildQiitaFirstArticleCandidate, validateQiitaFirstArticleCandidate, writeQiitaFirstArticleCandidate,
  recordQiitaFirstArticlePending, getQiitaFirstArticleApprovalState, readQiitaFirstArticleManifest,
  checkNoDevtoDuplication, approveQiitaFirstArticle, publishApprovedQiitaFirstArticle,
  QIITA_FIRST_ARTICLE_TITLE, QIITA_FIRST_ARTICLE_IDEMPOTENCY_KEY,
} from '../lib/qiitaFirstArticle.mjs';
import { recordAuthCheck, recordCanary } from '../lib/channelState.mjs';

const FACTS_PATH = new URL('../../../docs/marketing/VERITAS_FORGE_PUBLIC_FACTS.md', import.meta.url).pathname;

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-qiita-first-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

function tempDirs() {
  const contentDir = mkdtempSync(join(tmpdir(), 'marketing-qiita-first-content-'));
  const reviewDir = mkdtempSync(join(tmpdir(), 'marketing-qiita-first-review-'));
  return { contentDir, reviewDir };
}

test('buildQiitaFirstArticleCandidate: builds a real candidate against the real fact registry, citing VERIFIED/PARTIAL facts correctly', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildQiitaFirstArticleCandidate(facts);
  assert.equal(built.ok, true);
  assert.equal(built.candidate.title, QIITA_FIRST_ARTICLE_TITLE);
  assert.equal(built.candidate.channel, 'qiita');
  assert.ok(built.candidate.tags.length > 0 && built.candidate.tags.length <= 5);
  assert.ok(built.candidate.body_markdown.length > 800);
  assert.equal(built.candidate.canonical_content_id, QIITA_FIRST_ARTICLE_IDEMPOTENCY_KEY);
  // Primary facts required by the mandate.
  assert.ok(built.candidate.factIds.includes('FACT-009'));
  assert.ok(built.candidate.factIds.includes('FACT-010'));
  // Facts explicitly to avoid unless needed — not used here.
  assert.ok(!built.candidate.factIds.includes('FACT-013'));
  assert.ok(!built.candidate.factIds.includes('FACT-014'));
  assert.ok(!built.candidate.factIds.includes('FACT-015'));
  assert.equal(built.reviewManifest.claims.length, built.reviewManifest.claims.length); // sections may repeat a factId
  assert.ok(built.reviewManifest.claims.every((c) => c.sourcePath && c.sourceRepository));
});

test('buildQiitaFirstArticleCandidate: refuses if a cited fact id does not exist in the registry', () => {
  const facts = loadFacts(FACTS_PATH).filter((f) => f.id !== 'FACT-009');
  const built = buildQiitaFirstArticleCandidate(facts);
  assert.equal(built.ok, false);
  assert.equal(built.reason, 'MISSING_FACTS');
  assert.ok(built.missing.includes('FACT-009'));
});

test('FACT-008 (if used) is labeled explicitly PARTIAL / simulated planner-swap only, never as a demonstrated real provider swap', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildQiitaFirstArticleCandidate(facts);
  if (!built.candidate.factIds.includes('FACT-008')) return; // not used — nothing to check
  const claim = built.reviewManifest.claims.find((c) => c.factId === 'FACT-008');
  assert.equal(claim.factStatus, 'PARTIAL');
  assert.match(built.candidate.body_markdown, /PARTIAL/);
  assert.match(built.candidate.body_markdown, /プロバイダー/); // discusses the provider-swap caveat
  assert.match(built.candidate.body_markdown, /実証されていない/); // explicitly states the real-provider-swap claim is not yet demonstrated
});

test('validateQiitaFirstArticleCandidate: the real generated candidate passes with zero violations', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildQiitaFirstArticleCandidate(facts);
  const check = validateQiitaFirstArticleCandidate(built.candidate, facts);
  assert.deepEqual(check.violations, []);
  assert.equal(check.ok, true);
});

test('validateQiitaFirstArticleCandidate: FAILS when the article title/body duplicates the private canary content', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildQiitaFirstArticleCandidate(facts);
  const check1 = validateQiitaFirstArticleCandidate({ ...built.candidate, title: CANARY_QIITA_TITLE }, facts);
  assert.equal(check1.ok, false);
  assert.ok(check1.violations.includes('DUPLICATES_CANARY_CONTENT'));

  const check2 = validateQiitaFirstArticleCandidate({ ...built.candidate, body_markdown: CANARY_QIITA_BODY }, facts);
  assert.equal(check2.ok, false);
  assert.ok(check2.violations.includes('DUPLICATES_CANARY_CONTENT'));
});

test('validateQiitaFirstArticleCandidate: FAILS on more than 5 tags', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildQiitaFirstArticleCandidate(facts);
  const check = validateQiitaFirstArticleCandidate({ ...built.candidate, tags: ['a', 'b', 'c', 'd', 'e', 'f'] }, facts);
  assert.equal(check.ok, false);
  assert.ok(check.violations.includes('INVALID_TAG_COUNT'));
});

test('validateQiitaFirstArticleCandidate: FAILS if a cited fact id is unknown or not PUBLIC_SAFE', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildQiitaFirstArticleCandidate(facts);

  const unknown = validateQiitaFirstArticleCandidate({ ...built.candidate, factIds: [...built.candidate.factIds, 'FACT-999'] }, facts);
  assert.equal(unknown.ok, false);
  assert.ok(unknown.violations.includes('UNKNOWN_FACT_ID:FACT-999'));

  const notPublicSafe = facts.map((f) => (f.id === 'FACT-009' ? { ...f, PUBLIC_SAFE: 'false' } : f));
  const check = validateQiitaFirstArticleCandidate(built.candidate, notPublicSafe);
  assert.equal(check.ok, false);
  assert.ok(check.violations.includes('FACT_NOT_PUBLIC_SAFE:FACT-009'));
});

test('validateQiitaFirstArticleCandidate: FAILS on internal-only operational paths/secrets/real repo file paths leaking into the body', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildQiitaFirstArticleCandidate(facts);
  const leaked1 = { ...built.candidate, body_markdown: `${built.candidate.body_markdown}\n\nSee tools/marketing/lib/canary.mjs and QIITA_ACCESS_TOKEN.` };
  const check1 = validateQiitaFirstArticleCandidate(leaked1, facts);
  assert.equal(check1.ok, false);
  assert.ok(check1.violations.some((v) => v.startsWith('INTERNAL_PATH_LEAK')));

  const leaked2 = { ...built.candidate, body_markdown: `${built.candidate.body_markdown}\n\n実装は echo_agent_continuity_permission_v1.py にある。` };
  const check2 = validateQiitaFirstArticleCandidate(leaked2, facts);
  assert.equal(check2.ok, false);
  assert.ok(check2.violations.some((v) => v.startsWith('INTERNAL_PATH_LEAK')));
});

test('validateQiitaFirstArticleCandidate: FAILS on hype/marketing language (English and Japanese)', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildQiitaFirstArticleCandidate(facts);
  const hypedEn = { ...built.candidate, body_markdown: `${built.candidate.body_markdown}\n\nThis is a truly revolutionary, game-changing breakthrough.` };
  assert.ok(validateQiitaFirstArticleCandidate(hypedEn, facts).violations.includes('HYPE_LANGUAGE'));

  const hypedJa = { ...built.candidate, body_markdown: `${built.candidate.body_markdown}\n\nこれは業界初の画期的な技術です。` };
  assert.ok(validateQiitaFirstArticleCandidate(hypedJa, facts).violations.includes('HYPE_LANGUAGE'));
});

test('validateQiitaFirstArticleCandidate: FAILS on unsupported superiority / fake testimonial / fabricated metric language (shared policy gate)', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildQiitaFirstArticleCandidate(facts);
  const superlative = { ...built.candidate, body_markdown: `${built.candidate.body_markdown}\n\nWe are the best AI identity system, guaranteed.` };
  const check = validateQiitaFirstArticleCandidate(superlative, facts);
  assert.equal(check.ok, false);
  assert.ok(check.violations.includes('UNSUPPORTED_SUPERIORITY'));
});

test('checkNoDevtoDuplication: the real Qiita article shares no paragraph with the real DEV.to first article', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildQiitaFirstArticleCandidate(facts);
  const dup = checkNoDevtoDuplication(built.candidate.body_markdown, facts);
  assert.equal(dup.ok, true);
  assert.equal(dup.checked, true);
});

test('checkNoDevtoDuplication: FAILS when a paragraph is copied verbatim from the DEV.to article', async () => {
  const facts = loadFacts(FACTS_PATH);
  const { buildDevToFirstArticleCandidate } = await import('../lib/devtoFirstArticle.mjs');
  const devto = buildDevToFirstArticleCandidate(facts);
  const copiedParagraph = devto.candidate.body_markdown.split(/\n\n+/).find((p) => p.length >= 40);
  const dup = checkNoDevtoDuplication(`前置き\n\n${copiedParagraph}\n\n続き`, facts);
  assert.equal(dup.ok, false);
});

test('validateQiitaFirstArticleCandidate: FAILS end-to-end when duplicate DEV.to content is present', async () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildQiitaFirstArticleCandidate(facts);
  const { buildDevToFirstArticleCandidate } = await import('../lib/devtoFirstArticle.mjs');
  const devto = buildDevToFirstArticleCandidate(facts);
  const copiedParagraph = devto.candidate.body_markdown.split(/\n\n+/).find((p) => p.length >= 40);
  const duplicated = { ...built.candidate, body_markdown: `${built.candidate.body_markdown}\n\n${copiedParagraph}` };
  const check = validateQiitaFirstArticleCandidate(duplicated, facts);
  assert.equal(check.ok, false);
  assert.ok(check.violations.includes('DUPLICATE_DEVTO_CONTENT'));
});

test('writeQiitaFirstArticleCandidate: writes a real markdown article + a separate private manifest, and is idempotent', () => {
  const { contentDir, reviewDir } = tempDirs();
  try {
    const facts = loadFacts(FACTS_PATH);
    const built = buildQiitaFirstArticleCandidate(facts);
    const first = writeQiitaFirstArticleCandidate(built.candidate, built.reviewManifest, { contentDir, reviewDir });
    assert.equal(first.writtenArticle, true);
    assert.equal(first.writtenManifest, true);
    assert.ok(existsSync(first.articlePath));
    assert.ok(existsSync(first.manifestPath));

    const articleText = readFileSync(first.articlePath, 'utf8');
    assert.match(articleText, /reviewed_and_submitted: false/);
    assert.doesNotMatch(articleText, /tools\/marketing/);
    assert.doesNotMatch(articleText, /echo_agent_continuity_permission_v1\.py/);

    const manifest = readQiitaFirstArticleManifest(first.manifestPath);
    assert.equal(manifest.exists, true);
    assert.ok(manifest.manifest.claims.length >= 3);
    assert.ok(manifest.manifest.claims.every((c) => c.sourcePath));

    const second = writeQiitaFirstArticleCandidate(built.candidate, built.reviewManifest, { contentDir, reviewDir });
    assert.equal(second.writtenArticle, false);
    assert.equal(second.writtenManifest, false);
    assert.equal(second.articlePath, first.articlePath);
  } finally {
    rmSync(contentDir, { recursive: true, force: true });
    rmSync(reviewDir, { recursive: true, force: true });
  }
});

test('recordQiitaFirstArticlePending + getQiitaFirstArticleApprovalState: ends in PENDING_HUMAN_APPROVAL, never approved, idempotent', () => {
  const { dir, db } = tempDb();
  try {
    const facts = loadFacts(FACTS_PATH);
    const built = buildQiitaFirstArticleCandidate(facts);

    const before = getQiitaFirstArticleApprovalState(db, built.candidate);
    assert.equal(before.exists, false);
    assert.equal(before.approved, false);

    const pending1 = recordQiitaFirstArticlePending(db, built.candidate);
    assert.equal(pending1.status, 'PENDING_APPROVAL');

    const after = getQiitaFirstArticleApprovalState(db, built.candidate);
    assert.equal(after.exists, true);
    assert.equal(after.pending, true);
    assert.equal(after.published, false);
    assert.equal(after.approved, false, 'QIITA_FIRST_PUBLIC_APPROVED must stay false — recording PENDING alone must never flip it; only an explicit approveQiitaFirstArticle() call can');

    const row = db.prepare('SELECT approval_state, published_at FROM publication_ledger WHERE publication_id = ?').get(pending1.publicationId);
    assert.equal(row.approval_state, 'PENDING_HUMAN_APPROVAL');
    assert.equal(row.published_at, null);

    // Idempotent: recording again for the same candidate text reuses the same ledger row.
    const pending2 = recordQiitaFirstArticlePending(db, built.candidate);
    assert.equal(pending2.publicationId, pending1.publicationId);

    const count = db.prepare("SELECT COUNT(*) c FROM publication_ledger WHERE channel = 'qiita' AND content_type = ?").get(built.candidate.actionType).c;
    assert.equal(count, 1, 'a rerun must never create a second pending row for the same candidate');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('approveQiitaFirstArticle: refuses to approve content that was never recorded PENDING', () => {
  const { dir, db } = tempDb();
  try {
    const facts = loadFacts(FACTS_PATH);
    const built = buildQiitaFirstArticleCandidate(facts);
    const result = approveQiitaFirstArticle(db, built.candidate);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'NOT_PENDING');
    const state = getQiitaFirstArticleApprovalState(db, built.candidate);
    assert.equal(state.approved, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('approveQiitaFirstArticle: transitions PENDING_HUMAN_APPROVAL -> HUMAN_APPROVED (QIITA_FIRST_PUBLIC_APPROVED=true), binding to the exact content hash, durably and idempotently', () => {
  const { dir, db } = tempDb();
  try {
    const facts = loadFacts(FACTS_PATH);
    const built = buildQiitaFirstArticleCandidate(facts);
    recordQiitaFirstArticlePending(db, built.candidate);

    const first = approveQiitaFirstArticle(db, built.candidate);
    assert.equal(first.ok, true);
    assert.equal(first.alreadyApproved, false);

    const state = getQiitaFirstArticleApprovalState(db, built.candidate);
    assert.equal(state.approved, true);
    assert.equal(state.published, false, 'approval must never imply publication');

    // Idempotent re-approval.
    const second = approveQiitaFirstArticle(db, built.candidate);
    assert.equal(second.ok, true);
    assert.equal(second.alreadyApproved, true);
    assert.equal(second.publicationId, first.publicationId);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('approval binds to the exact content hash: editing the article after approval requires re-approval, never silently publishes new text', () => {
  const { dir, db } = tempDb();
  try {
    const facts = loadFacts(FACTS_PATH);
    const built = buildQiitaFirstArticleCandidate(facts);
    recordQiitaFirstArticlePending(db, built.candidate);
    approveQiitaFirstArticle(db, built.candidate);

    const edited = { ...built.candidate, body_markdown: `${built.candidate.body_markdown}\n\n一文追加。` };
    const editedState = getQiitaFirstArticleApprovalState(db, edited);
    assert.equal(editedState.exists, false);
    assert.equal(editedState.approved, false, 'a wording change after approval must never inherit the old approval');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('no global approval leakage: approving the Qiita first article has zero effect on the DEV.to first article\'s own approval state', async () => {
  const { dir, db } = tempDb();
  try {
    const facts = loadFacts(FACTS_PATH);
    const built = buildQiitaFirstArticleCandidate(facts);
    recordQiitaFirstArticlePending(db, built.candidate);
    approveQiitaFirstArticle(db, built.candidate);

    const { buildDevToFirstArticleCandidate, getDevToFirstArticleApprovalState } = await import('../lib/devtoFirstArticle.mjs');
    const devtoBuilt = buildDevToFirstArticleCandidate(facts);
    const devtoState = getDevToFirstArticleApprovalState(db, devtoBuilt.candidate);
    assert.equal(devtoState.exists, false);
    assert.equal(devtoState.approved, false, 'approving the Qiita article must never approve or create a row for the unrelated DEV.to article');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

function fakeQiitaResponse({ status = 200, body = {} } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

function approvedFixture(db) {
  const facts = loadFacts(FACTS_PATH);
  const built = buildQiitaFirstArticleCandidate(facts);
  recordQiitaFirstArticlePending(db, built.candidate);
  approveQiitaFirstArticle(db, built.candidate);
  recordAuthCheck(db, 'qiita', { authValid: true, accountIdentifier: '@Veritas_Forge', permissionsSufficient: true });
  recordCanary(db, 'qiita', { passed: true, externalId: '24d097823c81f2914e9b', externalUrl: 'https://qiita.com/Veritas_Forge/private/24d097823c81f2914e9b' });
  return built.candidate;
}

test('publishApprovedQiitaFirstArticle: refuses when the article was never approved', async () => {
  const { dir, db } = tempDb();
  try {
    const facts = loadFacts(FACTS_PATH);
    const built = buildQiitaFirstArticleCandidate(facts);
    let called = false;
    const qiitaClient = { getIdentity: async () => { called = true; return { ok: true }; } };
    const result = await publishApprovedQiitaFirstArticle(db, built.candidate, { qiitaClient });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'NOT_APPROVED');
    assert.equal(called, false, 'must never even check identity for unapproved content');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishApprovedQiitaFirstArticle: refuses when AUTH_VALID is not durably recorded, even if approved', async () => {
  const { dir, db } = tempDb();
  try {
    const facts = loadFacts(FACTS_PATH);
    const built = buildQiitaFirstArticleCandidate(facts);
    recordQiitaFirstArticlePending(db, built.candidate);
    approveQiitaFirstArticle(db, built.candidate);
    let called = false;
    const qiitaClient = { getIdentity: async () => { called = true; return { ok: true }; } };
    const result = await publishApprovedQiitaFirstArticle(db, built.candidate, { qiitaClient });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'AUTH_NOT_VALID_LOCALLY');
    assert.equal(called, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishApprovedQiitaFirstArticle: refuses when CANARY_PASS is not durably recorded, even if approved and auth valid', async () => {
  const { dir, db } = tempDb();
  try {
    const facts = loadFacts(FACTS_PATH);
    const built = buildQiitaFirstArticleCandidate(facts);
    recordQiitaFirstArticlePending(db, built.candidate);
    approveQiitaFirstArticle(db, built.candidate);
    recordAuthCheck(db, 'qiita', { authValid: true, accountIdentifier: '@Veritas_Forge', permissionsSufficient: true });
    // No recordCanary — canary_passed stays false.
    let called = false;
    const qiitaClient = { getIdentity: async () => { called = true; return { ok: true }; } };
    const result = await publishApprovedQiitaFirstArticle(db, built.candidate, { qiitaClient });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'CANARY_NOT_PASSED');
    assert.equal(called, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishApprovedQiitaFirstArticle: approved + auth valid + canary passed => real publish, private=false confirmed explicitly, records id/url', async () => {
  const { dir, db } = tempDb();
  try {
    const candidate = approvedFixture(db);
    let createCalls = 0;
    const qiitaClient = {
      getIdentity: async () => ({ ok: true, identifier: '@Veritas_Forge' }),
      getMyItems: async () => ({ ok: true, items: [] }),
      createItem: async (payload) => {
        createCalls++;
        assert.equal(payload.isPrivate, false);
        assert.equal(payload.title, candidate.title);
        assert.equal(payload.body, candidate.body_markdown);
        return { ok: true, id: 'pub1234567890abcdef', url: 'https://qiita.com/Veritas_Forge/items/pub1234567890abcdef', private: false };
      },
    };
    const result = await publishApprovedQiitaFirstArticle(db, candidate, { qiitaClient });
    assert.equal(result.ok, true);
    assert.equal(result.private, false);
    assert.equal(result.externalId, 'pub1234567890abcdef');
    assert.equal(result.externalUrl, 'https://qiita.com/Veritas_Forge/items/pub1234567890abcdef');
    assert.equal(createCalls, 1);

    const state = getQiitaFirstArticleApprovalState(db, candidate);
    assert.equal(state.published, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishApprovedQiitaFirstArticle: FAILS CLOSED when the create response explicitly confirms private=true', async () => {
  const { dir, db } = tempDb();
  try {
    const candidate = approvedFixture(db);
    const qiitaClient = {
      getIdentity: async () => ({ ok: true }),
      getMyItems: async () => ({ ok: true, items: [] }),
      createItem: async () => ({ ok: true, id: 'priv1', url: 'https://qiita.com/x/priv1', private: true }),
    };
    const result = await publishApprovedQiitaFirstArticle(db, candidate, { qiitaClient });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'PRIVATE_TRUE');
    const state = getQiitaFirstArticleApprovalState(db, candidate);
    assert.equal(state.published, false, 'CANARY-style safety: private=true must never be recorded as a successful public publish');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishApprovedQiitaFirstArticle: create response omits `private`, but reconciliation confirms PUBLIC => PASS', async () => {
  const { dir, db } = tempDb();
  try {
    const candidate = approvedFixture(db);
    const qiitaClient = {
      getIdentity: async () => ({ ok: true }),
      getMyItems: async () => ({ ok: true, items: [] }),
      createItem: async () => ({ ok: true, id: 'amb1', url: 'https://qiita.com/x/amb1' }), // no `private`
      reconcileItemStatus: async (id) => { assert.equal(id, 'amb1'); return { ok: true, status: 'PUBLIC' }; },
    };
    const result = await publishApprovedQiitaFirstArticle(db, candidate, { qiitaClient });
    assert.equal(result.ok, true);
    assert.equal(result.private, false);
    assert.equal(result.externalId, 'amb1');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishApprovedQiitaFirstArticle: create response omits `private`, and reconciliation cannot confirm PUBLIC => FAIL CLOSED', async () => {
  const { dir, db } = tempDb();
  try {
    const candidate = approvedFixture(db);
    const qiitaClient = {
      getIdentity: async () => ({ ok: true }),
      getMyItems: async () => ({ ok: true, items: [] }),
      createItem: async () => ({ ok: true, id: 'amb2', url: 'https://qiita.com/x/amb2' }), // no `private`
      reconcileItemStatus: async () => ({ ok: true, status: 'PRIVATE' }),
    };
    const result = await publishApprovedQiitaFirstArticle(db, candidate, { qiitaClient });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'VISIBILITY_NOT_CONFIRMED_PUBLIC');
    const state = getQiitaFirstArticleApprovalState(db, candidate);
    assert.equal(state.published, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishApprovedQiitaFirstArticle: a matching remote PUBLIC item already exists (crash/local-state-loss) => adopt it, zero create-item calls', async () => {
  const { dir, db } = tempDb();
  try {
    const candidate = approvedFixture(db);
    let createCalls = 0;
    const qiitaClient = {
      getIdentity: async () => ({ ok: true }),
      getMyItems: async () => ({
        ok: true,
        items: [{ id: 'recovered1', title: candidate.title, url: 'https://qiita.com/Veritas_Forge/items/recovered1', private: false }],
      }),
      createItem: async () => { createCalls++; return { ok: true, id: 'x', url: 'x', private: false }; },
    };
    const result = await publishApprovedQiitaFirstArticle(db, candidate, { qiitaClient });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyPublished, true);
    assert.equal(result.adopted, true);
    assert.equal(result.externalId, 'recovered1');
    assert.equal(createCalls, 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishApprovedQiitaFirstArticle: a matching remote PRIVATE item with the same title => FAIL CLOSED, never adopt, never create a second item', async () => {
  const { dir, db } = tempDb();
  try {
    const candidate = approvedFixture(db);
    let createCalls = 0;
    const qiitaClient = {
      getIdentity: async () => ({ ok: true }),
      getMyItems: async () => ({
        ok: true,
        items: [{ id: 'stray-private', title: candidate.title, url: 'https://qiita.com/x/stray-private', private: true }],
      }),
      createItem: async () => { createCalls++; return { ok: true, id: 'x', url: 'x', private: false }; },
    };
    const result = await publishApprovedQiitaFirstArticle(db, candidate, { qiitaClient });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'REMOTE_ITEM_EXISTS_PRIVATE');
    assert.equal(createCalls, 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('the private canary item is never treated as a match for the public article (different deterministic titles)', async () => {
  const { dir, db } = tempDb();
  try {
    const candidate = approvedFixture(db);
    let createCalls = 0;
    const qiitaClient = {
      getIdentity: async () => ({ ok: true }),
      getMyItems: async () => ({
        ok: true,
        // The real private canary item, with its own distinct deterministic title.
        items: [{ id: '24d097823c81f2914e9b', title: 'Veritas Forge API Publication Canary', private: true, url: 'https://qiita.com/Veritas_Forge/private/24d097823c81f2914e9b' }],
      }),
      createItem: async (payload) => {
        createCalls++;
        assert.equal(payload.title, candidate.title);
        return { ok: true, id: 'newpub1', url: 'https://qiita.com/Veritas_Forge/items/newpub1', private: false };
      },
    };
    const result = await publishApprovedQiitaFirstArticle(db, candidate, { qiitaClient });
    assert.equal(result.ok, true);
    assert.equal(result.externalId, 'newpub1', 'a genuinely new article, never confused with the canary item');
    assert.equal(createCalls, 1);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishApprovedQiitaFirstArticle: rerun after publish is idempotent — zero network calls, no duplicate item', async () => {
  const { dir, db } = tempDb();
  try {
    const candidate = approvedFixture(db);
    const qiitaClient = {
      getIdentity: async () => ({ ok: true }),
      getMyItems: async () => ({ ok: true, items: [] }),
      createItem: async () => ({ ok: true, id: 'rerun1', url: 'https://qiita.com/x/rerun1', private: false }),
    };
    const first = await publishApprovedQiitaFirstArticle(db, candidate, { qiitaClient });
    assert.equal(first.idempotent, false);

    let calledAgain = false;
    const secondClient = { getIdentity: async () => { calledAgain = true; return { ok: true }; } };
    const second = await publishApprovedQiitaFirstArticle(db, candidate, { qiitaClient: secondClient });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyPublished, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.externalId, first.externalId);
    assert.equal(calledAgain, false, 'an already-published rerun must make zero network calls');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('this module never imports a connector directly or calls fetch itself — the real client is always injected by the caller', () => {
  const source = readFileSync(new URL('../lib/qiitaFirstArticle.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /connectors\//);
  assert.doesNotMatch(source, /\bfetch\(/);
});
