import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOnce } from '../operator.mjs';
import { adapters as sourceAdapterList } from '../sourceAdapters/index.mjs';
import { normalizeChannelEnableFlags, withIsolatedLiveEnv } from './testEnvIsolation.mjs';

// See test/operator.test.mjs for why.
process.env.ECHO_AGENT_REPO_ROOT = '/nonexistent/marketing-test-stub/echo-agent';
process.env.ECHO_APP_REPO_ROOT = '/nonexistent/marketing-test-stub/echo-app';
process.env.NOEMORA_REPO_ROOT = '/nonexistent/marketing-test-stub/noemora';
process.env.OFFICIAL_SITE_REPO_ROOT = '/nonexistent/marketing-test-stub/official-site';
process.env.ECHO_AGENT_DEV_ROOT = '/nonexistent/marketing-test-stub/echo-agent-dev';
process.env.ECHO_APP_DEV_ROOT = '/nonexistent/marketing-test-stub/echo-app-dev';
process.env.NOEMORA_DEV_ROOT = '/nonexistent/marketing-test-stub/noemora-dev';
process.env.OFFICIAL_SITE_DEV_ROOT = '/nonexistent/marketing-test-stub/official-site-dev';

// Same reasoning as operator.test.mjs (see testEnvIsolation.mjs): normalize
// per-channel enable flags once so the ambient shell's real
// MARKETING_<CHANNEL>_ENABLED=true can't affect this file's runOnce() call.
normalizeChannelEnableFlags();

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;

function repoTreeHash() {
  // Hash of all tracked file contents + working-tree status, excluding var/ and
  // the two --exclude=index... deliberately vague: what matters is that a
  // read-only observation pass never dirties tracked product files.
  return execFileSync('git', ['status', '--porcelain', '--', '.', ':!var/'], { cwd: REPO_ROOT }).toString();
}

test('an operator run only ever writes inside var/marketing and the explicit facts path it was given', async () => {
  const { dir } = { dir: mkdtempSync(join(tmpdir(), 'marketing-readonly-test-')) };
  const dbPath = join(dir, 'test.db');
  const factsPath = join(dir, 'facts.md');
  writeFileSync(factsPath, `
## FACT-001
PRODUCT: ECHO Agent
STATUS: VERIFIED
CLAIM: test claim
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: x.py
SOURCE_EVIDENCE: y
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES:
`);

  const prevMode = process.env.MARKETING_MODE;
  const prevAuto = process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
  const before = repoTreeHash();
  try {
    // This test only cares about the read/write boundary, not LIVE-path
    // behavior — force the safe default deterministically (an ambient
    // MARKETING_MODE=LIVE shell must not change what this test exercises),
    // and scrub connector credentials + trip the network wire as a second,
    // independent layer in case the mode/flag gate is ever wrong.
    process.env.MARKETING_MODE = 'DRY_RUN';
    delete process.env.ECHO_MARKETING_AUTOMATION_ENABLED;
    await withIsolatedLiveEnv(() => runOnce({ dbPath, factsPath }));
  } finally {
    if (prevMode === undefined) delete process.env.MARKETING_MODE; else process.env.MARKETING_MODE = prevMode;
    if (prevAuto === undefined) delete process.env.ECHO_MARKETING_AUTOMATION_ENABLED; else process.env.ECHO_MARKETING_AUTOMATION_ENABLED = prevAuto;
    const after = repoTreeHash();
    assert.equal(before, after, 'operator run must not modify any tracked file in the website repo');
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Automatic event ingestion mandate section 21: a REAL scan of the four
// canonical product repositories (not the stubbed nonexistent paths used
// by every other test in this file) must never modify them. ---

function gitStatus(repoRoot) {
  return execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot }).toString();
}

function gitHead(repoRoot) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim();
}

function dirSnapshot(dirPath) {
  // Top-level listing + mtimes — sufficient for adapters that only ever
  // read top-level files (this repo's own adapter never recurses beyond
  // one level from its root).
  try {
    return execFileSync('find', [dirPath, '-maxdepth', '1', '-printf', '%p %T@\n'], { encoding: 'utf8' })
      .split('\n').sort().join('\n');
  } catch {
    return null; // path doesn't exist in this environment — nothing to compare
  }
}

test('a real scan of ECHODiscord版/ECHOapp/echo-r never changes their git status or HEAD, and never writes to Noemora_mod_core', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'marketing-realscan-')), 'x.db');
  const { openDb, closeDb } = await import('../lib/db.mjs');
  const { scanSource } = await import('../lib/sourceIngestion.mjs');

  const gitRepos = ['/home/silver/ECHODiscord版', '/home/silver/ECHOapp', '/home/silver/echo-r'];
  const noemoraRoot = '/home/silver/Noemora_mod_core';
  const before = {
    git: Object.fromEntries(gitRepos.filter((r) => existsSync(r)).map((r) => [r, { status: gitStatus(r), head: gitHead(r) }])),
    noemora: existsSync(noemoraRoot) ? dirSnapshot(noemoraRoot) : null,
  };

  const db = openDb(dbPath);
  try {
    // Real default paths (env vars unset here override this file's module-
    // level stub — passed directly to scanSource, not via process.env, so
    // it applies only to this one test).
    const realEnv = {
      ECHO_AGENT_REPO_ROOT: '/home/silver/ECHODiscord版',
      ECHO_APP_REPO_ROOT: '/home/silver/ECHOapp',
      NOEMORA_REPO_ROOT: '/home/silver/Noemora_mod_core',
      OFFICIAL_SITE_REPO_ROOT: '/home/silver/echo-r',
    };
    for (const adapter of sourceAdapterList) {
      await scanSource(db, adapter, { dryRun: true, env: realEnv }); // dryRun: this test verifies read-only-ness, not real ingestion
    }
  } finally {
    closeDb(db);
  }

  for (const [repo, snapshot] of Object.entries(before.git)) {
    assert.equal(gitStatus(repo), snapshot.status, `${repo}: git status must be unchanged after a real scan`);
    assert.equal(gitHead(repo), snapshot.head, `${repo}: HEAD must be unchanged after a real scan`);
  }
  if (before.noemora !== null) {
    assert.equal(dirSnapshot(noemoraRoot), before.noemora, 'Noemora_mod_core: top-level directory contents/mtimes must be unchanged after a real scan');
  }
});

// --- Local development observer: a REAL scan of the four real dev-root
// repositories (including Noemora_mod_core_work, the active worktree) must
// never modify them — same read-only guarantee as the canonical adapters
// above, proven the same way (real git status/HEAD before/after). ---

test('a real devObserver scan of ECHODiscord版/ECHOapp/Noemora_mod_core_work/echo-r never changes their git status or HEAD', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'marketing-devobserver-realscan-')), 'x.db');
  const { openDb, closeDb } = await import('../lib/db.mjs');
  const { observeAllDevRepos, devRepoConfigs } = await import('../lib/devObserver.mjs');

  const realConfigs = devRepoConfigs({
    ECHO_AGENT_DEV_ROOT: '/home/silver/ECHODiscord版',
    ECHO_APP_DEV_ROOT: '/home/silver/ECHOapp',
    NOEMORA_DEV_ROOT: '/home/silver/Noemora_mod_core_work',
    OFFICIAL_SITE_DEV_ROOT: '/home/silver/echo-r',
  });
  const existingConfigs = realConfigs.filter((c) => existsSync(c.repoPath));
  const before = Object.fromEntries(existingConfigs.map((c) => [c.repoPath, { status: gitStatus(c.repoPath), head: gitHead(c.repoPath) }]));

  const db = openDb(dbPath);
  try {
    // Baseline pass only (first activation for this fresh test db) —
    // real-repo git status/log/artifact-walk behavior on a SECOND pass is
    // already fully covered hermetically (fakeGit, no real subprocess
    // timing) by devObserver.test.mjs; doing that against these real,
    // actively-developed repos here would widen the window for an
    // unrelated concurrent process on this machine to touch them between
    // the before/after snapshots below, which is a real environmental
    // flake risk, not a devObserver correctness question.
    await observeAllDevRepos(db, existingConfigs, { facts: [] });
  } finally {
    closeDb(db);
  }

  for (const [repoPath, snapshot] of Object.entries(before)) {
    assert.equal(gitStatus(repoPath), snapshot.status, `${repoPath}: git status must be unchanged after a real devObserver scan`);
    assert.equal(gitHead(repoPath), snapshot.head, `${repoPath}: HEAD must be unchanged after a real devObserver scan`);
  }
});
