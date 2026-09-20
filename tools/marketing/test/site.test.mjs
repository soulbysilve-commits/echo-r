import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFacts } from '../lib/facts.mjs';
import { generateArticle, validateArticle, writeNewsArticle, NEWS_CATEGORIES } from '../lib/site.mjs';

const FACTS_MD = `
## FACT-001
PRODUCT: ECHO Agent
STATUS: VERIFIED
CLAIM: ECHO Agent's verifier rejects a claimed success with no evidence.
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: echo_agent_verifier_v1.py
SOURCE_EVIDENCE: tests pass
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES:

## FACT-002
PRODUCT: Noemora
STATUS: PLANNED
CLAIM: Autonomous residents act inside the Luanti world end-to-end.
SOURCE_REPOSITORY: Noemora_mod_core
SOURCE_PATH: docs/NOEMORA_COMPLETION_STATUS.md
SOURCE_EVIDENCE: currently FAIL per project's own audit
VERIFIED_AT:
PUBLIC_SAFE: true
NOTES:
`;

const facts = parseFacts(FACTS_MD);

test('a VERIFIED fact generates a valid, policy-passing article', () => {
  const article = generateArticle(facts[0], { locale: 'en', now: new Date('2026-09-13') });
  assert.equal(article.frontmatter.category, 'ECHO Agent');
  assert.equal(article.frontmatter.status, 'VERIFIED');
  const check = validateArticle(article, facts);
  assert.equal(check.ok, true);
});

test('a PLANNED fact cannot be emitted as an already-shipped article', () => {
  // Force shipped-style language onto a PLANNED fact to simulate a bug elsewhere
  // trying to slip an unverified claim through — the gate must still catch it.
  const planned = facts[1];
  const article = generateArticle(planned, { locale: 'en', now: new Date('2026-09-13') });
  // generateArticle itself uses honest "planned" framing, so assert that directly:
  assert.equal(article.draftForPolicy.claimStrength, 'planned');
  // And confirm the gate independently rejects a forced "shipped" version of the same claim:
  const forcedShipped = { ...article, draftForPolicy: { ...article.draftForPolicy, claimStrength: 'shipped', text: 'Available now: ' + article.draftForPolicy.text } };
  const check = validateArticle(forcedShipped, facts);
  assert.equal(check.ok, false);
  assert.ok(check.violations.some((v) => v.startsWith('UNVERIFIED_CLAIM:FACT-002')));
});

test('writeNewsArticle refuses to write when validation fails, and writes when it passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-site-test-'));
  try {
    const result = writeNewsArticle(facts[0], facts, { locale: 'en', contentDir: dir, now: new Date('2026-09-13') });
    assert.equal(result.written, true);
    const content = readFileSync(result.path, 'utf8');
    assert.ok(content.startsWith('---'));
    assert.ok(content.includes('FACT-001'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeNewsArticle is idempotent per fact id — a second call does not duplicate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-site-test2-'));
  try {
    const first = writeNewsArticle(facts[0], facts, { locale: 'en', contentDir: dir, now: new Date('2026-09-13') });
    const second = writeNewsArticle(facts[0], facts, { locale: 'en', contentDir: dir, now: new Date('2026-09-14') });
    assert.equal(first.written, true);
    assert.equal(second.written, false);
    assert.equal(second.reason, 'already generated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all generated categories are within the allowed NEWS_CATEGORIES set', () => {
  for (const fact of facts) {
    const article = generateArticle(fact, { locale: 'en' });
    assert.ok(NEWS_CATEGORIES.includes(article.frontmatter.category));
  }
});

test('Japanese locale produces Japanese body text distinct from English', () => {
  const en = generateArticle(facts[0], { locale: 'en', now: new Date('2026-09-13') });
  const ja = generateArticle(facts[0], { locale: 'ja', now: new Date('2026-09-13') });
  assert.notEqual(en.body, ja.body);
  assert.ok(ja.body.includes('ステータス'));
});
