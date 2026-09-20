import test from 'node:test';
import assert from 'node:assert/strict';
import * as discord from '../connectors/discord.mjs';
import * as reddit from '../connectors/reddit.mjs';
import * as qiita from '../connectors/qiita.mjs';
import * as youtube from '../connectors/youtube.mjs';

function fakeResponse({ status = 200, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// --- Discord ---

test('discord: no webhook URL -> AUTH_REQUIRED, no network call', async () => {
  let called = false;
  const result = await discord.postMessage('hi', { env: {}, fetchImpl: async () => { called = true; return fakeResponse(); } });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'AUTH_REQUIRED');
  assert.equal(called, false);
});

test('discord: posts to the configured webhook and captures message id', async () => {
  let capturedUrl;
  const fetchImpl = async (url, opts) => {
    capturedUrl = url;
    assert.equal(JSON.parse(opts.body).content, 'release notes');
    return fakeResponse({ status: 200, body: { id: 'msg1', channel_id: 'chan1' } });
  };
  const result = await discord.postMessage('release notes', {
    env: { DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/abc/def' }, fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.messageId, 'msg1');
  assert.ok(capturedUrl.startsWith('https://discord.com/api/webhooks/abc/def'));
});

test('discord: publish() dry-run never calls fetch', async () => {
  let called = false;
  const result = await discord.publish({ text: 'hi' }, {
    dryRun: true, env: { DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x/y' },
    fetchImpl: async () => { called = true; return fakeResponse(); },
  });
  assert.equal(result.ok, true);
  assert.equal(called, false);
});

// --- Reddit ---

const REDDIT_ENV = { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'secret', REDDIT_USERNAME: 'u', REDDIT_PASSWORD: 'p' };

test('reddit: missing credentials -> AUTH_REQUIRED before any network call', async () => {
  let called = false;
  const result = await reddit.getAccessToken({ env: {}, fetchImpl: async () => { called = true; return fakeResponse(); } });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'AUTH_REQUIRED');
  assert.equal(called, false);
});

test('reddit: submitPost exchanges a token then submits, returning the permalink', async () => {
  let step = 0;
  const fetchImpl = async (url) => {
    step++;
    if (url.includes('access_token')) return fakeResponse({ status: 200, body: { access_token: 'tok' } });
    return fakeResponse({ status: 200, body: { json: { errors: [], data: { id: 'abc', url: 'https://reddit.com/r/test/abc' } } } });
  };
  const result = await reddit.submitPost('test', 'A title', 'body text', { env: REDDIT_ENV, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.id, 'abc');
  assert.equal(step, 2);
});

test('reddit: a submission error from Reddit itself is surfaced as BAD_REQUEST, not silently dropped', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('access_token')) return fakeResponse({ status: 200, body: { access_token: 'tok' } });
    return fakeResponse({ status: 200, body: { json: { errors: [['RATELIMIT', 'too fast', 'ratelimit']] } } });
  };
  const result = await reddit.submitPost('test', 'A title', 'body text', { env: REDDIT_ENV, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'BAD_REQUEST');
});

test('reddit: publish() requires subreddit and title fields', async () => {
  const result = await reddit.publish({ text: 'no subreddit or title' }, { dryRun: false, env: REDDIT_ENV, fetchImpl: async () => fakeResponse() });
  assert.equal(result.ok, false);
});

// --- Qiita ---

test('qiita: missing token -> AUTH_REQUIRED', async () => {
  const result = await qiita.createItem({ title: 't', body: 'b' }, { env: {}, fetchImpl: async () => fakeResponse() });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'AUTH_REQUIRED');
});

test('qiita: createItem posts title/body/tags and returns the item URL', async () => {
  const fetchImpl = async (url, opts) => {
    const payload = JSON.parse(opts.body);
    assert.equal(payload.title, 'My Article');
    assert.deepEqual(payload.tags, [{ name: 'AI' }]);
    return fakeResponse({ status: 201, body: { id: 'item1', url: 'https://qiita.com/x/items/item1' } });
  };
  const result = await qiita.createItem({ title: 'My Article', body: '# hi', tags: ['AI'] }, {
    env: { QIITA_ACCESS_TOKEN: 'tok' }, fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://qiita.com/x/items/item1');
});

test('qiita: createItem returns the response\'s `private` field', async () => {
  const fetchImpl = async () => fakeResponse({ status: 201, body: { id: 'item2', url: 'https://qiita.com/x/items/item2', private: false } });
  const result = await qiita.createItem({ title: 't', body: 'b', tags: ['AI'] }, { env: { QIITA_ACCESS_TOKEN: 'tok' }, fetchImpl });
  assert.equal(result.private, false);
});

test('qiita: publish() maps a real draft\'s long_text field into the created item\'s body — regression test for a real bug where a non-dry-run publish of every real Qiita draft (draftQiitaArticle always produces `long_text`, never `body`) silently failed with "qiita draft requires title and body fields"', async () => {
  let capturedBody;
  const fetchImpl = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return fakeResponse({ status: 201, body: { id: 'item3', url: 'https://qiita.com/x/items/item3', private: false } });
  };
  const draft = { channel: 'qiita', title: 'ECHO Agentの実装: 何か', long_text: '# 本文\n\n技術的な内容。', tags: ['AI', 'アーキテクチャ'] };
  const result = await qiita.publish(draft, { dryRun: false, env: { QIITA_ACCESS_TOKEN: 'tok' }, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.externalId, 'item3');
  assert.equal(capturedBody.body, draft.long_text);
  assert.equal(capturedBody.title, draft.title);
  assert.equal(capturedBody.private, false);
});

test('qiita: publish() still refuses a draft with neither long_text nor body (validate() reused, fails closed)', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return fakeResponse(); };
  const result = await qiita.publish({ title: 't' }, { dryRun: false, env: { QIITA_ACCESS_TOKEN: 'tok' }, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

// --- YouTube ---

test('youtube: missing credentials -> AUTH_REQUIRED', async () => {
  const result = await youtube.getAccessToken({ env: {}, fetchImpl: async () => fakeResponse() });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'AUTH_REQUIRED');
});

test('youtube: uploadVideo exchanges a refresh token then uploads multipart, without reading a real file', async () => {
  let uploadCalled = false;
  const fetchImpl = async (url, opts) => {
    if (url.includes('oauth2.googleapis.com')) return fakeResponse({ status: 200, body: { access_token: 'tok' } });
    uploadCalled = true;
    assert.ok(opts.headers['Content-Type'].startsWith('multipart/related'));
    return fakeResponse({ status: 200, body: { id: 'vid1' } });
  };
  const readFileImpl = async () => Buffer.from('fake video bytes');
  const result = await youtube.uploadVideo(
    { filePath: '/tmp/fake.mp4', title: 'Demo', description: 'd', tags: ['ai'] },
    { env: { YOUTUBE_CLIENT_ID: 'a', YOUTUBE_CLIENT_SECRET: 'b', YOUTUBE_REFRESH_TOKEN: 'c' }, fetchImpl, readFileImpl }
  );
  assert.equal(result.ok, true);
  assert.equal(result.id, 'vid1');
  assert.equal(result.url, 'https://youtu.be/vid1');
  assert.equal(uploadCalled, true);
});

test('youtube: uploadVideo defaults to private even when privacyStatus is not specified', async () => {
  let capturedMetadata;
  const fetchImpl = async (url, opts) => {
    if (url.includes('oauth2.googleapis.com')) return fakeResponse({ status: 200, body: { access_token: 'tok' } });
    const bodyStr = opts.body.toString('utf8');
    capturedMetadata = JSON.parse(bodyStr.split('\r\n\r\n')[1].split('\r\n--')[0]);
    return fakeResponse({ status: 200, body: { id: 'vid2' } });
  };
  await youtube.uploadVideo(
    { filePath: '/tmp/fake.mp4', title: 'Demo' },
    { env: { YOUTUBE_CLIENT_ID: 'a', YOUTUBE_CLIENT_SECRET: 'b', YOUTUBE_REFRESH_TOKEN: 'c' }, fetchImpl, readFileImpl: async () => Buffer.from('x') }
  );
  assert.equal(capturedMetadata.status.privacyStatus, 'private');
  assert.equal(youtube.DEFAULT_PRIVACY, 'private');
});

test('youtube: getMyChannel returns AUTH_REQUIRED without credentials, and channel info on success', async () => {
  const noAuth = await youtube.getMyChannel({ env: {}, fetchImpl: async () => fakeResponse() });
  assert.equal(noAuth.ok, false);
  assert.equal(noAuth.errorClass, 'AUTH_REQUIRED');

  const fetchImpl = async (url) => {
    if (url.includes('oauth2.googleapis.com')) return fakeResponse({ status: 200, body: { access_token: 'tok' } });
    return fakeResponse({ status: 200, body: { items: [{ id: 'chan1', snippet: { title: 'Veritas Forge' } }] } });
  };
  const result = await youtube.getMyChannel({ env: { YOUTUBE_CLIENT_ID: 'a', YOUTUBE_CLIENT_SECRET: 'b', YOUTUBE_REFRESH_TOKEN: 'c' }, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.channelId, 'chan1');
  assert.equal(result.channelTitle, 'Veritas Forge');
});

test('youtube: getMyChannel reports AUTH_ERROR when the token lacks channel/upload scope (empty items)', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('oauth2.googleapis.com')) return fakeResponse({ status: 200, body: { access_token: 'tok' } });
    return fakeResponse({ status: 200, body: { items: [] } });
  };
  const result = await youtube.getMyChannel({ env: { YOUTUBE_CLIENT_ID: 'a', YOUTUBE_CLIENT_SECRET: 'b', YOUTUBE_REFRESH_TOKEN: 'c' }, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'AUTH_ERROR');
});

test('youtube: getVideoStatus verifies a video by re-reading it, not by trusting the upload response', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('oauth2.googleapis.com')) return fakeResponse({ status: 200, body: { access_token: 'tok' } });
    return fakeResponse({ status: 200, body: { items: [{ id: 'vid1', status: { privacyStatus: 'private' }, snippet: { title: 'Demo' } }] } });
  };
  const result = await youtube.getVideoStatus('vid1', { env: { YOUTUBE_CLIENT_ID: 'a', YOUTUBE_CLIENT_SECRET: 'b', YOUTUBE_REFRESH_TOKEN: 'c' }, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.privacyStatus, 'private');
});

test('youtube: getVideoStatus reports NOT_FOUND when the video id does not exist', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('oauth2.googleapis.com')) return fakeResponse({ status: 200, body: { access_token: 'tok' } });
    return fakeResponse({ status: 200, body: { items: [] } });
  };
  const result = await youtube.getVideoStatus('missing', { env: { YOUTUBE_CLIENT_ID: 'a', YOUTUBE_CLIENT_SECRET: 'b', YOUTUBE_REFRESH_TOKEN: 'c' }, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'NOT_FOUND');
});

test('youtube: setPrivacyStatus refuses to go public without confirmPublic:true, and never calls fetch in that case', async () => {
  let called = false;
  const result = await youtube.setPrivacyStatus('vid1', 'public', {
    env: { YOUTUBE_CLIENT_ID: 'a', YOUTUBE_CLIENT_SECRET: 'b', YOUTUBE_REFRESH_TOKEN: 'c' },
    fetchImpl: async () => { called = true; return fakeResponse(); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'CONFIRMATION_REQUIRED');
  assert.equal(called, false);
});

test('youtube: setPrivacyStatus with confirmPublic:true calls videos.update (PUT) and returns the new status', async () => {
  let capturedUrl, capturedMethod, capturedBody;
  const fetchImpl = async (url, opts) => {
    if (url.includes('oauth2.googleapis.com')) return fakeResponse({ status: 200, body: { access_token: 'tok' } });
    capturedUrl = url; capturedMethod = opts.method; capturedBody = JSON.parse(opts.body);
    return fakeResponse({ status: 200, body: { id: 'vid1', status: { privacyStatus: 'public' } } });
  };
  const result = await youtube.setPrivacyStatus('vid1', 'public', {
    confirmPublic: true, env: { YOUTUBE_CLIENT_ID: 'a', YOUTUBE_CLIENT_SECRET: 'b', YOUTUBE_REFRESH_TOKEN: 'c' }, fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.privacyStatus, 'public');
  assert.equal(capturedMethod, 'PUT');
  assert.ok(capturedUrl.includes('videos?part=status'));
  assert.equal(capturedBody.id, 'vid1');
  assert.equal(capturedBody.status.privacyStatus, 'public');
});

test('youtube: setPrivacyStatus to private never requires confirmPublic', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('oauth2.googleapis.com')) return fakeResponse({ status: 200, body: { access_token: 'tok' } });
    return fakeResponse({ status: 200, body: { id: 'vid1', status: { privacyStatus: 'private' } } });
  };
  const result = await youtube.setPrivacyStatus('vid1', 'private', {
    env: { YOUTUBE_CLIENT_ID: 'a', YOUTUBE_CLIENT_SECRET: 'b', YOUTUBE_REFRESH_TOKEN: 'c' }, fetchImpl,
  });
  assert.equal(result.ok, true);
});
