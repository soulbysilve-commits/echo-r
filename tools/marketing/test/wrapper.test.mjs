import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const WRAPPER = new URL('../../../scripts/run-marketing-operator.sh', import.meta.url).pathname;
const REPO_ROOT = new URL('../../../', import.meta.url).pathname;

// Every test below points MARKETING_STATE_DIR at its own temp directory —
// both so we verify the wrapper's *current* real output (not stale files
// left over from a previous run) and so these tests never write into the
// real ~/.local/share/veritas-forge-marketing operational history.
//
// A key set to `undefined` in `env` is deleted from the merged environment
// rather than passed through — this lets a test force-clear a variable the
// outer `node --test` process itself may already carry (e.g. this same
// suite is sometimes run with MARKETING_MODE pinned in the shell for
// safety), instead of merely relying on it happening to be absent.
function runWrapper(env, stateDir) {
  const merged = { ...process.env, MARKETING_STATE_DIR: stateDir, ...env };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return execFileAsync('bash', [WRAPPER], { cwd: REPO_ROOT, env: merged })
    .catch((err) => err); // execFile rejects on non-zero exit; we want the result either way
}

test('scheduler wrapper enforces its timeout on a hanging engine command', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'marketing-wrapper-test-'));
  try {
    const result = await runWrapper({
      MARKETING_OPERATOR_ENGINE: 'test',
      MARKETING_TEST_COMMAND: 'sleep 30',
      MARKETING_OPERATOR_TIMEOUT_SECONDS: '1',
    }, stateDir);
    // `timeout` exits 124 when it kills the child; the wrapper propagates that.
    assert.equal(result.code, 124);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}, { timeout: 15000 });

test('scheduler wrapper lock prevents a second concurrent invocation from running the engine', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'marketing-wrapper-test-'));
  try {
    // Start a slow run, then immediately try a second one; the second must SKIP_OVERLAP (exit 0)
    // without ever invoking MARKETING_TEST_COMMAND.
    const slow = runWrapper({
      MARKETING_OPERATOR_ENGINE: 'test',
      MARKETING_TEST_COMMAND: 'sleep 2',
      MARKETING_OPERATOR_TIMEOUT_SECONDS: '10',
    }, stateDir);
    await new Promise((r) => setTimeout(r, 300)); // let the first run acquire the lock
    const fast = await runWrapper({
      MARKETING_OPERATOR_ENGINE: 'test',
      MARKETING_TEST_COMMAND: 'true',
      MARKETING_OPERATOR_TIMEOUT_SECONDS: '10',
    }, stateDir);
    assert.equal(fast.code ?? 0, 0);
    await slow;
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}, { timeout: 15000 });

test('wrapper redacts secret-shaped strings out of its own log file', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'marketing-wrapper-test-'));
  try {
    await runWrapper({
      MARKETING_OPERATOR_ENGINE: 'test',
      MARKETING_TEST_COMMAND: 'echo "token=sk-SUPERSECRETVALUE1234567890"',
      MARKETING_OPERATOR_TIMEOUT_SECONDS: '5',
    }, stateDir);
    const status = JSON.parse(readFileSync(join(stateDir, 'health.json'), 'utf8'));
    const log = readFileSync(status.log_file, 'utf8');
    assert.ok(!log.includes('sk-SUPERSECRETVALUE1234567890'));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}, { timeout: 15000 });

test('wrapper refuses to run when MARKETING_OPERATOR_RUNNING=1 is already set (recursion guard)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'marketing-wrapper-test-'));
  try {
    // The recursion-block path exits before writing health.json (there's nothing
    // to report beyond "blocked"), so find its log file directly instead.
    const before = await runWrapper({
      MARKETING_OPERATOR_ENGINE: 'test',
      MARKETING_TEST_COMMAND: 'true',
      MARKETING_OPERATOR_RUNNING: '1',
    }, stateDir);
    assert.equal(before.code ?? 0, 0);
    const logsDir = join(stateDir, 'logs');
    const files = readdirSync(logsDir).map((f) => ({ f, t: statSync(join(logsDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    const newestLog = readFileSync(join(logsDir, files[0].f), 'utf8');
    assert.ok(newestLog.includes('RECURSION_BLOCKED'));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}, { timeout: 15000 });

test('wrapper state (health.json, logs) lives outside the repo worktree by default', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'marketing-wrapper-test-'));
  try {
    await runWrapper({ MARKETING_OPERATOR_ENGINE: 'test', MARKETING_TEST_COMMAND: 'true' }, stateDir);
    const status = JSON.parse(readFileSync(join(stateDir, 'health.json'), 'utf8'));
    assert.ok(!status.log_file.startsWith(REPO_ROOT), 'log file must not live inside the git worktree');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}, { timeout: 15000 });

// Pre-LIVE hardening: repo-local .env.local must never be able to override
// a global safety-control variable the trusted parent environment (systemd
// Environment=, or in production SECRETS_FILE) already set. MARKETING_ENV_LOCAL_FILE
// lets these tests point the wrapper at an isolated temp file instead of ever
// touching the real repo root's .env.local.
function readEffectiveVars(log) {
  const match = log.match(/EFFECTIVE mode=(\S*) automation=(\S*) devvar=(\S*)/);
  assert.ok(match, `expected EFFECTIVE line in log, got: ${log}`);
  return { mode: match[1], automation: match[2], devvar: match[3] };
}

const PRINT_EFFECTIVE_CMD = 'echo "EFFECTIVE mode=$MARKETING_MODE automation=$ECHO_MARKETING_AUTOMATION_ENABLED devvar=$MARKETING_SOME_DEV_VAR"';

async function runWithEnvLocal(env, envLocalContents) {
  const stateDir = mkdtempSync(join(tmpdir(), 'marketing-wrapper-test-'));
  const envLocalFile = join(stateDir, '.env.local');
  writeFileSync(envLocalFile, envLocalContents);
  try {
    await runWrapper({
      MARKETING_OPERATOR_ENGINE: 'test',
      MARKETING_TEST_COMMAND: PRINT_EFFECTIVE_CMD,
      MARKETING_OPERATOR_TIMEOUT_SECONDS: '5',
      MARKETING_ENV_LOCAL_FILE: envLocalFile,
      ...env,
    }, stateDir);
    const status = JSON.parse(readFileSync(join(stateDir, 'health.json'), 'utf8'));
    return readEffectiveVars(readFileSync(status.log_file, 'utf8'));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test('.env.local cannot override MARKETING_MODE already set by the trusted parent environment', async () => {
  const effective = await runWithEnvLocal(
    { MARKETING_MODE: 'DRY_RUN' },
    'MARKETING_MODE=LIVE\n'
  );
  assert.equal(effective.mode, 'DRY_RUN');
}, { timeout: 15000 });

test('.env.local cannot enable automation over a trusted parent env that disabled it', async () => {
  const effective = await runWithEnvLocal(
    { ECHO_MARKETING_AUTOMATION_ENABLED: 'false' },
    'ECHO_MARKETING_AUTOMATION_ENABLED=true\n'
  );
  assert.equal(effective.automation, 'false');
}, { timeout: 15000 });

test('.env.local may still set a protected variable when the trusted parent env never set it at all', async () => {
  // Explicitly cleared (not merely omitted) so this holds regardless of
  // whatever the outer `node --test` process's own ambient environment
  // happens to carry — nothing trusted to protect here, so a developer
  // running this wrapper by hand can still configure it locally.
  const effective = await runWithEnvLocal(
    { MARKETING_MODE: undefined },
    'MARKETING_MODE=LIVE\n'
  );
  assert.equal(effective.mode, 'LIVE');
}, { timeout: 15000 });

test('.env.local can still set an ordinary, unprotected developer variable', async () => {
  const effective = await runWithEnvLocal(
    { MARKETING_MODE: 'DRY_RUN' },
    'MARKETING_MODE=LIVE\nMARKETING_SOME_DEV_VAR=hello\n'
  );
  assert.equal(effective.mode, 'DRY_RUN'); // still protected
  assert.equal(effective.devvar, 'hello'); // unrelated dev convenience var still loads
}, { timeout: 15000 });

test('wrapper behaves exactly as before when no .env.local file is present', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'marketing-wrapper-test-'));
  try {
    await runWrapper({
      MARKETING_MODE: 'DRY_RUN',
      MARKETING_OPERATOR_ENGINE: 'test',
      MARKETING_TEST_COMMAND: PRINT_EFFECTIVE_CMD,
      MARKETING_ENV_LOCAL_FILE: join(stateDir, 'does-not-exist.env.local'),
    }, stateDir);
    const status = JSON.parse(readFileSync(join(stateDir, 'health.json'), 'utf8'));
    const effective = readEffectiveVars(readFileSync(status.log_file, 'utf8'));
    assert.equal(effective.mode, 'DRY_RUN');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}, { timeout: 15000 });

test('.env.local protection itself never echoes any variable value into the log', async () => {
  const effective = await runWithEnvLocal(
    { MARKETING_MODE: 'DRY_RUN' },
    'MARKETING_MODE=LIVE\nX_API_KEY=sk-SUPERSECRETVALUE1234567890\n'
  );
  assert.equal(effective.mode, 'DRY_RUN');
}, { timeout: 15000 });
