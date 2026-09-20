// Site-level (Next.js app) tests, separate from tools/marketing/test (the
// marketing operator subsystem's own tests). Run with:
//   node --test test/analyticsEvents.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, EVENT_TYPES } from '../lib/analyticsEvents.ts';

test('rejects an unknown event_type', () => {
  const result = validateEvent({ event_type: 'SOMETHING_ELSE', path: '/news' });
  assert.equal(result.ok, false);
});

test('requires a relative path', () => {
  const r1 = validateEvent({ event_type: 'PAGE_VIEW' });
  assert.equal(r1.ok, false);
  const r2 = validateEvent({ event_type: 'PAGE_VIEW', path: 'https://evil.example/x' });
  assert.equal(r2.ok, false);
});

test('accepts a valid event and captures UTM fields', () => {
  const result = validateEvent({
    event_type: 'CTA_CLICK', path: '/echo-agent', utm_source: 'x', utm_medium: 'social', utm_campaign: 'launch', utm_content: 'hero_cta',
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.event.utm_source, 'x');
    assert.equal(result.event.utm_campaign, 'launch');
  }
});

test('only allowlisted fields ever reach the returned event — extra/sensitive fields are dropped, not merely hidden', () => {
  const result = validateEvent({
    event_type: 'CHECKOUT_START',
    path: '/echo-agent',
    // Sensitive/unexpected fields a caller might accidentally include:
    card_number: '4111111111111111',
    stripe_secret_key: 'sk_live_abc123',
    conversation: 'private chat content',
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    const keys = Object.keys(result.event);
    assert.ok(!keys.includes('card_number'));
    assert.ok(!keys.includes('stripe_secret_key'));
    assert.ok(!keys.includes('conversation'));
    assert.deepEqual(
      keys.sort(),
      ['event_type', 'locale', 'path', 'received_at', 'referrer_host', 'utm_campaign', 'utm_content', 'utm_medium', 'utm_source'].sort()
    );
  }
});

test('referrer is reduced to host only, never the full URL (which may carry query params)', () => {
  const result = validateEvent({ event_type: 'PAGE_VIEW', path: '/', referrer: 'https://x.com/status/123?utm_source=leak&secret=abc' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.event.referrer_host, 'x.com');
  }
});

test('an invalid referrer URL is dropped rather than stored raw', () => {
  const result = validateEvent({ event_type: 'PAGE_VIEW', path: '/', referrer: 'not a url; DROP TABLE users;' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.event.referrer_host, null);
  }
});

test('EVENT_TYPES matches the mandate\'s required set exactly', () => {
  assert.deepEqual(
    [...EVENT_TYPES].sort(),
    ['PAGE_VIEW', 'PRODUCT_PAGE_VIEW', 'CTA_CLICK', 'CHECKOUT_START', 'CHECKOUT_SUCCESS', 'DOWNLOAD_READY', 'DOWNLOAD_COMPLETE'].sort()
  );
});
