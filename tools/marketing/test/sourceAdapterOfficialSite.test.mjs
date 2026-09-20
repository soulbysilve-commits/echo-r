import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanSince, normalize, source } from '../sourceAdapters/officialSite.mjs';

function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-site-fixture-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  return dir;
}

function commit(dir, relPath, content) {
  const full = join(dir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  execFileSync('git', ['add', relPath], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', `write ${relPath}`], { cwd: dir });
}

test('scanSince finds a real release manifest and never surfaces its encryption secret fields', async () => {
  const dir = makeFixtureRepo();
  try {
    mkdirSync(join(dir, 'release-output', 'echoagent-win-20260914T072837Z-abc123'), { recursive: true });
    writeFileSync(join(dir, 'release-output', 'echoagent-win-20260914T072837Z-abc123', 'manifest.json'), JSON.stringify({
      schema: 'veritasforge.echo-agent.release-manifest.v1',
      release_id: 'echoagent-win-20260914T072837Z-abc123',
      artifact_sha256: 'deadbeef',
      wrapped_dek: 'THIS-MUST-NEVER-APPEAR-IN-OUTPUT',
      auth_tag: 'ALSO-MUST-NEVER-APPEAR',
      byte_size: 123, created_at: '2026-09-14T07:28:45.781Z',
    }));

    const [raw] = await scanSince(null, { repoRoot: dir });
    const normalized = normalize(raw);
    assert.equal(normalized.event_type, 'RELEASE_READY');
    assert.equal(normalized.verification_state, 'VERIFIED');
    assert.deepEqual(normalized.evidence_hashes, ['deadbeef']);
    const text = JSON.stringify(normalized);
    assert.ok(!text.includes('THIS-MUST-NEVER-APPEAR-IN-OUTPUT'));
    assert.ok(!text.includes('ALSO-MUST-NEVER-APPEAR'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a docs/release/*.md with a passing *_E2E=PASS key becomes a PAYMENT_E2E_PASS candidate, always labeled sandbox/TEST mode', async () => {
  const dir = makeFixtureRepo();
  try {
    commit(dir, 'docs/release/EVIDENCE.md', '- SANDBOX_FULL_PURCHASE_E2E=PASS (real Stripe TEST mode checkout)\n- LEGAL_GATE=BLOCKED\n');
    const [raw] = await scanSince(null, { repoRoot: dir });
    const normalized = normalize(raw);
    assert.equal(normalized.event_type, 'PAYMENT_E2E_PASS');
    assert.match(normalized.title, /sandbox|TEST/i);
    assert.match(normalized.summary, /Sandbox|TEST-mode/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a docs/release/*.md with no passing E2E key is not a candidate', async () => {
  const dir = makeFixtureRepo();
  try {
    commit(dir, 'docs/release/EVIDENCE.md', '- SANDBOX_FULL_PURCHASE_E2E=FAIL\n- LEGAL_GATE=BLOCKED\n');
    const raw = await scanSince(null, { repoRoot: dir });
    assert.equal(raw.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanSince never includes surrounding prose text (which may name real Stripe test-mode IDs) — only KEY=VALUE tokens are used', async () => {
  const dir = makeFixtureRepo();
  try {
    commit(dir, 'docs/release/EVIDENCE.md', '- SANDBOX_FULL_PURCHASE_E2E=PASS — a real Stripe TEST MODE Checkout using account acct_1SYonVQSecretySensitive\n');
    const [raw] = await scanSince(null, { repoRoot: dir });
    const normalized = normalize(raw);
    const text = JSON.stringify(normalized);
    assert.ok(!text.includes('acct_1SYonVQSecretySensitive'), 'prose (which may contain real account IDs) must never be quoted verbatim');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanSince against a nonexistent repo root returns [] rather than throwing', async () => {
  const raw = await scanSince(null, { repoRoot: '/nonexistent/path/for/this/test' });
  assert.deepEqual(raw, []);
});

test('adapter identity', () => {
  assert.equal(source, 'official-site');
});
