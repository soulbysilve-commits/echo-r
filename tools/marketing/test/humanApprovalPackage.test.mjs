import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductHuntPackage, buildHackerNewsPackage, buildNotePackage } from '../lib/humanApprovalPackage.mjs';

const TECHNICAL_FACT = {
  id: 'FACT-001', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED',
  CLAIM: 'ECHO Agent\'s verifier rejects a claimed task success when there is no supporting evidence, using an idempotent write-ahead ledger architecture.',
  SOURCE_REPOSITORY: 'ECHODiscord版', SOURCE_PATH: 'echo_agent_verifier_v1.py',
  SOURCE_EVIDENCE: 'test passes', VERIFIED_AT: '2026-09-01', PUBLIC_SAFE: 'true', NOTES: '',
};

const PROMOTIONAL_FACT = {
  id: 'FACT-002', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED',
  CLAIM: 'ECHO Agent looks great now.', SOURCE_REPOSITORY: 'x', SOURCE_PATH: 'x',
  SOURCE_EVIDENCE: 'x', VERIFIED_AT: '2026-09-01', PUBLIC_SAFE: 'true', NOTES: '',
};

test('buildProductHuntPackage: includes every mandated field and traces to the real fact', () => {
  const pkg = buildProductHuntPackage(TECHNICAL_FACT, { launchUrl: 'https://producthunt.com/posts/x' });
  for (const field of ['productName', 'tagline', 'description', 'makerComment', 'galleryAssets', 'video', 'topics', 'launchUrl', 'firstComment', 'launchChecklist']) {
    assert.ok(field in pkg, `missing field: ${field}`);
  }
  assert.deepEqual(pkg.factIds, ['FACT-001']);
  assert.equal(pkg.actionType, 'producthunt_launch');
});

test('buildProductHuntPackage: never submits — it is a plain data object, no publish/network call anywhere in this module', () => {
  const pkg = buildProductHuntPackage(TECHNICAL_FACT);
  assert.equal(typeof pkg, 'object');
  assert.equal(pkg.launchUrl, null);
});

test('buildHackerNewsPackage: minimal marketing language, includes the human review checklist', () => {
  const pkg = buildHackerNewsPackage(TECHNICAL_FACT);
  assert.equal(pkg.actionType, 'hackernews_post');
  assert.ok(Array.isArray(pkg.checklist) && pkg.checklist.length > 0);
});

test('buildNotePackage: refuses a non-technical fact, same gate as Zenn/DEV.to/Qiita', () => {
  assert.equal(buildNotePackage(PROMOTIONAL_FACT, [PROMOTIONAL_FACT]), null);
});

test('buildNotePackage: produces a real Japanese long-form package for a technical fact', () => {
  const pkg = buildNotePackage(TECHNICAL_FACT, [TECHNICAL_FACT]);
  assert.equal(pkg.actionType, 'note_article');
  assert.match(pkg.long_text, /##/);
});
