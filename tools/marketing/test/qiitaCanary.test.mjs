import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import {
  canaryQiita, CANARY_QIITA_TITLE, CANARY_QIITA_BODY, CANARY_TEXT_QIITA, QIITA_CANARY_IDEMPOTENCY_KEY,
} from '../lib/canary.mjs';
import { getChannelState } from '../lib/channelState.mjs';

function fakeResponse({ status = 200, body = {} } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-qiita-canary-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

const QIITA_ENV = { QIITA_ACCESS_TOKEN: 'qiita-token' };

function qiitaFetchMock({
  createItemBody, createItemStatus = 200, myItems = [],
} = {}) {
  let createItemCalls = 0;
  let myItemsCalls = 0;
  const fetchImpl = async (url, opts) => {
    if (url.includes('/authenticated_user') && !url.includes('/items')) {
      return fakeResponse({ status: 200, body: { id: 'Veritas_Forge' } });
    }
    if (url.includes('/authenticated_user/items')) {
      myItemsCalls++;
      return fakeResponse({ status: 200, body: myItems });
    }
    if (url.includes('/items') && opts?.method === 'POST') {
      createItemCalls++;
      return fakeResponse({
        status: createItemStatus,
        body: createItemBody ?? { id: 'abc123def456', url: 'https://qiita.com/Veritas_Forge/items/abc123def456', private: true },
      });
    }
    throw new Error(`unexpected url: ${url} (opts: ${JSON.stringify(opts)})`);
  };
  return {
    fetchImpl,
    getCreateItemCalls: () => createItemCalls,
    getMyItemsCalls: () => myItemsCalls,
  };
}

test('canaryQiita refuses to create when auth is invalid, never touches the ledger', async () => {
  const { dir, db } = tempDb();
  try {
    const fetchImpl = async () => fakeResponse({ status: 401 });
    const result = await canaryQiita(db, { env: QIITA_ENV, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'AUTH_INVALID');
    const count = db.prepare('SELECT COUNT(*) c FROM publication_ledger').get().c;
    assert.equal(count, 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryQiita creates exactly one private item (one create-item POST) with private=true, and a rerun makes zero additional calls', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl, getCreateItemCalls } = qiitaFetchMock();
    const first = await canaryQiita(db, { env: QIITA_ENV, fetchImpl });
    assert.equal(first.ok, true);
    assert.equal(first.alreadyPassed, false);
    assert.equal(first.idempotent, false);
    assert.equal(first.private, true);
    assert.equal(first.canaryPass, true);
    assert.equal(first.externalId, 'abc123def456');
    assert.equal(first.externalUrl, 'https://qiita.com/Veritas_Forge/items/abc123def456');
    assert.equal(getCreateItemCalls(), 1);

    const second = await canaryQiita(db, { env: QIITA_ENV, fetchImpl });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyPassed, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.private, true);
    assert.equal(second.externalId, first.externalId);
    assert.equal(second.externalUrl, first.externalUrl);
    assert.equal(getCreateItemCalls(), 1, 'a second canary call must never create a second item — exactly one Qiita private item total');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryQiita sends private:true (and title/body) in the request payload', async () => {
  const { dir, db } = tempDb();
  try {
    let capturedBody;
    const fetchImpl = async (url, opts) => {
      if (url.includes('/authenticated_user') && !url.includes('/items')) return fakeResponse({ status: 200, body: { id: 'u' } });
      if (url.includes('/authenticated_user/items') && opts?.method !== 'POST') return fakeResponse({ status: 200, body: [] });
      if (url.includes('/items') && opts?.method === 'POST') {
        capturedBody = JSON.parse(opts.body);
        return fakeResponse({ body: { id: 'x-1', url: 'https://qiita.com/u/items/x-1', private: true } });
      }
      throw new Error(`unexpected url ${url}`);
    };
    await canaryQiita(db, { env: QIITA_ENV, fetchImpl });
    assert.equal(capturedBody.private, true);
    assert.equal(capturedBody.title, CANARY_QIITA_TITLE);
    assert.equal(capturedBody.body, CANARY_QIITA_BODY);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryQiita FAILS CLOSED if the API response claims private=false — HTTP success alone is never sufficient', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = qiitaFetchMock({ createItemBody: { id: 'pub-1', url: 'https://qiita.com/u/items/pub-1', private: false } });
    const result = await canaryQiita(db, { env: QIITA_ENV, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'PRIVATE_FALSE');
    const state = getChannelState(db, 'qiita');
    assert.equal(!!state.canary_passed, false, 'CANARY_PASS must never be set when the API claims private=false');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryQiita: create response id + no `private` field, but remote "my items" lookup confirms private => PASS', async () => {
  const { dir, db } = tempDb();
  try {
    let itemsCalls = 0;
    const fetchImpl = async (url, opts) => {
      if (url.includes('/authenticated_user') && !url.includes('/items')) return fakeResponse({ status: 200, body: { id: 'u' } });
      if (url.includes('/items') && opts?.method === 'POST') {
        return fakeResponse({ body: { id: 'amb-1', url: 'https://qiita.com/u/items/amb-1' } }); // no `private` field
      }
      if (url.includes('/authenticated_user/items')) {
        itemsCalls++;
        // 1st call = pre-create adopt check (nothing yet); 2nd = post-create reconciliation (now shows up, private)
        return fakeResponse({
          status: 200,
          body: itemsCalls === 1 ? [] : [{ id: 'amb-1', title: CANARY_QIITA_TITLE, private: true }],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    };
    const result = await canaryQiita(db, { env: QIITA_ENV, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.canaryPass, true);
    assert.equal(result.private, true);
    assert.equal(result.externalId, 'amb-1');
    const state = getChannelState(db, 'qiita');
    assert.equal(!!state.canary_passed, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryQiita: create response id + no `private` field, and remote reconciliation cannot confirm private => FAIL CLOSED', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = qiitaFetchMock({
      createItemBody: { id: 'amb-2', url: 'https://qiita.com/u/items/amb-2' }, // no `private`
      myItems: [], // never shows up anywhere
    });
    const result = await canaryQiita(db, { env: QIITA_ENV, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'PRIVATE_NOT_CONFIRMED');
    const state = getChannelState(db, 'qiita');
    assert.equal(!!state.canary_passed, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryQiita: a matching remote PRIVATE item already exists but local state is absent => adopt it, zero create-item calls', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl, getCreateItemCalls } = qiitaFetchMock({
      myItems: [{ id: 'existing-priv-1', title: CANARY_QIITA_TITLE, url: 'https://qiita.com/Veritas_Forge/items/existing-priv-1', private: true }],
    });
    const result = await canaryQiita(db, { env: QIITA_ENV, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyPassed, true);
    assert.equal(result.idempotent, true);
    assert.equal(result.adopted, true);
    assert.equal(result.externalId, 'existing-priv-1');
    assert.equal(result.private, true);
    assert.equal(getCreateItemCalls(), 0, 'adopting an existing remote private item must never create a second one');
    const state = getChannelState(db, 'qiita');
    assert.equal(!!state.canary_passed, true);
    assert.equal(state.canary_external_id, 'existing-priv-1');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryQiita: rerun after adoption returns alreadyPassed=true and makes zero create-item calls', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl: firstFetch, getCreateItemCalls: firstCreateCalls } = qiitaFetchMock({
      myItems: [{ id: 'existing-priv-2', title: CANARY_QIITA_TITLE, url: 'https://qiita.com/u/items/existing-priv-2', private: true }],
    });
    const first = await canaryQiita(db, { env: QIITA_ENV, fetchImpl: firstFetch });
    assert.equal(first.alreadyPassed, true);
    assert.equal(firstCreateCalls(), 0);

    const { fetchImpl: secondFetch, getCreateItemCalls: secondCreateCalls } = qiitaFetchMock();
    const second = await canaryQiita(db, { env: QIITA_ENV, fetchImpl: secondFetch });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyPassed, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.externalId, 'existing-priv-2');
    assert.equal(secondCreateCalls(), 0, 'a rerun after recovery must never create an item');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryQiita: a matching remote PUBLIC item exists => FAIL CLOSED, never adopt it as the canary, never create a duplicate', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl, getCreateItemCalls } = qiitaFetchMock({
      myItems: [{ id: 'public-item-1', title: CANARY_QIITA_TITLE, url: 'https://qiita.com/Veritas_Forge/items/public-item-1', private: false }],
    });
    const result = await canaryQiita(db, { env: QIITA_ENV, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'REMOTE_MATCH_IS_PUBLIC');
    assert.equal(getCreateItemCalls(), 0, 'must never create a second item when a same-titled PUBLIC item already exists');
    const state = getChannelState(db, 'qiita');
    assert.equal(!!state.canary_passed, false, 'a public match must never be adopted as a passed private canary');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryQiita: remote reconciliation finds the id already public => FAIL CLOSED', async () => {
  const { dir, db } = tempDb();
  try {
    const fetchImpl = async (url, opts) => {
      if (url.includes('/authenticated_user') && !url.includes('/items')) return fakeResponse({ status: 200, body: { id: 'u' } });
      if (url.includes('/items') && opts?.method === 'POST') {
        return fakeResponse({ body: { id: 'flip-1', url: 'https://qiita.com/u/items/flip-1' } }); // no `private`
      }
      // Both the pre-create adopt check and the post-create reconciliation hit
      // this: the specific item never shows up as private (id flip-1 isn't
      // there either time — only a DIFFERENT, already-public item is).
      if (url.includes('/authenticated_user/items')) {
        return fakeResponse({ status: 200, body: [{ id: 'flip-1', title: CANARY_QIITA_TITLE, private: false }] });
      }
      throw new Error(`unexpected url: ${url}`);
    };
    const result = await canaryQiita(db, { env: QIITA_ENV, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'REMOTE_MATCH_IS_PUBLIC');
    const state = getChannelState(db, 'qiita');
    assert.equal(!!state.canary_passed, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryQiita: durable adoption survives a process restart (db reopened) — zero duplicate items', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-qiita-canary-adopt-restart-'));
  try {
    const dbPath = join(dir, 'x.db');
    const remoteItem = [{ id: 'restart-priv-1', title: CANARY_QIITA_TITLE, url: 'https://qiita.com/u/items/restart-priv-1', private: true }];

    let db = openDb(dbPath);
    const { fetchImpl: fetchImpl1 } = qiitaFetchMock({ myItems: remoteItem });
    await canaryQiita(db, { env: QIITA_ENV, fetchImpl: fetchImpl1 });
    closeDb(db);

    // Simulate a fresh process: reopen the same db, never create a duplicate.
    db = openDb(dbPath);
    const { fetchImpl: fetchImpl2, getCreateItemCalls } = qiitaFetchMock({ myItems: remoteItem });
    const result = await canaryQiita(db, { env: QIITA_ENV, fetchImpl: fetchImpl2 });
    assert.equal(result.alreadyPassed, true);
    assert.equal(result.externalId, 'restart-priv-1');
    assert.equal(getCreateItemCalls(), 0);
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canaryQiita: durable canary state (externalId/url/private=true) survives a process restart (no matching remote item, real create)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-qiita-canary-restart-'));
  try {
    const dbPath = join(dir, 'x.db');
    const { fetchImpl } = qiitaFetchMock();
    let db = openDb(dbPath);
    await canaryQiita(db, { env: QIITA_ENV, fetchImpl });
    closeDb(db);

    db = openDb(dbPath);
    const { fetchImpl: fetchImpl2, getCreateItemCalls } = qiitaFetchMock();
    const result = await canaryQiita(db, { env: QIITA_ENV, fetchImpl: fetchImpl2 });
    assert.equal(result.alreadyPassed, true);
    assert.equal(result.externalId, 'abc123def456');
    assert.equal(result.private, true);
    assert.equal(getCreateItemCalls(), 0);
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canaryQiita: a failed create-item call does not mark the canary passed, and stays retryable', async () => {
  const { dir, db } = tempDb();
  try {
    const fetchImpl = async (url, opts) => {
      if (url.includes('/authenticated_user') && !url.includes('/items')) return fakeResponse({ status: 200, body: { id: 'u' } });
      if (url.includes('/authenticated_user/items') && opts?.method !== 'POST') return fakeResponse({ status: 200, body: [] });
      if (url.includes('/items') && opts?.method === 'POST') return fakeResponse({ status: 500 });
      throw new Error(`unexpected url: ${url}`);
    };
    const result = await canaryQiita(db, { env: QIITA_ENV, fetchImpl, retryOpts: { maxRetries: 0 } });
    assert.equal(result.ok, false);
    const state = getChannelState(db, 'qiita');
    assert.equal(!!state.canary_passed, false);
    const { fetchImpl: workingFetch } = qiitaFetchMock();
    const retry = await canaryQiita(db, { env: QIITA_ENV, fetchImpl: workingFetch });
    assert.equal(retry.ok, true);
    assert.equal(retry.alreadyPassed, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryQiita: no credential value ever appears in the result', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = qiitaFetchMock();
    const result = await canaryQiita(db, { env: QIITA_ENV, fetchImpl });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(QIITA_ENV.QIITA_ACCESS_TOKEN));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryQiita: the canary content makes no product/user/revenue/performance claims and mentions no private infrastructure', () => {
  assert.doesNotMatch(CANARY_TEXT_QIITA, /users|revenue|customers|\$|ACCESS_TOKEN|secret|password/i);
  assert.match(CANARY_TEXT_QIITA, /intentionally private/i);
});

test('canaryQiita: the durable idempotency key constant is exactly qiita:private-canary:v1', () => {
  assert.equal(QIITA_CANARY_IDEMPOTENCY_KEY, 'qiita:private-canary:v1');
});
