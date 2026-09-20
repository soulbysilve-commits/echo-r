// Per-channel frequency guards + publication staggering (multi-channel
// expansion mandate section 16). Extends lib/limits.mjs's existing single
// global MAX_EXTERNAL_POSTS_PER_DAY (still also used as-is for the
// cross-channel today's-post-count cap inside operator.mjs's legacy
// runOnceInner — unchanged) with an explicit PER-CHANNEL cap for every
// channel, so X/Bluesky/Mastodon/etc. each have their own independent
// daily/weekly budget rather than only ever sharing one counter.
import { ensureLedgerV2Schema } from './ledger.mjs';

// Defaults from mandate section 16. Every one is env-overridable
// (MARKETING_<CHANNEL>_MAX_PER_DAY / MARKETING_<CHANNEL>_MAX_PER_WEEK), same
// "safe defaults, ops can tune without a code change" philosophy as
// lib/limits.mjs.
const DEFAULT_CAPS = {
  bluesky: { perDay: 2 },
  mastodon: { perDay: 2 },
  devto: { perWeek: 2 },
  qiita: { perWeek: 2 },
  zenn: { perWeek: 2 },
  hashnode: { perWeek: 2 },
  linkedin: { perWeek: 3 },
  // Reddit/Product Hunt/Hacker News/note never auto-publish at all (mandate
  // section 1: HUMAN_APPROVAL_REQUIRED) — their "frequency" limits (1
  // approved promotion/subreddit/7 days; release-event-only;
  // major-event-only) constrain what may be PREPARED for human approval,
  // enforced in lib/subredditPolicy.mjs / lib/humanApprovalPackage.mjs, not
  // here (this module is specifically the auto-publish gate).
};

export function channelCaps(channel, env = process.env) {
  const upper = channel.toUpperCase();
  const perDayOverride = env[`MARKETING_${upper}_MAX_PER_DAY`];
  const perWeekOverride = env[`MARKETING_${upper}_MAX_PER_WEEK`];
  // X predates this module and already has its own configurable global
  // daily cap (MARKETING_MAX_EXTERNAL_POSTS_PER_DAY, lib/limits.mjs,
  // default 3), enforced separately inside operator.mjs's legacy
  // runOnceInner. Reused here as X's default per-channel cap too (pre-LIVE
  // hardening: X now also goes through this same shared guard) rather than
  // inventing a second, parallel MARKETING_X_MAX_PER_DAY value ops would
  // have to configure — MARKETING_X_MAX_PER_DAY can still override it
  // explicitly if a stricter X-specific cap is ever wanted.
  const defaults = channel === 'x'
    ? { perDay: Number(env.MARKETING_MAX_EXTERNAL_POSTS_PER_DAY ?? 3) }
    : (DEFAULT_CAPS[channel] ?? {});
  return {
    perDay: perDayOverride !== undefined ? Number(perDayOverride) : defaults.perDay,
    perWeek: perWeekOverride !== undefined ? Number(perWeekOverride) : defaults.perWeek,
  };
}

function publicationsSince(db, channel, sinceIso) {
  ensureLedgerV2Schema(db);
  return db.prepare(
    'SELECT * FROM publication_ledger WHERE channel = ? AND published_at IS NOT NULL AND published_at >= ?'
  ).all(channel, sinceIso);
}

export function channelPublicationCount(db, channel, { windowDays = 1 } = {}) {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  return publicationsSince(db, channel, since).length;
}

/**
 * The one function every newly-added channel's auto-publish decision routes
 * through (mandate section 16). Fails CLOSED: a channel with neither perDay
 * nor perWeek configured has no default here, so it can never auto-publish
 * until an explicit cap exists — "no configured limit" is never treated as
 * "unlimited".
 */
export function checkFrequencyGuard(db, channel, env = process.env) {
  const caps = channelCaps(channel, env);
  if (caps.perDay === undefined && caps.perWeek === undefined) {
    return { ok: false, reason: `${channel} has no configured frequency cap — refusing to auto-publish without an explicit limit` };
  }
  if (caps.perDay !== undefined) {
    const count = channelPublicationCount(db, channel, { windowDays: 1 });
    if (count >= caps.perDay) {
      return { ok: false, reason: `${channel} daily cap ${caps.perDay} reached (${count} published in the last 24h)` };
    }
  }
  if (caps.perWeek !== undefined) {
    const count = channelPublicationCount(db, channel, { windowDays: 7 });
    if (count >= caps.perWeek) {
      return { ok: false, reason: `${channel} weekly cap ${caps.perWeek} reached (${count} published in the last 7 days)` };
    }
  }
  return { ok: true };
}

/**
 * No simultaneous cross-channel burst for the SAME long-form content
 * (DEV.to activation mandate section 6: "at minimum, the same
 * canonical_content_id should not be published as a long-form article
 * across DEV.to/Qiita/Zenn simultaneously"). Same shape/semantics as
 * checkStagger() above but keyed on the ledger's canonical_content_id
 * column instead of event_id — a deliberately separate check, since the two
 * columns carry different meanings (event_id = the originating story;
 * canonical_content_id = "this is the same piece of long-form content
 * cross-posted to multiple channels"). A no-op whenever a caller doesn't
 * pass a canonicalContentId (every existing short-form channel today), so
 * adding this never changes behavior for Bluesky/Mastodon/X.
 */
export function checkCanonicalContentStagger(db, canonicalContentId, channel, { staggerMs = 5 * 60 * 1000 } = {}) {
  if (!canonicalContentId) return { ok: true };
  ensureLedgerV2Schema(db);
  const rows = db.prepare(
    "SELECT channel, published_at FROM publication_ledger WHERE canonical_content_id = ? AND published_at IS NOT NULL AND channel != ? ORDER BY published_at DESC LIMIT 1"
  ).all(canonicalContentId, channel);
  if (rows.length === 0) return { ok: true };
  const last = rows[0];
  const elapsed = Date.now() - Date.parse(last.published_at);
  if (elapsed < staggerMs) {
    return {
      ok: false,
      reason: `long-form staggering: ${last.channel} published canonical content ${canonicalContentId} ${Math.round(elapsed / 1000)}s ago (< ${Math.round(staggerMs / 1000)}s stagger window)`,
    };
  }
  return { ok: true };
}

/**
 * No simultaneous cross-channel burst for one event (mandate section 16:
 * "No single event may produce a simultaneous burst across all channels.
 * Introduce staggered publication scheduling."). True only if no OTHER
 * channel published for the exact same `eventId` within `staggerMs` — this
 * channel's own prior publish for the same event never blocks itself
 * (idempotency already prevents a duplicate there).
 */
export function checkStagger(db, eventId, channel, { staggerMs = 5 * 60 * 1000 } = {}) {
  if (!eventId) return { ok: true }; // nothing to stagger against without a shared event id
  ensureLedgerV2Schema(db);
  const rows = db.prepare(
    "SELECT channel, published_at FROM publication_ledger WHERE event_id = ? AND published_at IS NOT NULL AND channel != ? ORDER BY published_at DESC LIMIT 1"
  ).all(eventId, channel);
  if (rows.length === 0) return { ok: true };
  const last = rows[0];
  const elapsed = Date.now() - Date.parse(last.published_at);
  if (elapsed < staggerMs) {
    return {
      ok: false,
      reason: `staggering: ${last.channel} published for event ${eventId} ${Math.round(elapsed / 1000)}s ago (< ${Math.round(staggerMs / 1000)}s stagger window)`,
    };
  }
  return { ok: true };
}
