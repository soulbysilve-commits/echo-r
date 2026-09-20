import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFacts, validateFacts, supportsShippedClaim, factById } from '../lib/facts.mjs';
import { checkContent, checkPolicyGate, classifyRisk, RISK_CLASS } from '../lib/policy.mjs';

const SAMPLE_FACTS_MD = `
## FACT-001
PRODUCT: ECHO Agent
STATUS: VERIFIED
CLAIM: ECHO Agent can checkpoint a task and resume it after a process restart.
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: state_wal.py
SOURCE_EVIDENCE: test_state_wal_append_hardening_v1.py passes
VERIFIED_AT: 2026-09-01
PUBLIC_SAFE: true
NOTES: has demo

## FACT-002
PRODUCT: Noemora
STATUS: PLANNED
CLAIM: Autonomous residents will act inside the Luanti world without scripted pathways.
SOURCE_REPOSITORY: Noemora_mod_core
SOURCE_PATH: docs/NOEMORA_COMPLETION_STATUS.md
SOURCE_EVIDENCE: project's own audit marks this FAIL today
VERIFIED_AT:
PUBLIC_SAFE: true
NOTES:
`;

test('parseFacts extracts structured fields for each FACT block', () => {
  const facts = parseFacts(SAMPLE_FACTS_MD);
  assert.equal(facts.length, 2);
  assert.equal(facts[0].id, 'FACT-001');
  assert.equal(facts[0].STATUS, 'VERIFIED');
  assert.equal(facts[1].STATUS, 'PLANNED');
});

test('validateFacts flags missing evidence and bad status values', () => {
  const badFacts = parseFacts(`
## FACT-999
PRODUCT: X
STATUS: SHIPPED_FOR_SURE
CLAIM: it works
`);
  const errors = validateFacts(badFacts);
  assert.ok(errors.some((e) => e.includes('invalid STATUS')));
  assert.ok(errors.some((e) => e.includes('missing source')));
});

test('supportsShippedClaim requires VERIFIED status and PUBLIC_SAFE=true', () => {
  const facts = parseFacts(SAMPLE_FACTS_MD);
  assert.equal(supportsShippedClaim(factById(facts, 'FACT-001')), true);
  assert.equal(supportsShippedClaim(factById(facts, 'FACT-002')), false);
});

test('a PLANNED feature cannot be described as shipped', () => {
  const facts = parseFacts(SAMPLE_FACTS_MD);
  const draft = {
    text: 'Available now: autonomous residents acting freely in the Luanti world!',
    factIds: ['FACT-002'],
    claimStrength: 'shipped',
  };
  const result = checkContent(draft, facts);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.startsWith('UNVERIFIED_CLAIM:FACT-002')));
});

test('a public claim with no backing fact id is blocked', () => {
  const facts = parseFacts(SAMPLE_FACTS_MD);
  const draft = { text: 'Shipped: a brand new capability nobody has seen yet.', factIds: [], claimStrength: 'shipped' };
  const result = checkContent(draft, facts);
  assert.equal(result.ok, false);
  assert.ok(result.violations.includes('NO_EVIDENCE_FOR_SHIPPED_CLAIM'));
});

test('a VERIFIED, public-safe fact can support a shipped claim', () => {
  const facts = parseFacts(SAMPLE_FACTS_MD);
  const draft = {
    text: 'Available now: ECHO Agent can checkpoint and resume a task after restart.',
    factIds: ['FACT-001'],
    claimStrength: 'shipped',
  };
  const result = checkContent(draft, facts);
  assert.equal(result.ok, true);
});

test('spam / fabricated-metric / fake-testimonial patterns are blocked regardless of evidence', () => {
  const facts = parseFacts(SAMPLE_FACTS_MD);
  const spammy = { text: 'Our customers say this is the best agent ever, 40% faster than anything else. DM me!', factIds: ['FACT-001'], claimStrength: 'neutral' };
  const result = checkContent(spammy, facts);
  assert.equal(result.ok, false);
  assert.ok(result.violations.includes('FAKE_TESTIMONIAL'));
  assert.ok(result.violations.includes('UNSUPPORTED_SUPERIORITY'));
  assert.ok(result.violations.includes('FABRICATED_METRIC'));
  assert.ok(result.violations.includes('MASS_SOLICITATION'));
});

test('policy gate blocks unsupported accusations and possible credential leaks', () => {
  const r1 = checkPolicyGate({ text: 'This competitor is a total scam.' });
  assert.equal(r1.ok, false);
  const r2 = checkPolicyGate({ text: 'Here is our api_key: sk-abc123 for testing' });
  assert.equal(r2.ok, false);
});

test('risk classification matches the three action classes from the mandate', () => {
  assert.equal(classifyRisk('x_post'), RISK_CLASS.AUTO);
  assert.equal(classifyRisk('x_reply'), RISK_CLASS.AUTO_WITH_POLICY);
  assert.equal(classifyRisk('price_change'), RISK_CLASS.HUMAN_APPROVAL_REQUIRED);
  assert.equal(classifyRisk('stripe_live_mode_activation'), RISK_CLASS.HUMAN_APPROVAL_REQUIRED);
  assert.equal(classifyRisk('some_unknown_future_action'), RISK_CLASS.HUMAN_APPROVAL_REQUIRED);
});

test('YouTube: private upload is AUTO-class but making a video public requires human approval', () => {
  assert.equal(classifyRisk('youtube_upload_private'), RISK_CLASS.AUTO);
  assert.equal(classifyRisk('youtube_make_public'), RISK_CLASS.HUMAN_APPROVAL_REQUIRED);
  assert.equal(classifyRisk('x_video_followup'), RISK_CLASS.AUTO);
});
