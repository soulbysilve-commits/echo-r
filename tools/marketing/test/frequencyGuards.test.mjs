import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { recordIntent, markPublished } from '../lib/ledger.mjs';
import { channelCaps, checkFrequencyGuard, channelPublicationCount, checkStagger } from '../lib/frequencyGuards.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-freqguard-test-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

function publishNow(db, { channel, text, eventId, publishedAt }) {
  const row = recordIntent(db, { channel, text, riskClass: 'AUTO', approvalState: 'AUTO_APPROVED', eventId });
  markPublished(db, row.publication_id, { externalId: 'ext1', externalUrl: 'https://example.com/1', result: 'OK' });
  if (publishedAt) {
    db.prepare('UPDATE publication_ledger SET published_at = ? WHERE publication_id = ?').run(publishedAt, row.publication_id);
  }
  return row;
}

test('channelCaps: known channels get their mandate-default caps', () => {
  assert.deepEqual(channelCaps('bluesky', {}), { perDay: 2, perWeek: undefined });
  assert.deepEqual(channelCaps('devto', {}), { perDay: undefined, perWeek: 2 });
  assert.deepEqual(channelCaps('linkedin', {}), { perDay: undefined, perWeek: 3 });
});

test('channelCaps: env override takes precedence over the default', () => {
  assert.equal(channelCaps('bluesky', { MARKETING_BLUESKY_MAX_PER_DAY: '5' }).perDay, 5);
});

test('checkFrequencyGuard: an unconfigured channel (no default, no override) fails closed, never "unlimited"', () => {
  const { dir, db } = tempDb();
  try {
    const result = checkFrequencyGuard(db, 'some_future_channel', {});
    assert.equal(result.ok, false);
    assert.match(result.reason, /no configured frequency cap/);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkFrequencyGuard: bluesky daily cap (2/day) blocks a 3rd publish within 24h', () => {
  const { dir, db } = tempDb();
  try {
    publishNow(db, { channel: 'bluesky', text: 'post 1' });
    publishNow(db, { channel: 'bluesky', text: 'post 2' });
    const result = checkFrequencyGuard(db, 'bluesky', {});
    assert.equal(result.ok, false);
    assert.match(result.reason, /daily cap 2 reached/);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkFrequencyGuard: bluesky allows a 2nd publish when only 1 exists today', () => {
  const { dir, db } = tempDb();
  try {
    publishNow(db, { channel: 'bluesky', text: 'post 1' });
    const result = checkFrequencyGuard(db, 'bluesky', {});
    assert.equal(result.ok, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkFrequencyGuard: devto weekly cap (2/week) blocks a 3rd article within 7 days, even across day boundaries', () => {
  const { dir, db } = tempDb();
  try {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    publishNow(db, { channel: 'devto', text: 'article 1', publishedAt: threeDaysAgo });
    publishNow(db, { channel: 'devto', text: 'article 2' });
    const result = checkFrequencyGuard(db, 'devto', {});
    assert.equal(result.ok, false);
    assert.match(result.reason, /weekly cap 2 reached/);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkFrequencyGuard: a publication older than the window does not count against the cap', () => {
  const { dir, db } = tempDb();
  try {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    publishNow(db, { channel: 'devto', text: 'old article', publishedAt: tenDaysAgo });
    const result = checkFrequencyGuard(db, 'devto', {});
    assert.equal(result.ok, true);
    assert.equal(channelPublicationCount(db, 'devto', { windowDays: 7 }), 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- checkStagger (no simultaneous cross-channel burst) ---

test('checkStagger: no prior publication for this event -> ok', () => {
  const { dir, db } = tempDb();
  try {
    const result = checkStagger(db, 'evt-1', 'x');
    assert.equal(result.ok, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkStagger: a different channel publishing the SAME event moments ago blocks an immediate second channel', () => {
  const { dir, db } = tempDb();
  try {
    publishNow(db, { channel: 'x', text: 'announcement', eventId: 'evt-1' });
    const result = checkStagger(db, 'evt-1', 'bluesky', { staggerMs: 5 * 60 * 1000 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /staggering/);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkStagger: the SAME channel\'s own prior publish for this event never blocks itself', () => {
  const { dir, db } = tempDb();
  try {
    publishNow(db, { channel: 'x', text: 'announcement', eventId: 'evt-1' });
    const result = checkStagger(db, 'evt-1', 'x');
    assert.equal(result.ok, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkStagger: once the stagger window has elapsed, a second channel is allowed', () => {
  const { dir, db } = tempDb();
  try {
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    publishNow(db, { channel: 'x', text: 'announcement', eventId: 'evt-1', publishedAt: sixMinutesAgo });
    const result = checkStagger(db, 'evt-1', 'bluesky', { staggerMs: 5 * 60 * 1000 });
    assert.equal(result.ok, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkStagger: no event_id at all -> always ok (nothing to stagger against)', () => {
  const { dir, db } = tempDb();
  try {
    const result = checkStagger(db, null, 'x');
    assert.equal(result.ok, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});
