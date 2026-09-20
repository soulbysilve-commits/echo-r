import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMilestoneWorthy, scanSince, source } from '../sourceAdapters/echoApp.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeTaggedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-echoapp-fixture-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'f.txt'), 'x');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

// --- isMilestoneWorthy (verified against the real 94-tag corpus's noise pattern) ---

test('isMilestoneWorthy rejects bare metadata-bump tags (the real, confirmed noise pattern)', () => {
  assert.equal(isMilestoneWorthy('Freeze ECHO iOS Bundle Identifier Metadata v0.1'), false);
  assert.equal(isMilestoneWorthy('Freeze ECHO iOS App Version Metadata v0.1'), false);
  assert.equal(isMilestoneWorthy('Freeze ECHO iOS Launch Screen Metadata v0.1'), false);
});

test('isMilestoneWorthy accepts real milestone-shaped subjects', () => {
  assert.equal(isMilestoneWorthy('Freeze ECHO A.8.16 Public Durable Production Endpoint v0.1'), true);
  assert.equal(isMilestoneWorthy('A.8.16 IPv6 sync runtime recovery freeze'), true);
});

test('isMilestoneWorthy rejects a subject with no milestone keyword at all (git commit alone is not sufficient)', () => {
  assert.equal(isMilestoneWorthy('Freeze ECHO iOS App Icon Packaging v0.1'), false);
  assert.equal(isMilestoneWorthy(''), false);
  assert.equal(isMilestoneWorthy(undefined), false);
});

// --- scanSince against a real (fixture) git repo ---

test('scanSince only reads tags (git for-each-ref refs/tags), never raw commits — a bare commit never becomes a candidate', async () => {
  const dir = makeTaggedRepo();
  try {
    const raw = await scanSince(null, { repoRoot: dir });
    assert.deepEqual(raw, [], 'no tags exist yet — a real commit alone must never surface as a candidate');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanSince filters out noise tags and keeps milestone-worthy ones — test/tag spam aggregation', async () => {
  const dir = makeTaggedRepo();
  try {
    git(dir, ['tag', '-a', 'echo-ios-bundle-identifier-metadata-v0.1', '-m', 'Freeze ECHO iOS Bundle Identifier Metadata v0.1']);
    git(dir, ['tag', '-a', 'echo-ios-launch-screen-metadata-v0.1', '-m', 'Freeze ECHO iOS Launch Screen Metadata v0.1']);
    git(dir, ['tag', '-a', 'echo-ios-app-version-metadata-v0.1', '-m', 'Freeze ECHO iOS App Version Metadata v0.1']);
    git(dir, ['tag', '-a', 'echo-public-durable-production-endpoint-v0.1', '-m', 'Freeze ECHO A.8.16 Public Durable Production Endpoint v0.1']);

    const raw = await scanSince(null, { repoRoot: dir });
    assert.equal(raw.length, 1, '3 noise tags + 1 real milestone tag -> exactly 1 candidate, not 4');
    assert.equal(raw[0].tagName, 'echo-public-durable-production-endpoint-v0.1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanSince respects the cursor — a tag created before the cursor\'s last_timestamp is not re-returned', async () => {
  const dir = makeTaggedRepo();
  try {
    git(dir, ['tag', '-a', 'echo-production-milestone-v0.1', '-m', 'Freeze ECHO Production Milestone v0.1']);
    const firstScan = await scanSince(null, { repoRoot: dir });
    assert.equal(firstScan.length, 1);

    const cursor = { last_timestamp: firstScan[0].createdAt };
    const secondScan = await scanSince(cursor, { repoRoot: dir });
    assert.equal(secondScan.length, 0, 'already-seen tag must not be returned again');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanSince against a nonexistent repo root returns [] rather than throwing', async () => {
  const raw = await scanSince(null, { repoRoot: '/nonexistent/path/for/this/test' });
  assert.deepEqual(raw, []);
});

test('adapter identity', () => {
  assert.equal(source, 'echo-app');
});
