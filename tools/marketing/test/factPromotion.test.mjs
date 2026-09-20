import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { ensureActivationBoundary } from '../lib/activation.mjs';
import {
  STAGE, deterministicFactId, evaluatePublicSafeGate, recordFactPromotion,
  machineVerifiedFactRow, loadMergedFacts, factPromotionStatus, MACHINE_FACT_SOURCE_KEY,
} from '../lib/factPromotion.mjs';
import { validateEvidence } from '../lib/evidenceAllowlist.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-factpromotion-test-'));
  const db = openDb(join(dir, 'test.db'));
  return { dir, db };
}

function strongEvidence(overrides = {}) {
  return {
    ok: true,
    evidenceType: 'generic:e2e_test_report',
    product: 'ECHO Agent',
    sourceRepository: 'ECHODiscord版',
    artifactPath: 'CI_RESULT.json',
    artifactHash: 'h'.repeat(64),
    sourceRevision: 'rev-current',
    verifiedAt: '2026-09-17T00:00:00.000Z',
    result: 'PASS',
    verifierIdentity: 'pytest-e2e-runner',
    claim: "ECHO Agent's end-to-end test suite passed for: checkout flow",
    claimStatus: 'VERIFIED',
    limitations: null,
    ...overrides,
  };
}

test('deterministicFactId: stable for identical inputs, different for any changed input', () => {
  const base = { product: 'ECHO Agent', sourceRevision: 'r1', artifactHash: 'h1', evidenceType: 'generic:e2e_test_report' };
  const id1 = deterministicFactId(base);
  const id2 = deterministicFactId({ ...base });
  assert.equal(id1, id2);
  assert.notEqual(id1, deterministicFactId({ ...base, sourceRevision: 'r2' }));
  assert.notEqual(id1, deterministicFactId({ ...base, artifactHash: 'h2' }));
  assert.match(id1, /^MVF-[0-9a-f]{16}$/);
});

test('evaluatePublicSafeGate: clean strong evidence, past activation boundary, current revision -> PUBLIC_SAFE_VERIFIED_FACT', () => {
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z'); // well before verifiedAt
    const gate = evaluatePublicSafeGate(strongEvidence(), { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'rev-current' });
    assert.equal(gate.stage, STAGE.PUBLIC_SAFE_VERIFIED_FACT);
    assert.deepEqual(gate.reasons, []);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluatePublicSafeGate: a stale revision (does not match the repo\'s currently-known HEAD) is BLOCKED, never auto-promoted', () => {
  const gate = evaluatePublicSafeGate(strongEvidence({ sourceRevision: 'rev-old-abandoned' }), {
    activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'rev-current',
  });
  assert.equal(gate.stage, STAGE.VERIFIED_FACT_CANDIDATE);
  assert.ok(gate.reasons.includes('STALE_REVISION'));
});

test('evaluatePublicSafeGate: generic:release_promotion_record is EXEMPT from STALE_REVISION — the repo HEAD moving past the deployment\'s own source revision (e.g. via the commit that adds the evidence file itself) does not retroactively invalidate a completed, point-in-time deployment claim', () => {
  const gate = evaluatePublicSafeGate(strongEvidence({
    evidenceType: 'generic:release_promotion_record',
    sourceRevision: 'deploy-source-rev',
  }), {
    activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'repo-head-several-commits-later',
  });
  assert.equal(gate.stage, STAGE.PUBLIC_SAFE_VERIFIED_FACT, JSON.stringify(gate.reasons));
  assert.ok(!gate.reasons.includes('STALE_REVISION'));
});

test('evaluatePublicSafeGate: the STALE_REVISION exemption is scoped ONLY to generic:release_promotion_record — every other generic evidence type (e2e/unit/integration test reports, offline evaluations) is still blocked when its revision mismatches the repo\'s current HEAD', () => {
  for (const evidenceType of ['generic:e2e_test_report', 'generic:unit_test_report', 'generic:integration_test_report', 'generic:offline_evaluation']) {
    const gate = evaluatePublicSafeGate(strongEvidence({ evidenceType, sourceRevision: 'rev-old-abandoned' }), {
      activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'rev-current',
    });
    assert.ok(gate.reasons.includes('STALE_REVISION'), `expected STALE_REVISION for ${evidenceType}, got ${JSON.stringify(gate.reasons)}`);
  }
});

test('evaluatePublicSafeGate: historical strong evidence (verified_at predates the activation boundary) is recorded but remains activation-blocked — no backlog laundering', () => {
  const gate = evaluatePublicSafeGate(strongEvidence({ verifiedAt: '2026-09-01T00:00:00.000Z' }), {
    activationBoundary: '2026-09-14T16:44:43.953Z', // real global boundary shape from this codebase
    knownCurrentRevision: 'rev-current',
  });
  assert.equal(gate.stage, STAGE.VERIFIED_FACT_CANDIDATE);
  assert.ok(gate.reasons.some((r) => r.startsWith('PRE_ACTIVATION')));
});

test('evaluatePublicSafeGate: a secret-shaped string inside the composed claim/limitations text is BLOCKED', () => {
  const gate = evaluatePublicSafeGate(
    strongEvidence({ limitations: 'DEBUG: api_key: sk-THISISASECRETKEY1234567890' }),
    { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'rev-current' }
  );
  assert.equal(gate.stage, STAGE.VERIFIED_FACT_CANDIDATE);
  assert.ok(gate.reasons.includes('POSSIBLE_SECRET_IN_CLAIM'));
});

test('evaluatePublicSafeGate: an unsupported-superiority-style claim is BLOCKED by the existing shared policy gate, not a second copy of the rules', () => {
  const gate = evaluatePublicSafeGate(
    strongEvidence({ claim: 'ECHO Agent is the best AI agent framework, guaranteed.' }),
    { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'rev-current' }
  );
  assert.equal(gate.stage, STAGE.VERIFIED_FACT_CANDIDATE);
  assert.ok(gate.reasons.some((r) => r.includes('UNSUPPORTED_SUPERIORITY')));
});

test('evaluatePublicSafeGate: a non-VERIFIED (PARTIAL) claim that still smuggles "production" language is BLOCKED', () => {
  const gate = evaluatePublicSafeGate(
    strongEvidence({ claimStatus: 'PARTIAL', claim: 'ECHO Agent works correctly in production.' }),
    { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'rev-current' }
  );
  assert.ok(gate.reasons.includes('OVERBROAD_PRODUCTION_CLAIM_FROM_NON_VERIFIED_EVIDENCE'));
});

test('recordFactPromotion: BLOCKED_UNVERIFIED evidence (ok:false or unknown schema) is durably logged, never silently dropped', () => {
  const { dir, db } = tempDb();
  try {
    const result = recordFactPromotion(db, {
      ok: false, reason: 'no parseable status marker',
      product: 'ECHO Agent', sourceRepository: 'ECHODiscord版', artifactPath: 'SOME_REPORT.md', artifactHash: 'h'.repeat(64),
    });
    assert.equal(result.stage, STAGE.BLOCKED_UNVERIFIED);
    const row = db.prepare('SELECT * FROM machine_verified_facts WHERE fact_id = ?').get(result.factId);
    assert.ok(row, 'a BLOCKED_UNVERIFIED artifact must still be durably logged, not silently dropped');
    const result2 = recordFactPromotion(db, null);
    assert.equal(result2.stage, STAGE.BLOCKED_UNVERIFIED);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordFactPromotion: the SAME artifact observed twice produces exactly ONE machine_verified_facts row (idempotent), never a duplicate', () => {
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    const evidence = strongEvidence();
    const first = recordFactPromotion(db, evidence, { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'rev-current' });
    const second = recordFactPromotion(db, evidence, { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'rev-current' });
    assert.equal(first.factId, second.factId);
    assert.equal(first.stage, STAGE.PUBLIC_SAFE_VERIFIED_FACT);
    const rows = db.prepare('SELECT * FROM machine_verified_facts').all();
    assert.equal(rows.length, 1);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMergedFacts: only PUBLIC_SAFE_VERIFIED_FACT rows are merged — VERIFIED_FACT_CANDIDATE/BLOCKED rows never appear', () => {
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', MACHINE_FACT_SOURCE_KEY); // deterministic for this test — see loadMergedFacts()'s own source boundary
    recordFactPromotion(db, strongEvidence({ artifactPath: 'promoted.json', sourceRevision: 'rev-a' }), {
      activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'rev-a',
    });
    recordFactPromotion(db, strongEvidence({ artifactPath: 'stale.json', sourceRevision: 'rev-old' }), {
      activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'rev-current-different',
    });
    recordFactPromotion(db, {
      ok: false, reason: 'malformed',
      product: 'ECHO Agent', sourceRepository: 'ECHODiscord版', artifactPath: 'malformed.json', artifactHash: 'z'.repeat(64),
    });

    const handAuthored = [{ id: 'FACT-001', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED', CLAIM: 'hand authored', PUBLIC_SAFE: 'true' }];
    const merged = loadMergedFacts(handAuthored, db);
    assert.equal(merged.length, 2, 'hand-authored fact + exactly the one PUBLIC_SAFE_VERIFIED_FACT row');
    assert.ok(merged.some((f) => f.id === 'FACT-001'));
    assert.ok(merged.some((f) => f.id.startsWith('MVF-') && f.SOURCE_PATH === 'promoted.json'));
    assert.ok(!merged.some((f) => f.SOURCE_PATH === 'stale.json'));
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('factPromotionStatus: per-product counts and latest-promoted reporting are accurate and read-only', () => {
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    recordFactPromotion(db, strongEvidence({ artifactPath: 'a.json', sourceRevision: 'r1' }), {
      activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'r1',
    });
    recordFactPromotion(db, strongEvidence({ artifactPath: 'b.json', sourceRevision: 'r2', product: 'ECHO App' }), {
      activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: 'wrong-rev', // stale -> candidate, not promoted
    });
    const status = factPromotionStatus(db);
    const echoAgent = status.byProduct.find((p) => p.PRODUCT === 'ECHO Agent');
    const echoApp = status.byProduct.find((p) => p.PRODUCT === 'ECHO App');
    assert.equal(echoAgent.AUTO_PROMOTED_FACTS, 1);
    assert.equal(echoApp.VERIFIED_FACT_CANDIDATES, 1);
    assert.equal(echoApp.AUTO_PROMOTED_FACTS, 0);
    assert.ok(status.latestPromoted);
    assert.equal(status.latestPromoted.PRODUCT, 'ECHO Agent');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('machineVerifiedFactRow: returns null for an unknown fact_id rather than throwing', () => {
  const { dir, db } = tempDb();
  try {
    assert.equal(machineVerifiedFactRow(db, 'MVF-doesnotexist'), null);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Section 11: claim topic tests (release-orchestrator integration, 2026-09-18) ---

function genericEvidenceText({ product, claimTopic, sourceRevision = 'abc123', description = 'test description' }) {
  return JSON.stringify({
    schema: 'veritas-forge-verified-evidence/v1', product, artifact_type: 'release_promotion_record',
    source_revision: sourceRevision, verified_at: '2026-09-18T00:00:00.000Z', result: 'VERIFIED',
    verifier: 'test', public_safe: true, claim_topic: claimTopic, description,
  });
}

test('Section 11: OFFICIAL_SITE_CLAIM_ALLOWED -- a real, narrow official_site_deployment claim passes every gate through to PUBLIC_SAFE_VERIFIED_FACT', () => {
  const text = genericEvidenceText({
    product: 'ECHO-R', claimTopic: 'official_site_deployment',
    description: 'npm build + 5 hermetic fulfillment/crypto/activation regression scripts',
  });
  const evidence = validateEvidence({ product: 'ECHO-R', sourceRepository: 'echo-r', relPath: 'x.json', text });
  assert.equal(evidence.ok, true);
  const gate = evaluatePublicSafeGate(evidence, { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: null });
  assert.equal(gate.stage, STAGE.PUBLIC_SAFE_VERIFIED_FACT, JSON.stringify(gate.reasons));
  assert.doesNotMatch(evidence.claim, /sales|checkout|pricing|purchase/i);
});

test('Section 11: OFFICIAL_SITE_OVERCLAIM_REJECTED -- a description smuggling a sales/checkout implication is blocked, never PUBLIC_SAFE_VERIFIED_FACT', () => {
  const text = genericEvidenceText({
    product: 'ECHO-R', claimTopic: 'official_site_deployment',
    description: 'checkout is now open and pricing has changed',
  });
  const evidence = validateEvidence({ product: 'ECHO-R', sourceRepository: 'echo-r', relPath: 'x.json', text });
  assert.equal(evidence.ok, true); // allowlist itself doesn't judge claim content, only structure/topic/product
  const gate = evaluatePublicSafeGate(evidence, { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: null });
  assert.notEqual(gate.stage, STAGE.PUBLIC_SAFE_VERIFIED_FACT);
  assert.ok(gate.reasons.some((r) => r.includes('POLICY') || r.includes('OVERCLAIM')), JSON.stringify(gate.reasons));
});

test('Section 11: ECHO_APP_CLAIM_ALLOWED -- a real, narrow echo_app_validated_release claim passes every gate through to PUBLIC_SAFE_VERIFIED_FACT', () => {
  const text = genericEvidenceText({
    product: 'ECHO App', claimTopic: 'echo_app_validated_release',
    description: 'core-freeze ancestry + backend/tests/ full suite',
  });
  const evidence = validateEvidence({ product: 'ECHO App', sourceRepository: 'ECHOapp', relPath: 'x.json', text });
  assert.equal(evidence.ok, true);
  const gate = evaluatePublicSafeGate(evidence, { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: null });
  assert.equal(gate.stage, STAGE.PUBLIC_SAFE_VERIFIED_FACT, JSON.stringify(gate.reasons));
});

test('Section 11: APP_STORE_RELEASE_CLAIM_REJECTED -- a description claiming App Store/TestFlight availability is blocked regardless of topic', () => {
  for (const description of [
    'now available on the App Store',
    'shipped via TestFlight to beta testers',
    'passed Apple review',
  ]) {
    const text = genericEvidenceText({ product: 'ECHO App', claimTopic: 'echo_app_validated_release', description });
    const evidence = validateEvidence({ product: 'ECHO App', sourceRepository: 'ECHOapp', relPath: 'x.json', text });
    const gate = evaluatePublicSafeGate(evidence, { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: null });
    assert.notEqual(gate.stage, STAGE.PUBLIC_SAFE_VERIFIED_FACT, `expected "${description}" to be rejected`);
    assert.ok(gate.reasons.includes('OVERCLAIM_GENERAL_AVAILABILITY_OR_STORE_RELEASE'), JSON.stringify(gate.reasons));
  }
});

test('Section 11: GENERAL_AVAILABILITY_CLAIM_REJECTED -- a description claiming general/public/customer availability is blocked regardless of topic', () => {
  for (const description of [
    'now generally available to all users',
    'publicly downloadable from the website',
    'available to customers worldwide',
  ]) {
    const text = genericEvidenceText({ product: 'ECHO-R', claimTopic: 'official_site_deployment', description });
    const evidence = validateEvidence({ product: 'ECHO-R', sourceRepository: 'echo-r', relPath: 'x.json', text });
    const gate = evaluatePublicSafeGate(evidence, { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: null });
    assert.notEqual(gate.stage, STAGE.PUBLIC_SAFE_VERIFIED_FACT, `expected "${description}" to be rejected`);
    assert.ok(gate.reasons.includes('OVERCLAIM_GENERAL_AVAILABILITY_OR_STORE_RELEASE'), JSON.stringify(gate.reasons));
  }
});

test('Section 11: a legitimate claim never false-positives on the new overclaim check -- every real CLAIM_TOPICS template text is unaffected', () => {
  for (const [claimTopic, product] of [
    ['echo_agent_production_release', 'ECHO Agent'], ['echo_app_validated_release', 'ECHO App'],
    ['noemora_runtime_release', 'Noemora'], ['official_site_deployment', 'ECHO-R'],
  ]) {
    const text = genericEvidenceText({ product, claimTopic, description: '' });
    const evidence = validateEvidence({ product, sourceRepository: 'test', relPath: 'x.json', text });
    const gate = evaluatePublicSafeGate(evidence, { activationBoundary: '2020-01-01T00:00:00.000Z', knownCurrentRevision: null });
    assert.equal(gate.stage, STAGE.PUBLIC_SAFE_VERIFIED_FACT, `${claimTopic} with no description must never overclaim: ${JSON.stringify(gate.reasons)}`);
  }
});
