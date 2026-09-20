import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import {
  canaryDevto, CANARY_DEVTO_TITLE, CANARY_DEVTO_BODY, CANARY_TEXT_DEVTO, DEVTO_CANARY_IDEMPOTENCY_KEY,
} from '../lib/canary.mjs';
import { getChannelState } from '../lib/channelState.mjs';
import { publishToChannel } from '../lib/multiChannelPublish.mjs';
import { draftDevToArticle } from '../lib/crossChannelDraft.mjs';
import { ensureActivationBoundary } from '../lib/activation.mjs';

function fakeResponse({ status = 200, body = {} } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-devto-canary-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

const DEVTO_ENV = { DEVTO_API_KEY: 'devto-key' };

function devtoFetchMock({
  createArticleBody, createArticleStatus = 200, unpublishedArticles = [], allArticles = null,
} = {}) {
  let createArticleCalls = 0;
  let unpublishedCalls = 0;
  let allCalls = 0;
  const fetchImpl = async (url, opts) => {
    if (url.includes('/users/me')) {
      return fakeResponse({ status: 200, body: { id: 4127021, username: 'veritasforge_ai' } });
    }
    if (url.includes('/articles/me/unpublished')) {
      unpublishedCalls++;
      return fakeResponse({ status: 200, body: unpublishedArticles });
    }
    if (url.includes('/articles/me/all')) {
      allCalls++;
      return fakeResponse({ status: 200, body: allArticles ?? unpublishedArticles });
    }
    if (url.includes('/articles') && opts?.method === 'POST') {
      createArticleCalls++;
      return fakeResponse({
        status: createArticleStatus,
        body: createArticleBody ?? { id: 999, url: 'https://dev.to/veritasforge_ai/veritas-forge-api-publication-canary-999', published: false },
      });
    }
    throw new Error(`unexpected url: ${url} (opts: ${JSON.stringify(opts)})`);
  };
  return {
    fetchImpl,
    getCreateArticleCalls: () => createArticleCalls,
    getUnpublishedCalls: () => unpublishedCalls,
    getAllCalls: () => allCalls,
  };
}

const ORIGINAL_ENV = { ...process.env };
function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

test('canaryDevto refuses to create when auth is invalid, never touches the ledger', async () => {
  const { dir, db } = tempDb();
  try {
    const fetchImpl = async () => fakeResponse({ status: 401 });
    const result = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'AUTH_INVALID');
    const count = db.prepare('SELECT COUNT(*) c FROM publication_ledger').get().c;
    assert.equal(count, 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryDevto creates exactly one draft (one create-article POST) with published=false, and a rerun makes zero additional calls', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl, getCreateArticleCalls } = devtoFetchMock();
    const first = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl });
    assert.equal(first.ok, true);
    assert.equal(first.alreadyPassed, false);
    assert.equal(first.idempotent, false);
    assert.equal(first.published, false);
    assert.equal(first.canaryPass, true);
    assert.equal(first.externalId, '999');
    assert.equal(first.externalUrl, 'https://dev.to/veritasforge_ai/veritas-forge-api-publication-canary-999');
    assert.equal(getCreateArticleCalls(), 1);

    const second = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyPassed, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.published, false);
    assert.equal(second.externalId, first.externalId);
    assert.equal(second.externalUrl, first.externalUrl);
    assert.equal(getCreateArticleCalls(), 1, 'a second canary call must never create a second draft — exactly one DEV.to draft total');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryDevto sends published:false in the request payload', async () => {
  const { dir, db } = tempDb();
  try {
    let capturedBody;
    const fetchImpl = async (url, opts) => {
      if (url.includes('/users/me')) return fakeResponse({ status: 200, body: { id: 1, username: 'u' } });
      if (url.includes('/articles/me/unpublished')) return fakeResponse({ status: 200, body: [] });
      if (url.includes('/articles') && opts?.method === 'POST') {
        capturedBody = JSON.parse(opts.body);
        return fakeResponse({ body: { id: 1, url: 'https://dev.to/u/x-1', published: false } });
      }
      throw new Error(`unexpected url ${url}`);
    };
    await canaryDevto(db, { env: DEVTO_ENV, fetchImpl });
    assert.equal(capturedBody.article.published, false);
    assert.equal(capturedBody.article.title, CANARY_DEVTO_TITLE);
    assert.equal(capturedBody.article.body_markdown, CANARY_DEVTO_BODY);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryDevto FAILS CLOSED if the API response claims published=true — HTTP success alone is never sufficient', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = devtoFetchMock({ createArticleBody: { id: 1000, url: 'https://dev.to/veritasforge_ai/x-1000', published: true } });
    const result = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'PUBLISHED_TRUE');
    const state = getChannelState(db, 'devto');
    assert.equal(!!state.canary_passed, false, 'CANARY_PASS must never be set when the API claims published=true');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryDevto: a malformed response missing the published field never marks the canary passed', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = devtoFetchMock({ createArticleBody: { id: 1001, url: 'https://dev.to/veritasforge_ai/x-1001' } }); // no `published` at all
    const result = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'PUBLISHED_NOT_CONFIRMED_FALSE');
    const state = getChannelState(db, 'devto');
    assert.equal(!!state.canary_passed, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryDevto: a malformed response missing the article id never marks the canary passed', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = devtoFetchMock({ createArticleBody: { url: 'https://dev.to/veritasforge_ai/x-none', published: false } }); // no id
    const result = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl });
    assert.equal(result.ok, false);
    assert.match(result.reason, /id/i);
    const state = getChannelState(db, 'devto');
    assert.equal(!!state.canary_passed, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryDevto: create returns id + no published field, but remote unpublished-drafts lookup confirms the id => PASS', async () => {
  const { dir, db } = tempDb();
  try {
    let unpublishedCalls = 0;
    const fetchImpl = async (url, opts) => {
      if (url.includes('/users/me')) return fakeResponse({ status: 200, body: { id: 1, username: 'u' } });
      if (url.includes('/articles') && opts?.method === 'POST') {
        return fakeResponse({ body: { id: 2002, url: 'https://dev.to/u/x-2002' } }); // no `published` field
      }
      if (url.includes('/articles/me/unpublished')) {
        unpublishedCalls++;
        // 1st call = pre-create adopt check (nothing yet); 2nd call = post-create reconciliation (the real draft now shows up)
        return fakeResponse({
          status: 200,
          body: unpublishedCalls === 1 ? [] : [{ id: 2002, title: CANARY_DEVTO_TITLE, published: false }],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    };
    const result = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.canaryPass, true);
    assert.equal(result.published, false);
    assert.equal(result.externalId, '2002');
    const state = getChannelState(db, 'devto');
    assert.equal(!!state.canary_passed, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryDevto: create returns id + no published field, and remote reconciliation cannot confirm it => FAIL CLOSED', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = devtoFetchMock({
      createArticleBody: { id: 2003, url: 'https://dev.to/u/x-2003' }, // no `published`
      unpublishedArticles: [], allArticles: [], // never shows up anywhere
    });
    const result = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'PUBLISHED_NOT_CONFIRMED_FALSE');
    const state = getChannelState(db, 'devto');
    assert.equal(!!state.canary_passed, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryDevto: a matching remote draft already exists but local canary state is absent => adopt it, zero create-article calls', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl, getCreateArticleCalls } = devtoFetchMock({
      unpublishedArticles: [{ id: 4669152, title: CANARY_DEVTO_TITLE, url: 'https://dev.to/veritasforge_ai/veritas-forge-api-publication-canary-2186-temp-slug-3305550', published: false }],
    });
    const result = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyPassed, true);
    assert.equal(result.idempotent, true);
    assert.equal(result.adopted, true);
    assert.equal(result.externalId, '4669152');
    assert.equal(result.published, false);
    assert.equal(getCreateArticleCalls(), 0, 'adopting an existing remote draft must never create a second one');
    const state = getChannelState(db, 'devto');
    assert.equal(!!state.canary_passed, true);
    assert.equal(state.canary_external_id, '4669152');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryDevto: rerun after adoption returns alreadyPassed=true and makes zero create-article calls', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl: firstFetch, getCreateArticleCalls: firstCreateCalls } = devtoFetchMock({
      unpublishedArticles: [{ id: 4669152, title: CANARY_DEVTO_TITLE, url: 'https://dev.to/veritasforge_ai/x-4669152', published: false }],
    });
    const first = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl: firstFetch });
    assert.equal(first.alreadyPassed, true);
    assert.equal(firstCreateCalls(), 0);

    const { fetchImpl: secondFetch, getCreateArticleCalls: secondCreateCalls } = devtoFetchMock();
    const second = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl: secondFetch });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyPassed, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.externalId, '4669152');
    assert.equal(secondCreateCalls(), 0, 'a rerun after recovery must never create a draft');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryDevto: remote reconciliation finds the id already published => FAIL CLOSED', async () => {
  const { dir, db } = tempDb();
  try {
    const fetchImpl = async (url, opts) => {
      if (url.includes('/users/me')) return fakeResponse({ status: 200, body: { id: 1, username: 'u' } });
      if (url.includes('/articles') && opts?.method === 'POST') {
        return fakeResponse({ body: { id: 3003, url: 'https://dev.to/u/x-3003' } }); // no `published`
      }
      // Both the pre-create adopt check and the post-create reconciliation hit
      // this: never a draft (id 3003 isn't there either time).
      if (url.includes('/articles/me/unpublished')) {
        return fakeResponse({ status: 200, body: [] });
      }
      if (url.includes('/articles/me/all')) {
        return fakeResponse({ status: 200, body: [{ id: 3003, title: CANARY_DEVTO_TITLE, published: true }] });
      }
      throw new Error(`unexpected url: ${url}`);
    };
    const result = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'RECONCILED_PUBLISHED');
    const state = getChannelState(db, 'devto');
    assert.equal(!!state.canary_passed, false, 'CANARY_PASS must never be set once reconciliation finds the article published');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryDevto: durable adoption survives a process restart (db reopened) — zero duplicate drafts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-devto-canary-adopt-restart-'));
  try {
    const dbPath = join(dir, 'x.db');
    const remoteDraft = [{ id: 4669152, title: CANARY_DEVTO_TITLE, url: 'https://dev.to/veritasforge_ai/x-4669152', published: false }];

    let db = openDb(dbPath);
    const { fetchImpl: fetchImpl1 } = devtoFetchMock({ unpublishedArticles: remoteDraft });
    await canaryDevto(db, { env: DEVTO_ENV, fetchImpl: fetchImpl1 });
    closeDb(db);

    // Simulate a fresh process: reopen the same db, never create a duplicate.
    db = openDb(dbPath);
    const { fetchImpl: fetchImpl2, getCreateArticleCalls } = devtoFetchMock({ unpublishedArticles: remoteDraft });
    const result = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl: fetchImpl2 });
    assert.equal(result.alreadyPassed, true);
    assert.equal(result.externalId, '4669152');
    assert.equal(getCreateArticleCalls(), 0);
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canaryDevto: a failed create-article call does not mark the canary passed, and stays retryable', async () => {
  const { dir, db } = tempDb();
  try {
    const fetchImpl = async (url, opts) => {
      if (url.includes('/users/me')) return fakeResponse({ status: 200, body: { id: 1, username: 'u' } });
      if (url.includes('/articles/me/unpublished')) return fakeResponse({ status: 200, body: [] });
      if (url.includes('/articles') && opts?.method === 'POST') return fakeResponse({ status: 500 });
      throw new Error(`unexpected url: ${url}`);
    };
    const result = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl, retryOpts: { maxRetries: 0 } });
    assert.equal(result.ok, false);
    const state = getChannelState(db, 'devto');
    assert.equal(!!state.canary_passed, false);
    // Still retryable: a later call with a working fetchImpl succeeds cleanly.
    const { fetchImpl: workingFetch } = devtoFetchMock();
    const retry = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl: workingFetch });
    assert.equal(retry.ok, true);
    assert.equal(retry.alreadyPassed, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryDevto: durable canary state (externalId/url/published=false) survives a process restart (db reopened)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-devto-canary-restart-'));
  try {
    const dbPath = join(dir, 'x.db');
    const { fetchImpl } = devtoFetchMock();
    let db = openDb(dbPath);
    await canaryDevto(db, { env: DEVTO_ENV, fetchImpl });
    closeDb(db);

    // Simulate a fresh process: reopen the same db file, never create a second draft.
    db = openDb(dbPath);
    const { fetchImpl: fetchImpl2, getCreateArticleCalls } = devtoFetchMock();
    const result = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl: fetchImpl2 });
    assert.equal(result.alreadyPassed, true);
    assert.equal(result.externalId, '999');
    assert.equal(result.published, false);
    assert.equal(getCreateArticleCalls(), 0);
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canaryDevto: MARKETING_DEVTO_ENABLED=false does not block the explicit draft canary', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = devtoFetchMock();
    const result = await canaryDevto(db, { env: { ...DEVTO_ENV, MARKETING_DEVTO_ENABLED: 'false' }, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.canaryPass, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryDevto: PUBLIC_MARKETING_MODE=DRY_RUN (or entirely unset) does not block the explicit draft canary — it never reads that env var at all', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = devtoFetchMock();
    const result = await canaryDevto(db, { env: { ...DEVTO_ENV, MARKETING_MODE: 'DRY_RUN' }, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.canaryPass, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('regression: normal (non-canary) devto publish via publishToChannel remains blocked in DRY_RUN mode, unaffected by adding the canary', async () => {
  resetEnv();
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db);
    process.env.MARKETING_MODE = 'DRY_RUN';
    let called = false;
    const fact = {
      id: 'FACT-001', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED',
      CLAIM: 'ECHO Agent\'s verifier rejects a claimed task success when there is no supporting evidence.',
      SOURCE_REPOSITORY: 'ECHODiscord版', SOURCE_PATH: 'echo_agent_verifier_v1.py',
      SOURCE_EVIDENCE: 'test passes', VERIFIED_AT: '2099-01-01', PUBLIC_SAFE: 'true', NOTES: '',
    };
    const result = await publishToChannel(db, 'devto', fact, draftDevToArticle, {
      env: { MARKETING_DEVTO_ENABLED: 'true' }, fetchImpl: async () => { called = true; },
    });
    assert.equal(result.status, 'DRY_RUN_OK');
    assert.equal(called, false);
  } finally {
    resetEnv();
    closeDb(db); rmSync(dir, { recursive: true, force: true });
  }
});

test('canaryDevto: no credential value ever appears in the result', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = devtoFetchMock();
    const result = await canaryDevto(db, { env: DEVTO_ENV, fetchImpl });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(DEVTO_ENV.DEVTO_API_KEY));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryDevto: the canary content makes no product/user/revenue/performance claims and mentions no private infrastructure', () => {
  assert.doesNotMatch(CANARY_TEXT_DEVTO, /users|revenue|customers|\$|API_KEY|secret|password/i);
  assert.match(CANARY_TEXT_DEVTO, /intentionally not public/i);
});

test('canaryDevto: the durable idempotency key constant is exactly devto:draft-canary:v1', () => {
  assert.equal(DEVTO_CANARY_IDEMPOTENCY_KEY, 'devto:draft-canary:v1');
});
