import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { authCheckX, authCheckYoutube, writePermissionStatus } from '../lib/authCheck.mjs';
import { canaryX, canaryYoutube, ensureCanaryVideo, CANARY_VIDEO_TITLE, canaryBluesky, CANARY_TEXT_BLUESKY, canaryMastodon, CANARY_TEXT_MASTODON } from '../lib/canary.mjs';
import { publishToChannel } from '../lib/multiChannelPublish.mjs';
import { draftBlueskyPost, draftMastodonPost } from '../lib/crossChannelDraft.mjs';
import { ensureActivationBoundary } from '../lib/activation.mjs';
import { recordAuthCheck, getChannelState } from '../lib/channelState.mjs';

function fakeResponse({ status = 200, body = {} } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-auth-canary-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

const X_ENV = { X_API_KEY: 'ck', X_API_SECRET: 'cs', X_ACCESS_TOKEN: 'at', X_ACCESS_TOKEN_SECRET: 'ats' };
const YT_ENV = { YOUTUBE_CLIENT_ID: 'a', YOUTUBE_CLIENT_SECRET: 'b', YOUTUBE_REFRESH_TOKEN: 'c' };

// --- write-permission status (regression: cli.mjs used to report
// UNCONFIRMED_UNTIL_CANARY forever for X even after a real canary post had
// already succeeded and durable channel_state.canary_passed was true —
// it re-derived from the read-only auth-check's own permissionsSufficient
// flag instead of consulting the actual canary result) ---

test('writePermissionStatus is true once a real canary has passed, regardless of the read-only permissionsSufficient flag', () => {
  assert.equal(writePermissionStatus({ permissionsSufficient: true, canaryPass: true }), true);
  // Even a stale/false read-only permissionsSufficient must not downgrade a
  // durable, already-passed canary result -- the canary IS the stronger,
  // more direct evidence of write permission.
  assert.equal(writePermissionStatus({ permissionsSufficient: false, canaryPass: true }), true);
});

test('writePermissionStatus is UNCONFIRMED_UNTIL_CANARY when read-auth passed but no canary has run yet', () => {
  assert.equal(writePermissionStatus({ permissionsSufficient: true, canaryPass: false }), 'UNCONFIRMED_UNTIL_CANARY');
});

test('writePermissionStatus is false when the read-only auth check itself failed and no canary has passed', () => {
  assert.equal(writePermissionStatus({ permissionsSufficient: false, canaryPass: false }), false);
});

// --- auth-check ---

test('authCheckX reports credentialsPresent=false without ever calling fetch when unconfigured', async () => {
  let called = false;
  const result = await authCheckX({ env: {}, fetchImpl: async () => { called = true; return fakeResponse(); } });
  assert.equal(result.clientImplemented, true);
  assert.equal(result.credentialsPresent, false);
  assert.equal(result.authValid, false);
  assert.equal(called, false);
});

test('authCheckX reports authValid=true and a safe identifier on a successful read', async () => {
  const fetchImpl = async () => fakeResponse({ status: 200, body: { data: { id: '1', username: 'veritasforge' } } });
  const result = await authCheckX({ env: X_ENV, fetchImpl });
  assert.equal(result.credentialsPresent, true);
  assert.equal(result.authValid, true);
  assert.equal(result.accountIdentifierSafe, '@veritasforge (id 1)');
});

test('authCheckX reports authValid=false on a 401 without throwing', async () => {
  const fetchImpl = async () => fakeResponse({ status: 401 });
  const result = await authCheckX({ env: X_ENV, fetchImpl, retryOpts: { maxRetries: 0 } });
  assert.equal(result.authValid, false);
});

test('authCheckYoutube reports credentialsPresent=false without calling fetch when unconfigured', async () => {
  let called = false;
  const result = await authCheckYoutube({ env: {}, fetchImpl: async () => { called = true; return fakeResponse(); } });
  assert.equal(result.credentialsPresent, false);
  assert.equal(called, false);
});

test('authCheckYoutube reports channel identity on success', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('oauth2.googleapis.com')) return fakeResponse({ status: 200, body: { access_token: 'tok' } });
    return fakeResponse({ status: 200, body: { items: [{ id: 'chan1', snippet: { title: 'Veritas Forge' } }] } });
  };
  const result = await authCheckYoutube({ env: YT_ENV, fetchImpl });
  assert.equal(result.authValid, true);
  assert.equal(result.accountIdentifierSafe, 'Veritas Forge (channel chan1)');
});

test('authCheckYoutube reports authValid=true for an upload-only-scoped token even though channels.list is 403 (ACCESS_TOKEN_SCOPE_INSUFFICIENT) — regression for a real finding', async () => {
  // A token minted with ONLY the youtube.upload scope (the minimum-scope
  // credential this project actually uses) genuinely cannot call
  // channels.list?mine=true — Google returns 403 for that read regardless of
  // how valid the token is for uploading. authValid must reflect that the
  // TOKEN is valid (the refresh-token exchange succeeded), not that this
  // particular read succeeded.
  const fetchImpl = async (url) => {
    if (url.includes('oauth2.googleapis.com')) return fakeResponse({ status: 200, body: { access_token: 'tok' } });
    return fakeResponse({ status: 403, body: { error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] } } });
  };
  const result = await authCheckYoutube({ env: YT_ENV, fetchImpl });
  assert.equal(result.authValid, true);
  assert.equal(result.channelId, null);
  assert.equal(result.channelTitle, null);
  assert.ok(result.error.includes('broader scope'));
});

test('authCheckYoutube reports authValid=false when the refresh token itself is rejected (not just a scope-limited read)', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('oauth2.googleapis.com')) return fakeResponse({ status: 400, body: { error: 'invalid_grant' } });
    throw new Error('should not reach channels.list if the token exchange itself failed');
  };
  const result = await authCheckYoutube({ env: YT_ENV, fetchImpl });
  assert.equal(result.authValid, false);
});

// --- persistence ---

test('auth-check results persist and are readable via getChannelState', () => {
  const { dir, db } = tempDb();
  try {
    recordAuthCheck(db, 'x', { authValid: true, accountIdentifier: '@veritasforge', permissionsSufficient: true });
    const state = getChannelState(db, 'x');
    assert.equal(state.auth_valid, 1);
    assert.equal(state.account_identifier, '@veritasforge');
    assert.ok(state.auth_checked_at);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- canary: X ---

test('canaryX refuses to post when auth is invalid', async () => {
  const { dir, db } = tempDb();
  try {
    const fetchImpl = async () => fakeResponse({ status: 401 });
    const result = await canaryX(db, { env: X_ENV, fetchImpl, retryOpts: { maxRetries: 0 } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'AUTH_INVALID');
    const count = db.prepare('SELECT COUNT(*) c FROM publication_ledger').get().c;
    assert.equal(count, 0, 'must not record a ledger row for a canary that never got past auth');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryX posts exactly once and a second call is idempotent (no second post)', async () => {
  const { dir, db } = tempDb();
  try {
    let postCount = 0;
    const fetchImpl = async (url, opts) => {
      if (opts?.method === 'POST') { postCount++; return fakeResponse({ status: 201, body: { data: { id: 'tweet1' } } }); }
      return fakeResponse({ status: 200, body: { data: { id: '1', username: 'veritasforge' } } });
    };
    const first = await canaryX(db, { env: X_ENV, fetchImpl });
    assert.equal(first.ok, true);
    assert.equal(first.alreadyPassed, false);
    assert.equal(postCount, 1);

    const second = await canaryX(db, { env: X_ENV, fetchImpl });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyPassed, true);
    assert.equal(postCount, 1, 'a second canary call must not post again');
    assert.equal(second.externalId, 'tweet1');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- canary: YouTube ---

test('ensureCanaryVideo does not regenerate an already-existing file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-canary-video-'));
  try {
    const videoPath = join(dir, 'canary.mp4');
    writeFileSync(videoPath, 'not really a video, just testing existence check');
    let called = false;
    const result = await ensureCanaryVideo(videoPath, { execFileImpl: async () => { called = true; } });
    assert.equal(result.ok, true);
    assert.equal(result.created, false);
    assert.equal(called, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ensureCanaryVideo reports failure honestly if ffmpeg fails, without pretending success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-canary-video-'));
  try {
    const videoPath = join(dir, 'canary.mp4');
    const result = await ensureCanaryVideo(videoPath, { execFileImpl: async () => { throw new Error('ffmpeg not found'); } });
    assert.equal(result.ok, false);
    assert.ok(!existsSync(videoPath));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canaryYoutube refuses to upload when the refresh token itself is invalid (not merely scope-limited)', async () => {
  const { dir, db } = tempDb();
  try {
    const fetchImpl = async (url) => {
      if (url.includes('oauth2.googleapis.com')) return fakeResponse({ status: 400, body: { error: 'invalid_grant' } });
      throw new Error('should not reach the upload step if the token exchange failed');
    };
    const result = await canaryYoutube(db, { env: YT_ENV, fetchImpl, videoPath: join(dir, 'x.mp4') });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'AUTH_INVALID');
    const count = db.prepare('SELECT COUNT(*) c FROM publication_ledger').get().c;
    assert.equal(count, 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryYoutube proceeds and verifies via the upload response itself when channels.list is scope-limited (real finding: upload-only scope cannot call channels.list)', async () => {
  const { dir, db } = tempDb();
  try {
    let uploadCount = 0;
    // channels.list and videos.list both 403 under upload-only scope, exactly
    // as found empirically against the real credential — the canary must
    // still pass, using only what the upload response itself returns.
    const fetchImpl = async (url) => {
      if (url.includes('oauth2.googleapis.com')) return fakeResponse({ status: 200, body: { access_token: 'tok' } });
      if (url.includes('/upload/youtube')) {
        uploadCount++;
        return fakeResponse({ status: 200, body: { id: 'vid1', status: { privacyStatus: 'private' }, snippet: { title: CANARY_VIDEO_TITLE } } });
      }
      if (url.includes('/videos?')) return fakeResponse({ status: 403, body: { error: { status: 'PERMISSION_DENIED' } } });
      throw new Error('unexpected url ' + url);
    };
    const ensureVideoImpl = async (path) => ({ ok: true, created: true, videoPath: path });
    const readFileImpl = async () => Buffer.from('fake');

    const first = await canaryYoutube(db, { env: YT_ENV, fetchImpl, videoPath: join(dir, 'canary.mp4'), ensureVideoImpl, readFileImpl });
    assert.equal(first.ok, true);
    assert.equal(first.alreadyPassed, false);
    assert.equal(first.privacyStatus, 'private');
    assert.equal(uploadCount, 1);

    const second = await canaryYoutube(db, { env: YT_ENV, fetchImpl, videoPath: join(dir, 'canary.mp4'), ensureVideoImpl, readFileImpl });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyPassed, true);
    assert.equal(second.verifiedStillExists, false); // videos.list still scope-limited on replay — not treated as failure
    assert.equal(uploadCount, 1, 'a second canary call must not upload again');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryYoutube fails closed if the upload response is missing id/status entirely (cannot confirm success at all)', async () => {
  const { dir, db } = tempDb();
  try {
    const fetchImpl = async (url) => {
      if (url.includes('oauth2.googleapis.com')) return fakeResponse({ status: 200, body: { access_token: 'tok' } });
      if (url.includes('/upload/youtube')) return fakeResponse({ status: 200, body: {} }); // malformed/incomplete response
      throw new Error('unexpected url ' + url);
    };
    const result = await canaryYoutube(db, {
      env: YT_ENV, fetchImpl, videoPath: join(dir, 'canary.mp4'),
      ensureVideoImpl: async (p) => ({ ok: true, created: true, videoPath: p }),
      readFileImpl: async () => Buffer.from('fake'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'UPLOAD_NOT_VERIFIABLE');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- canary: Bluesky (multi-channel expansion) ---

const BLUESKY_ENV = { BLUESKY_IDENTIFIER: 'veritasforge.bsky.social', BLUESKY_APP_PASSWORD: 'app-pass' };

function blueskyFetchMock({ createRecordBody, createRecordStatus = 200 } = {}) {
  let createRecordCalls = 0;
  const fetchImpl = async (url, opts) => {
    if (url.includes('createSession')) {
      return fakeResponse({ status: 200, body: { accessJwt: 'jwt1', did: 'did:plc:abc', handle: 'veritasforge.bsky.social' } });
    }
    if (url.includes('createRecord')) {
      createRecordCalls++;
      return fakeResponse({
        status: createRecordStatus,
        body: createRecordBody ?? { uri: 'at://did:plc:abc/app.bsky.feed.post/canary1', cid: 'bafyCanary1' },
      });
    }
    throw new Error(`unexpected url: ${url} (opts: ${JSON.stringify(opts)})`);
  };
  return { fetchImpl, getCreateRecordCalls: () => createRecordCalls };
}

test('canaryBluesky refuses to post when auth is invalid, never touches the ledger', async () => {
  const { dir, db } = tempDb();
  try {
    const fetchImpl = async () => fakeResponse({ status: 401 });
    const result = await canaryBluesky(db, { env: BLUESKY_ENV, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'AUTH_INVALID');
    const count = db.prepare('SELECT COUNT(*) c FROM publication_ledger').get().c;
    assert.equal(count, 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryBluesky posts exactly once (one createRecord call) and a rerun is idempotent (zero additional publish calls)', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl, getCreateRecordCalls } = blueskyFetchMock();
    const first = await canaryBluesky(db, { env: BLUESKY_ENV, fetchImpl });
    assert.equal(first.ok, true);
    assert.equal(first.alreadyPassed, false);
    assert.equal(first.uri, 'at://did:plc:abc/app.bsky.feed.post/canary1');
    assert.equal(first.cid, 'bafyCanary1');
    assert.equal(first.url, 'https://bsky.app/profile/veritasforge.bsky.social/post/canary1');
    assert.equal(getCreateRecordCalls(), 1);

    const second = await canaryBluesky(db, { env: BLUESKY_ENV, fetchImpl });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyPassed, true);
    assert.equal(getCreateRecordCalls(), 1, 'a second canary call must never post again');
    assert.equal(second.uri, first.uri);
    assert.equal(second.cid, first.cid);
    assert.equal(second.url, first.url);
    assert.ok(second.publishedAt);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryBluesky: durable canary state (uri/cid/url) survives a process restart (db reopened)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-bluesky-canary-restart-'));
  try {
    const dbPath = join(dir, 'x.db');
    const { fetchImpl } = blueskyFetchMock();
    let db = openDb(dbPath);
    await canaryBluesky(db, { env: BLUESKY_ENV, fetchImpl });
    closeDb(db);

    // Simulate a fresh process: reopen the same db file, never re-post.
    db = openDb(dbPath);
    const { fetchImpl: fetchImpl2, getCreateRecordCalls } = blueskyFetchMock();
    const result = await canaryBluesky(db, { env: BLUESKY_ENV, fetchImpl: fetchImpl2 });
    assert.equal(result.alreadyPassed, true);
    assert.equal(result.uri, 'at://did:plc:abc/app.bsky.feed.post/canary1');
    assert.equal(result.cid, 'bafyCanary1');
    assert.equal(getCreateRecordCalls(), 0);
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canaryBluesky: MARKETING_BLUESKY_ENABLED=false does not block the explicit canary', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = blueskyFetchMock();
    const result = await canaryBluesky(db, { env: { ...BLUESKY_ENV, MARKETING_BLUESKY_ENABLED: 'false' }, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.canaryPass, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryBluesky: PUBLIC_MARKETING_MODE=DRY_RUN (or entirely unset) does not block the explicit canary — it never reads that env var at all', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = blueskyFetchMock();
    const result = await canaryBluesky(db, { env: { ...BLUESKY_ENV, MARKETING_MODE: 'DRY_RUN' }, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.canaryPass, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('regression: normal (non-canary) Bluesky publish via publishToChannel remains blocked in DRY_RUN mode, unaffected by adding the canary', async () => {
  const ORIGINAL_MODE = process.env.MARKETING_MODE;
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
    const result = await publishToChannel(db, 'bluesky', fact, draftBlueskyPost, {
      env: { MARKETING_BLUESKY_ENABLED: 'true' }, fetchImpl: async () => { called = true; },
    });
    assert.equal(result.status, 'DRY_RUN_OK');
    assert.equal(called, false);
  } finally {
    if (ORIGINAL_MODE === undefined) delete process.env.MARKETING_MODE; else process.env.MARKETING_MODE = ORIGINAL_MODE;
    closeDb(db); rmSync(dir, { recursive: true, force: true });
  }
});

test('canaryBluesky: a failed createRecord call does not mark the canary passed, and stays retryable', async () => {
  const { dir, db } = tempDb();
  try {
    let attempt = 0;
    const fetchImpl = async (url) => {
      if (url.includes('createSession')) return fakeResponse({ status: 200, body: { accessJwt: 'jwt1', did: 'did:plc:abc', handle: 'veritasforge.bsky.social' } });
      if (url.includes('createRecord')) { attempt++; return fakeResponse({ status: 500 }); }
      throw new Error(`unexpected url: ${url}`);
    };
    const result = await canaryBluesky(db, { env: BLUESKY_ENV, fetchImpl, retryOpts: { maxRetries: 0 } });
    assert.equal(result.ok, false);
    const state = getChannelState(db, 'bluesky');
    assert.equal(!!state.canary_passed, false);
    // Still retryable: a later call with a working fetchImpl succeeds cleanly.
    const { fetchImpl: workingFetch } = blueskyFetchMock();
    const retry = await canaryBluesky(db, { env: BLUESKY_ENV, fetchImpl: workingFetch });
    assert.equal(retry.ok, true);
    assert.equal(retry.alreadyPassed, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryBluesky: a malformed response (missing uri) never marks the canary passed', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = blueskyFetchMock({ createRecordBody: { cid: 'bafyOnly' } }); // no uri
    const result = await canaryBluesky(db, { env: BLUESKY_ENV, fetchImpl });
    assert.equal(result.ok, false);
    const state = getChannelState(db, 'bluesky');
    assert.equal(!!state.canary_passed, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryBluesky: no credential value ever appears in the result', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = blueskyFetchMock();
    const result = await canaryBluesky(db, { env: BLUESKY_ENV, fetchImpl });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(BLUESKY_ENV.BLUESKY_APP_PASSWORD));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryBluesky: the canary text makes no product/user/revenue/performance claims and mentions no private infrastructure', () => {
  assert.doesNotMatch(CANARY_TEXT_BLUESKY, /users|revenue|customers|\$|API_KEY|secret|password/i);
});

// --- canary: Mastodon (same architecture as canaryBluesky above) ---

const MASTODON_ENV = { MASTODON_BASE_URL: 'https://mastodon.social', MASTODON_ACCESS_TOKEN: 'tok' };

function mastodonFetchMock({ statusBody, statusHttpStatus = 200 } = {}) {
  let statusCalls = 0;
  const fetchImpl = async (url, opts) => {
    if (url.includes('/api/v1/accounts/verify_credentials')) {
      return fakeResponse({ status: 200, body: { id: 'acct1', username: 'Veritas_Forge' } });
    }
    if (url.includes('/api/v1/statuses')) {
      statusCalls++;
      return fakeResponse({
        status: statusHttpStatus,
        body: statusBody ?? { id: 'status1', url: 'https://mastodon.social/@Veritas_Forge/status1' },
      });
    }
    throw new Error(`unexpected url: ${url} (opts: ${JSON.stringify(opts)})`);
  };
  return { fetchImpl, getStatusCalls: () => statusCalls };
}

test('canaryMastodon refuses to post when auth is invalid, never touches the ledger', async () => {
  const { dir, db } = tempDb();
  try {
    const fetchImpl = async () => fakeResponse({ status: 401 });
    const result = await canaryMastodon(db, { env: MASTODON_ENV, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'AUTH_INVALID');
    const count = db.prepare('SELECT COUNT(*) c FROM publication_ledger').get().c;
    assert.equal(count, 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryMastodon posts exactly once (one statuses POST) and a rerun is idempotent (zero additional publish calls)', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl, getStatusCalls } = mastodonFetchMock();
    const first = await canaryMastodon(db, { env: MASTODON_ENV, fetchImpl });
    assert.equal(first.ok, true);
    assert.equal(first.alreadyPassed, false);
    assert.equal(first.externalId, 'status1');
    assert.equal(first.url, 'https://mastodon.social/@Veritas_Forge/status1');
    assert.equal(first.canaryPass, true);
    assert.equal(getStatusCalls(), 1);

    const second = await canaryMastodon(db, { env: MASTODON_ENV, fetchImpl });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyPassed, true);
    assert.equal(second.idempotent, true);
    assert.equal(getStatusCalls(), 1, 'a second canary call must never post again — exactly one Mastodon post total');
    assert.equal(second.externalId, first.externalId);
    assert.equal(second.url, first.url);
    assert.ok(second.publishedAt);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryMastodon: durable canary state (externalId/url) survives a process restart (db reopened)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-mastodon-canary-restart-'));
  try {
    const dbPath = join(dir, 'x.db');
    const { fetchImpl } = mastodonFetchMock();
    let db = openDb(dbPath);
    await canaryMastodon(db, { env: MASTODON_ENV, fetchImpl });
    closeDb(db);

    // Simulate a fresh process: reopen the same db file, never re-post.
    db = openDb(dbPath);
    const { fetchImpl: fetchImpl2, getStatusCalls } = mastodonFetchMock();
    const result = await canaryMastodon(db, { env: MASTODON_ENV, fetchImpl: fetchImpl2 });
    assert.equal(result.alreadyPassed, true);
    assert.equal(result.externalId, 'status1');
    assert.equal(getStatusCalls(), 0);
    closeDb(db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canaryMastodon: MARKETING_MASTODON_ENABLED=false does not block the explicit canary', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = mastodonFetchMock();
    const result = await canaryMastodon(db, { env: { ...MASTODON_ENV, MARKETING_MASTODON_ENABLED: 'false' }, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.canaryPass, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryMastodon: PUBLIC_MARKETING_MODE=DRY_RUN (or entirely unset) does not block the explicit canary — it never reads that env var at all', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = mastodonFetchMock();
    const result = await canaryMastodon(db, { env: { ...MASTODON_ENV, MARKETING_MODE: 'DRY_RUN' }, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.canaryPass, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('regression: normal (non-canary) Mastodon publish via publishToChannel remains blocked in DRY_RUN mode, unaffected by adding the canary', async () => {
  const ORIGINAL_MODE = process.env.MARKETING_MODE;
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
    const result = await publishToChannel(db, 'mastodon', fact, draftMastodonPost, {
      env: { MARKETING_MASTODON_ENABLED: 'true' }, fetchImpl: async () => { called = true; },
    });
    assert.equal(result.status, 'DRY_RUN_OK');
    assert.equal(called, false);
  } finally {
    if (ORIGINAL_MODE === undefined) delete process.env.MARKETING_MODE; else process.env.MARKETING_MODE = ORIGINAL_MODE;
    closeDb(db); rmSync(dir, { recursive: true, force: true });
  }
});

test('canaryMastodon: a failed statuses POST does not mark the canary passed, and stays retryable', async () => {
  const { dir, db } = tempDb();
  try {
    const fetchImpl = async (url) => {
      if (url.includes('/api/v1/accounts/verify_credentials')) return fakeResponse({ status: 200, body: { id: 'acct1', username: 'Veritas_Forge' } });
      if (url.includes('/api/v1/statuses')) return fakeResponse({ status: 500 });
      throw new Error(`unexpected url: ${url}`);
    };
    const result = await canaryMastodon(db, { env: MASTODON_ENV, fetchImpl });
    assert.equal(result.ok, false);
    const state = getChannelState(db, 'mastodon');
    assert.equal(!!state.canary_passed, false);
    // Still retryable: a later call with a working fetchImpl succeeds cleanly.
    const { fetchImpl: workingFetch } = mastodonFetchMock();
    const retry = await canaryMastodon(db, { env: MASTODON_ENV, fetchImpl: workingFetch });
    assert.equal(retry.ok, true);
    assert.equal(retry.alreadyPassed, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryMastodon: a malformed response (missing status id) never marks the canary passed', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = mastodonFetchMock({ statusBody: { url: 'https://mastodon.social/@Veritas_Forge/status1' } }); // no id
    const result = await canaryMastodon(db, { env: MASTODON_ENV, fetchImpl });
    assert.equal(result.ok, false);
    const state = getChannelState(db, 'mastodon');
    assert.equal(!!state.canary_passed, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryMastodon: no credential value ever appears in the result', async () => {
  const { dir, db } = tempDb();
  try {
    const { fetchImpl } = mastodonFetchMock();
    const result = await canaryMastodon(db, { env: MASTODON_ENV, fetchImpl });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(MASTODON_ENV.MASTODON_ACCESS_TOKEN));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canaryMastodon: the canary text makes no product/user/revenue/performance claims, mentions no private infrastructure, and carries a clear AI disclosure (mastodon.social signup rules require this)', () => {
  assert.doesNotMatch(CANARY_TEXT_MASTODON, /users|revenue|customers|\$|API_KEY|secret|password|launch|benchmark|partner/i);
  assert.match(CANARY_TEXT_MASTODON, /AI[- ]assisted|AI[- ]generated|generative AI/i);
});
