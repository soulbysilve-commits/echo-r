import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSince, normalize, source } from '../sourceAdapters/noemora.mjs';

function makeFixtureRepo() {
  return mkdtempSync(join(tmpdir(), 'marketing-noemora-fixture-'));
}

const SEALED_MD = `# v22.9.2 Public Demo Master Final Seal

Status: FINAL MASTER SEALED
Generated: 2026-07-02T10:46:19.514358+00:00

## Final public demo package

- SHA256: 91c53d71ff9502c7a32d91bd6aebd55f9d3274fda4b51bb6de7c0f4e835879f4
`;

test('scanSince finds a real, well-formed public-demo seal file', async () => {
  const dir = makeFixtureRepo();
  try {
    writeFileSync(join(dir, 'V22902_PUBLIC_DEMO_MASTER_FINAL_SEAL.md'), SEALED_MD);
    const raw = await scanSince(null, { repoRoot: dir });
    assert.equal(raw.length, 1);
    assert.equal(raw[0].versionNumber, '22902');
    assert.equal(raw[0].statusLine, 'FINAL MASTER SEALED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanSince NEVER reads or reports anything from private/non-seal files, even when they sit right next to a real seal', async () => {
  const dir = makeFixtureRepo();
  try {
    writeFileSync(join(dir, 'V22902_PUBLIC_DEMO_MASTER_FINAL_SEAL.md'), SEALED_MD);
    // Simulate real private categories found in this repo (resident receipts,
    // private SBE state, campfire drafts) sitting in the same directory.
    writeFileSync(join(dir, 'NOEMORA_PRIVATE_SBE_STATE_SNAPSHOT.json'), JSON.stringify({ resident: 'private world data' }));
    writeFileSync(join(dir, 'NOEMORA_CAMPFIRE_COMMUNITY_PUBLIC_POST_CANDIDATE_V267800.md'), '# Draft\nActual publication: FALSE\nActual upload: FALSE\n');
    mkdirSync(join(dir, 'evaluator_only'), { recursive: true });
    writeFileSync(join(dir, 'evaluator_only', 'resident_receipt.json'), JSON.stringify({ subject_id: 'private-resident-1' }));

    const raw = await scanSince(null, { repoRoot: dir });
    assert.equal(raw.length, 1, 'only the real seal file becomes a candidate');
    assert.equal(raw[0].sealFile, 'V22902_PUBLIC_DEMO_MASTER_FINAL_SEAL.md');
    const allText = JSON.stringify(raw);
    assert.ok(!allText.includes('private world data'));
    assert.ok(!allText.includes('private-resident-1'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a weaker-status seal ("HANDOFF PREPARED") is still a candidate but classified PARTIAL, not VERIFIED', async () => {
  const dir = makeFixtureRepo();
  try {
    writeFileSync(join(dir, 'V22800_PUBLIC_DEMO_RELEASE_SUMMARY_OPERATOR_HANDOFF_SEAL.md'), '# Handoff\n\nStatus: HANDOFF PREPARED\nGenerated: 2026-07-02T10:00:00Z\n');
    const [raw] = await scanSince(null, { repoRoot: dir });
    const normalized = normalize(raw);
    assert.equal(normalized.verification_state, 'PARTIAL');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a strongly-sealed record normalizes to VERIFIED, public-safe, DEMO_COMPLETED', async () => {
  const dir = makeFixtureRepo();
  try {
    writeFileSync(join(dir, 'V22902_PUBLIC_DEMO_MASTER_FINAL_SEAL.md'), SEALED_MD);
    const [raw] = await scanSince(null, { repoRoot: dir });
    const normalized = normalize(raw);
    assert.equal(normalized.event_type, 'DEMO_COMPLETED');
    assert.equal(normalized.verification_state, 'VERIFIED');
    assert.equal(normalized.public_safety_state, 'PUBLIC_SAFE');
    assert.deepEqual(normalized.evidence_hashes, ['91c53d71ff9502c7a32d91bd6aebd55f9d3274fda4b51bb6de7c0f4e835879f4']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanSince against a nonexistent repo root returns [] rather than throwing', async () => {
  const raw = await scanSince(null, { repoRoot: '/nonexistent/path/for/this/test' });
  assert.deepEqual(raw, []);
});

test('adapter identity', () => {
  assert.equal(source, 'noemora');
});
