// Official Site release evidence: deployment binding + single authoritative
// interpretation.
//
// Covers two things veritas-release-orchestrator's autorelease hardening
// changed on the evidence side:
//
//   1. `release_binding` (which exact Vercel deployment a
//      release_promotion_record refers to) is an OPTIONAL, additive part of
//      the veritas-forge-verified-evidence/v1 schema. When present it is
//      strictly validated and can never carry a secret or widen a claim;
//      when absent (every historical record) nothing changes.
//   2. lib/devObserver.mjs no longer stamps an allowlist-VERIFIED artifact
//      'BLOCKED_UNVERIFIED: no parseable status marker'. The allowlist is
//      the single authority for schemas it recognizes; the legacy text
//      heuristic remains only for files no schema recognizes.
//
// The HISTORICAL_* fixture reproduces, byte for byte, the real evidence file
// for revision 541d3c0 (sha256 1566836d...), so idempotency of the existing
// machine fact MVF-d692c436ab73035d is asserted against the real thing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { observeRepo, ensureDevObserverSchema } from '../lib/devObserver.mjs';
import { ensureActivationBoundary } from '../lib/activation.mjs';
import { MACHINE_FACT_SOURCE_KEY, deterministicFactId, ensureFactPromotionSchema } from '../lib/factPromotion.mjs';
import { validateEvidence, validateReleaseBinding } from '../lib/evidenceAllowlist.mjs';

const SITE_REPO = 'veritas-release-orchestrator/official-site';
const SITE_CONFIG_BASE = { repoKey: 'release-orchestrator-official-site', sourceRepository: SITE_REPO, product: 'ECHO-R' };

const HISTORICAL_SHA = '541d3c0c14c6acf53c5451eadb5fe7f33a4d918a';
const HISTORICAL_FILE = 'OFFICIAL_SITE-1789736533816-VERIFICATION-RECORD.json';
const HISTORICAL_FILE_SHA256 = '1566836dc153292c90d59219169c66a409aa2936f2dbb706d481115a8b4967f6';
const HISTORICAL_FACT_ID = 'MVF-d692c436ab73035d';
// identity_hash of the real dev_observations row the legacy heuristic mislabeled.
const HISTORICAL_OBSERVATION_HASH = 'cfe363320696e533c61d6adbd9c1e9276ef08fa6e91b3d9edd45260c1f45198b';

const HISTORICAL_OBJECT = {
  schema: 'veritas-forge-verified-evidence/v1',
  product: 'ECHO-R',
  artifact_type: 'release_promotion_record',
  source_revision: HISTORICAL_SHA,
  verified_at: '2026-09-18T13:02:13.816Z',
  result: 'PASS',
  verifier: 'veritas-release-orchestrator/officialSiteAdapter',
  public_safe: true,
  claim_topic: 'official_site_deployment',
  description: 'npm build + 5 hermetic fulfillment/crypto/activation regression scripts',
};
const HISTORICAL_TEXT = JSON.stringify(HISTORICAL_OBJECT, null, 2);

const NEW_SHA = 'a'.repeat(40);
const BINDING = {
  deployment_id: 'dpl_9egDSysqaiL6UW4XBiRQfu6gfBzc',
  deployment_url: 'https://echo-a5vqgwi5v-veritas-forge.vercel.app',
  production_alias: 'echo-r.veritasforge.net',
  promoted_at: '2026-09-20T01:02:13.816Z',
  post_validation_result: 'PASS',
  live_revision_verified: true,
};
function enrichedObject(overrides = {}, binding = BINDING) {
  return {
    ...HISTORICAL_OBJECT, source_revision: NEW_SHA, verified_at: BINDING.promoted_at,
    description: 'npm build + 6 hermetic fulfillment/crypto/activation/release-identity regression scripts',
    ...(binding === undefined ? {} : { release_binding: binding }), ...overrides,
  };
}
const enrichedText = (overrides, binding) => JSON.stringify(enrichedObject(overrides, binding), null, 2);

function validate(text, relPath = 'OFFICIAL_SITE-1-VERIFICATION-RECORD.json') {
  return validateEvidence({ product: 'ECHO-R', sourceRepository: SITE_REPO, relPath, text });
}

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-releasebinding-test-'));
  return { dir, db: openDb(join(dir, 'test.db')) };
}

/** Baseline scan then a real scan of a directory holding `files`. */
async function scanEvidenceDir(db, files, { legacyRow = false } = {}) {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'marketing-releasebinding-evidence-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(evidenceRoot, name), text);
  const config = { ...SITE_CONFIG_BASE, repoPath: evidenceRoot };
  const noGit = async () => ({ stdout: '' });
  ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
  ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', MACHINE_FACT_SOURCE_KEY);
  if (legacyRow) {
    ensureDevObserverSchema(db);
    db.prepare(
      `INSERT INTO dev_observations (identity_hash, repo_key, kind, identity, summary, detected_at, status, matched_fact_id)
       VALUES (?, ?, 'artifact', ?, 'no parseable status marker', '2026-09-19T00:05:56.871Z', 'BLOCKED_UNVERIFIED', NULL)`
    ).run(HISTORICAL_OBSERVATION_HASH, SITE_CONFIG_BASE.repoKey, HISTORICAL_FILE);
  }
  await observeRepo(db, config, { execFileImpl: noGit, facts: [] }); // baseline
  const first = await observeRepo(db, config, { execFileImpl: noGit, facts: [] });
  return { evidenceRoot, config, noGit, first };
}

const artifactRows = (db) => db.prepare("SELECT * FROM dev_observations WHERE kind = 'artifact' ORDER BY detected_at, identity").all();
// The fact table is created lazily (first recognized artifact), so ensure it
// exists before asserting on it -- "no table" and "no rows" mean the same here.
const facts = (db) => { ensureFactPromotionSchema(db); return db.prepare('SELECT * FROM machine_verified_facts ORDER BY fact_id').all(); };

// ---------------------------------------------------------------------------
// The historical record: fixture fidelity + idempotent identity
// ---------------------------------------------------------------------------

test('fixture: the historical evidence text is byte-identical to the real file (sha256 pinned)', () => {
  assert.equal(createHash('sha256').update(HISTORICAL_TEXT, 'utf8').digest('hex'), HISTORICAL_FILE_SHA256);
});

test('historical evidence (no release_binding) is still allowlisted, unchanged, with no binding', () => {
  const r = validate(HISTORICAL_TEXT, HISTORICAL_FILE);
  assert.equal(r.ok, true);
  assert.equal(r.releaseBinding, null);
  assert.equal(r.artifactHash, HISTORICAL_FILE_SHA256);
  assert.equal(r.claim, 'A validated ECHO-R website revision was deployed (npm build + 5 hermetic fulfillment/crypto/activation regression scripts).');
});

test('historical evidence derives the SAME fact id as the existing MVF-d692c436ab73035d (idempotent identity)', () => {
  const r = validate(HISTORICAL_TEXT, HISTORICAL_FILE);
  assert.equal(deterministicFactId(r), HISTORICAL_FACT_ID);
});

// ---------------------------------------------------------------------------
// Enriched evidence: still allowlisted, scope not broadened
// ---------------------------------------------------------------------------

test('enriched Official Site evidence (valid release_binding) is still allowlisted as the same claim topic', () => {
  const r = validate(enrichedText());
  assert.equal(r.ok, true);
  assert.equal(r.evidenceType, 'generic:release_promotion_record');
  assert.equal(r.claimTopic, 'official_site_deployment');
  assert.equal(r.claimStatus, 'VERIFIED');
  assert.deepEqual(r.releaseBinding, {
    deploymentId: BINDING.deployment_id, deploymentUrl: BINDING.deployment_url,
    productionAlias: BINDING.production_alias, promotedAt: BINDING.promoted_at,
  });
});

test('deployment metadata does not broaden claim scope: claim sentence and limitations are identical with and without a binding', () => {
  const withBinding = validate(enrichedText());
  const without = validate(enrichedText({}, undefined));
  assert.equal(withBinding.ok, true);
  assert.equal(without.ok, true);
  assert.equal(withBinding.claim, without.claim);
  assert.equal(withBinding.limitations, without.limitations);
  assert.equal(withBinding.claimStatus, without.claimStatus);
  // The binding is provenance only -- none of its values may leak into the claim.
  for (const v of [BINDING.deployment_id, BINDING.deployment_url, BINDING.production_alias]) {
    assert.equal(withBinding.claim.includes(v), false);
    assert.equal(withBinding.limitations.includes(v), false);
  }
  assert.match(withBinding.limitations, /Does not imply general sales are live/);
});

test('a binding does not change which product/topic pairing is accepted (wrong product still blocked)', () => {
  const r = validate(enrichedText({ product: 'ECHO Agent' }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /scoped to product/);
});

test('release_binding is only valid on release_promotion_record evidence', () => {
  const r = validateEvidence({
    product: 'ECHO Agent', sourceRepository: 'echo-r', relPath: 'CI_REPORT.json',
    text: JSON.stringify({
      schema: 'veritas-forge-verified-evidence/v1', product: 'ECHO Agent', artifact_type: 'e2e_test_report', source_revision: 'rev2',
      verified_at: '2026-09-17T00:00:00.000Z', result: 'PASS', verifier: 'runner', public_safe: true, claim_topic: 'e2e_test_pass',
      description: 'checkout', release_binding: BINDING,
    }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /only valid on release_promotion_record/);
});

// ---------------------------------------------------------------------------
// Malformed / secret-bearing metadata is rejected
// ---------------------------------------------------------------------------

test('malformed deployment metadata is rejected (blocked, never allowlisted)', () => {
  const cases = {
    'id without dpl_ prefix': { deployment_id: '9egDSysqaiL6UW4XBiRQfu6gfBzc' },
    'id with path traversal': { deployment_id: 'dpl_../../etc/passwd' },
    'id too short': { deployment_id: 'dpl_abc' },
    'http (not https) url': { deployment_url: 'http://echo-a5vqgwi5v-veritas-forge.vercel.app' },
    'non-vercel host': { deployment_url: 'https://evil.example.com' },
    'url with a path': { deployment_url: 'https://echo-a5vqgwi5v-veritas-forge.vercel.app/admin' },
    'alias with a scheme': { production_alias: 'https://echo-r.veritasforge.net' },
    'alias with a path': { production_alias: 'echo-r.veritasforge.net/x' },
    'non-ISO timestamp': { promoted_at: 'yesterday' },
    'timestamp without Z': { promoted_at: '2026-09-20T01:02:13.816+09:00' },
    'result not PASS': { post_validation_result: 'FAIL' },
    'live_revision_verified false': { live_revision_verified: false },
    'live_revision_verified string': { live_revision_verified: 'true' },
    'empty id': { deployment_id: '' },
    'numeric url': { deployment_url: 42 },
  };
  for (const [label, override] of Object.entries(cases)) {
    const r = validate(enrichedText({}, { ...BINDING, ...override }));
    assert.equal(r.ok, false, `${label} must be rejected`);
    assert.match(r.reason, /release_binding/, label);
  }
});

test('a missing required binding key, an unknown key, or a non-object binding is rejected', () => {
  for (const key of Object.keys(BINDING)) {
    const partial = { ...BINDING };
    delete partial[key];
    assert.equal(validate(enrichedText({}, partial)).ok, false, `missing ${key}`);
  }
  assert.equal(validate(enrichedText({}, { ...BINDING, extra_field: 'x' })).ok, false, 'unknown key');
  assert.equal(validate(enrichedText({}, null)).ok, false, 'null binding');
  assert.equal(validate(enrichedText({}, [BINDING])).ok, false, 'array binding');
  assert.equal(validate(enrichedText({}, 'dpl_x')).ok, false, 'string binding');
});

test('secret-bearing metadata is rejected, and the reason never echoes the secret', () => {
  const secrets = {
    'stripe live key in an extra key': { extra: 'sk_live_CANARY0123456789' },
    'stripe test key in the alias': { production_alias: 'sk_test_CANARY0123456789.example.com' },
    'webhook secret in the url': { deployment_url: 'https://whsec_CANARY0123456789.vercel.app' },
    'bearer token': { extra: 'Bearer CANARY0123456789abcdef' },
    'vercel token': { extra: 'vcp_CANARY0123456789abcd' },
    'aws key': { extra: 'AKIACANARY0123456789' },
    'github token': { extra: 'ghp_CANARY0123456789abcdefghij' },
    'private key block': { extra: '-----BEGIN PRIVATE KEY-----' },
    'token query param in the url': { deployment_url: 'https://echo-a5vqgwi5v-veritas-forge.vercel.app?token=CANARY' },
    'credentials in the url': { deployment_url: 'https://user:CANARYpw@echo-a5vqgwi5v-veritas-forge.vercel.app' },
  };
  for (const [label, override] of Object.entries(secrets)) {
    const r = validate(enrichedText({}, { ...BINDING, ...override }));
    assert.equal(r.ok, false, `${label} must be rejected`);
    // The secret scan runs BEFORE the format checks, so the recorded cause is
    // "secret-shaped content" (not a generic malformed-field reason that would
    // hide it) -- and that reason is a fixed string, never the value itself.
    assert.equal(r.reason, 'release_binding contains secret-shaped content', `${label}: must be rejected AS a secret`);
    assert.equal(JSON.stringify(r.reason).includes('CANARY'), false, `${label}: reason must not echo the secret`);
    assert.equal(r.reason.includes('sk_'), false, label);
  }
  // A blocked record is durably logged too -- its stored fields must be secret-free.
  const blocked = validate(enrichedText({}, { ...BINDING, extra: 'sk_live_CANARY0123456789' }));
  assert.equal(JSON.stringify({ reason: blocked.reason, path: blocked.artifactPath, hash: blocked.artifactHash }).includes('CANARY'), false);
});

test('validateReleaseBinding: accepts a well-formed binding and returns a minimal copy (no passthrough of extras)', () => {
  const r = validateReleaseBinding({ ...BINDING });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.value).sort(), ['deploymentId', 'deploymentUrl', 'productionAlias', 'promotedAt']);
});

// ---------------------------------------------------------------------------
// One authoritative interpretation (dev_observations vs machine facts)
// ---------------------------------------------------------------------------

test('an allowlist-verified evidence file is NOT stamped BLOCKED_UNVERIFIED: the observation agrees with the fact', async () => {
  const { dir, db } = tempDb();
  try {
    const { first } = await scanEvidenceDir(db, { [HISTORICAL_FILE]: HISTORICAL_TEXT });
    const rows = artifactRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'CANDIDATE');
    assert.notEqual(rows[0].summary, 'no parseable status marker');
    assert.match(rows[0].summary, /^allowlist-verified generic:release_promotion_record \(official_site_deployment\); stage /);
    assert.equal(first.blocked, 0);
    assert.equal(first.newCandidates, 1);
    const f = facts(db);
    assert.equal(f.length, 1);
    assert.equal(f[0].fact_id, HISTORICAL_FACT_ID);
    assert.equal(f[0].source_artifact_hash, HISTORICAL_FILE_SHA256);
    assert.equal(rows[0].matched_fact_id, f[0].fact_id, 'the audit row points at the fact the allowlist path created');
  } finally {
    closeDb(db); rmSync(dir, { recursive: true, force: true });
  }
});

test('the observation summary carries the deployment id for enriched evidence (no Vercel access needed to read it)', async () => {
  const { dir, db } = tempDb();
  try {
    await scanEvidenceDir(db, { 'OFFICIAL_SITE-2-VERIFICATION-RECORD.json': enrichedText() });
    const rows = artifactRows(db);
    assert.equal(rows.length, 1);
    assert.match(rows[0].summary, new RegExp(`deployment ${BINDING.deployment_id}$`));
    assert.equal(facts(db).length, 1);
  } finally {
    closeDb(db); rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence the allowlist REJECTS is BLOCKED_UNVERIFIED with the allowlist\'s own reason, and creates no VERIFIED fact', async () => {
  const { dir, db } = tempDb();
  try {
    const bad = enrichedText({}, { ...BINDING, deployment_id: 'nope' });
    await scanEvidenceDir(db, { 'OFFICIAL_SITE-3-VERIFICATION-RECORD.json': bad });
    const rows = artifactRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'BLOCKED_UNVERIFIED');
    assert.match(rows[0].summary, /^allowlist rejected: release_binding\.deployment_id is malformed/);
    assert.equal(facts(db).filter((f) => f.status === 'VERIFIED').length, 0);
    assert.equal(facts(db).filter((f) => f.status === 'BLOCKED').length, 1);
  } finally {
    closeDb(db); rmSync(dir, { recursive: true, force: true });
  }
});

test('the legacy text-marker heuristic still governs files NO schema recognizes (unchanged fallback)', async () => {
  const { dir, db } = tempDb();
  try {
    await scanEvidenceDir(db, {
      'RANDOM_REPORT.md': '# something\n\nno status line here\n',
      'OTHER_VERIFIED_REPORT.md': '# t\n\nStatus: PASSED\n',
    });
    const byId = Object.fromEntries(artifactRows(db).map((r) => [r.identity, r]));
    assert.equal(byId['RANDOM_REPORT.md'].status, 'BLOCKED_UNVERIFIED');
    assert.equal(byId['RANDOM_REPORT.md'].summary, 'no parseable status marker');
    assert.equal(byId['OTHER_VERIFIED_REPORT.md'].status, 'CANDIDATE');
    assert.equal(facts(db).length, 0, 'unrecognized files never create facts');
  } finally {
    closeDb(db); rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The historical contradiction: heal the one mislabeled row, never duplicate
// ---------------------------------------------------------------------------

test('the pinned identity hash is exactly the real legacy row\'s hash (so the reconciliation targets the real row)', () => {
  const h = createHash('sha256').update(`${SITE_CONFIG_BASE.repoKey}:artifact:${HISTORICAL_FILE}`, 'utf8').digest('hex');
  assert.equal(h, HISTORICAL_OBSERVATION_HASH);
});

test('a pre-existing BLOCKED_UNVERIFIED "no parseable status marker" row for an allowlist-verified file is corrected IN PLACE -- no second row, no second fact', async () => {
  const { dir, db } = tempDb();
  try {
    const { first } = await scanEvidenceDir(db, { [HISTORICAL_FILE]: HISTORICAL_TEXT }, { legacyRow: true });
    const rows = artifactRows(db);
    assert.equal(rows.length, 1, 'exactly one audit row for the file (no duplicate, no contradictory pair)');
    assert.equal(rows[0].identity_hash, HISTORICAL_OBSERVATION_HASH, 'the SAME row was corrected');
    assert.equal(rows[0].status, 'CANDIDATE');
    assert.equal(rows[0].detected_at, '2026-09-19T00:05:56.871Z', 'original detection time preserved');
    assert.equal(rows[0].matched_fact_id, HISTORICAL_FACT_ID);
    assert.equal(first.newCandidates, 1);
    assert.equal(first.blocked, 0);
    assert.equal(facts(db).length, 1);
    assert.equal(facts(db)[0].fact_id, HISTORICAL_FACT_ID, 'the historical machine fact identity is reproduced, not duplicated');
  } finally {
    closeDb(db); rmSync(dir, { recursive: true, force: true });
  }
});

test('re-scanning after the reconciliation changes nothing: no new rows, no new facts, no rewritten timestamps (idempotent)', async () => {
  const { dir, db } = tempDb();
  try {
    const { config, noGit } = await scanEvidenceDir(db, { [HISTORICAL_FILE]: HISTORICAL_TEXT }, { legacyRow: true });
    const rowsBefore = JSON.stringify(artifactRows(db));
    const factsBefore = JSON.stringify(facts(db).map((f) => [f.fact_id, f.created_at]));
    for (let i = 0; i < 3; i++) {
      const again = await observeRepo(db, config, { execFileImpl: noGit, facts: [] });
      assert.equal(again.newCandidates, 0);
      assert.equal(again.blocked, 0);
    }
    assert.equal(JSON.stringify(artifactRows(db)), rowsBefore);
    assert.equal(JSON.stringify(facts(db).map((f) => [f.fact_id, f.created_at])), factsBefore);
  } finally {
    closeDb(db); rmSync(dir, { recursive: true, force: true });
  }
});

test('the reconciliation touches ONLY the exact contradictory state: other BLOCKED rows and unrelated statuses are left alone', async () => {
  const { dir, db } = tempDb();
  try {
    ensureDevObserverSchema(db);
    // Same identity, but blocked for a DIFFERENT reason -> must not be "healed".
    db.prepare(
      `INSERT INTO dev_observations (identity_hash, repo_key, kind, identity, summary, detected_at, status, matched_fact_id)
       VALUES (?, ?, 'artifact', ?, 'allowlist rejected: something real', '2026-09-19T00:05:56.871Z', 'BLOCKED_UNVERIFIED', NULL)`
    ).run(HISTORICAL_OBSERVATION_HASH, SITE_CONFIG_BASE.repoKey, HISTORICAL_FILE);
    await scanEvidenceDir(db, { [HISTORICAL_FILE]: HISTORICAL_TEXT });
    const rows = artifactRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'BLOCKED_UNVERIFIED');
    assert.equal(rows[0].summary, 'allowlist rejected: something real');
  } finally {
    closeDb(db); rmSync(dir, { recursive: true, force: true });
  }
});

test('historical machine fact is not duplicated when new, enriched evidence for a NEW revision arrives alongside it', async () => {
  const { dir, db } = tempDb();
  try {
    await scanEvidenceDir(db, {
      [HISTORICAL_FILE]: HISTORICAL_TEXT,
      'OFFICIAL_SITE-1790000000000-VERIFICATION-RECORD.json': enrichedText(),
    }, { legacyRow: true });
    const f = facts(db);
    assert.equal(f.length, 2);
    assert.equal(f.filter((x) => x.fact_id === HISTORICAL_FACT_ID).length, 1);
    assert.equal(new Set(f.map((x) => x.fact_id)).size, 2, 'the new revision is a DIFFERENT fact, not a mutation of the old one');
    assert.equal(f.find((x) => x.fact_id === HISTORICAL_FACT_ID).source_revision, HISTORICAL_SHA);
    assert.equal(f.find((x) => x.fact_id === HISTORICAL_FACT_ID).verified_at, '2026-09-18T13:02:13.816Z', 'historical verified_at is never rewritten');
    assert.equal(artifactRows(db).length, 2);
  } finally {
    closeDb(db); rmSync(dir, { recursive: true, force: true });
  }
});

test('the same enriched evidence scanned twice yields exactly one fact (idempotent)', async () => {
  const { dir, db } = tempDb();
  try {
    const { config, noGit } = await scanEvidenceDir(db, { 'OFFICIAL_SITE-2-VERIFICATION-RECORD.json': enrichedText() });
    await observeRepo(db, config, { execFileImpl: noGit, facts: [] });
    await observeRepo(db, config, { execFileImpl: noGit, facts: [] });
    assert.equal(facts(db).length, 1);
    assert.equal(artifactRows(db).length, 1);
  } finally {
    closeDb(db); rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Reconciliation-backed evidence (veritas-release-orchestrator RECONCILED_ACTIVE)
// ---------------------------------------------------------------------------
// A release the orchestrator did not promote itself but which was observed
// live and independently passed the complete hardened Production validation
// is recorded with an optional `reconciled` + `reconciliation_id` pair in its
// release_binding. It is provenance only: same claim, same limitations.

const RECONCILED_BINDING = { ...BINDING, reconciled: true, reconciliation_id: 'recon-2026-09-19-official-site-e43669b' };

test('reconciled evidence (release_binding with reconciled + reconciliation_id) is allowlisted, same claim topic, not BLOCKED', () => {
  const r = validate(enrichedText({}, RECONCILED_BINDING));
  assert.equal(r.ok, true);
  assert.equal(r.claimTopic, 'official_site_deployment');
  assert.equal(r.claimStatus, 'VERIFIED');
  assert.deepEqual(r.releaseBinding, {
    deploymentId: BINDING.deployment_id, deploymentUrl: BINDING.deployment_url,
    productionAlias: BINDING.production_alias, promotedAt: BINDING.promoted_at,
    reconciled: true, reconciliationId: 'recon-2026-09-19-official-site-e43669b',
  });
});

test('reconciliation provenance never widens the claim: sentence and limitations equal the plain-binding ones', () => {
  const rec = validate(enrichedText({}, RECONCILED_BINDING));
  const plain = validate(enrichedText());
  assert.equal(rec.claim, plain.claim);
  assert.equal(rec.limitations, plain.limitations);
  assert.equal(rec.claim.includes('recon-'), false);
  assert.equal(rec.limitations.includes('recon-'), false);
});

test('a half-specified, non-true, or malformed reconciliation pair is rejected (blocked, never allowlisted)', () => {
  const bad = {
    'reconciled without id': { ...BINDING, reconciled: true },
    'id without reconciled': { ...BINDING, reconciliation_id: 'recon-2026-09-19-official-site-e43669b' },
    'reconciled false': { ...RECONCILED_BINDING, reconciled: false },
    'reconciled string': { ...RECONCILED_BINDING, reconciled: 'true' },
    'id wrong prefix': { ...RECONCILED_BINDING, reconciliation_id: 'incident-2026-09-19' },
    'id too short': { ...RECONCILED_BINDING, reconciliation_id: 'recon-a' },
    'id not a string': { ...RECONCILED_BINDING, reconciliation_id: 12345 },
    'id with a secret-shaped value': { ...RECONCILED_BINDING, reconciliation_id: 'recon-sk_live_abcdef123456' },
    'extra unknown key next to the pair': { ...RECONCILED_BINDING, note: 'x' },
  };
  for (const [name, binding] of Object.entries(bad)) assert.equal(validate(enrichedText({}, binding)).ok, false, name);
});

test('a non-reconciled binding still returns exactly the four historical provenance keys (shape unchanged)', () => {
  const r = validateReleaseBinding({ ...BINDING });
  assert.deepEqual(Object.keys(r.value).sort(), ['deploymentId', 'deploymentUrl', 'productionAlias', 'promotedAt']);
});

test('reconciled evidence is NOT stamped BLOCKED_UNVERIFIED: it is a CANDIDATE observation marked reconciled, and creates exactly one new fact beside the historical one', async () => {
  const { dir, db } = tempDb();
  try {
    await scanEvidenceDir(db, {
      [HISTORICAL_FILE]: HISTORICAL_TEXT,
      'OFFICIAL_SITE-1790000000000-VERIFICATION-RECORD.json': enrichedText({}, RECONCILED_BINDING),
    }, { legacyRow: true });
    const rows = artifactRows(db);
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((r) => r.status === 'BLOCKED_UNVERIFIED').length, 0, 'no false BLOCKED_UNVERIFIED');
    const recRow = rows.find((r) => r.identity.startsWith('OFFICIAL_SITE-1790000000000'));
    assert.match(recRow.summary, /allowlist-verified generic:release_promotion_record \(official_site_deployment\)/);
    assert.match(recRow.summary, /deployment dpl_9egDSysqaiL6UW4XBiRQfu6gfBzc \(reconciled\)/);
    const f = facts(db);
    assert.equal(f.length, 2);
    assert.equal(f.filter((x) => x.fact_id === HISTORICAL_FACT_ID).length, 1, 'historical fact not duplicated');
    assert.equal(f.find((x) => x.fact_id === HISTORICAL_FACT_ID).verified_at, '2026-09-18T13:02:13.816Z');
  } finally {
    closeDb(db); rmSync(dir, { recursive: true, force: true });
  }
});

test('reconciled evidence scanned repeatedly yields exactly one fact (deterministic identity, idempotent)', async () => {
  const { dir, db } = tempDb();
  try {
    const { config, noGit } = await scanEvidenceDir(db, { 'OFFICIAL_SITE-3-VERIFICATION-RECORD.json': enrichedText({}, RECONCILED_BINDING) });
    await observeRepo(db, config, { execFileImpl: noGit, facts: [] });
    await observeRepo(db, config, { execFileImpl: noGit, facts: [] });
    assert.equal(facts(db).length, 1);
    assert.equal(artifactRows(db).length, 1);
  } finally {
    closeDb(db); rmSync(dir, { recursive: true, force: true });
  }
});
