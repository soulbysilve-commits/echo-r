import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import {
  observeRepo, observeAllDevRepos, devObserverStatus, devRepoConfigs, ensureDevObserverSchema,
} from '../lib/devObserver.mjs';
import { defaultRepoRoot as noemoraCanonicalRoot } from '../sourceAdapters/noemora.mjs';
import { ensureFactPromotionSchema } from '../lib/factPromotion.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-devobserver-test-'));
  const db = openDb(join(dir, 'test.db'));
  return { dir, db };
}

/** Fake execFileImpl — never spawns a real process, never touches a real
 * repo. `heads` maps repoPath -> current HEAD sha; `dirty` maps repoPath ->
 * array of dirty relative paths; `commitsBetween(from, to)` supplies the
 * fake `git log from..to` output. */
function fakeGit({ heads = {}, dirty = {}, commits = [] } = {}) {
  return async (bin, args, opts) => {
    assert.equal(bin, 'git');
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

const REPO_CONFIG = { repoKey: 'test-repo', repoPath: '/fake/repo', sourceRepository: 'TestRepo' };

test('devObserver: first scan baselines current state — zero candidates, no historical burst', async () => {
  const { dir, db } = tempDb();
  try {
    const execFileImpl = fakeGit({ heads: { '/fake/repo': 'aaa111' } });
    const result = await observeRepo(db, REPO_CONFIG, { execFileImpl, facts: [] });
    assert.equal(result.baselined, true);
    assert.equal(result.lastHead, 'aaa111');
    assert.equal(result.newCandidates, 0);
    assert.equal(result.promoted, 0);
    assert.equal(result.blocked, 0);
    const rows = db.prepare('SELECT * FROM dev_observations').all();
    assert.equal(rows.length, 0, 'baseline must never emit an observation, even if the repo already has history');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('devObserver: a new commit since baseline produces exactly one LOCAL_DEVELOPMENT_CANDIDATE', async () => {
  const { dir, db } = tempDb();
  try {
    await observeRepo(db, REPO_CONFIG, { execFileImpl: fakeGit({ heads: { '/fake/repo': 'aaa111' } }), facts: [] });

    const execFileImpl = fakeGit({
      heads: { '/fake/repo': 'bbb222' },
      commits: [{ sha: 'bbb222', subject: 'feat: real progress' }],
    });
    const result = await observeRepo(db, REPO_CONFIG, { execFileImpl, facts: [] });
    assert.equal(result.baselined, false);
    assert.equal(result.newCandidates, 1);
    const rows = db.prepare("SELECT * FROM dev_observations WHERE kind = 'commit'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'CANDIDATE');
    assert.equal(rows[0].identity, 'bbb222');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('devObserver: an unchanged HEAD produces no duplicate observation on rescan', async () => {
  const { dir, db } = tempDb();
  try {
    await observeRepo(db, REPO_CONFIG, { execFileImpl: fakeGit({ heads: { '/fake/repo': 'aaa111' } }), facts: [] });
    const afterFirstCommit = fakeGit({ heads: { '/fake/repo': 'bbb222' }, commits: [{ sha: 'bbb222', subject: 'x' }] });
    await observeRepo(db, REPO_CONFIG, { execFileImpl: afterFirstCommit, facts: [] });

    // Rescan with the SAME head — no new commits between bbb222..bbb222.
    const rescan = fakeGit({ heads: { '/fake/repo': 'bbb222' }, commits: [] });
    const result = await observeRepo(db, REPO_CONFIG, { execFileImpl: rescan, facts: [] });
    assert.equal(result.newCandidates, 0);
    const rows = db.prepare('SELECT * FROM dev_observations').all();
    assert.equal(rows.length, 1, 'still exactly the one commit observation from before — no duplicate');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('devObserver: a dirty file alone is at most a candidate, and NEVER becomes a public-safe fact', async () => {
  const { dir, db } = tempDb();
  try {
    await observeRepo(db, REPO_CONFIG, { execFileImpl: fakeGit({ heads: { '/fake/repo': 'aaa111' } }), facts: [] });

    const execFileImpl = fakeGit({
      heads: { '/fake/repo': 'aaa111' }, // HEAD unchanged — only working-tree dirt
      dirty: { '/fake/repo': ['src/thing.mjs'] },
    });
    const result = await observeRepo(db, REPO_CONFIG, { execFileImpl, facts: [] });
    assert.equal(result.blocked, 1);
    const rows = db.prepare("SELECT * FROM dev_observations WHERE kind = 'dirty'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'BLOCKED_UNVERIFIED');
    assert.notEqual(rows[0].status, 'PROMOTED');
    assert.equal(rows[0].matched_fact_id, null);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('devObserver: a new well-formed verified artifact is a CANDIDATE, never auto-promoted without a matching existing fact', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'marketing-devobserver-repo-'));
  const { dir, db } = tempDb();
  try {
    const repoConfig = { repoKey: 'artifact-repo', repoPath: repoRoot, sourceRepository: 'ArtifactRepo' };
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'h1' } }), facts: [] });

    writeFileSync(join(repoRoot, 'V1_VALIDATION_REPORT.md'), '# Report\n\nStatus: VERIFIED\n\nAll checks passed.\n');
    const result = await observeRepo(db, repoConfig, {
      execFileImpl: fakeGit({ heads: { [repoRoot]: 'h1' } }),
      facts: [], // no fact registry entry references this artifact
    });
    assert.equal(result.newCandidates, 1);
    assert.equal(result.promoted, 0);
    const rows = db.prepare("SELECT * FROM dev_observations WHERE kind = 'artifact'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'CANDIDATE');
    assert.equal(rows[0].matched_fact_id, null);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('devObserver: promotion only happens through the EXISTING evidence gate — a matching fact registry entry marks it PROMOTED', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'marketing-devobserver-repo-'));
  const { dir, db } = tempDb();
  try {
    const repoConfig = { repoKey: 'promoted-repo', repoPath: repoRoot, sourceRepository: 'PromotedRepo' };
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'h1' } }), facts: [] });

    writeFileSync(join(repoRoot, 'V2_VALIDATION_REPORT.md'), '# Report\n\nStatus: VERIFIED\n\nAll checks passed.\n');
    const facts = [{ id: 'FACT-777', SOURCE_REPOSITORY: 'PromotedRepo', SOURCE_PATH: 'V2_VALIDATION_REPORT.md' }];
    const result = await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'h1' } }), facts });
    assert.equal(result.promoted, 1);
    assert.equal(result.newCandidates, 0);
    const row = db.prepare("SELECT * FROM dev_observations WHERE kind = 'artifact'").get();
    assert.equal(row.status, 'PROMOTED');
    assert.equal(row.matched_fact_id, 'FACT-777');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('devObserver: a malformed artifact (filename matches, no real marker inside) is BLOCKED, never a candidate', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'marketing-devobserver-repo-'));
  const { dir, db } = tempDb();
  try {
    const repoConfig = { repoKey: 'malformed-repo', repoPath: repoRoot, sourceRepository: 'MalformedRepo' };
    await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'h1' } }), facts: [] });

    writeFileSync(join(repoRoot, 'SOME_REPORT.md'), '# Just some notes\n\nNothing verified here, just prose.\n');
    const result = await observeRepo(db, repoConfig, { execFileImpl: fakeGit({ heads: { [repoRoot]: 'h1' } }), facts: [] });
    assert.equal(result.newCandidates, 0);
    assert.equal(result.blocked, 1);
    const row = db.prepare("SELECT * FROM dev_observations WHERE kind = 'artifact'").get();
    assert.equal(row.status, 'BLOCKED_UNVERIFIED');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('devObserver: the same evidence content found under two different repo paths is deduplicated, not double-counted', async () => {
  const repoA = mkdtempSync(join(tmpdir(), 'marketing-devobserver-dupA-'));
  const repoB = mkdtempSync(join(tmpdir(), 'marketing-devobserver-dupB-'));
  const { dir, db } = tempDb();
  try {
    const content = '# Report\n\nStatus: VERIFIED\n\nIdentical evidence in two places.\n';
    writeFileSync(join(repoA, 'V3_VALIDATION_REPORT.md'), content);
    writeFileSync(join(repoB, 'V3_VALIDATION_REPORT.md'), content); // byte-identical content, different path

    const configA = { repoKey: 'dup-a', repoPath: repoA, sourceRepository: 'DupA' };
    const configB = { repoKey: 'dup-b', repoPath: repoB, sourceRepository: 'DupB' };

    await observeRepo(db, configA, { execFileImpl: fakeGit({ heads: { [repoA]: 'h1' } }), facts: [] });
    await observeRepo(db, configB, { execFileImpl: fakeGit({ heads: { [repoB]: 'h1' } }), facts: [] });

    const firstA = await observeRepo(db, configA, { execFileImpl: fakeGit({ heads: { [repoA]: 'h1' } }), facts: [] });
    assert.equal(firstA.newCandidates, 1);
    const secondB = await observeRepo(db, configB, { execFileImpl: fakeGit({ heads: { [repoB]: 'h1' } }), facts: [] });
    assert.equal(secondB.newCandidates, 0, 'identical content already recorded via repo A must not be re-recorded via repo B');

    const rows = db.prepare("SELECT * FROM dev_observations WHERE kind = 'artifact'").all();
    assert.equal(rows.length, 1, 'exactly one row total for this one piece of evidence, regardless of how many paths it was seen under');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  }
});

test('devObserver: Noemora active worktree is observed via NOEMORA_DEV_ROOT, independent of the canonical seal source', () => {
  const configs = devRepoConfigs({});
  const noemoraDev = configs.find((c) => c.repoKey === 'noemora-work-dev');
  assert.equal(noemoraDev.repoPath, '/home/silver/Noemora_mod_core_work');
  assert.notEqual(noemoraDev.repoPath, noemoraCanonicalRoot());
});

test('devObserver: NOEMORA_REPO_ROOT (the canonical adapter\'s own override) never affects the dev observer\'s Noemora path', () => {
  const configs = devRepoConfigs({ NOEMORA_REPO_ROOT: '/some/other/canonical/override' });
  const noemoraDev = configs.find((c) => c.repoKey === 'noemora-work-dev');
  assert.equal(noemoraDev.repoPath, '/home/silver/Noemora_mod_core_work');
});

test('devObserver: the canonical Noemora PUBLIC_DEMO seal adapter is completely unchanged (separate module, separate table)', () => {
  assert.equal(noemoraCanonicalRoot(), '/home/silver/Noemora_mod_core');
});

test('devObserver: NOEMORA_DEV_ROOT overrides only the dev observer path, all four repo defaults resolve as documented', () => {
  const configs = devRepoConfigs({});
  const byKey = Object.fromEntries(configs.map((c) => [c.repoKey, c.repoPath]));
  assert.equal(byKey['echo-agent-dev'], '/home/silver/ECHODiscord版');
  assert.equal(byKey['echo-app-dev'], '/home/silver/ECHOapp');
  assert.equal(byKey['noemora-work-dev'], '/home/silver/Noemora_mod_core_work');
  assert.equal(byKey['official-site-dev'], '/home/silver/echo-r');

  const overridden = devRepoConfigs({ NOEMORA_DEV_ROOT: '/tmp/custom-noemora-work' });
  assert.equal(overridden.find((c) => c.repoKey === 'noemora-work-dev').repoPath, '/tmp/custom-noemora-work');
});

test('devObserver: zero real external network calls and zero product-repo writes — every git call is read-only rev-parse/log/status', async () => {
  const { dir, db } = tempDb();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('UNEXPECTED_NETWORK_CALL: devObserver must never touch the network'); };
  try {
    const allowedSubcommands = new Set(['rev-parse', 'log', 'status']);
    const execFileImpl = async (bin, args, opts) => {
      assert.equal(bin, 'git');
      assert.ok(allowedSubcommands.has(args[0]), `devObserver must never invoke a mutating git subcommand (saw: ${args[0]})`);
      if (args[0] === 'rev-parse') return { stdout: 'h1\n' };
      return { stdout: '' };
    };
    await observeRepo(db, REPO_CONFIG, { execFileImpl, facts: [] });
    await observeRepo(db, REPO_CONFIG, { execFileImpl, facts: [] });
  } finally {
    globalThis.fetch = realFetch;
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('devObserver: observeAllDevRepos scans every configured repo and devObserverStatus reports read-only per-repo counts', async () => {
  const { dir, db } = tempDb();
  try {
    const configs = [
      { repoKey: 'r1', repoPath: '/fake/r1', sourceRepository: 'R1' },
      { repoKey: 'r2', repoPath: '/fake/r2', sourceRepository: 'R2' },
    ];
    const execFileImpl = fakeGit({ heads: { '/fake/r1': 'a1', '/fake/r2': 'a2' } });
    const results = await observeAllDevRepos(db, configs, { execFileImpl, facts: [] });
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.baselined === true));

    const status = devObserverStatus(db, configs);
    assert.equal(status.length, 2);
    assert.equal(status[0].LAST_HEAD, 'a1');
    assert.equal(status[1].LAST_HEAD, 'a2');
    assert.equal(status[0].NEW_CANDIDATES, 0);
    assert.equal(status[0].PROMOTED_PUBLIC_FACTS, 0);
    assert.equal(status[0].BLOCKED_UNVERIFIED, 0);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('devObserver: schema is idempotent to (re-)create', () => {
  const { dir, db } = tempDb();
  try {
    ensureDevObserverSchema(db);
    ensureDevObserverSchema(db);
    assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) FROM dev_observations').get());
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- release-orchestrator evidence handoff (added 2026-09-18) ---

test('devObserver: devRepoConfigs() includes two dedicated release-orchestrator evidence sources, correctly product-scoped and independently overridable', () => {
  const configs = devRepoConfigs({});
  const site = configs.find((c) => c.repoKey === 'release-orchestrator-official-site');
  const app = configs.find((c) => c.repoKey === 'release-orchestrator-echo-app');
  assert.ok(site);
  assert.ok(app);
  assert.equal(site.repoPath, '/home/silver/veritas-release-orchestrator/state/public-evidence/official-site');
  assert.equal(site.product, 'ECHO-R');
  assert.equal(app.repoPath, '/home/silver/veritas-release-orchestrator/state/public-evidence/echo-app');
  assert.equal(app.product, 'ECHO App');
  assert.notEqual(site.repoPath, app.repoPath, 'the two products must never share a watched directory');
  assert.notEqual(site.sourceRepository, app.sourceRepository);

  const overridden = devRepoConfigs({
    RELEASE_ORCHESTRATOR_OFFICIAL_SITE_EVIDENCE_ROOT: '/tmp/custom-site-evidence',
    RELEASE_ORCHESTRATOR_ECHO_APP_EVIDENCE_ROOT: '/tmp/custom-app-evidence',
  });
  assert.equal(overridden.find((c) => c.repoKey === 'release-orchestrator-official-site').repoPath, '/tmp/custom-site-evidence');
  assert.equal(overridden.find((c) => c.repoKey === 'release-orchestrator-echo-app').repoPath, '/tmp/custom-app-evidence');
});

function officialSiteEvidenceJson({ sourceRevision, verifiedAt }) {
  return JSON.stringify({
    schema: 'veritas-forge-verified-evidence/v1',
    product: 'ECHO-R',
    artifact_type: 'release_promotion_record',
    source_revision: sourceRevision,
    verified_at: verifiedAt,
    result: 'VERIFIED',
    verifier: 'veritas-release-orchestrator/officialSiteAdapter',
    public_safe: true,
    claim_topic: 'official_site_deployment',
    description: 'npm build + 5 hermetic fulfillment/crypto/activation regression scripts',
  });
}

function echoAppEvidenceJson({ sourceRevision, verifiedAt }) {
  return JSON.stringify({
    schema: 'veritas-forge-verified-evidence/v1',
    product: 'ECHO App',
    artifact_type: 'release_promotion_record',
    source_revision: sourceRevision,
    verified_at: verifiedAt,
    result: 'VERIFIED',
    verifier: 'veritas-release-orchestrator/echoAppAdapter',
    public_safe: true,
    claim_topic: 'echo_app_validated_release',
    description: 'core-freeze ancestry + backend/tests/ full suite',
  });
}

test('devObserver: a real Official Site release-orchestrator evidence file is discovered, from its own dedicated directory, correctly labeled ECHO-R', async () => {
  const { dir, db } = tempDb();
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'veritas-orch-site-evidence-'));
  try {
    const filePath = join(evidenceRoot, 'OFFICIAL_SITE-1789731567905-VERIFICATION-RECORD.json');
    writeFileSync(filePath, officialSiteEvidenceJson({ sourceRevision: 'd65b9e5cc09c74c784a5728d0b4af3b376a95df3', verifiedAt: '2026-09-18T05:38:43.000Z' }));
    const config = { repoKey: 'release-orchestrator-official-site', repoPath: evidenceRoot, sourceRepository: 'veritas-release-orchestrator/official-site', product: 'ECHO-R' };

    await observeRepo(db, config, { execFileImpl: async () => ({ stdout: '' }), facts: [] }); // baseline
    await observeRepo(db, config, { execFileImpl: async () => ({ stdout: '' }), facts: [] }); // real scan

    const row = db.prepare("SELECT * FROM machine_verified_facts WHERE source_artifact LIKE '%VERIFICATION-RECORD.json'").get();
    assert.ok(row, 'the evidence file must be discovered and promoted to a machine_verified_facts row');
    assert.equal(row.product, 'ECHO-R');
    assert.equal(row.evidence_type, 'generic:release_promotion_record');
    assert.equal(row.source_revision, 'd65b9e5cc09c74c784a5728d0b4af3b376a95df3');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('devObserver: a real ECHO App release-orchestrator evidence file is discovered, from its own dedicated directory, correctly labeled ECHO App (never ECHO-R)', async () => {
  const { dir, db } = tempDb();
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'veritas-orch-app-evidence-'));
  try {
    const filePath = join(evidenceRoot, 'ECHO_APP-1789731567905-VERIFICATION-RECORD.json');
    writeFileSync(filePath, echoAppEvidenceJson({ sourceRevision: '5507255d12ac77d3a9593ce3ce23b58b446b3c03', verifiedAt: '2026-09-18T11:39:27.905Z' }));
    const config = { repoKey: 'release-orchestrator-echo-app', repoPath: evidenceRoot, sourceRepository: 'veritas-release-orchestrator/echo-app', product: 'ECHO App' };

    await observeRepo(db, config, { execFileImpl: async () => ({ stdout: '' }), facts: [] }); // baseline
    await observeRepo(db, config, { execFileImpl: async () => ({ stdout: '' }), facts: [] }); // real scan

    const row = db.prepare("SELECT * FROM machine_verified_facts WHERE source_artifact LIKE '%VERIFICATION-RECORD.json'").get();
    assert.ok(row);
    assert.equal(row.product, 'ECHO App');
    assert.notEqual(row.product, 'ECHO-R');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('devObserver: an old-convention filename (no VERIFICATION/VERIFIED/etc keyword) is never discovered -- regression guard matching the exact bug this integration fixed', async () => {
  const { dir, db } = tempDb();
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'veritas-orch-oldname-'));
  try {
    writeFileSync(join(evidenceRoot, 'OFFICIAL_SITE-1789731567905-public-evidence.json'), officialSiteEvidenceJson({ sourceRevision: 'sha', verifiedAt: '2026-09-18T00:00:00.000Z' }));
    const config = { repoKey: 'release-orchestrator-official-site', repoPath: evidenceRoot, sourceRepository: 'veritas-release-orchestrator/official-site', product: 'ECHO-R' };
    await observeRepo(db, config, { execFileImpl: async () => ({ stdout: '' }), facts: [] }); // baseline
    const result = await observeRepo(db, config, { execFileImpl: async () => ({ stdout: '' }), facts: [] });
    assert.equal(result.newCandidates, 0);
    assert.equal(result.promoted, 0);
    ensureFactPromotionSchema(db); // may never have been created if nothing was ever promoted
    const row = db.prepare('SELECT COUNT(*) c FROM machine_verified_facts').get();
    assert.equal(row.c, 0);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});
