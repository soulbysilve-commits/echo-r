// Public-live activation boundary (safe-activation mandate section 1).
//
// A durable, set-once timestamp stored in the SAME marketing.db this
// codebase already keeps in the durable state dir — no second persistence
// mechanism, same pattern as lib/sourceCursors.mjs.
//
// Contract: once flipping MARKETING_MODE to LIVE, existing content that
// predates activation must never auto-publish "merely because LIVE mode
// was enabled later" — see operator.mjs's runOnceInner, which ANDs a
// pre-activation-baseline check into liveAllowed for every candidate. The
// boundary itself is idempotent: calling ensureActivationBoundary() again
// after one is already set returns the EXISTING boundary unchanged, so
// re-running an activation script never creates a moving target that could
// make yesterday's "historical" content look "new" again.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS activation_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activation_classifications (
  kind          TEXT NOT NULL,   -- 'marketing_event' | 'pending_publication'
  item_id       TEXT NOT NULL,
  bucket        TEXT NOT NULL,
  reason        TEXT,
  classified_at TEXT NOT NULL,
  PRIMARY KEY (kind, item_id)
);
`;

const BOUNDARY_KEY = 'public_live_not_before';

// Multi-channel expansion: each channel gets its OWN durable boundary, same
// table/mechanism, never a parallel system — key-namespaced so
// getActivationBoundary(db) (no channel arg) keeps returning exactly the
// original global PUBLIC_LIVE_NOT_BEFORE untouched, for every existing
// caller (operator.mjs's runOnceInner). A channel boundary is never
// initialized FROM the global one, an old event timestamp, or an old canary
// timestamp — ensureActivationBoundary()'s default (`new Date()`, evaluated
// fresh at call time) is the only source, same as the original boundary's
// own contract.
function boundaryKey(channel) {
  return channel ? `channel_live_not_before:${channel}` : BOUNDARY_KEY;
}

export function ensureActivationSchema(db) {
  db.exec(SCHEMA);
}

export function getActivationBoundary(db, channel) {
  ensureActivationSchema(db);
  const row = db.prepare('SELECT value FROM activation_state WHERE key = ?').get(boundaryKey(channel));
  return row?.value ?? null;
}

/**
 * Sets the (global, or per-channel when `channel` is given) live-not-before
 * boundary if and only if it has never been set before. Returns { boundary,
 * created }: `boundary` is always the value now in effect (the one just
 * set, or the pre-existing one), `created` is true only the first time this
 * is ever called for this db (and this specific channel/global key).
 */
export function ensureActivationBoundary(db, isoTimestamp = new Date().toISOString(), channel) {
  ensureActivationSchema(db);
  const existing = getActivationBoundary(db, channel);
  if (existing) return { boundary: existing, created: false };
  db.prepare('INSERT INTO activation_state (key, value) VALUES (?, ?)').run(boundaryKey(channel), isoTimestamp);
  return { boundary: isoTimestamp, created: true };
}

/**
 * True when `candidateTimestamp` (an ISO date or datetime string — e.g. a
 * fact's VERIFIED_AT, or an event's received_at) is strictly before the
 * activation boundary. A candidate with no timestamp at all is treated as
 * pre-activation (fail closed: unknown provenance never auto-publishes).
 * Plain ISO-8601 string comparison is correct here because every timestamp
 * in this codebase (date-only "YYYY-MM-DD" or full datetime) shares the
 * same left-to-right, zero-padded, most-significant-first format.
 */
export function isPreActivation(candidateTimestamp, boundary) {
  if (!boundary) return false; // no boundary set yet => nothing is gated
  if (!candidateTimestamp) return true;
  return String(candidateTimestamp) < String(boundary);
}

/**
 * Idempotent upsert of a classification record for one historical item
 * (a marketing_event or a pending publication_ledger row), keyed on
 * (kind, item_id) — re-running the same classification pass is always
 * safe and just refreshes the reason/timestamp, never creates duplicates.
 */
export function recordClassification(db, { kind, itemId, bucket, reason }) {
  ensureActivationSchema(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO activation_classifications (kind, item_id, bucket, reason, classified_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(kind, item_id) DO UPDATE SET
       bucket = excluded.bucket, reason = excluded.reason, classified_at = excluded.classified_at`
  ).run(kind, itemId, bucket, reason ?? null, now);
}

export function getClassifications(db, kind) {
  ensureActivationSchema(db);
  return db.prepare('SELECT * FROM activation_classifications WHERE kind = ? ORDER BY item_id ASC').all(kind);
}

// A timestamp is only ever trusted for a boundary comparison if it at least
// LOOKS like a real ISO-8601 date/datetime (every real timestamp in this
// codebase — event.received_at, fact.VERIFIED_AT, channel boundaries — is
// "YYYY-MM-DD" or a full datetime with that same prefix). Deliberately NOT
// the same fail-closed direction as isPreActivation()'s own contract below:
// isPreActivation() is a PUBLICATION gate, where "unknown timestamp" must
// mean "never auto-publish" (so it treats a missing timestamp as
// pre-activation, on purpose). This is a CLASSIFICATION/bookkeeping
// decision, where "unknown timestamp" must mean the opposite — never
// silently resolved as historical (which would both mislabel the audit
// trail and, for a marketing_event, permanently remove it from the video
// pipeline's candidate pool via markEventProcessed()) — it must stay
// MANUAL_REVIEW/unresolved for a human or the normal pipeline to still see.
function looksLikeRealTimestamp(ts) {
  return typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}/.test(ts);
}

/**
 * The full activation pass (mandate sections 1-3): ensure the boundary,
 * classify every currently-unprocessed marketing_event and every currently-
 * pending publication_ledger row, and persist both. Never publishes
 * anything, never touches a publication_ledger row's approval_state.
 * Idempotent — safe to call more than once (a re-run only reclassifies
 * items that are STILL unprocessed/pending; anything already resolved by a
 * prior activation pass is left alone).
 *
 * Both loops below actually compare a real timestamp against `boundary`
 * (mirroring the exact fields the runtime PUBLICATION gate itself relies on
 * — operator.mjs's runOnceInner / lib/multiChannelPublish.mjs's
 * publishToChannel() both call isPreActivation()) rather than merely
 * asserting a bucket by inference: marketing_events are compared on their
 * own received_at (there is no fact yet — see PRIOR BUG below); pending
 * publications are compared on their BACKING FACT's VERIFIED_AT (the same
 * field the runtime gate re-checks at actual publish time), never the
 * ledger row's own created_at, which has no bearing on whether the
 * publication will ever actually be allowed to go LIVE.
 *
 * PRIOR BUG (found by a PRE-LIVE audit, fixed here): both loops used to
 * unconditionally assign BASELINE_BEFORE_LIVE / HISTORICAL_PENDING to any
 * item that reached that branch, regardless of whether its own timestamp
 * was actually before `boundary` — the reason string mentioned a
 * comparison that the bucket-assignment code never actually made. For
 * marketing_events this was a genuine live risk (no other runtime check
 * backs it up — unlike facts, which are independently re-checked via
 * isPreActivation() at actual publish time — so a mislabeled event would
 * be permanently marked processed via markEventProcessed() and silently
 * removed from the video pipeline's candidate pool the first time
 * `activate` happened to run after some genuinely NEW, post-boundary event
 * arrived). Fixed by making the comparison real on both sides.
 *
 * Callers pass in the concrete functions this needs (dependency injection)
 * rather than this module importing events.mjs/ledger.mjs/videoCandidates.mjs
 * directly, to avoid a circular import (videoCandidates.mjs is deep in the
 * video pipeline's own dependency graph) and to keep this module trivially
 * unit-testable against fake data.
 */
export function classifyActivationBaseline(db, {
  facts = [],
  unprocessedEvents,
  markEventProcessed,
  pendingPublications,
  candidateFromEvent,
  computeStoryFingerprint,
  isDuplicateStory,
} = {}) {
  const { boundary, created } = ensureActivationBoundary(db);
  const factIds = new Set(facts.map((f) => f.id));
  const factsById = new Map(facts.map((f) => [f.id, f]));

  // Buckets that represent a genuinely RESOLVED decision — anything else
  // (MANUAL_REVIEW, or a real post-boundary event/publication) is left
  // unprocessed/unresolved on purpose so a human or the normal pipeline can
  // still see and act on it, rather than being silently swallowed here.
  const RESOLVED_EVENT_BUCKETS = new Set(['ALREADY_CONSUMED', 'DUPLICATE', 'BASELINE_BEFORE_LIVE']);

  const events = [];
  for (const eventRow of unprocessedEvents(db)) {
    let bucket; let reason;
    if (eventRow.fact_id) {
      bucket = 'ALREADY_CONSUMED';
      reason = `already linked to fact ${eventRow.fact_id}`;
    } else {
      const candidate = candidateFromEvent(eventRow);
      if (!candidate) {
        bucket = 'MANUAL_REVIEW';
        reason = 'no usable evidence for automatic classification';
      } else {
        const fingerprint = computeStoryFingerprint(candidate);
        if (isDuplicateStory(db, fingerprint)) {
          bucket = 'DUPLICATE';
          reason = `duplicate story (fingerprint ${fingerprint.slice(0, 12)}...)`;
        } else if (!looksLikeRealTimestamp(eventRow.received_at)) {
          bucket = 'MANUAL_REVIEW';
          reason = `received_at is missing or not a valid ISO-8601 timestamp (${eventRow.received_at ?? 'null'}) — cannot safely compare against the activation boundary, fails closed to manual review`;
        } else if (isPreActivation(eventRow.received_at, boundary)) {
          bucket = 'BASELINE_BEFORE_LIVE';
          reason = `detected ${eventRow.received_at}, before activation boundary ${boundary}`;
        } else {
          // Genuinely AT or AFTER the boundary — real, live-era evidence,
          // never activation baseline. Left unprocessed below so it stays
          // available to the normal video-candidate pipeline.
          bucket = 'POST_BOUNDARY_NOT_HISTORICAL';
          reason = `detected ${eventRow.received_at}, at or after activation boundary ${boundary} — not baseline; left available for normal pipeline consideration`;
        }
      }
    }
    recordClassification(db, { kind: 'marketing_event', itemId: eventRow.event_id, bucket, reason });
    // Only a genuinely resolved bucket is ever marked processed — the
    // video-candidate scheduler (the only real consumer of
    // unprocessedEvents()) must still be able to see and select a real
    // post-boundary event, exactly as if `activate` had never run.
    if (RESOLVED_EVENT_BUCKETS.has(bucket)) {
      markEventProcessed(db, eventRow.event_id, `activation baseline: ${bucket}`);
    }
    events.push({ event_id: eventRow.event_id, event_type: eventRow.event_type, bucket, reason });
  }

  const pending = [];
  for (const row of pendingPublications(db)) {
    let bucket; let reason;
    if (row.channel === 'youtube') {
      bucket = 'PRIVATE_VIDEO_REVIEW';
      reason = 'pending YouTube item — governed by the separate private-video review queue, not text publication';
    } else if (row.risk_class === 'HUMAN_APPROVAL_REQUIRED') {
      bucket = 'SAFE_TO_KEEP_PENDING';
      reason = 'already correctly held for human approval, independent of activation';
    } else {
      const factId = (row.source_evidence || '').split(',')[0].trim();
      const fact = factId ? factsById.get(factId) : undefined;
      if (factId && !factIds.has(factId)) {
        bucket = 'DISCARD_AS_OBSOLETE';
        reason = `source fact ${factId || '(none)'} no longer present in the current registry`;
      } else if (!factId || !fact || !looksLikeRealTimestamp(fact.VERIFIED_AT)) {
        // Same fail-closed direction as the marketing_event branch above:
        // the row's OWN created_at has no bearing on whether it will ever
        // actually be allowed to go LIVE (the runtime gate re-checks the
        // BACKING FACT's VERIFIED_AT, never created_at) — with no usable
        // fact timestamp to compare, this must never be silently filed
        // away as historical.
        bucket = 'MANUAL_REVIEW';
        reason = `cannot determine a valid VERIFIED_AT for backing fact ${factId || '(no source_evidence)'} — fails closed to manual review rather than assuming historical`;
      } else if (isPreActivation(fact.VERIFIED_AT, boundary)) {
        bucket = 'HISTORICAL_PENDING';
        reason = `pre-activation AUTO-approved draft (created ${row.created_at}) — backing fact ${factId} VERIFIED_AT ${fact.VERIFIED_AT} predates PUBLIC_LIVE_NOT_BEFORE ${boundary}`;
      } else {
        // Genuinely AT or AFTER the boundary — the runtime publish gate
        // (isPreActivation() at actual publish time) will correctly
        // re-evaluate this normally; it must never be mislabeled historical
        // here just because the row happens to already exist.
        bucket = 'POST_BOUNDARY_PENDING';
        reason = `backing fact ${factId} VERIFIED_AT ${fact.VERIFIED_AT} is at or after PUBLIC_LIVE_NOT_BEFORE ${boundary} — not historical; the runtime publish gate evaluates this normally`;
      }
    }
    recordClassification(db, { kind: 'pending_publication', itemId: row.publication_id, bucket, reason });
    pending.push({ publication_id: row.publication_id, channel: row.channel, source_evidence: row.source_evidence, bucket, reason });
  }

  return { boundary, created, events, pendingPublications: pending };
}
