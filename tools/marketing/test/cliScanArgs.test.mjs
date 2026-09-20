import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const CLI = new URL('../cli.mjs', import.meta.url).pathname;
const REPO_ROOT = new URL('../../../', import.meta.url).pathname;

// Regression test for a real CLI bug: `scan --dry-run` (no source name,
// meaning "all sources, dry run") was parsing `--dry-run` itself as the
// source-name positional arg (`const [nameArg] = args`), so it always fell
// into the "unknown adapter" branch and exited 1 with a usage message —
// `scan echo-agent --dry-run` (name first) worked, but the documented
// no-name form never did. Points every adapter at a nonexistent repo root
// and the db at a throwaway temp path so this never touches real product
// repos or the real marketing database.
function runCli(args, stateDir) {
  return execFileAsync('node', [CLI, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MARKETING_DB_PATH: join(stateDir, 'test.db'),
      ECHO_AGENT_REPO_ROOT: '/nonexistent/cli-scan-args-test/echo-agent',
      ECHO_APP_REPO_ROOT: '/nonexistent/cli-scan-args-test/echo-app',
      NOEMORA_REPO_ROOT: '/nonexistent/cli-scan-args-test/noemora',
      OFFICIAL_SITE_REPO_ROOT: '/nonexistent/cli-scan-args-test/official-site',
    },
  });
}

test('cli.mjs scan --dry-run (no source name) scans all four adapters instead of treating --dry-run as an unknown source', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'marketing-cli-scan-test-'));
  try {
    const { stdout } = await runCli(['scan', '--dry-run'], stateDir);
    const result = JSON.parse(stdout);
    assert.equal(result.length, 4, 'expected one result per adapter, not a usage error');
    assert.deepEqual(
      result.map((r) => r.source).sort(),
      ['echo-agent', 'echo-app', 'noemora', 'official-site'],
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('cli.mjs scan echo-agent --dry-run (source name first) still works', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'marketing-cli-scan-test-'));
  try {
    const { stdout } = await runCli(['scan', 'echo-agent', '--dry-run'], stateDir);
    const result = JSON.parse(stdout);
    assert.equal(result.source, 'echo-agent');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
