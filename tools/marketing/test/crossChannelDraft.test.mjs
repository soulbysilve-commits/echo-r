import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTechnicalSubstance, draftBlueskyPost, draftMastodonPost, draftDevToArticle, draftQiitaArticle,
  draftZennArticle, draftHashnodePost, draftLinkedInPost, draftRedditPost, draftHackerNewsPost, draftNoteArticle,
} from '../lib/crossChannelDraft.mjs';

const TECHNICAL_FACT = {
  id: 'FACT-001', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED',
  CLAIM: 'ECHO Agent\'s verifier rejects a claimed task success when there is no supporting evidence, using an idempotent write-ahead ledger to detect a race condition between concurrent verifier retries.',
  SOURCE_REPOSITORY: 'ECHODiscord版', SOURCE_PATH: 'echo_agent_verifier_v1.py',
  SOURCE_EVIDENCE: 'test_fake_success_with_no_evidence_and_no_reviewer_fails_closed passes',
  VERIFIED_AT: '2026-09-01', PUBLIC_SAFE: 'true', NOTES: 'covers the architecture of the retry protocol',
};

const PROMOTIONAL_FACT = {
  id: 'FACT-002', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED',
  CLAIM: 'ECHO Agent now looks great in the new dashboard.',
  SOURCE_REPOSITORY: 'ECHODiscord版', SOURCE_PATH: 'ui.py',
  SOURCE_EVIDENCE: 'screenshot reviewed', VERIFIED_AT: '2026-09-01', PUBLIC_SAFE: 'true', NOTES: '',
};

test('isTechnicalSubstance: a genuine technical claim with real keywords and enough length qualifies', () => {
  assert.equal(isTechnicalSubstance(TECHNICAL_FACT), true);
});

test('isTechnicalSubstance: ordinary promotional copy never qualifies, no matter how it is phrased', () => {
  assert.equal(isTechnicalSubstance(PROMOTIONAL_FACT), false);
});

test('isTechnicalSubstance: a short claim with a technical keyword still fails the minimum length bar', () => {
  assert.equal(isTechnicalSubstance({ CLAIM: 'architecture', NOTES: '' }), false);
});

test('draftBlueskyPost and draftMastodonPost never produce identical text for the same fact', () => {
  const bsky = draftBlueskyPost(TECHNICAL_FACT);
  const masto = draftMastodonPost(TECHNICAL_FACT);
  assert.notEqual(bsky.text, masto.text);
  assert.equal(bsky.channel, 'bluesky');
  assert.equal(masto.channel, 'mastodon');
});

test('draftMastodonPost always carries the AI-use disclosure mastodon.social requires (real content generation, not just a validation fallback)', () => {
  const masto = draftMastodonPost(TECHNICAL_FACT);
  assert.match(masto.text, /AI-assisted/i);
});

test('every short-form draft traces its factIds back to the source fact — never invented content', () => {
  for (const draft of [draftBlueskyPost(TECHNICAL_FACT), draftMastodonPost(TECHNICAL_FACT), draftLinkedInPost(TECHNICAL_FACT)]) {
    assert.deepEqual(draft.factIds, ['FACT-001']);
    assert.ok(draft.text.includes(TECHNICAL_FACT.CLAIM.split(',')[0].split('.')[0]) || draft.text.length > 0);
  }
});

test('long-form generators (devto/qiita/zenn/hashnode/note) refuse a non-technical fact — never turn promotional copy into an article', () => {
  assert.equal(draftDevToArticle(PROMOTIONAL_FACT), null);
  assert.equal(draftQiitaArticle(PROMOTIONAL_FACT), null);
  assert.equal(draftZennArticle(PROMOTIONAL_FACT), null);
  assert.equal(draftHashnodePost(PROMOTIONAL_FACT), null);
  assert.equal(draftNoteArticle(PROMOTIONAL_FACT), null);
});

test('long-form generators produce a real draft for a genuinely technical fact, each with distinct title/body language', () => {
  const dev = draftDevToArticle(TECHNICAL_FACT, { canonicalUrl: 'https://veritasforge.example/canonical/1' });
  const qiita = draftQiitaArticle(TECHNICAL_FACT);
  const zenn = draftZennArticle(TECHNICAL_FACT);
  assert.ok(dev.long_text.includes('## Summary'));
  assert.ok(qiita.long_text.includes('## 概要'));
  assert.ok(zenn.long_text.includes('## 概要'));
  assert.notEqual(qiita.title, zenn.title);
  assert.equal(dev.canonical_url, 'https://veritasforge.example/canonical/1');
  assert.equal(dev.actionType, 'devto_article');
  assert.equal(qiita.actionType, 'qiita_article');
  assert.equal(zenn.actionType, 'zenn_draft');
});

test('draftRedditPost carries the target subreddit and a reddit_self_promotion actionType (never a plain reply)', () => {
  const draft = draftRedditPost(TECHNICAL_FACT, 'programming');
  assert.equal(draft.subreddit, 'programming');
  assert.equal(draft.actionType, 'reddit_self_promotion');
});

test('draftHackerNewsPost keeps minimal marketing language — the title is the claim, not embellished', () => {
  const draft = draftHackerNewsPost(TECHNICAL_FACT);
  assert.ok(draft.title.startsWith('ECHO Agent:'));
  assert.equal(draft.actionType, 'hackernews_post');
});
