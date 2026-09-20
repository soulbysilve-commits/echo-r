import test from 'node:test';
import assert from 'node:assert/strict';
import { createPost, replyToPost, fetchRecentPosts, getMe, isAuthConfigured, publish, REQUIRED_ENV_VARS } from '../connectors/x.mjs';

const FULL_ENV = {
  X_API_KEY: 'ck', X_API_SECRET: 'cs', X_ACCESS_TOKEN: 'at', X_ACCESS_TOKEN_SECRET: 'ats',
};

function fakeResponse({ status = 200, body = {}, headers = {} } = {}) {
  const map = new Map(Object.entries(headers));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => map.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('isAuthConfigured requires all four env vars, no partial credentials accepted', () => {
  assert.equal(isAuthConfigured({}), false);
  assert.equal(isAuthConfigured({ X_API_KEY: 'x' }), false);
  assert.equal(isAuthConfigured(FULL_ENV), true);
  assert.deepEqual(REQUIRED_ENV_VARS, ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET']);
});

test('createPost without credentials returns AUTH_REQUIRED and never calls fetch', async () => {
  let called = false;
  const result = await createPost('hello', { env: {}, fetchImpl: async () => { called = true; return fakeResponse(); } });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'AUTH_REQUIRED');
  assert.equal(called, false);
});

test('createPost signs the request and captures the returned id and URL on success', async () => {
  let capturedAuthHeader;
  const fetchImpl = async (url, opts) => {
    capturedAuthHeader = opts.headers.Authorization;
    assert.equal(url, 'https://api.twitter.com/2/tweets');
    assert.equal(JSON.parse(opts.body).text, 'hello world');
    return fakeResponse({ status: 201, body: { data: { id: '12345' } } });
  };
  const result = await createPost('hello world', { env: FULL_ENV, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.id, '12345');
  assert.equal(result.url, 'https://x.com/i/web/status/12345');
  assert.ok(capturedAuthHeader.startsWith('OAuth '));
});

test('replyToPost includes in_reply_to_tweet_id in the request body', async () => {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.reply.in_reply_to_tweet_id, '999');
    return fakeResponse({ status: 201, body: { data: { id: '1000' } } });
  };
  const result = await replyToPost('a reply', '999', { env: FULL_ENV, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.id, '1000');
});

test('fetchRecentPosts returns the posts array on success', async () => {
  const fetchImpl = async () => fakeResponse({ status: 200, body: { data: [{ id: '1' }, { id: '2' }] } });
  const result = await fetchRecentPosts('user123', { env: FULL_ENV, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.posts.length, 2);
});

test('a 401 is classified as AUTH_ERROR and is not retried', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return fakeResponse({ status: 401 }); };
  const result = await createPost('x', { env: FULL_ENV, fetchImpl, retryOpts: { maxRetries: 2, sleepFn: async () => {} } });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'AUTH_ERROR');
  assert.equal(calls, 1);
});

test('a 500 is retried up to the bound, then surfaces TRANSIENT', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return fakeResponse({ status: 500 }); };
  const result = await createPost('x', { env: FULL_ENV, fetchImpl, retryOpts: { maxRetries: 2, sleepFn: async () => {} } });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'TRANSIENT');
  assert.equal(calls, 3); // initial + 2 retries
});

test('a 429 with a near reset time is retried once and can then succeed', async () => {
  let calls = 0;
  const resetAt = Math.floor((Date.now() + 50) / 1000);
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return fakeResponse({ status: 429, headers: { 'x-rate-limit-reset': String(resetAt) } });
    return fakeResponse({ status: 201, body: { data: { id: 'ok' } } });
  };
  const result = await createPost('x', { env: FULL_ENV, fetchImpl, retryOpts: { maxRetries: 1, maxRateLimitWaitMs: 5000, sleepFn: async () => {} } });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test('a 429 with a far-future reset is surfaced immediately as RATE_LIMITED rather than blocking', async () => {
  let calls = 0;
  const farReset = Math.floor((Date.now() + 60 * 60 * 1000) / 1000); // 1 hour away
  const fetchImpl = async () => { calls++; return fakeResponse({ status: 429, headers: { 'x-rate-limit-reset': String(farReset) } }); };
  const result = await createPost('x', { env: FULL_ENV, fetchImpl, retryOpts: { maxRetries: 2, maxRateLimitWaitMs: 5000, sleepFn: async () => {} } });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'RATE_LIMITED');
  assert.equal(calls, 1);
});

test('publish() in dryRun never calls fetch even with valid credentials', async () => {
  let called = false;
  const result = await publish({ text: 'hi' }, { dryRun: true, env: FULL_ENV, fetchImpl: async () => { called = true; return fakeResponse(); } });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(called, false);
});

test('getMe: without credentials returns AUTH_REQUIRED and never calls fetch', async () => {
  let called = false;
  const result = await getMe({ env: {}, fetchImpl: async () => { called = true; return fakeResponse(); } });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'AUTH_REQUIRED');
  assert.equal(called, false);
});

test('getMe: signs a GET to /2/users/me and returns id/username on success', async () => {
  let capturedUrl, capturedMethod, capturedAuth;
  const fetchImpl = async (url, opts) => {
    capturedUrl = url; capturedMethod = opts.method; capturedAuth = opts.headers.Authorization;
    return fakeResponse({ status: 200, body: { data: { id: '42', username: 'veritasforge' } } });
  };
  const result = await getMe({ env: FULL_ENV, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.id, '42');
  assert.equal(result.username, 'veritasforge');
  assert.equal(capturedUrl, 'https://api.twitter.com/2/users/me');
  assert.equal(capturedMethod, 'GET');
  assert.ok(capturedAuth.startsWith('OAuth '));
});

test('getMe: a 401 is classified as AUTH_ERROR', async () => {
  const result = await getMe({ env: FULL_ENV, fetchImpl: async () => fakeResponse({ status: 401 }), retryOpts: { maxRetries: 0 } });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'AUTH_ERROR');
});

test('publish() without credentials reports connectionRequired instead of throwing', async () => {
  const result = await publish({ text: 'hi' }, { dryRun: false, env: {}, fetchImpl: async () => fakeResponse() });
  assert.equal(result.ok, false);
  assert.equal(result.connectionRequired, true);
});
