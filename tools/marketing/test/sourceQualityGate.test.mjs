import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNormalizedEvent } from '../lib/sourceEventSchema.mjs';
import { evaluateEventQuality } from '../lib/sourceQualityGate.mjs';

const BASE = { source_repository: 'ECHOapp', source_kind: 'git_milestone_tag', source_native_id: 'tag-1', event_type: 'NEW_FEATURE_VERIFIED', evidence_refs: ['tag:tag-1'] };

test('a record with no source identity is IGNORE (SOURCE_INVALID)', () => {
  const normalized = buildNormalizedEvent({ event_type: 'BUG_FIXED' }); // no source_repository/kind/native_id
  const gate = evaluateEventQuality(normalized);
  assert.equal(gate.classification, 'IGNORE');
});

test('a record with no evidence at all is IGNORE (EVIDENCE_MISSING) — the "ordinary commit" case', () => {
  const normalized = buildNormalizedEvent({ ...BASE, evidence_refs: [], evidence_hashes: [] });
  const gate = evaluateEventQuality(normalized);
  assert.equal(gate.classification, 'IGNORE');
  assert.ok(gate.reasons.some((r) => r.includes('EVIDENCE_MISSING')));
});

test('a duplicate record is IGNORE regardless of how strong its evidence is', () => {
  const normalized = buildNormalizedEvent({ ...BASE, verification_state: 'VERIFIED', public_safety_state: 'PUBLIC_SAFE' });
  const gate = evaluateEventQuality(normalized, { isDuplicate: true });
  assert.equal(gate.classification, 'IGNORE');
  assert.ok(gate.reasons.includes('DUPLICATE'));
});

test('UNVERIFIED evidence (git commit alone, no attached proof) is IGNORE, not scored', () => {
  const normalized = buildNormalizedEvent({ ...BASE, verification_state: 'UNVERIFIED', public_safety_state: 'PUBLIC_SAFE' });
  const gate = evaluateEventQuality(normalized);
  assert.equal(gate.classification, 'IGNORE');
});

test('CLAIMED_ONLY evidence is NEEDS_REVIEW — a real claim exists but nothing machine-verified it', () => {
  const normalized = buildNormalizedEvent({ ...BASE, verification_state: 'CLAIMED_ONLY', public_safety_state: 'PUBLIC_SAFE' });
  const gate = evaluateEventQuality(normalized);
  assert.equal(gate.classification, 'NEEDS_REVIEW');
});

test('an AUTHORITATIVE, verified, evidence-backed event is INGEST', () => {
  const normalized = buildNormalizedEvent({ ...BASE, verification_state: 'VERIFIED', public_safety_state: 'PUBLIC_SAFE' });
  const gate = evaluateEventQuality(normalized);
  assert.equal(gate.classification, 'INGEST');
  assert.deepEqual(gate.reasons, []);
});

test('an event explicitly marked NOT_PUBLIC is HOLD_PRIVATE — the default posture (mandate section 13)', () => {
  const normalized = buildNormalizedEvent({ ...BASE, verification_state: 'VERIFIED', public_safety_state: 'NOT_PUBLIC' });
  const gate = evaluateEventQuality(normalized);
  assert.equal(gate.classification, 'HOLD_PRIVATE');
});

test('an event whose public_safety_state was never evaluated is NEEDS_REVIEW, not silently allowed through', () => {
  const normalized = buildNormalizedEvent({ ...BASE, verification_state: 'VERIFIED' }); // public_safety_state defaults to NEEDS_REVIEW
  const gate = evaluateEventQuality(normalized);
  assert.equal(gate.classification, 'NEEDS_REVIEW');
});

test('an event whose title/summary contains a secret shape is HOLD_PRIVATE even if the adapter itself claimed PUBLIC_SAFE — never trust the adapter alone', () => {
  const normalized = buildNormalizedEvent({
    ...BASE, verification_state: 'VERIFIED', public_safety_state: 'PUBLIC_SAFE',
    summary: 'Deployed with STRIPE_SECRET_KEY=sk_live_abc123def456ghi789 configured.',
  });
  const gate = evaluateEventQuality(normalized);
  assert.equal(gate.classification, 'HOLD_PRIVATE');
  assert.ok(gate.reasons.some((r) => r.includes('PRIVACY_SCAN_FAILED')));
});

test('an event whose title/summary contains an email address is HOLD_PRIVATE (private user content default)', () => {
  const normalized = buildNormalizedEvent({
    ...BASE, verification_state: 'VERIFIED', public_safety_state: 'PUBLIC_SAFE',
    title: 'Task completed for someone@example.com',
  });
  const gate = evaluateEventQuality(normalized);
  assert.equal(gate.classification, 'HOLD_PRIVATE');
});
