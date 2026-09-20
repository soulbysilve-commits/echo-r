import { factById, supportsShippedClaim } from './facts.mjs';

// Mandate section 4: three action classes.
export const RISK_CLASS = {
  AUTO: 'AUTO',
  AUTO_WITH_POLICY: 'AUTO_WITH_POLICY',
  HUMAN_APPROVAL_REQUIRED: 'HUMAN_APPROVAL_REQUIRED',
};

const AUTO_ACTIONS = new Set([
  'x_post', 'dev_update', 'release_notes', 'changelog', 'site_news', 'site_blog',
  'seo_metadata', 'sitemap_update', 'discord_release_announcement', 'demo_announcement',
  'scheduled_technical_content', 'benchmark_summary', 'build_in_public_update',
  'routine_copy_correction', 'analytics_collection', 'utm_generation',
  'content_scheduling', 'performance_report',
  'youtube_upload_private', 'x_video_followup',
  // Multi-channel expansion (mandate section 1: AUTO_PUBLIC_ELIGIBLE) — same
  // evidence-gated, template-drafted, policy-checked path as x_post; the
  // channel-level enable flag (lib/channelFlags.mjs) and per-channel
  // frequency guard (lib/frequencyGuards.mjs) are the additional gates that
  // make each of these actually safe to run unattended.
  'bluesky_post', 'mastodon_post', 'devto_article', 'qiita_article',
]);

const AUTO_WITH_POLICY_ACTIONS = new Set([
  'x_reply', 'competitor_comparison', 'failure_post', 'pricing_post',
  'architecture_security_discussion', 'reddit_reply', 'hn_reply', 'community_reply',
  // CONDITIONAL_AUTO (mandate section 1) — additionally gated on a real,
  // dedicated capability check reporting READY (see connectors/hashnode.mjs
  // / linkedin.mjs's detectCapability()) before channelEnabled() can ever be
  // true in practice; classified AUTO_WITH_POLICY (not plain AUTO) so the
  // existing content/policy gate still runs on every post.
  'hashnode_post', 'linkedin_post',
]);

const HUMAN_APPROVAL_ACTIONS = new Set([
  'price_change', 'refund', 'paid_ad_spend', 'legal_policy_change', 'eula_change',
  'vulnerability_disclosure', 'security_incident_disclosure', 'partnership_announcement',
  'customer_testimonial', 'mass_dm', 'political_campaigning', 'production_sales_activation',
  'stripe_live_mode_activation', 'destructive_account_change',
  // Making an uploaded video PUBLIC is a separate, deliberate step from
  // uploading it PRIVATE — initial automation only ever uploads private
  // (see connectors/youtube.mjs DEFAULT_PRIVACY); flipping to public is
  // conservative-by-default until several successful runs build confidence.
  'youtube_make_public',
  // Multi-channel expansion (mandate section 1: HUMAN_APPROVAL_REQUIRED).
  // These never auto-publish under any mode — the operator only ever
  // prepares a package and records it PENDING_HUMAN_APPROVAL (mandate
  // section 20: MODE=AUTO_PREPARE_HUMAN_APPROVAL). Reddit's own
  // self-promotion posts (distinct from reddit_reply above, which stays
  // AUTO_WITH_POLICY — replies to an existing thread are a different, lower
  // -risk action than starting a new self-promotional post).
  'reddit_self_promotion', 'producthunt_launch', 'hackernews_post', 'note_article',
]);

export function classifyRisk(actionType) {
  if (HUMAN_APPROVAL_ACTIONS.has(actionType)) return RISK_CLASS.HUMAN_APPROVAL_REQUIRED;
  if (AUTO_WITH_POLICY_ACTIONS.has(actionType)) return RISK_CLASS.AUTO_WITH_POLICY;
  if (AUTO_ACTIONS.has(actionType)) return RISK_CLASS.AUTO;
  // Unknown action types are conservatively treated as requiring approval.
  return RISK_CLASS.HUMAN_APPROVAL_REQUIRED;
}

// Heuristic spam / deceptive-growth / unsupported-claim signals (mandate sections 3, 5).
const BANNED_PATTERNS = [
  { name: 'FAKE_TESTIMONIAL', re: /\b(our (users|customers) (say|report|love)|reviews (show|say))\b/i },
  { name: 'UNSUPPORTED_SUPERIORITY', re: /\b(the best|#1|number one|guaranteed|nobody else|world'?s first)\b/i },
  { name: 'FABRICATED_METRIC', re: /\b\d+(\.\d+)?%\s*(faster|better|more accurate|improvement)\b/i },
  { name: 'MASS_SOLICITATION', re: /\b(dm me|buy now|limited time offer|act now|click here)\b/i },
];

const SHIPPED_LANGUAGE = /\b(available now|now available|shipped|released|live in production|out now)\b/i;

/**
 * draft = { text, factIds: string[], claimStrength: 'shipped' | 'planned' | 'neutral' }
 */
export function checkContent(draft, facts) {
  const violations = [];

  for (const { name, re } of BANNED_PATTERNS) {
    if (re.test(draft.text)) violations.push(name);
  }

  const impliesShipped = draft.claimStrength === 'shipped' || SHIPPED_LANGUAGE.test(draft.text);
  if (impliesShipped) {
    if (!draft.factIds || draft.factIds.length === 0) {
      violations.push('NO_EVIDENCE_FOR_SHIPPED_CLAIM');
    } else {
      for (const id of draft.factIds) {
        const fact = factById(facts, id);
        if (!fact) {
          violations.push(`UNKNOWN_FACT_ID:${id}`);
        } else if (!supportsShippedClaim(fact)) {
          violations.push(`UNVERIFIED_CLAIM:${id}:${fact.STATUS}`);
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Extra checks for AUTO_WITH_POLICY actions (mandate section 4).
 */
export function checkPolicyGate(draft) {
  const violations = [];
  if (/\b(you (people|guys) (always|never)|scam|fraud|liar)\b/i.test(draft.text)) {
    violations.push('UNSUPPORTED_ACCUSATION');
  }
  if (/\b(sk-|api[_-]?key|secret[_-]?key|password\s*[:=])\b/i.test(draft.text)) {
    violations.push('POSSIBLE_CREDENTIAL_LEAK');
  }
  return { ok: violations.length === 0, violations };
}
