import test from 'node:test';
import assert from 'node:assert/strict';
import * as bluesky from '../connectors/bluesky.mjs';
import * as mastodon from '../connectors/mastodon.mjs';
import * as devto from '../connectors/devto.mjs';
import * as hashnode from '../connectors/hashnode.mjs';
import * as linkedin from '../connectors/linkedin.mjs';
import * as qiita from '../connectors/qiita.mjs';

function fakeResponse({ status = 200, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// --- Bluesky ---

const BLUESKY_ENV = { BLUESKY_IDENTIFIER: 'user.bsky.social', BLUESKY_APP_PASSWORD: 'app-pass' };

test('bluesky: missing credentials -> AUTH_REQUIRED, no network call', async () => {
  let called = false;
  const result = await bluesky.createSession({ env: {}, fetchImpl: async () => { called = true; return fakeResponse(); } });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'AUTH_REQUIRED');
  assert.equal(called, false);
});

test('bluesky: createSession posts identifier/password and returns accessJwt/did', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://bsky.social/xrpc/com.atproto.server.createSession');
    const body = JSON.parse(opts.body);
    assert.equal(body.identifier, 'user.bsky.social');
    return fakeResponse({ body: { accessJwt: 'jwt1', did: 'did:plc:abc', handle: 'user.bsky.social' } });
  };
  const result = await bluesky.createSession({ env: BLUESKY_ENV, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.did, 'did:plc:abc');
});

test('bluesky: honors a custom BLUESKY_SERVICE_URL rather than assuming bsky.social', async () => {
  let capturedUrl;
  const fetchImpl = async (url) => { capturedUrl = url; return fakeResponse({ body: { accessJwt: 'j', did: 'd', handle: 'h' } }); };
  await bluesky.createSession({ env: { ...BLUESKY_ENV, BLUESKY_SERVICE_URL: 'https://custom.pds.example' }, fetchImpl });
  assert.ok(capturedUrl.startsWith('https://custom.pds.example'));
});

test('bluesky: createPost creates a record and derives the public post URL from the returned uri', async () => {
  const fetchImpl = async (url, opts) => {
    if (url.includes('createSession')) return fakeResponse({ body: { accessJwt: 'jwt1', did: 'did:plc:abc', handle: 'user.bsky.social' } });
    if (url.includes('createRecord')) {
      const body = JSON.parse(opts.body);
      assert.equal(body.collection, 'app.bsky.feed.post');
      assert.equal(body.record.text, 'hello bluesky');
      return fakeResponse({ body: { uri: 'at://did:plc:abc/app.bsky.feed.post/3abc123', cid: 'bafy1' } });
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const result = await bluesky.createPost('hello bluesky', { env: BLUESKY_ENV, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://bsky.app/profile/user.bsky.social/post/3abc123');
});

test('bluesky: validate() rejects text over the 300-grapheme limit', () => {
  const result = bluesky.validate({ short_text: 'x'.repeat(301) });
  assert.equal(result.ok, false);
});

test('bluesky: publish() dry-run never calls fetch', async () => {
  let called = false;
  const result = await bluesky.publish({ text: 'hi' }, { dryRun: true, env: BLUESKY_ENV, fetchImpl: async () => { called = true; return fakeResponse(); } });
  assert.equal(result.ok, true);
  assert.equal(called, false);
});

test('bluesky: publish() without credentials reports connectionRequired', async () => {
  const result = await bluesky.publish({ text: 'hi' }, { dryRun: false, env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.connectionRequired, true);
});

// --- Mastodon ---

const MASTODON_ENV = { MASTODON_BASE_URL: 'https://mastodon.example', MASTODON_ACCESS_TOKEN: 'tok' };

test('mastodon: missing credentials -> AUTH_REQUIRED, no network call', async () => {
  let called = false;
  const result = await mastodon.createStatus('hi', { env: {}, fetchImpl: async () => { called = true; return fakeResponse(); } });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'AUTH_REQUIRED');
  assert.equal(called, false);
});

test('mastodon: never assumes mastodon.social — uses the configured MASTODON_BASE_URL exactly', async () => {
  let capturedUrl;
  const fetchImpl = async (url) => { capturedUrl = url; return fakeResponse({ body: { id: '1', url: 'https://mastodon.example/@u/1' } }); };
  await mastodon.createStatus('hello', { env: MASTODON_ENV, fetchImpl });
  assert.ok(capturedUrl.startsWith('https://mastodon.example/api/v1/statuses'));
});

test('mastodon: createStatus sends a real Idempotency-Key header, generating one when not provided', async () => {
  let capturedHeaders;
  const fetchImpl = async (url, opts) => { capturedHeaders = opts.headers; return fakeResponse({ body: { id: '1', url: 'https://mastodon.example/@u/1' } }); };
  await mastodon.createStatus('hello', { env: MASTODON_ENV, fetchImpl });
  assert.ok(capturedHeaders['Idempotency-Key']);
});

test('mastodon: createStatus reuses an explicitly-passed Idempotency-Key (retry safety)', async () => {
  let capturedHeaders;
  const fetchImpl = async (url, opts) => { capturedHeaders = opts.headers; return fakeResponse({ body: { id: '1', url: 'https://mastodon.example/@u/1' } }); };
  await mastodon.createStatus('hello', { env: MASTODON_ENV, fetchImpl, idempotencyKey: 'fixed-key-123' });
  assert.equal(capturedHeaders['Idempotency-Key'], 'fixed-key-123');
});

test('mastodon: validate() rejects text over 500 characters (instance default assumed)', () => {
  const result = mastodon.validate({ short_text: 'x'.repeat(501) });
  assert.equal(result.ok, false);
});

test('mastodon: publish() dry-run never calls fetch', async () => {
  let called = false;
  const result = await mastodon.publish({ text: 'hi. AI-assisted post.' }, { dryRun: true, env: MASTODON_ENV, fetchImpl: async () => { called = true; return fakeResponse(); } });
  assert.equal(result.ok, true);
  assert.equal(called, false);
});

// --- Mastodon: AI-use disclosure gate (mastodon.social signup rules
// require disclosure of generative-AI use — enforced in validate() so this
// applies to every publish() caller, canary or autonomous, fail-closed) ---

test('mastodon: validate() rejects text with no AI disclosure', () => {
  const result = mastodon.validate({ short_text: 'A perfectly reasonable post with no disclosure.' });
  assert.equal(result.ok, false);
  assert.match(result.error, /disclosure/i);
});

test('mastodon: validate() accepts text carrying the English disclosure', () => {
  const result = mastodon.validate({ short_text: `A post about something. ${mastodon.AI_DISCLOSURE_EN}` });
  assert.equal(result.ok, true);
});

test('mastodon: validate() accepts text carrying the Japanese disclosure', () => {
  const result = mastodon.validate({ short_text: `何かについての投稿です。${mastodon.AI_DISCLOSURE_JA}` });
  assert.equal(result.ok, true);
});

test('mastodon: publish() in LIVE mode fails closed (never calls fetch) when the disclosure is missing, even with valid credentials', async () => {
  let called = false;
  const result = await mastodon.publish({ text: 'no disclosure here' }, {
    dryRun: false, env: MASTODON_ENV, fetchImpl: async () => { called = true; return fakeResponse(); },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /disclosure/i);
  assert.equal(called, false);
});

// --- DEV.to ---

const DEVTO_ENV = { DEVTO_API_KEY: 'key1' };

test('devto: missing API key -> AUTH_REQUIRED, no network call', async () => {
  let called = false;
  const result = await devto.createArticle({ title: 't', body_markdown: 'b' }, { env: {}, fetchImpl: async () => { called = true; return fakeResponse(); } });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'AUTH_REQUIRED');
  assert.equal(called, false);
});

test('devto: createArticle sends api-key header and article payload, captures id/url', async () => {
  let capturedHeaders; let capturedBody;
  const fetchImpl = async (url, opts) => {
    capturedHeaders = opts.headers; capturedBody = JSON.parse(opts.body);
    return fakeResponse({ body: { id: 42, url: 'https://dev.to/user/article-42' } });
  };
  const result = await devto.createArticle({ title: 'Deep dive', body_markdown: '# body', tags: ['ai'] }, { env: DEVTO_ENV, fetchImpl });
  assert.equal(capturedHeaders['api-key'], 'key1');
  assert.equal(capturedBody.article.title, 'Deep dive');
  assert.equal(result.ok, true);
  assert.equal(result.id, 42);
});

test('devto: validate() requires title and long_text, and caps tags at 4', () => {
  assert.equal(devto.validate({ long_text: 'b' }).ok, false);
  assert.equal(devto.validate({ title: 't' }).ok, false);
  assert.equal(devto.validate({ title: 't', long_text: 'b', tags: ['a', 'b', 'c', 'd', 'e'] }).ok, false);
  assert.equal(devto.validate({ title: 't', long_text: 'b', tags: ['a'] }).ok, true);
});

test('devto: publish() dry-run never calls fetch', async () => {
  let called = false;
  const result = await devto.publish({ title: 't', long_text: 'b' }, { dryRun: true, env: DEVTO_ENV, fetchImpl: async () => { called = true; return fakeResponse(); } });
  assert.equal(result.ok, true);
  assert.equal(called, false);
});

test('devto: lookupExisting finds a matching title among the author\'s own articles', async () => {
  const fetchImpl = async () => fakeResponse({ body: [{ id: 1, title: 'Old' }, { id: 2, title: 'Deep dive' }] });
  const result = await devto.lookupExisting('Deep dive', { env: DEVTO_ENV, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.found, true);
  assert.equal(result.id, 2);
});

// --- Qiita (new contract methods) ---

const QIITA_ENV = { QIITA_ACCESS_TOKEN: 'tok' };

test('qiita: validate() requires title, body, and at least one tag', () => {
  assert.equal(qiita.validate({}).ok, false);
  assert.equal(qiita.validate({ title: 't', long_text: 'b' }).ok, false, 'no tags');
  assert.equal(qiita.validate({ title: 't', long_text: 'b', tags: ['js'] }).ok, true);
});

test('qiita: getIdentity uses the real authenticated_user endpoint', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://qiita.com/api/v2/authenticated_user');
    return fakeResponse({ body: { id: 'qiita_user' } });
  };
  const result = await qiita.getIdentity({ env: QIITA_ENV, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.username, 'qiita_user');
});

// --- Hashnode (capability detection only) ---

const HASHNODE_ENV = { HASHNODE_API_KEY: 'hn-key' };

test('hashnode: no API key -> AUTH_REQUIRED, no network call', async () => {
  let called = false;
  const result = await hashnode.detectCapability({ env: {}, fetchImpl: async () => { called = true; return fakeResponse(); } });
  assert.equal(result.state, 'AUTH_REQUIRED');
  assert.equal(called, false);
});

test('hashnode: valid key + publishPost exposed in schema -> READY', async () => {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.query.includes('me {')) return fakeResponse({ body: { data: { me: { id: '1', username: 'author1' } } } });
    if (body.query.includes('__type')) return fakeResponse({ body: { data: { __type: { fields: [{ name: 'publishPost' }, { name: 'other' }] } } } });
    throw new Error('unexpected query');
  };
  const result = await hashnode.detectCapability({ env: HASHNODE_ENV, fetchImpl });
  assert.equal(result.state, 'READY');
  assert.equal(result.identifier, 'author1');
});

test('hashnode: valid key but publishPost NOT exposed -> PLAN_REQUIRED, never fabricated READY', async () => {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.query.includes('me {')) return fakeResponse({ body: { data: { me: { id: '1', username: 'author1' } } } });
    if (body.query.includes('__type')) return fakeResponse({ body: { data: { __type: { fields: [{ name: 'other' }] } } } });
    throw new Error('unexpected query');
  };
  const result = await hashnode.detectCapability({ env: HASHNODE_ENV, fetchImpl });
  assert.equal(result.state, 'PLAN_REQUIRED');
});

test('hashnode: publish() always refuses — capability detection only this pass, never a fabricated success', async () => {
  const result = await hashnode.publish({}, {});
  assert.equal(result.ok, false);
  assert.equal(result.notImplemented, true);
});

// --- LinkedIn (capability/auth discovery only) ---

const LINKEDIN_ENV = { LINKEDIN_ACCESS_TOKEN: 'li-tok' };

test('linkedin: no access token -> AUTH_REQUIRED, no network call', async () => {
  let called = false;
  const result = await linkedin.detectCapability({ env: {}, fetchImpl: async () => { called = true; return fakeResponse(); } });
  assert.equal(result.state, 'AUTH_REQUIRED');
  assert.equal(called, false);
});

test('linkedin: valid token but no organization URN configured -> API_APPROVAL_REQUIRED, never a fabricated READY', async () => {
  const fetchImpl = async () => fakeResponse({ body: { sub: 'user123', name: 'A Person' } });
  const result = await linkedin.detectCapability({ env: LINKEDIN_ENV, fetchImpl });
  assert.equal(result.state, 'API_APPROVAL_REQUIRED');
});

test('linkedin: valid token + configured organization URN -> READY', async () => {
  const fetchImpl = async () => fakeResponse({ body: { sub: 'user123', name: 'A Person' } });
  const result = await linkedin.detectCapability({ env: { ...LINKEDIN_ENV, LINKEDIN_ORGANIZATION_URN: 'urn:li:organization:123' }, fetchImpl });
  assert.equal(result.state, 'READY');
});

test('linkedin: invalid token -> AUTH_REQUIRED', async () => {
  const fetchImpl = async () => fakeResponse({ status: 401 });
  const result = await linkedin.detectCapability({ env: LINKEDIN_ENV, fetchImpl });
  assert.equal(result.state, 'AUTH_REQUIRED');
});

test('linkedin: publish() never browser-automates as a fallback — always refuses', async () => {
  const result = await linkedin.publish({}, {});
  assert.equal(result.ok, false);
  assert.equal(result.notImplemented, true);
});
