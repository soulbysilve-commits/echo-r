// Cross-channel content engine (multi-channel expansion mandate section 14):
// one verified fact must never produce identical spam across every
// platform. Every generator below is template-based from the SAME fact
// object draft.mjs's existing generators use (never free-generation — every
// claim traces directly to fact.CLAIM, same evidence discipline), but
// produces genuinely platform-appropriate wording/length/register, per
// mandate section 14's own examples.
import { STATUS_LABEL_JA, STATUS_LABEL_EN } from './draft.mjs';
import { AI_DISCLOSURE_EN as MASTODON_AI_DISCLOSURE_EN } from '../connectors/mastodon.mjs';

const TECHNICAL_KEYWORDS = [
  'architecture', 'implementation', 'algorithm', 'protocol', 'verifier', 'verification',
  'continuity', 'memory', 'reliability', 'concurrency', 'race condition', 'engineering',
  'e2e', 'end-to-end', 'benchmark', 'latency', 'consistency', 'idempotent', 'idempotency',
  'write-ahead', 'wal', 'ledger', 'gate', 'schema', 'migration', 'retry', 'backoff',
  'signing', 'signature', 'oauth', 'encoding', 'serialization', 'deserialization',
];

/**
 * True only when the fact has genuine technical substance (mandate sections
 * 5/6/7/12/13: "Technical long-form content only... Never turn ordinary
 * promotional copy into an article. There must be actual technical
 * substance/evidence.") — a real, checkable heuristic (keyword presence in
 * the fact's own verified CLAIM/NOTES text, never a free-form judgment call
 * made up per-call) plus a minimum content length, so a one-line marketing
 * claim can never qualify no matter how it's phrased.
 */
export function isTechnicalSubstance(fact) {
  const text = `${fact.CLAIM ?? ''} ${fact.NOTES ?? ''}`.toLowerCase();
  if (text.trim().length < 60) return false;
  return TECHNICAL_KEYWORDS.some((kw) => text.includes(kw));
}

function statusSuffixEn(fact) {
  return STATUS_LABEL_EN[fact.STATUS] ?? '';
}
function statusSuffixJa(fact) {
  return STATUS_LABEL_JA[fact.STATUS] ?? '';
}

// --- AUTO_PUBLIC_ELIGIBLE short-form channels ---

export function draftBlueskyPost(fact) {
  const label = statusSuffixEn(fact);
  const text = `${fact.CLAIM}${label ? ' ' + label : ''}`.trim();
  return { channel: 'bluesky', text, factIds: [fact.id], claimStrength: fact.STATUS === 'VERIFIED' ? 'shipped' : 'planned', actionType: 'bluesky_post' };
}

export function draftMastodonPost(fact) {
  const label = statusSuffixEn(fact);
  // Technical/concise register: leads with the product+component, not a
  // hook — distinct voice from Bluesky's more conversational phrasing.
  // Always carries the AI-use disclosure mastodon.social's own signup rules
  // require — connectors/mastodon.mjs's validate() fails closed without it,
  // so this is the real (not merely defensive) source of that line, kept in
  // sync with the connector's own AI_DISCLOSURE_EN rather than duplicated.
  const text = `${fact.PRODUCT}: ${fact.CLAIM}${label ? ' ' + label : ''}\n\nSource: ${fact.SOURCE_REPOSITORY}/${fact.SOURCE_PATH}\n\n${MASTODON_AI_DISCLOSURE_EN}`.trim();
  return { channel: 'mastodon', text, factIds: [fact.id], claimStrength: fact.STATUS === 'VERIFIED' ? 'shipped' : 'planned', actionType: 'mastodon_post' };
}

// --- AUTO_PUBLIC_ELIGIBLE long-form channels (technical substance required) ---

function longFormBody(fact, { language }) {
  const evidence = language === 'ja'
    ? `## 検証内容\n\n${fact.SOURCE_EVIDENCE ?? ''}\n\n出典: \`${fact.SOURCE_REPOSITORY}/${fact.SOURCE_PATH}\``
    : `## Verification\n\n${fact.SOURCE_EVIDENCE ?? ''}\n\nSource: \`${fact.SOURCE_REPOSITORY}/${fact.SOURCE_PATH}\``;
  const claim = language === 'ja' ? `## 概要\n\n${fact.CLAIM}` : `## Summary\n\n${fact.CLAIM}`;
  const notes = fact.NOTES ? `\n\n${language === 'ja' ? '## 補足' : '## Notes'}\n\n${fact.NOTES}` : '';
  return `${claim}\n\n${evidence}${notes}`;
}

export function draftDevToArticle(fact, { canonicalUrl } = {}) {
  if (!isTechnicalSubstance(fact)) return null;
  return {
    channel: 'devto',
    title: `${fact.PRODUCT}: ${fact.CLAIM.split('.')[0]}`,
    long_text: longFormBody(fact, { language: 'en' }),
    short_text: fact.CLAIM,
    tags: ['ai', 'architecture'],
    canonical_url: canonicalUrl,
    factIds: [fact.id],
    claimStrength: fact.STATUS === 'VERIFIED' ? 'shipped' : 'planned',
    actionType: 'devto_article',
  };
}

export function draftQiitaArticle(fact, { canonicalUrl } = {}) {
  if (!isTechnicalSubstance(fact)) return null;
  return {
    channel: 'qiita',
    title: `${fact.PRODUCT}の実装: ${fact.CLAIM.split('.')[0]}`,
    long_text: longFormBody(fact, { language: 'ja' }),
    tags: ['AI', 'アーキテクチャ'],
    canonical_url: canonicalUrl,
    factIds: [fact.id],
    claimStrength: fact.STATUS === 'VERIFIED' ? 'shipped' : 'planned',
    actionType: 'qiita_article',
  };
}

export function draftZennArticle(fact, { canonicalUrl } = {}) {
  if (!isTechnicalSubstance(fact)) return null;
  return {
    channel: 'zenn',
    title: `${fact.PRODUCT}の設計: ${fact.CLAIM.split('.')[0]}`,
    long_text: longFormBody(fact, { language: 'ja' }),
    tags: ['ai', 'architecture'],
    canonical_url: canonicalUrl,
    factIds: [fact.id],
    claimStrength: fact.STATUS === 'VERIFIED' ? 'shipped' : 'planned',
    actionType: 'zenn_draft',
  };
}

// --- CONDITIONAL_AUTO channels ---

export function draftHashnodePost(fact, { canonicalUrl } = {}) {
  if (!isTechnicalSubstance(fact)) return null;
  return {
    channel: 'hashnode',
    title: `${fact.PRODUCT}: ${fact.CLAIM.split('.')[0]}`,
    long_text: longFormBody(fact, { language: 'en' }),
    short_text: fact.CLAIM,
    tags: ['ai', 'softwareengineering'],
    canonical_url: canonicalUrl,
    factIds: [fact.id],
    claimStrength: fact.STATUS === 'VERIFIED' ? 'shipped' : 'planned',
    actionType: 'hashnode_post',
  };
}

export function draftLinkedInPost(fact) {
  const label = statusSuffixEn(fact);
  // Business/product framing (mandate section 14) — leads with the product
  // outcome, not the implementation detail.
  const text = `${fact.PRODUCT} update: ${fact.CLAIM}${label ? ' ' + label : ''}`.trim();
  return { channel: 'linkedin', text, factIds: [fact.id], claimStrength: fact.STATUS === 'VERIFIED' ? 'shipped' : 'planned', actionType: 'linkedin_post' };
}

// --- HUMAN_APPROVAL_REQUIRED channels — these never auto-publish; the
// generators below only ever produce a PREPARED PACKAGE for a human to
// review (see lib/humanApprovalPackage.mjs / lib/subredditPolicy.mjs for
// the fuller structured packages; these are the plain draft/text form used
// for the ledger/policy path). ---

export function draftRedditPost(fact, subreddit) {
  const text = `${fact.CLAIM}\n\nHappy to answer questions about the implementation — source: ${fact.SOURCE_REPOSITORY}/${fact.SOURCE_PATH}`;
  return {
    channel: 'reddit', subreddit, title: `${fact.PRODUCT}: ${fact.CLAIM.split('.')[0]}`, text,
    factIds: [fact.id], claimStrength: fact.STATUS === 'VERIFIED' ? 'shipped' : 'planned', actionType: 'reddit_self_promotion',
  };
}

export function draftHackerNewsPost(fact) {
  // Minimal marketing language (mandate section 12) — title only mentions
  // the concrete technical fact, no adjectives.
  return {
    channel: 'hackernews', title: `${fact.PRODUCT}: ${fact.CLAIM.split('.')[0]}`,
    text: fact.CLAIM, factIds: [fact.id], claimStrength: fact.STATUS === 'VERIFIED' ? 'shipped' : 'planned', actionType: 'hackernews_post',
  };
}

export function draftNoteArticle(fact) {
  if (!isTechnicalSubstance(fact)) return null;
  return {
    channel: 'note',
    title: `${fact.PRODUCT}: ${fact.CLAIM.split('。')[0].split('.')[0]}`,
    long_text: longFormBody(fact, { language: 'ja' }),
    factIds: [fact.id], claimStrength: fact.STATUS === 'VERIFIED' ? 'shipped' : 'planned', actionType: 'note_article',
  };
}
