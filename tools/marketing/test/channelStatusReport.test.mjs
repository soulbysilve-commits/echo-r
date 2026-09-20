import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { recordIntent, markPublished } from '../lib/ledger.mjs';
import { recordAuthCheck, recordCanary } from '../lib/channelState.mjs';
import { buildChannelStatus, buildAllChannelStatus, allExpansionChannelNames } from '../lib/channelStatusReport.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-channelstatus-test-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

test('buildChannelStatus: a real-client AUTO_PUBLIC channel with no credentials reports AUTH_REQUIRED, never LIVE_READY', () => {
  const { dir, db } = tempDb();
  try {
    const result = buildChannelStatus(db, 'bluesky', {});
    assert.equal(result.CLIENT, true);
    assert.equal(result.AUTH_CONFIGURED, false);
    assert.equal(result.AUTH, 'AUTH_REQUIRED');
    assert.equal(result.CANARY, false);
    assert.equal(result.MODE, 'AUTO_PUBLIC');
    assert.equal(result.LIVE_READY, false);
    assert.equal(result.BLOCKER, 'AUTH_REQUIRED');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('buildChannelStatus: configured + enabled but never auth-checked -> still AUTH_REQUIRED, not LIVE_READY (configured is not proven)', () => {
  const { dir, db } = tempDb();
  try {
    const env = { BLUESKY_IDENTIFIER: 'u.bsky.social', BLUESKY_APP_PASSWORD: 'pw', MARKETING_BLUESKY_ENABLED: 'true' };
    const result = buildChannelStatus(db, 'bluesky', env);
    assert.equal(result.AUTH_CONFIGURED, true);
    assert.equal(result.AUTH, 'AUTH_REQUIRED');
    assert.equal(result.LIVE_READY, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('buildChannelStatus: AUTH_VALID + enabled but no canary yet -> still not LIVE_READY (canary is a separate, required gate)', () => {
  const { dir, db } = tempDb();
  try {
    const env = { BLUESKY_IDENTIFIER: 'u.bsky.social', BLUESKY_APP_PASSWORD: 'pw', MARKETING_BLUESKY_ENABLED: 'true' };
    recordAuthCheck(db, 'bluesky', { authValid: true, accountIdentifier: '@u.bsky.social', permissionsSufficient: true });
    const result = buildChannelStatus(db, 'bluesky', env);
    assert.equal(result.AUTH, 'AUTH_VALID');
    assert.equal(result.CANARY, false);
    assert.equal(result.LIVE_READY, false);
    assert.equal(result.BLOCKER, 'CANARY_NOT_PASSED');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('buildChannelStatus: AUTH_VALID + enabled + CANARY passed -> LIVE_READY=true, no blocker', () => {
  const { dir, db } = tempDb();
  try {
    const env = { BLUESKY_IDENTIFIER: 'u.bsky.social', BLUESKY_APP_PASSWORD: 'pw', MARKETING_BLUESKY_ENABLED: 'true' };
    recordAuthCheck(db, 'bluesky', { authValid: true, accountIdentifier: '@u.bsky.social', permissionsSufficient: true });
    recordCanary(db, 'bluesky', { passed: true, externalId: 'at://x', externalUrl: 'https://bsky.app/x' });
    const result = buildChannelStatus(db, 'bluesky', env);
    assert.equal(result.LIVE_READY, true);
    assert.equal(result.BLOCKER, null);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('buildChannelStatus: mastodon AUTH_VALID + CANARY passed but MARKETING_MASTODON_ENABLED left false -> reports CANARY=true, LIVE_READY=false, BLOCKER=CHANNEL_DISABLED (real post-canary shape before the channel is deliberately enabled)', () => {
  const { dir, db } = tempDb();
  try {
    const env = { MASTODON_BASE_URL: 'https://mastodon.social', MASTODON_ACCESS_TOKEN: 'tok' }; // no MARKETING_MASTODON_ENABLED
    recordAuthCheck(db, 'mastodon', { authValid: true, accountIdentifier: '@Veritas_Forge', permissionsSufficient: true });
    recordCanary(db, 'mastodon', { passed: true, externalId: 'status1', externalUrl: 'https://mastodon.social/@Veritas_Forge/status1' });
    const result = buildChannelStatus(db, 'mastodon', env);
    assert.equal(result.AUTH, 'AUTH_VALID');
    assert.equal(result.CANARY, true);
    assert.equal(result.ENABLED, false);
    assert.equal(result.LIVE_READY, false);
    assert.equal(result.BLOCKER, 'CHANNEL_DISABLED');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('buildChannelStatus: a real auth-check that recorded AUTH_INVALID is reported as AUTH_INVALID, never AUTH_REQUIRED or AUTH_VALID', () => {
  const { dir, db } = tempDb();
  try {
    const env = { BLUESKY_IDENTIFIER: 'u.bsky.social', BLUESKY_APP_PASSWORD: 'wrong-pw', MARKETING_BLUESKY_ENABLED: 'true' };
    recordAuthCheck(db, 'bluesky', { authValid: false, accountIdentifier: null, permissionsSufficient: false });
    const result = buildChannelStatus(db, 'bluesky', env);
    assert.equal(result.AUTH, 'AUTH_INVALID');
    assert.equal(result.LIVE_READY, false);
    assert.equal(result.BLOCKER, 'AUTH_INVALID');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('buildChannelStatus: reddit is NEVER live-ready even with full credentials + enabled — AUTO_PREPARE_HUMAN_APPROVAL by design', () => {
  const { dir, db } = tempDb();
  try {
    const env = { REDDIT_CLIENT_ID: 'a', REDDIT_CLIENT_SECRET: 'b', REDDIT_USERNAME: 'c', REDDIT_PASSWORD: 'd', MARKETING_REDDIT_ENABLED: 'true' };
    const result = buildChannelStatus(db, 'reddit', env);
    assert.equal(result.MODE, 'AUTO_PREPARE_HUMAN_APPROVAL');
    assert.equal(result.LIVE_READY, false);
    assert.match(result.BLOCKER, /HUMAN_APPROVAL_REQUIRED_BY_DESIGN/);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('buildChannelStatus: producthunt/hackernews/note (no real client at all) are never live-ready either', () => {
  const { dir, db } = tempDb();
  try {
    for (const ch of ['producthunt', 'hackernews', 'note']) {
      const result = buildChannelStatus(db, ch, {});
      assert.equal(result.LIVE_READY, false, ch);
      assert.match(result.BLOCKER, /HUMAN_APPROVAL_REQUIRED_BY_DESIGN/, ch);
    }
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('buildChannelStatus: hashnode/linkedin (capability detection only) report AUTH_REQUIRED when unconfigured, never LIVE_READY', () => {
  const { dir, db } = tempDb();
  try {
    for (const ch of ['hashnode', 'linkedin']) {
      const result = buildChannelStatus(db, ch, {});
      assert.equal(result.LIVE_READY, false, ch);
      assert.equal(result.BLOCKER, 'AUTH_REQUIRED', ch);
    }
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('buildChannelStatus: TODAY_COUNT and LAST_PUBLICATION reflect real ledger rows for that channel only', () => {
  const { dir, db } = tempDb();
  try {
    const row = recordIntent(db, { channel: 'bluesky', text: 'a post', riskClass: 'AUTO', approvalState: 'AUTO_APPROVED' });
    markPublished(db, row.publication_id, { externalId: 'e1', externalUrl: 'https://bsky.app/x', result: 'OK' });
    recordIntent(db, { channel: 'mastodon', text: 'unrelated', riskClass: 'AUTO', approvalState: 'AUTO_APPROVED' });

    const bsky = buildChannelStatus(db, 'bluesky', {});
    assert.equal(bsky.TODAY_COUNT, 1);
    assert.ok(bsky.LAST_PUBLICATION);

    const masto = buildChannelStatus(db, 'mastodon', {});
    assert.equal(masto.TODAY_COUNT, 0, 'unpublished mastodon draft must not count as a publication');
    assert.equal(masto.LAST_PUBLICATION, null);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('buildAllChannelStatus: reports every expansion channel exactly once', () => {
  const { dir, db } = tempDb();
  try {
    const all = buildAllChannelStatus(db, {});
    assert.deepEqual(Object.keys(all).sort(), [...allExpansionChannelNames()].sort());
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});
