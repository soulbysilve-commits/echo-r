// The unified channel-adapter contract (multi-channel expansion mandate
// section 2). Every channel adapter (connectors/*.mjs) is expected to
// export a subset of: isAuthConfigured(env), capabilities(), prepare(input),
// validate(input), publish(draft, opts), lookupExisting(input, opts),
// status(env) — not every channel needs every method (e.g. a capability-
// detection-only adapter like hashnode.mjs has no real publish()).
//
// This module defines the CANONICAL publication input/output shapes so
// every adapter maps to/from the same fields, rather than each connector
// inventing its own draft shape from scratch — and the shared idempotency-
// key derivation every connector's lookupExisting()/publish() should use.
import { createHash } from 'node:crypto';

// Canonical publication input fields (spec section 2). Every field is
// optional except the ones a specific channel's prepare()/validate()
// actually requires — this is a shared vocabulary, not a strict schema.
export const PUBLICATION_INPUT_FIELDS = [
  'event_id', 'claim_ids', 'content_id', 'canonical_url', 'title',
  'short_text', 'long_text', 'tags', 'images', 'video_url', 'language', 'created_at',
];

// Canonical publication output fields every publish() result should be
// mappable to (operator.mjs already produces most of these from
// connector.publish()'s existing {ok, externalId, externalUrl, error}
// shape; this documents the full canonical shape publish() callers may add:
// channel, external_id, external_url, publication_state, published_at,
// content_hash, idempotency_key, error).
export const PUBLICATION_OUTPUT_FIELDS = [
  'channel', 'external_id', 'external_url', 'publication_state',
  'published_at', 'content_hash', 'idempotency_key', 'error',
];

/**
 * A durable, deterministic idempotency key for one (channel, content_id ??
 * event_id, canonical text) triple — passed as a real Idempotency-Key header
 * where the platform supports one (Mastodon), and always usable as a second,
 * independent dedup check alongside the publication_ledger's own
 * UNIQUE(channel, content_hash) constraint (mandate: "durable idempotency...
 * never publish twice", checked two ways, not one).
 */
export function idempotencyKey(channel, input) {
  const basis = input.content_id ?? input.event_id ?? `${input.title ?? ''}|${input.short_text ?? input.long_text ?? ''}`;
  return createHash('sha256').update(`${channel}:${basis}`, 'utf8').digest('hex').slice(0, 32);
}

/**
 * True only when every claim in `input` traces to a real, currently-VERIFIED
 * fact ID from the registry (mandate section 17: "never invent benchmarks,
 * users, revenue, adoption, performance, partnerships, customer quotes,
 * capabilities" — enforced structurally by requiring at least one real
 * claim_id/fact id, never by trusting free text). Channel-agnostic; every
 * prepare() should call this before returning a draft.
 */
export function hasTraceableEvidence(input, factIds) {
  const claimIds = input.claim_ids ?? input.factIds ?? [];
  if (!Array.isArray(claimIds) || claimIds.length === 0) return false;
  return claimIds.every((id) => factIds.has(id));
}
