import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvidence, CLAIM_TOPICS, GENERIC_SCHEMA_ID, RELEASE_MANIFEST_SCHEMA_ID } from '../lib/evidenceAllowlist.mjs';

const NOEMORA_SEAL_TEXT = [
  '# Public Demo Master Completion',
  '',
  'Status: SEALED',
  'Generated: 2026-09-16T10:00:00Z',
  '',
  'SHA256: ' + 'a'.repeat(64),
].join('\n');

test('evidenceAllowlist: a real Noemora PUBLIC_DEMO seal is recognized as strong evidence', () => {
  const result = validateEvidence({
    product: 'Noemora', sourceRepository: 'Noemora_mod_core_work',
    relPath: 'V22902_PUBLIC_DEMO_MASTER_FINAL_SEAL.md', text: NOEMORA_SEAL_TEXT,
  });
  assert.equal(result.ok, true);
  assert.equal(result.evidenceType, 'noemora_public_demo_seal');
  assert.equal(result.result, 'PASS');
  assert.equal(result.verifiedAt, '2026-09-16T10:00:00Z');
  assert.ok(result.claim.includes('Noemora'));
});

test('evidenceAllowlist: a non-PUBLIC_DEMO Noemora seal (e.g. a DENIAL/internal-review seal) is NOT recognized at all', () => {
  // Real, dangerous-lookalike filenames actually found in Noemora_mod_core_work
  // — these must never be silently trusted just because they contain "SEAL".
  const denialText = ['# Enactment Approval', '', 'Status: DENIAL - FINAL', ''].join('\n');
  const result1 = validateEvidence({
    product: 'Noemora', sourceRepository: 'Noemora_mod_core_work',
    relPath: 'NOEMORA_PRIVATE_SBE_ENACTMENT_APPROVAL_DENIAL_SEAL_V263700.md', text: denialText,
  });
  assert.equal(result1, null, 'a seal filename without the literal PUBLIC_DEMO segment must never match');

  const staticReviewText = ['# Static Review', '', 'Status: STATIC_VERIFICATION_FINAL', ''].join('\n');
  const result2 = validateEvidence({
    product: 'Noemora', sourceRepository: 'Noemora_mod_core_work',
    relPath: 'V22801_OPERATOR_HANDOFF_STATIC_VERIFICATION_SEAL.md', text: staticReviewText,
  });
  assert.equal(result2, null);
});

test('evidenceAllowlist: a PUBLIC_DEMO-named seal file with no real Status marker is BLOCKED (malformed), not silently ignored', () => {
  const result = validateEvidence({
    product: 'Noemora', sourceRepository: 'Noemora_mod_core_work',
    relPath: 'V1_PUBLIC_DEMO_EMPTY_SEAL.md', text: '# Just a title\n\nsome prose, no status line at all.\n',
  });
  assert.equal(result.ok, false);
});

const RELEASE_MANIFEST_TEXT = JSON.stringify({
  schema: RELEASE_MANIFEST_SCHEMA_ID, release_id: 'echoagent-win-20260914', artifact_sha256: 'b'.repeat(64),
  created_at: '2026-09-14T00:00:00Z', byte_size: 12345,
});

test('evidenceAllowlist: a real release manifest is recognized as strong evidence', () => {
  const result = validateEvidence({
    product: 'ECHO Agent', sourceRepository: 'echo-r',
    relPath: 'release-output/echoagent-win-20260914/manifest.json', text: RELEASE_MANIFEST_TEXT,
  });
  assert.equal(result.ok, true);
  assert.equal(result.evidenceType, 'release_manifest');
  assert.equal(result.sourceRevision, 'echoagent-win-20260914');
});

test('evidenceAllowlist: a manifest.json with a DIFFERENT schema tag is not recognized as this convention', () => {
  const text = JSON.stringify({ schema: 'someone-elses-schema/v1', release_id: 'x' });
  const result = validateEvidence({ product: 'ECHO Agent', sourceRepository: 'echo-r', relPath: 'release-output/x/manifest.json', text });
  assert.equal(result, null);
});

test('evidenceAllowlist: a manifest.json declaring the right schema but missing required fields is BLOCKED', () => {
  const text = JSON.stringify({ schema: RELEASE_MANIFEST_SCHEMA_ID, release_id: 'x' }); // no artifact_sha256/created_at
  const result = validateEvidence({ product: 'ECHO Agent', sourceRepository: 'echo-r', relPath: 'release-output/x/manifest.json', text });
  assert.equal(result.ok, false);
});

function genericEvidence(overrides = {}) {
  return JSON.stringify({
    schema: GENERIC_SCHEMA_ID, product: 'ECHO Agent', artifact_type: 'e2e_test_report',
    source_revision: 'deadbeef1234', verified_at: '2026-09-17T00:00:00Z', result: 'PASS',
    verifier: 'pytest-e2e-runner', public_safe: true, claim_topic: 'e2e_test_pass',
    description: 'checkout flow completes in sandbox mode', ...overrides,
  });
}

test('evidenceAllowlist: a well-formed generic-schema PASS artifact is recognized as strong evidence', () => {
  const result = validateEvidence({ product: 'ECHO Agent', sourceRepository: 'ECHODiscord版', relPath: 'CI_RESULT.json', text: genericEvidence() });
  assert.equal(result.ok, true);
  assert.equal(result.evidenceType, 'generic:e2e_test_report');
  assert.equal(result.claimStatus, 'VERIFIED');
});

test('evidenceAllowlist: arbitrary JSON that merely contains the word PASS, with no schema tag, is NOT recognized', () => {
  const text = JSON.stringify({ note: 'all good', result: 'PASS', totally: 'made up shape' });
  const result = validateEvidence({ product: 'ECHO Agent', sourceRepository: 'ECHODiscord版', relPath: 'whatever.json', text });
  assert.equal(result, null);
});

test('evidenceAllowlist: a plain "fake PASS.txt" (not JSON at all) is never recognized', () => {
  const result = validateEvidence({ product: 'ECHO Agent', sourceRepository: 'ECHODiscord版', relPath: 'FAKE_PASS.txt', text: 'PASS\nPASS\nPASS\neverything passed I promise\n' });
  assert.equal(result, null);
});

test('evidenceAllowlist: a result that is not an EXPLICIT PASS/VERIFIED (e.g. "OK", "GREEN") is BLOCKED', () => {
  const result = validateEvidence({ product: 'ECHO Agent', sourceRepository: 'ECHODiscord版', relPath: 'x.json', text: genericEvidence({ result: 'OK' }) });
  assert.equal(result.ok, false);
});

test('evidenceAllowlist: an unknown claim_topic is BLOCKED', () => {
  const result = validateEvidence({ product: 'ECHO Agent', sourceRepository: 'ECHODiscord版', relPath: 'x.json', text: genericEvidence({ claim_topic: 'production_deployment_confirmed' }) });
  assert.equal(result.ok, false);
});

test('evidenceAllowlist: a valid claim_topic paired with a MISMATCHED artifact_type is BLOCKED (never silently widened)', () => {
  // offline_evaluation_result only accepts artifact_type 'offline_evaluation' — pairing it
  // with an e2e_test_report would let offline-only evidence claim e2e-level scope.
  const result = validateEvidence({
    product: 'ECHO Agent', sourceRepository: 'ECHODiscord版', relPath: 'x.json',
    text: genericEvidence({ artifact_type: 'e2e_test_report', claim_topic: 'offline_evaluation_result' }),
  });
  assert.equal(result.ok, false);
});

test('evidenceAllowlist: the planner_function_swap claim template never contains "model" or "provider" migration language', () => {
  const claim = CLAIM_TOPICS.planner_function_swap.template({ product: 'ECHO Agent', description: 'swapped lambda A vs B' });
  assert.ok(!/\bmodel\b/i.test(claim), 'must never imply a real AI model swap');
  assert.ok(!/\bprovider\b/i.test(claim), 'must never imply a real API provider swap');
  assert.ok(claim.includes('planner function'));
});

test('evidenceAllowlist: offline_evaluation_result carries a non-null limitations string preserving its offline-only scope', () => {
  assert.ok(CLAIM_TOPICS.offline_evaluation_result.limitations);
  assert.match(CLAIM_TOPICS.offline_evaluation_result.limitations, /offline/i);
});

test('evidenceAllowlist: missing required generic-schema fields are BLOCKED with a specific reason', () => {
  const text = JSON.stringify({ schema: GENERIC_SCHEMA_ID, product: 'ECHO Agent' }); // everything else missing
  const result = validateEvidence({ product: 'ECHO Agent', sourceRepository: 'ECHODiscord版', relPath: 'x.json', text });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing required field/);
});

// --- release-orchestrator claim topics (added 2026-09-18) ---

function releasePromotionEvidence(product, claimTopic, overrides = {}) {
  return JSON.stringify({
    schema: GENERIC_SCHEMA_ID, product, artifact_type: 'release_promotion_record',
    source_revision: 'deadbeef1234', verified_at: '2026-09-18T00:00:00Z', result: 'VERIFIED',
    verifier: 'veritas-release-orchestrator', public_safe: true, claim_topic: claimTopic,
    description: 'promoted via the orchestrator', ...overrides,
  });
}

test('evidenceAllowlist: echo_agent_production_release accepts well-formed ECHO Agent evidence', () => {
  const result = validateEvidence({ product: 'ECHO Agent', sourceRepository: 'echo-r', relPath: 'x.json', text: releasePromotionEvidence('ECHO Agent', 'echo_agent_production_release') });
  assert.equal(result.ok, true);
  assert.match(result.claim, /promoted to the Production distribution path/);
});

test('evidenceAllowlist: echo_app_validated_release accepts well-formed ECHO App evidence', () => {
  const result = validateEvidence({ product: 'ECHO App', sourceRepository: 'ECHOapp', relPath: 'x.json', text: releasePromotionEvidence('ECHO App', 'echo_app_validated_release') });
  assert.equal(result.ok, true);
  assert.match(result.claim, /passed its validated release pipeline/);
  assert.doesNotMatch(result.limitations, /App Store availability confirmed/i);
  assert.match(result.limitations, /Does not imply App Store/);
});

test('evidenceAllowlist: noemora_runtime_release accepts well-formed Noemora evidence and forbids governance extrapolation', () => {
  const result = validateEvidence({ product: 'Noemora', sourceRepository: 'Noemora_mod_core_work', relPath: 'x.json', text: releasePromotionEvidence('Noemora', 'noemora_runtime_release') });
  assert.equal(result.ok, true);
  assert.match(result.claim, /validated Noemora runtime revision was deployed/);
  assert.match(result.limitations, /never implies any autonomous governance decision/);
});

test('evidenceAllowlist: official_site_deployment accepts well-formed ECHO-R evidence and forbids a sales-live claim', () => {
  const result = validateEvidence({ product: 'ECHO-R', sourceRepository: 'echo-r', relPath: 'x.json', text: releasePromotionEvidence('ECHO-R', 'official_site_deployment') });
  assert.equal(result.ok, true);
  assert.match(result.claim, /validated ECHO-R website revision was deployed/);
  assert.match(result.limitations, /Does not imply general sales are live/);
});

test('evidenceAllowlist: a release-promotion claim_topic used with the WRONG product is BLOCKED, never silently retargeted', () => {
  const result = validateEvidence({ product: 'Noemora', sourceRepository: 'Noemora_mod_core_work', relPath: 'x.json', text: releasePromotionEvidence('Noemora', 'echo_agent_production_release') });
  assert.equal(result.ok, false);
  assert.match(result.reason, /is scoped to product 'ECHO Agent'/);
});

test('evidenceAllowlist: all four release-scoped topics reject every other product, not just one example', () => {
  const combos = [
    ['echo_agent_production_release', 'ECHO App'],
    ['echo_app_validated_release', 'ECHO Agent'],
    ['noemora_runtime_release', 'ECHO-R'],
    ['official_site_deployment', 'Noemora'],
  ];
  for (const [topic, wrongProduct] of combos) {
    const result = validateEvidence({ product: wrongProduct, sourceRepository: 'x', relPath: 'x.json', text: releasePromotionEvidence(wrongProduct, topic) });
    assert.equal(result.ok, false, `${topic} should reject product ${wrongProduct}`);
  }
});

test('evidenceAllowlist: release_promotion_record paired with an unrelated claim_topic is still governed by requiredArtifactTypes', () => {
  const result = validateEvidence({
    product: 'ECHO Agent', sourceRepository: 'echo-r', relPath: 'x.json',
    text: releasePromotionEvidence('ECHO Agent', 'e2e_test_pass'), // e2e_test_pass requires e2e_test_report, not release_promotion_record
  });
  assert.equal(result.ok, false);
});
