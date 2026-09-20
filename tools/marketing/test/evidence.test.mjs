import test from 'node:test';
import assert from 'node:assert/strict';
import { scanEvidence, buildPublicSafeBundle } from '../lib/evidence.mjs';

test('scanEvidence flags an API key shape and redacts it', () => {
  const result = scanEvidence('running with token sk-THISISASECRETVALUE1234567890');
  assert.equal(result.clean, false);
  assert.ok(result.findings.includes('GENERIC_SECRET_SHAPE'));
  assert.ok(!result.redactedText.includes('sk-THISISASECRETVALUE1234567890'));
});

test('scanEvidence flags an email address', () => {
  const result = scanEvidence('contact: silver@example.com for access');
  assert.equal(result.clean, false);
  assert.ok(result.findings.includes('EMAIL'));
});

test('scanEvidence flags a private IPv4 address', () => {
  const result = scanEvidence('connecting to 192.168.1.42 for internal service');
  assert.equal(result.clean, false);
  assert.ok(result.findings.includes('PRIVATE_IPV4'));
});

test('scanEvidence flags a Stripe-style identifier', () => {
  const result = scanEvidence('order for cus_ABCDEFGHIJKLMN completed');
  assert.equal(result.clean, false);
  assert.ok(result.findings.includes('STRIPE_ID'));
});

test('scanEvidence passes clean, ordinary log lines', () => {
  const result = scanEvidence('[00:06] PLAN CREATED — 5 STEPS');
  assert.equal(result.clean, true);
  assert.deepEqual(result.findings, []);
});

test('buildPublicSafeBundle blocks the whole bundle if any single line fails the scan', () => {
  const result = buildPublicSafeBundle({
    demoRunId: 'demo1',
    rawLogLines: [
      '[00:02] GOAL ACCEPTED',
      'DEBUG: STRIPE_SECRET_KEY=sk_live_abc123def456',
      '[00:06] PLAN CREATED — 5 STEPS',
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'VIDEO_PUBLICATION_BLOCKED');
});

test('buildPublicSafeBundle passes through a fully clean set of lines', () => {
  const result = buildPublicSafeBundle({
    demoRunId: 'demo2',
    factIds: ['FACT-001'],
    rawLogLines: [
      '[00:02] GOAL ACCEPTED',
      '[00:06] PLAN CREATED — 5 STEPS',
      '[00:31] STEP 3 FAILED',
      '[00:32] VERIFIER — REJECT',
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'PUBLIC_SAFE');
  assert.equal(result.bundle.demoRunId, 'demo2');
  assert.equal(result.bundle.publicSafeLogLines.length, 4);
});

test('buildPublicSafeBundle with zero evidence lines is trivially clean but carries no content', () => {
  const result = buildPublicSafeBundle({ demoRunId: 'demo3', rawLogLines: [] });
  assert.equal(result.ok, true);
  assert.equal(result.bundle.publicSafeLogLines.length, 0);
});
