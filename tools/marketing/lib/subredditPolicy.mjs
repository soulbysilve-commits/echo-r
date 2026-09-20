// Reddit subreddit policy registry + candidate matching (multi-channel
// expansion mandate section 10). Reddit's own connector (connectors/
// reddit.mjs) stays REAL_CLIENT_IMPLEMENTED for replies (unchanged,
// AUTO_WITH_POLICY per lib/policy.mjs), but a self-promotional POST is a
// fundamentally different, higher-risk action — this module is the extra
// gate a candidate must pass before it can even reach the human-approval
// queue; it never itself submits anything.
import { isAuthConfigured } from '../connectors/reddit.mjs';

// A real, curated starting registry — not exhaustive, deliberately small and
// conservative. Every entry states its actual self-promotion rule as
// documented by that subreddit's own community, never assumed permissive by
// default (mandate: "self-promotion rules must allow it" is a real check,
// not a formality). Extend this list only with subreddits whose rules have
// actually been read.
export const SUBREDDIT_REGISTRY = {
  programming: {
    selfPromoAllowed: false,
    rule: 'r/programming disallows self-promotional submissions of your own project; direct links to your own product are typically removed.',
    tags: [],
  },
  MachineLearning: {
    selfPromoAllowed: false,
    rule: 'Self-promotion belongs in the stickied monthly projects/hiring thread, not as a top-level submission.',
    tags: ['ai', 'ml', 'agent', 'llm'],
  },
  artificial: {
    selfPromoAllowed: true,
    rule: 'Generally allows project showcases if clearly labeled and genuinely on-topic — still subject to moderator discretion.',
    tags: ['ai', 'agent', 'llm', 'autonomous'],
  },
  SideProject: {
    selfPromoAllowed: true,
    rule: 'Self-promotion of a side project is the explicit purpose of this subreddit.',
    tags: ['ai', 'agent', 'tool', 'saas', 'automation'],
  },
};

function factKeywords(fact) {
  return `${fact.PRODUCT ?? ''} ${fact.CLAIM ?? ''}`.toLowerCase();
}

// Word-boundary match — plain substring matching would false-positive on
// e.g. tag "ai" inside the ordinary English word "claim".
function hasTag(text, tag) {
  return new RegExp(`\\b${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
}

/**
 * "Subreddit relevance must be high" (mandate section 10) — a real, checkable
 * signal: the fact's own product/claim text must actually mention at least
 * one of the subreddit's declared topic tags. A subreddit with no tags
 * configured (e.g. r/programming here) can never match anything — it's
 * listed only to document that self-promotion is disallowed there, not as a
 * candidate target.
 */
export function matchCandidateSubreddits(fact, registry = SUBREDDIT_REGISTRY) {
  const text = factKeywords(fact);
  return Object.entries(registry)
    .filter(([, info]) => info.selfPromoAllowed && info.tags.some((tag) => hasTag(text, tag)))
    .map(([name]) => name);
}

function recentSubredditPromotions(db, subreddit, days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(
    "SELECT * FROM publication_ledger WHERE channel = 'reddit' AND content_type = 'reddit_self_promotion' AND account = ? AND created_at >= ?"
  ).all(subreddit, since);
}

function recentDistinctSubreddits(db, days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(
    "SELECT DISTINCT account FROM publication_ledger WHERE channel = 'reddit' AND content_type = 'reddit_self_promotion' AND created_at >= ?"
  ).all(since);
  return rows.map((r) => r.account).filter(Boolean);
}

/**
 * The full eligibility gate (mandate section 10) — every condition
 * independently required, all checked BEFORE a candidate may even reach the
 * human-approval queue: subreddit relevance high, self-promotion rules
 * allow it, account/API capability valid, no repeated promotion (same
 * subreddit within 7 days), no cross-subreddit burst (more than
 * `maxSubredditsPerDay` distinct subreddits targeted in 24h).
 */
export function checkRedditEligibility(db, subreddit, fact, {
  env = process.env, registry = SUBREDDIT_REGISTRY, repeatWindowDays = 7, maxSubredditsPerDay = 1,
} = {}) {
  const reasons = [];
  const info = registry[subreddit];
  if (!info) {
    return { eligible: false, reasons: [`${subreddit} is not in the subreddit policy registry — refusing an unreviewed target`] };
  }
  if (!info.selfPromoAllowed) {
    reasons.push(`r/${subreddit}'s self-promotion rule disallows this: ${info.rule}`);
  }
  const text = factKeywords(fact);
  const relevant = info.tags.some((tag) => hasTag(text, tag));
  if (!relevant) {
    reasons.push(`fact does not match r/${subreddit}'s topic tags (${info.tags.join(', ') || 'none configured'}) — relevance too low`);
  }
  if (!isAuthConfigured(env)) {
    reasons.push('reddit API credentials not configured');
  }
  const repeats = recentSubredditPromotions(db, subreddit, repeatWindowDays);
  if (repeats.length > 0) {
    reasons.push(`r/${subreddit} already received a promotion within the last ${repeatWindowDays} days (repeated promotion not allowed)`);
  }
  const distinctToday = recentDistinctSubreddits(db, 1);
  if (!distinctToday.includes(subreddit) && distinctToday.length >= maxSubredditsPerDay) {
    reasons.push(`cross-subreddit burst guard: already targeted ${distinctToday.length} distinct subreddit(s) in the last 24h (max ${maxSubredditsPerDay})`);
  }
  return { eligible: reasons.length === 0, reasons };
}
