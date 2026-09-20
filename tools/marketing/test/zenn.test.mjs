import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateZennArticle, writeZennArticle, readZennPublishedState } from '../lib/zenn.mjs';

const TECHNICAL_FACT = {
  id: 'FACT-001', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED',
  CLAIM: 'ECHO Agent\'s verifier rejects a claimed task success when there is no supporting evidence, using an idempotent write-ahead ledger architecture to detect a race condition.',
  SOURCE_REPOSITORY: 'ECHODiscord版', SOURCE_PATH: 'echo_agent_verifier_v1.py',
  SOURCE_EVIDENCE: 'test passes', VERIFIED_AT: '2026-09-01', PUBLIC_SAFE: 'true', NOTES: '',
};
const FACTS = [TECHNICAL_FACT];

const PROMOTIONAL_FACT = {
  id: 'FACT-002', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED',
  CLAIM: 'ECHO Agent looks great now.', SOURCE_REPOSITORY: 'x', SOURCE_PATH: 'x',
  SOURCE_EVIDENCE: 'x', VERIFIED_AT: '2026-09-01', PUBLIC_SAFE: 'true', NOTES: '',
};

function tempContentDir() {
  return mkdtempSync(join(tmpdir(), 'marketing-zenn-test-'));
}

test('generateZennArticle: refuses a non-technical fact, never fabricates an article', () => {
  const result = generateZennArticle(PROMOTIONAL_FACT, [PROMOTIONAL_FACT]);
  assert.equal(result.ok, false);
});

test('generateZennArticle: always sets published:false — AUTO_DRAFT only, never AUTO_PUBLISH', () => {
  const result = generateZennArticle(TECHNICAL_FACT, FACTS);
  assert.equal(result.ok, true);
  assert.equal(result.frontmatter.published, false);
});

test('writeZennArticle: writes a real markdown file with the fact-derived slug', () => {
  const dir = tempContentDir();
  try {
    const result = writeZennArticle(TECHNICAL_FACT, FACTS, { contentDir: dir });
    assert.equal(result.written, true);
    assert.ok(existsSync(result.path));
    const raw = readFileSync(result.path, 'utf8');
    assert.match(raw, /published: false/);
    assert.match(raw, /^---/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeZennArticle: idempotent — a second call for the same fact does not overwrite or duplicate', () => {
  const dir = tempContentDir();
  try {
    const first = writeZennArticle(TECHNICAL_FACT, FACTS, { contentDir: dir });
    const second = writeZennArticle(TECHNICAL_FACT, FACTS, { contentDir: dir });
    assert.equal(first.written, true);
    assert.equal(second.written, false);
    assert.equal(second.reason, 'already generated');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeZennArticle: never writes anything for a non-technical fact', () => {
  const dir = tempContentDir();
  try {
    const result = writeZennArticle(PROMOTIONAL_FACT, [PROMOTIONAL_FACT], { contentDir: dir });
    assert.equal(result.written, false);
    assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readZennPublishedState: reads the real published flag back from disk, never assumes', () => {
  const dir = tempContentDir();
  try {
    const written = writeZennArticle(TECHNICAL_FACT, FACTS, { contentDir: dir });
    const state = readZennPublishedState(written.path);
    assert.equal(state.exists, true);
    assert.equal(state.published, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readZennPublishedState: a nonexistent path reports exists:false, never a guessed published state', () => {
  const state = readZennPublishedState('/nonexistent/path/article.md');
  assert.equal(state.exists, false);
});
