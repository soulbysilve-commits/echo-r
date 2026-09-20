// Hermetic end-to-end test for the full three-stage pipeline (mandate
// section 9): lib/devObserver.mjs (Stage A) -> lib/evidenceAllowlist.mjs
// (Stage B gate) -> lib/factPromotion.mjs (Stage B/C storage) ->
// lib/facts.mjs-shaped merged view a real candidate-selection pass
// (rankFacts) can select from. No real git subprocess, no real network
// call, and — critically — this file never calls publishToChannel() or any
// connector; it only proves the fact becomes SELECTABLE, never that it was
// actually posted anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { observeRepo } from '../lib/devObserver.mjs';
import { ensureActivationBoundary, getActivationBoundary } from '../lib/activation.mjs';
import { loadMergedFacts, factPromotionStatus, recordFactPromotion, ensureFactPromotionSchema, MACHINE_FACT_SOURCE_KEY } from '../lib/factPromotion.mjs';
import { rankFacts } from '../lib/scoring.mjs';
import { GENERIC_SCHEMA_ID, validateEvidence } from '../lib/evidenceAllowlist.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-e2e-test-'));
  const db = openDb(join(dir, 'test.db'));
  ensureFactPromotionSchema(db);
  return { dir, db };
}

function fakeGit({ heads = {}, dirty = {}, commits = [] } = {}) {
  return async (bin, args, opts) => {
    const repoPath = opts.cwd;
    if (args[0] === 'rev-parse') return { stdout: `${heads[repoPath] ?? ''}\n` };
    if (args[0] === 'status') {
      const paths = dirty[repoPath] ?? [];
      return { stdout: paths.map((p) => ` M ${p}`).join('\n') + (paths.length ? '\n' : '') };
    }
    if (args[0] === 'log') {
      const stdout = commits.map(({ sha, subject }) => `${sha}\x1f${subject}`).join('\n');
      return { stdout: stdout ? `${stdout}\n` : '' };
    }
    throw new Error(`unexpected git subcommand: ${args[0]}`);
  };
}

function goodEvidenceText(overrides = {}) {
  return JSON.stringify({
    schema: GENERIC_SCHEMA_ID, product: 'ECHO Agent', artifact_type: 'e2e_test_report',
    source_revision: 'rev2', verified_at: '2026-09-17T00:00:00.000Z', result: 'PASS',
    verifier: 'pytest-e2e-runner', public_safe: true, claim_topic: 'e2e_test_pass',
    description: 'checkout E2E flow completes in sandbox mode', ...overrides,
  });
}

test('E2E: new commit + new allow-listed PASS artifact at the same revision -> LOCAL_DEVELOPMENT_OBSERVATION -> VERIFIED_FACT_CANDIDATE -> PUBLIC_SAFE_VERIFIED_FACT -> selectable by rankFacts (never published)', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'marketing-e2e-repo-'));
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z'); // well before the evidence's verified_at
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z', MACHINE_FACT_SOURCE_KEY); // deterministic machine-fact-source boundary for this test
    const repoConfig = { repoKey: 'e2e-echo-agent', repoPath: repoRoot, sourceRepository: 'ECHODiscord版', product: 'ECHO Agent' };

    // Baseline first (first activation never bursts).
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });

    // A real commit landed, AND a real allow-listed PASS artifact at the
    // exact new HEAD revision appeared on disk.
    writeFileSync(join(repoRoot, 'CI_E2E_REPORT.json'), goodEvidenceText());
    const execFileImpl = fakeGit({ heads: { [repoRoot]: 'rev2' }, commits: [{ sha: 'rev2', subject: 'feat: checkout E2E now green' }] });
    const observation = await observeRepo(db, repoConfig, { execFileImpl, facts: [] });

    // Stage A: the commit itself is a LOCAL_DEVELOPMENT_OBSERVATION, and so
    // is the allowlist-verified artifact (it is an artifact-shaped file that
    // cleared Stage B). Before the single-authority reconciliation this count
    // was 1 only because the verified JSON artifact was wrongly stamped
    // BLOCKED_UNVERIFIED by the legacy text-marker heuristic.
    assert.equal(observation.newCandidates, 2, 'the commit and the allowlist-verified artifact are both Stage A candidates');
    assert.equal(observation.blocked, 0, 'nothing verified by the allowlist may be reported as blocked');
    const commitRows = db.prepare("SELECT * FROM dev_observations WHERE kind = 'commit'").all();
    assert.equal(commitRows.length, 1);
    assert.equal(commitRows[0].status, 'CANDIDATE');
    const artifactRows = db.prepare("SELECT * FROM dev_observations WHERE kind = 'artifact'").all();
    assert.equal(artifactRows.length, 1);
    assert.equal(artifactRows[0].status, 'CANDIDATE');
    assert.match(artifactRows[0].summary, /^allowlist-verified generic:/);

    // Stage B/C: the artifact cleared the strong-evidence gate.
    const mvfRow = db.prepare("SELECT * FROM machine_verified_facts WHERE source_artifact = 'CI_E2E_REPORT.json'").get();
    assert.ok(mvfRow, 'a machine_verified_facts row must exist for the strong artifact');
    assert.equal(mvfRow.promotion_stage, 'PUBLIC_SAFE_VERIFIED_FACT');
    assert.equal(artifactRows[0].matched_fact_id, mvfRow.fact_id, 'the audit row points at the fact the allowlist path created');

    const status = factPromotionStatus(db);
    assert.equal(status.byProduct.find((p) => p.PRODUCT === 'ECHO Agent').AUTO_PROMOTED_FACTS, 1);

    // Now selectable by the SAME candidate-selection function the real
    // marketing pipeline uses — proving it into the merged view is
    // sufficient for normal selection, without ever calling a connector.
    const merged = loadMergedFacts([], db);
    const promotedFact = merged.find((f) => f.id === mvfRow.fact_id);
    assert.ok(promotedFact);
    const ranked = rankFacts(merged);
    assert.ok(ranked.some((r) => r.fact.id === mvfRow.fact_id), 'the promoted fact must be a real, scoreable rankFacts() candidate');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('E2E: a commit with NO accompanying strong artifact never produces a fact', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'marketing-e2e-repo-'));
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    const repoConfig = { repoKey: 'e2e-commit-only', repoPath: repoRoot, sourceRepository: 'ECHODiscord版', product: 'ECHO Agent' };
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });
    await observeRepo(db, repoConfig, {
      execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev2' }, commits: [{ sha: 'rev2', subject: 'refactor: internal cleanup' }] }), facts: [],
    });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM machine_verified_facts').get().c, 0);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('E2E: dirty source alone never produces a fact', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'marketing-e2e-repo-'));
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    const repoConfig = { repoKey: 'e2e-dirty-only', repoPath: repoRoot, sourceRepository: 'ECHODiscord版', product: 'ECHO Agent' };
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });
    await observeRepo(db, repoConfig, {
      execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' }, dirty: { [repoRoot]: ['src/x.py'] } }), facts: [],
    });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM machine_verified_facts').get().c, 0);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('E2E: a fake PASS.txt (plain text, not JSON) never produces a fact', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'marketing-e2e-repo-'));
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    const repoConfig = { repoKey: 'e2e-fake-pass', repoPath: repoRoot, sourceRepository: 'ECHODiscord版', product: 'ECHO Agent' };
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });
    writeFileSync(join(repoRoot, 'REPORT_PASS.txt'), 'PASS PASS PASS everything is great, trust me\n');
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM machine_verified_facts').get().c, 0);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('E2E: an arbitrary JSON file containing "PASS" but no trusted schema tag never produces a fact', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'marketing-e2e-repo-'));
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    const repoConfig = { repoKey: 'e2e-unknown-json', repoPath: repoRoot, sourceRepository: 'ECHODiscord版', product: 'ECHO Agent' };
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });
    writeFileSync(join(repoRoot, 'RANDOM_REPORT.json'), JSON.stringify({ status: 'PASS', notes: 'looks fine to me' }));
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM machine_verified_facts').get().c, 0);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('E2E: a stale verifier result (artifact revision no longer matches the repo\'s current HEAD) is recorded but BLOCKED from promotion', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'marketing-e2e-repo-'));
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    const repoConfig = { repoKey: 'e2e-stale', repoPath: repoRoot, sourceRepository: 'ECHODiscord版', product: 'ECHO Agent' };
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });
    // The artifact claims rev2, but the repo's real current HEAD has since moved to rev3.
    writeFileSync(join(repoRoot, 'CI_STALE_REPORT.json'), goodEvidenceText({ source_revision: 'rev2' }));
    const execFileImpl = fakeGit({ heads: { [repoRoot]: 'rev3' }, commits: [{ sha: 'rev3', subject: 'later, unrelated commit' }] });
    await observeRepo(db, repoConfig, { execFileImpl, facts: [] });

    const row = db.prepare("SELECT * FROM machine_verified_facts WHERE source_artifact = 'CI_STALE_REPORT.json'").get();
    assert.ok(row, 'stale evidence is still recorded for audit');
    assert.equal(row.promotion_stage, 'VERIFIED_FACT_CANDIDATE');
    assert.match(row.block_reasons, /STALE_REVISION/);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('E2E: offline-only proof preserves its limitations text and is never phrased as a production claim', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'marketing-e2e-repo-'));
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    const repoConfig = { repoKey: 'e2e-offline', repoPath: repoRoot, sourceRepository: 'ECHODiscord版', product: 'ECHO Agent' };
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });
    writeFileSync(join(repoRoot, 'OFFLINE_EVAL_REPORT.json'), goodEvidenceText({
      artifact_type: 'offline_evaluation', claim_topic: 'offline_evaluation_result', source_revision: 'rev1', description: 'benchmark suite v3',
    }));
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });

    const row = db.prepare("SELECT * FROM machine_verified_facts WHERE source_artifact = 'OFFLINE_EVAL_REPORT.json'").get();
    assert.ok(row);
    assert.equal(row.promotion_stage, 'PUBLIC_SAFE_VERIFIED_FACT');
    assert.match(row.limitations, /[Oo]ffline evaluation only/);
    assert.ok(!/production/i.test(row.claim));
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('E2E: an overbroad claim_topic/artifact_type combination is blocked at the allowlist stage, never reaching promotion', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'marketing-e2e-repo-'));
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    const repoConfig = { repoKey: 'e2e-overbroad', repoPath: repoRoot, sourceRepository: 'ECHODiscord版', product: 'ECHO Agent' };
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });
    // unit_test_report is not an accepted artifact_type for the e2e_test_pass topic.
    writeFileSync(join(repoRoot, 'OVERBROAD_REPORT.json'), goodEvidenceText({ artifact_type: 'unit_test_report', source_revision: 'rev1' }));
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });

    const row = db.prepare("SELECT * FROM machine_verified_facts WHERE source_artifact = 'OVERBROAD_REPORT.json'").get();
    assert.ok(row);
    assert.equal(row.promotion_stage, 'BLOCKED_UNVERIFIED');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('E2E: observing the same artifact twice (unchanged revision) produces exactly one fact row, never a duplicate', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'marketing-e2e-repo-'));
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    const repoConfig = { repoKey: 'e2e-dup', repoPath: repoRoot, sourceRepository: 'ECHODiscord版', product: 'ECHO Agent' };
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });
    writeFileSync(join(repoRoot, 'CI_DUP_REPORT.json'), goodEvidenceText({ source_revision: 'rev1' }));
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });
    // Rescan again — HEAD unchanged, same artifact content still present.
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });

    const rows = db.prepare("SELECT * FROM machine_verified_facts WHERE source_artifact = 'CI_DUP_REPORT.json'").all();
    assert.equal(rows.length, 1);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('E2E: a genuinely historical strong artifact (verified_at predates the real activation boundary) is recorded for audit but stays activation-blocked forever', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'marketing-e2e-repo-'));
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2026-09-14T16:44:43.953Z'); // real global boundary shape
    const repoConfig = { repoKey: 'e2e-historical', repoPath: repoRoot, sourceRepository: 'ECHODiscord版', product: 'ECHO Agent' };
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });
    writeFileSync(join(repoRoot, 'CI_HISTORICAL_REPORT.json'), goodEvidenceText({ source_revision: 'rev1', verified_at: '2026-09-01T00:00:00.000Z' }));
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'rev1' } }), facts: [] });

    const row = db.prepare("SELECT * FROM machine_verified_facts WHERE source_artifact = 'CI_HISTORICAL_REPORT.json'").get();
    assert.ok(row, 'historical evidence is still durably recorded, never silently discarded');
    assert.equal(row.promotion_stage, 'VERIFIED_FACT_CANDIDATE');
    assert.match(row.block_reasons, /PRE_ACTIVATION/);

    // And it must never be selectable via the merged view, even though it's a real, well-formed row.
    const merged = loadMergedFacts([], db);
    assert.ok(!merged.some((f) => f.SOURCE_PATH === 'CI_HISTORICAL_REPORT.json'));
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Added 2026-09-18: explains and proves the release-orchestrator's own
// integration path with a real one of the four new release-scoped
// claim_topics (official_site_deployment), using the EXACT evidence shape
// veritas-release-orchestrator's src/core/evidence.ts emitPublicEvidence()
// produces. A prior manual trace (not committed as a test) found
// loadMergedFacts() returning empty for a freshly-recorded fact and
// initially looked like a bug -- it wasn't. The machine-fact-source
// boundary (MACHINE_FACT_SOURCE_KEY) is set LAZILY, the first real instant
// loadMergedFacts()/ensureMachineFactSourceBoundary() is ever called for a
// given db, exactly like every other channel's activation boundary in this
// codebase. That trace never pre-set the boundary, so it got created at
// "now" (the moment loadMergedFacts() was first called) -- strictly AFTER
// the evidence's own verified_at (recorded moments earlier in the same
// script) -- so the fact was correctly, deliberately classified
// PRE_ACTIVATION and filtered out. This is the mandate's "no backlog
// laundering" rule working exactly as designed, not a defect. The two
// tests below prove both halves: a real operator sets the boundary ONCE
// (e.g. via a deliberate ensureMachineFactSourceBoundary() call at real
// wiring time), and evidence verified AFTER that boundary DOES flow all
// the way to rankFacts(); evidence verified BEFORE it does not.
function releaseOrchestratorEvidenceText(overrides = {}) {
  return JSON.stringify({
    schema: GENERIC_SCHEMA_ID, product: 'ECHO-R', artifact_type: 'release_promotion_record',
    source_revision: '17bd02913c1a59e3d845e69578b826ef53f9d87b', verified_at: '2026-09-18T00:00:00.000Z',
    result: 'PASS', verifier: 'veritas-release-orchestrator/officialSiteAdapter', public_safe: true,
    claim_topic: 'official_site_deployment', description: 'npm build + 5 hermetic regression scripts', ...overrides,
  });
}

test('E2E (release-orchestrator evidence, POST-boundary): reaches machine_verified_facts -> canonical merged loader -> rankFacts', () => {
  const { dir, db } = tempDb();
  try {
    // A real operator establishes the machine-fact-source boundary ONCE,
    // at real wiring time, dated safely before the release evidence below
    // -- exactly the ensureMachineFactSourceBoundary() call loadMergedFacts()
    // would otherwise perform lazily (and too late) on first real use.
    ensureActivationBoundary(db, '2026-09-01T00:00:00.000Z', MACHINE_FACT_SOURCE_KEY);
    assert.equal(getActivationBoundary(db, MACHINE_FACT_SOURCE_KEY), '2026-09-01T00:00:00.000Z');

    const text = releaseOrchestratorEvidenceText(); // verified_at 2026-09-18, AFTER the boundary above
    const evidence = validateEvidence({ product: 'ECHO-R', sourceRepository: 'echo-r', relPath: 'state/public-evidence/OFFICIAL_SITE-x-public-evidence.json', text });
    assert.equal(evidence.ok, true);

    const promoted = recordFactPromotion(db, evidence, {});
    assert.equal(promoted.stage, 'PUBLIC_SAFE_VERIFIED_FACT', JSON.stringify(promoted.reasons));

    const merged = loadMergedFacts([], db);
    const fact = merged.find((f) => f.id === promoted.factId);
    assert.ok(fact, 'post-boundary release evidence must be a real candidate in the merged view');
    assert.equal(fact.PRODUCT, 'ECHO-R');
    assert.doesNotMatch(fact.CLAIM, /sales|checkout|available now/i);

    const ranked = rankFacts(merged);
    assert.ok(ranked.some((r) => r.fact.id === promoted.factId), 'must be a real, scoreable rankFacts() candidate -- this is exactly where this test stops, before any connector/publish call');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E2E (release-orchestrator evidence, PRE-boundary): the SAME evidence, verified before the boundary, is durably recorded but never selectable', () => {
  const { dir, db } = tempDb();
  try {
    // Boundary set AFTER the evidence's verified_at this time.
    ensureActivationBoundary(db, '2026-09-20T00:00:00.000Z', MACHINE_FACT_SOURCE_KEY);

    const text = releaseOrchestratorEvidenceText(); // verified_at 2026-09-18, BEFORE the boundary above
    const evidence = validateEvidence({ product: 'ECHO-R', sourceRepository: 'echo-r', relPath: 'state/public-evidence/OFFICIAL_SITE-x-public-evidence.json', text });
    const promoted = recordFactPromotion(db, evidence, {});
    assert.equal(promoted.stage, 'PUBLIC_SAFE_VERIFIED_FACT'); // gate itself passed -- it's a clean, well-formed fact

    const merged = loadMergedFacts([], db);
    assert.ok(!merged.some((f) => f.id === promoted.factId), 'pre-boundary evidence must never be selectable, even though it is a clean, real fact');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});
