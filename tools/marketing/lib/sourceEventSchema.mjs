// Canonical normalized-event schema (mandate section 4) + the deterministic
// fingerprint that makes ingestion naturally idempotent. One schema shared
// by every adapter — adapters never hand repo-specific shapes to the
// scoring engine (mandate section 3: "Do not couple the existing scoring
// engine directly to repo-repo-specific formats").
import { createHash } from 'node:crypto';
import { EVENT_TYPES } from './events.mjs';

// lib/events.mjs's EVENT_TYPES is the single source of truth (it's what
// ingestEvent() actually validates against) — re-exported here under this
// module's own name so callers reading the canonical-schema module don't
// need to know that detail.
export const MARKETING_EVENT_TYPES = EVENT_TYPES;

export const VERIFICATION_STATES = ['VERIFIED', 'PARTIAL', 'UNVERIFIED', 'CLAIMED_ONLY'];
export const PUBLIC_SAFETY_STATES = ['PUBLIC_SAFE', 'NOT_PUBLIC', 'NEEDS_REVIEW'];

/**
 * Stable identity for dedup (mandate section 11): the SAME underlying
 * source record always produces the SAME fingerprint, regardless of when
 * or how many times it's rescanned. Deliberately does NOT include
 * detected_at/occurred_at — two scans of the identical record on different
 * days must fingerprint identically.
 */
export function computeSourceFingerprint({ source_repository, source_kind, source_native_id }) {
  return createHash('sha256')
    .update(JSON.stringify({ source_repository, source_kind, source_native_id }))
    .digest('hex');
}

/**
 * Builds one canonical normalized event from an adapter's raw findings.
 * `event_id` IS the source fingerprint (not a random id) — this lets
 * ingestion reuse lib/events.mjs's existing ingestEvent(dedupeKey) idempotency
 * mechanism directly, rather than inventing a second dedup table: the exact
 * same underlying record can never produce two marketing_events rows,
 * because it's always the same primary key.
 */
export function buildNormalizedEvent(raw) {
  const fingerprint = computeSourceFingerprint(raw);
  const now = new Date().toISOString();
  return {
    event_id: fingerprint,
    source_fingerprint: fingerprint,
    source_product: raw.source_product,
    source_repository: raw.source_repository,
    source_kind: raw.source_kind,
    source_native_id: raw.source_native_id,
    occurred_at: raw.occurred_at ?? null,
    detected_at: raw.detected_at ?? now,

    event_type: raw.event_type,
    title: raw.title ?? null,
    summary: raw.summary ?? null,

    evidence_refs: raw.evidence_refs ?? [],
    evidence_hashes: raw.evidence_hashes ?? [],
    verification_state: raw.verification_state ?? 'UNVERIFIED',
    public_safety_state: raw.public_safety_state ?? 'NEEDS_REVIEW', // fail closed (section 13)

    task_id: raw.task_id ?? null,
    run_id: raw.run_id ?? null,
    release_id: raw.release_id ?? null,
    commit_sha: raw.commit_sha ?? null,

    capabilities: raw.capabilities ?? [],
    story_signals: raw.story_signals ?? [],

    contains_failure: !!raw.contains_failure,
    contains_recovery: !!raw.contains_recovery,
    contains_verifier_result: !!raw.contains_verifier_result,
    contains_checkpoint_resume: !!raw.contains_checkpoint_resume,
    contains_continuity_event: !!raw.contains_continuity_event,
    contains_skill_learning: !!raw.contains_skill_learning,
  };
}
