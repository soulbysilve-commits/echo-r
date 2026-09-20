import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { loadFacts } from '../lib/facts.mjs';
import { CANARY_DEVTO_TITLE, CANARY_DEVTO_BODY } from '../lib/canary.mjs';
import {
  buildDevToFirstArticleCandidate, validateDevToFirstArticleCandidate, writeDevToFirstArticleCandidate,
  recordDevToFirstArticlePending, getDevToFirstArticleApprovalState, readDevToFirstArticleManifest,
  approveDevToFirstArticle, publishApprovedDevToFirstArticle,
  DEVTO_FIRST_ARTICLE_TITLE, DEVTO_FIRST_ARTICLE_IDEMPOTENCY_KEY,
} from '../lib/devtoFirstArticle.mjs';
import { recordAuthCheck, recordCanary } from '../lib/channelState.mjs';

const FACTS_PATH = new URL('../../../docs/marketing/VERITAS_FORGE_PUBLIC_FACTS.md', import.meta.url).pathname;

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-devto-first-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

function tempDirs() {
  const contentDir = mkdtempSync(join(tmpdir(), 'marketing-devto-first-content-'));
  const reviewDir = mkdtempSync(join(tmpdir(), 'marketing-devto-first-review-'));
  return { contentDir, reviewDir };
}

test('buildDevToFirstArticleCandidate: builds a real candidate against the real fact registry, citing multiple facts', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildDevToFirstArticleCandidate(facts);
  assert.equal(built.ok, true);
  assert.equal(built.candidate.title, DEVTO_FIRST_ARTICLE_TITLE);
  assert.ok(built.candidate.description.length > 0);
  assert.ok(built.candidate.tags.length > 0 && built.candidate.tags.length <= 4);
  assert.ok(built.candidate.body_markdown.length > 1500);
  assert.ok(built.candidate.factIds.length >= 5);
  assert.equal(built.candidate.canonical_content_id, DEVTO_FIRST_ARTICLE_IDEMPOTENCY_KEY);
  assert.equal(built.reviewManifest.claims.length, built.candidate.factIds.length);
});

test('buildDevToFirstArticleCandidate: refuses if a cited fact id does not exist in the registry', () => {
  const facts = loadFacts(FACTS_PATH).filter((f) => f.id !== 'FACT-009');
  const built = buildDevToFirstArticleCandidate(facts);
  assert.equal(built.ok, false);
  assert.equal(built.reason, 'MISSING_FACTS');
  assert.ok(built.missing.includes('FACT-009'));
});

test('validateDevToFirstArticleCandidate: the real generated candidate passes with zero violations', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildDevToFirstArticleCandidate(facts);
  const check = validateDevToFirstArticleCandidate(built.candidate, facts);
  assert.deepEqual(check.violations, []);
  assert.equal(check.ok, true);
});

test('validateDevToFirstArticleCandidate: every claim label distinguishes implemented/verified from partial/planned', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildDevToFirstArticleCandidate(facts);
  const body = built.candidate.body_markdown;
  // Every VERIFIED-status fact used must be labeled Verified in the article, every PARTIAL-status fact must not claim to be Verified outright.
  for (const claim of built.reviewManifest.claims) {
    if (claim.factStatus === 'VERIFIED') {
      assert.match(claim.statusLabelInArticle, /verified/i);
    } else {
      assert.doesNotMatch(claim.statusLabelInArticle, /^Verified$/);
    }
  }
  assert.match(body, /Partial/);
});

test('validateDevToFirstArticleCandidate: FAILS when the article title/body duplicates the canary content', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildDevToFirstArticleCandidate(facts);
  const check1 = validateDevToFirstArticleCandidate({ ...built.candidate, title: CANARY_DEVTO_TITLE }, facts);
  assert.equal(check1.ok, false);
  assert.ok(check1.violations.includes('DUPLICATES_CANARY_CONTENT'));

  const check2 = validateDevToFirstArticleCandidate({ ...built.candidate, body_markdown: CANARY_DEVTO_BODY }, facts);
  assert.equal(check2.ok, false);
  assert.ok(check2.violations.includes('DUPLICATES_CANARY_CONTENT'));
});

test('validateDevToFirstArticleCandidate: FAILS on more than 4 tags', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildDevToFirstArticleCandidate(facts);
  const check = validateDevToFirstArticleCandidate({ ...built.candidate, tags: ['a', 'b', 'c', 'd', 'e'] }, facts);
  assert.equal(check.ok, false);
  assert.ok(check.violations.includes('INVALID_TAG_COUNT'));
});

test('validateDevToFirstArticleCandidate: FAILS if a cited fact id is unknown or not PUBLIC_SAFE', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildDevToFirstArticleCandidate(facts);

  const unknown = validateDevToFirstArticleCandidate({ ...built.candidate, factIds: [...built.candidate.factIds, 'FACT-999'] }, facts);
  assert.equal(unknown.ok, false);
  assert.ok(unknown.violations.includes('UNKNOWN_FACT_ID:FACT-999'));

  const notPublicSafe = facts.map((f) => (f.id === 'FACT-009' ? { ...f, PUBLIC_SAFE: 'false' } : f));
  const check = validateDevToFirstArticleCandidate(built.candidate, notPublicSafe);
  assert.equal(check.ok, false);
  assert.ok(check.violations.includes('FACT_NOT_PUBLIC_SAFE:FACT-009'));
});

test('validateDevToFirstArticleCandidate: FAILS on internal-only operational paths/secrets leaking into the body', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildDevToFirstArticleCandidate(facts);
  const leaked = { ...built.candidate, body_markdown: `${built.candidate.body_markdown}\n\nSee tools/marketing/lib/canary.mjs and DEVTO_API_KEY.` };
  const check = validateDevToFirstArticleCandidate(leaked, facts);
  assert.equal(check.ok, false);
  assert.ok(check.violations.some((v) => v.startsWith('INTERNAL_PATH_LEAK')));
});

test('validateDevToFirstArticleCandidate: FAILS on hype/marketing language', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildDevToFirstArticleCandidate(facts);
  const hyped = { ...built.candidate, body_markdown: `${built.candidate.body_markdown}\n\nThis is a truly revolutionary, game-changing breakthrough.` };
  const check = validateDevToFirstArticleCandidate(hyped, facts);
  assert.equal(check.ok, false);
  assert.ok(check.violations.includes('HYPE_LANGUAGE'));
});

test('validateDevToFirstArticleCandidate: FAILS on unsupported superiority / fake testimonial / fabricated metric language (shared policy gate)', () => {
  const facts = loadFacts(FACTS_PATH);
  const built = buildDevToFirstArticleCandidate(facts);
  const superlative = { ...built.candidate, body_markdown: `${built.candidate.body_markdown}\n\nWe are the best AI identity system, guaranteed.` };
  const check = validateDevToFirstArticleCandidate(superlative, facts);
  assert.equal(check.ok, false);
  assert.ok(check.violations.includes('UNSUPPORTED_SUPERIORITY'));
});

test('writeDevToFirstArticleCandidate: writes a real markdown article + a separate private manifest, and is idempotent', () => {
  const { contentDir, reviewDir } = tempDirs();
  try {
    const facts = loadFacts(FACTS_PATH);
    const built = buildDevToFirstArticleCandidate(facts);
    const first = writeDevToFirstArticleCandidate(built.candidate, built.reviewManifest, { contentDir, reviewDir });
    assert.equal(first.writtenArticle, true);
    assert.equal(first.writtenManifest, true);
    assert.ok(existsSync(first.articlePath));
    assert.ok(existsSync(first.manifestPath));

    const articleText = readFileSync(first.articlePath, 'utf8');
    assert.match(articleText, /published: false/);
    assert.doesNotMatch(articleText, /tools\/marketing/);

    const manifest = readDevToFirstArticleManifest(first.manifestPath);
    assert.equal(manifest.exists, true);
    assert.ok(manifest.manifest.claims.length >= 5);
    assert.ok(manifest.manifest.claims.every((c) => c.sourcePath));

    const second = writeDevToFirstArticleCandidate(built.candidate, built.reviewManifest, { contentDir, reviewDir });
    assert.equal(second.writtenArticle, false);
    assert.equal(second.writtenManifest, false);
    assert.equal(second.articlePath, first.articlePath);
  } finally {
    rmSync(contentDir, { recursive: true, force: true });
    rmSync(reviewDir, { recursive: true, force: true });
  }
});

test('recordDevToFirstArticlePending + getDevToFirstArticleApprovalState: durably PENDING, never auto-approved, idempotent', () => {
  const { dir, db } = tempDb();
  try {
    const facts = loadFacts(FACTS_PATH);
    const built = buildDevToFirstArticleCandidate(facts);

    const before = getDevToFirstArticleApprovalState(db, built.candidate);
    assert.equal(before.exists, false);
    assert.equal(before.approved, false);

    const pending1 = recordDevToFirstArticlePending(db, built.candidate);
    assert.equal(pending1.status, 'PENDING_APPROVAL');

    const after = getDevToFirstArticleApprovalState(db, built.candidate);
    assert.equal(after.exists, true);
    assert.equal(after.pending, true);
    assert.equal(after.published, false);
    assert.equal(after.approved, false, 'DEVTO_FIRST_PUBLIC_APPROVED must stay false — recording PENDING alone must never flip it; only an explicit approveDevToFirstArticle() call can');

    // Idempotent: recording again for the same candidate text reuses the same ledger row.
    const pending2 = recordDevToFirstArticlePending(db, built.candidate);
    assert.equal(pending2.publicationId, pending1.publicationId);

    const count = db.prepare("SELECT COUNT(*) c FROM publication_ledger WHERE channel = 'devto' AND content_type = ?").get(built.candidate.actionType).c;
    assert.equal(count, 1, 'a rerun must never create a second pending row for the same candidate');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('approveDevToFirstArticle: refuses to approve content that was never recorded PENDING', () => {
  const { dir, db } = tempDb();
  try {
    const facts = loadFacts(FACTS_PATH);
    const built = buildDevToFirstArticleCandidate(facts);
    const result = approveDevToFirstArticle(db, built.candidate);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'NOT_PENDING');
    const state = getDevToFirstArticleApprovalState(db, built.candidate);
    assert.equal(state.approved, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('approveDevToFirstArticle: transitions PENDING_HUMAN_APPROVAL -> HUMAN_APPROVED (DEVTO_FIRST_PUBLIC_APPROVED=true), durably and idempotently', () => {
  const { dir, db } = tempDb();
  try {
    const facts = loadFacts(FACTS_PATH);
    const built = buildDevToFirstArticleCandidate(facts);
    recordDevToFirstArticlePending(db, built.candidate);

    const first = approveDevToFirstArticle(db, built.candidate);
    assert.equal(first.ok, true);
    assert.equal(first.alreadyApproved, false);

    const state = getDevToFirstArticleApprovalState(db, built.candidate);
    assert.equal(state.approved, true);
    assert.equal(state.published, false, 'approval must never imply publication');

    // Idempotent re-approval.
    const second = approveDevToFirstArticle(db, built.candidate);
    assert.equal(second.ok, true);
    assert.equal(second.alreadyApproved, true);
    assert.equal(second.publicationId, first.publicationId);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('approveDevToFirstArticle only affects the row matching this exact content — editing the article after approval requires re-approval, never silently publishes new text', () => {
  const { dir, db } = tempDb();
  try {
    const facts = loadFacts(FACTS_PATH);
    const built = buildDevToFirstArticleCandidate(facts);
    recordDevToFirstArticlePending(db, built.candidate);
    approveDevToFirstArticle(db, built.candidate);

    const edited = { ...built.candidate, body_markdown: `${built.candidate.body_markdown}\n\nOne more edited sentence.` };
    const editedState = getDevToFirstArticleApprovalState(db, edited);
    assert.equal(editedState.exists, false);
    assert.equal(editedState.approved, false, 'a wording change after approval must never inherit the old approval');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

function fakeDevtoResponse({ status = 200, body = {} } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

function approvedFixture(db) {
  const facts = loadFacts(FACTS_PATH);
  const built = buildDevToFirstArticleCandidate(facts);
  recordDevToFirstArticlePending(db, built.candidate);
  approveDevToFirstArticle(db, built.candidate);
  recordAuthCheck(db, 'devto', { authValid: true, accountIdentifier: '@veritasforge_ai', permissionsSufficient: true });
  recordCanary(db, 'devto', { passed: true, externalId: '4669152', externalUrl: 'https://dev.to/x/canary' });
  return built.candidate;
}

test('publishApprovedDevToFirstArticle: refuses when the article was never approved', async () => {
  const { dir, db } = tempDb();
  try {
    const facts = loadFacts(FACTS_PATH);
    const built = buildDevToFirstArticleCandidate(facts);
    let called = false;
    const devtoClient = { getIdentity: async () => { called = true; return { ok: true }; } };
    const result = await publishApprovedDevToFirstArticle(db, built.candidate, { devtoClient });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'NOT_APPROVED');
    assert.equal(called, false, 'must never even check identity for unapproved content');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishApprovedDevToFirstArticle: refuses when AUTH_VALID/CANARY_PASS are not durably recorded, even if approved', async () => {
  const { dir, db } = tempDb();
  try {
    const facts = loadFacts(FACTS_PATH);
    const built = buildDevToFirstArticleCandidate(facts);
    recordDevToFirstArticlePending(db, built.candidate);
    approveDevToFirstArticle(db, built.candidate);
    let called = false;
    const devtoClient = { getIdentity: async () => { called = true; return { ok: true }; } };
    const result = await publishApprovedDevToFirstArticle(db, built.candidate, { devtoClient });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'AUTH_NOT_VALID_LOCALLY');
    assert.equal(called, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishApprovedDevToFirstArticle: approved + auth valid + canary passed => real publish, published=true confirmed explicitly, records id/url', async () => {
  const { dir, db } = tempDb();
  try {
    const candidate = approvedFixture(db);
    let createCalls = 0;
    const devtoClient = {
      getIdentity: async () => ({ ok: true, identifier: '@veritasforge_ai' }),
      getAllArticles: async () => ({ ok: true, articles: [] }),
      createArticle: async (payload) => {
        createCalls++;
        assert.equal(payload.published, true);
        assert.equal(payload.title, candidate.title);
        assert.equal(payload.body_markdown, candidate.body_markdown);
        return { ok: true, id: 5555555, url: 'https://dev.to/veritasforge_ai/how-we-separate-5555555', published: true };
      },
    };
    const result = await publishApprovedDevToFirstArticle(db, candidate, { devtoClient });
    assert.equal(result.ok, true);
    assert.equal(result.published, true);
    assert.equal(result.externalId, '5555555');
    assert.equal(result.externalUrl, 'https://dev.to/veritasforge_ai/how-we-separate-5555555');
    assert.equal(createCalls, 1);

    const state = getDevToFirstArticleApprovalState(db, candidate);
    assert.equal(state.published, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishApprovedDevToFirstArticle: rerun after publish is idempotent — zero network calls, no duplicate article', async () => {
  const { dir, db } = tempDb();
  try {
    const candidate = approvedFixture(db);
    const devtoClient = {
      getIdentity: async () => ({ ok: true }),
      getAllArticles: async () => ({ ok: true, articles: [] }),
      createArticle: async () => ({ ok: true, id: 6666666, url: 'https://dev.to/x/6666666', published: true }),
    };
    const first = await publishApprovedDevToFirstArticle(db, candidate, { devtoClient });
    assert.equal(first.idempotent, false);

    let calledAgain = false;
    const secondClient = { getIdentity: async () => { calledAgain = true; return { ok: true }; } };
    const second = await publishApprovedDevToFirstArticle(db, candidate, { devtoClient: secondClient });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyPublished, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.externalId, first.externalId);
    assert.equal(calledAgain, false, 'an already-published rerun must make zero network calls');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishApprovedDevToFirstArticle: a matching remote article already exists and is published => adopt it, zero create-article calls', async () => {
  const { dir, db } = tempDb();
  try {
    const candidate = approvedFixture(db);
    let createCalls = 0;
    const devtoClient = {
      getIdentity: async () => ({ ok: true }),
      getAllArticles: async () => ({
        ok: true,
        articles: [{ id: 7777777, title: candidate.title, url: 'https://dev.to/x/7777777', published: true }],
      }),
      createArticle: async () => { createCalls++; return { ok: true, id: 1, url: 'x', published: true }; },
    };
    const result = await publishApprovedDevToFirstArticle(db, candidate, { devtoClient });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyPublished, true);
    assert.equal(result.adopted, true);
    assert.equal(result.externalId, '7777777');
    assert.equal(createCalls, 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishApprovedDevToFirstArticle: a matching remote DRAFT (not published) with the same title => FAIL CLOSED, never create a second one', async () => {
  const { dir, db } = tempDb();
  try {
    const candidate = approvedFixture(db);
    let createCalls = 0;
    const devtoClient = {
      getIdentity: async () => ({ ok: true }),
      getAllArticles: async () => ({
        ok: true,
        articles: [{ id: 8888888, title: candidate.title, url: 'https://dev.to/x/8888888', published: false }],
      }),
      createArticle: async () => { createCalls++; return { ok: true, id: 1, url: 'x', published: true }; },
    };
    const result = await publishApprovedDevToFirstArticle(db, candidate, { devtoClient });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'REMOTE_DRAFT_EXISTS_NOT_PUBLISHED');
    assert.equal(createCalls, 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishApprovedDevToFirstArticle: create response omits published, but reconciliation confirms PUBLISHED => PASS', async () => {
  const { dir, db } = tempDb();
  try {
    const candidate = approvedFixture(db);
    const devtoClient = {
      getIdentity: async () => ({ ok: true }),
      getAllArticles: async () => ({ ok: true, articles: [] }),
      createArticle: async () => ({ ok: true, id: 9999999, url: 'https://dev.to/x/9999999' }), // no `published`
      reconcileArticleStatus: async (id) => { assert.equal(id, '9999999'); return { ok: true, status: 'PUBLISHED' }; },
    };
    const result = await publishApprovedDevToFirstArticle(db, candidate, { devtoClient });
    assert.equal(result.ok, true);
    assert.equal(result.published, true);
    assert.equal(result.externalId, '9999999');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('publishApprovedDevToFirstArticle: create response omits published, and reconciliation cannot confirm PUBLISHED => FAIL CLOSED', async () => {
  const { dir, db } = tempDb();
  try {
    const candidate = approvedFixture(db);
    const devtoClient = {
      getIdentity: async () => ({ ok: true }),
      getAllArticles: async () => ({ ok: true, articles: [] }),
      createArticle: async () => ({ ok: true, id: 1010101, url: 'https://dev.to/x/1010101' }), // no `published`
      reconcileArticleStatus: async () => ({ ok: true, status: 'UNPUBLISHED' }),
    };
    const result = await publishApprovedDevToFirstArticle(db, candidate, { devtoClient });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'PUBLISHED_NOT_CONFIRMED_TRUE');
    const state = getDevToFirstArticleApprovalState(db, candidate);
    assert.equal(state.published, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('this module never imports a connector directly or calls fetch itself — the real client is always injected by the caller', () => {
  const source = readFileSync(new URL('../lib/devtoFirstArticle.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /connectors\//);
  assert.doesNotMatch(source, /\bfetch\(/);
});
