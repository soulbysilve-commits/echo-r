// Candidate pre-filter for the ranked.find()-style selection every
// AUTO_PUBLIC channel cycle in operator.mjs uses (bug found 2026-09-18:
// each cycle's old `!alreadyCovered[ByChannel](db, channel, fact.id)`
// predicate treated ANY prior publication_ledger row for a fact -- a real
// PUBLISHED success, a permanent PRE_ACTIVATION BASELINE_SKIPPED, or a
// merely TEMPORARY DRY_RUN/frequency-cap/stagger/auth-not-ready block --
// as equally "covered forever." That correctly stopped a fact being
// re-attempted once truly published, but it also meant a channel whose
// higher-ranked facts are permanently pre-activation could only ever burn
// through them one-per-cycle before ever reaching a genuinely new,
// eligible fact -- observed live on 2026-09-18: every one of
// x/bluesky/mastodon/devto/qiita's "first uncovered" candidate was STILL a
// 2026-09-13 pre-activation historical fact, with the new, eligible,
// post-activation ECHO Agent fact (MVF-17cbc9ef77e56440, rank 12/21)
// sitting unreachable behind it.
//
// Deliberately narrow: NO_DRAFT and content/policy rejections are NOT
// covered here, even though they are also deterministic/permanent given a
// fact's own immutable claim text -- publishToChannel() returns those
// statuses BEFORE ever calling recordIntent() (see lib/multiChannelPublish.mjs),
// so they never wrote a ledger row under the old logic either and were
// never subject to the queue-jam bug this module fixes; folding them in
// here would only destroy the specific violation/reason detail
// publishToChannel()'s own result already carries, for no queue-advancing
// benefit. If a policy-blocked or draft-declined fact needs to stop being
// re-selected every cycle, that is a separate, deliberate decision, not an
// automatic side effect of this fix.
//
// This module fixes ONLY the selection step. publishToChannel() (and
// runOnceInner's own equivalent inline gate for X) remains the sole
// authority on whether a selected candidate may actually publish --
// nothing here is a second copy of that decision, and nothing here ever
// writes to the ledger or calls a connector.
import { getActivationBoundary, isPreActivation } from './activation.mjs';

/**
 * True only for ineligibility that cannot resolve on its own between now
 * and the next cycle -- no daily/weekly cap reset, no stagger window
 * elapsing, no auth/canary fix, no MARKETING_MODE flip, no retry ever
 * changes the answer:
 *
 *   - PRE_ACTIVATION: the fact's own VERIFIED_AT predates the global or
 *     this channel's activation boundary. Boundaries are set-once and
 *     never move forward (lib/activation.mjs), so this can never become
 *     eligible later -- exactly the "no backlog laundering" contract every
 *     boundary in this codebase already has.
 *   - ALREADY_PUBLISHED: this exact fact has a REAL, terminal publish
 *     already recorded for this channel (publication_ledger.published_at
 *     IS NOT NULL) -- never re-publish a duplicate.
 *
 * Deliberately does NOT check: MARKETING_MODE, the global kill switch,
 * this channel's own enable flag, AUTH_VALID/CANARY_PASSED, the frequency
 * guard, the cross-channel/cross-content stagger, or content/policy
 * validity -- every one of those either can legitimately change between
 * one cycle and the next (so a fact blocked only by one of them must
 * remain a real candidate), or is already re-evaluated fresh by
 * publishToChannel() on every selection with no queue-jam risk of its own
 * (content/policy — see module doc comment above). Only
 * publishToChannel()'s own gate ever decides those.
 */
export function isPermanentlyIneligibleForChannel(db, channel, fact, { alreadyPublished } = {}) {
  const globalBoundary = getActivationBoundary(db);
  const channelBoundary = getActivationBoundary(db, channel);
  if (isPreActivation(fact.VERIFIED_AT, globalBoundary) || isPreActivation(fact.VERIFIED_AT, channelBoundary)) {
    return { blocked: true, reason: 'PRE_ACTIVATION' };
  }

  if (alreadyPublished?.(fact.id)) {
    return { blocked: true, reason: 'ALREADY_PUBLISHED' };
  }

  return { blocked: false };
}

/**
 * Highest-ranked candidate for `channel` that isn't permanently
 * ineligible, skipping past (never mutating, never publishing, never
 * ledger-writing) any fact that is. Returns null when every ranked fact is
 * permanently ineligible (mirrors the old `ranked.find()` returning
 * undefined) -- every call site's existing `if (!candidate) return
 * NO_POST` handling is unchanged.
 */
export function selectCandidateForChannel(db, channel, ranked, opts = {}) {
  for (const candidate of ranked) {
    if (!isPermanentlyIneligibleForChannel(db, channel, candidate.fact, opts).blocked) {
      return candidate;
    }
  }
  return null;
}
