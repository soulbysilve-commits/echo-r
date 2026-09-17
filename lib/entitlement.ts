import { createHash } from "crypto";
import { getObjectStore } from "./storage.ts";

/**
 * Durable entitlement/idempotency/one-time-claim state for the
 * `automatic_download` fulfillment mode, stored as small JSON objects
 * in the same private object storage as the encrypted artifact (see
 * ECHO_AGENT_FULFILLMENT.md §"Entitlement state"). No customer PII
 * beyond what Stripe itself already holds is stored here, and no
 * card/CVC data is ever written anywhere in this codebase.
 */

export type EntitlementStatus = "pending" | "ready" | "failed";

export interface EntitlementRecord {
  schema: "veritasforge.echo-agent.entitlement.v1";
  checkoutSessionId: string;
  priceId: string | null;
  mode: "payment" | "subscription";
  customerId: string | null;
  subscriptionId: string | null;
  status: EntitlementStatus;
  releaseId: string | null;
  checkoutNonceHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionStateRecord {
  schema: "veritasforge.echo-agent.subscription-state.v1";
  subscriptionId: string;
  status: string; // Stripe subscription status, verbatim
  checkoutSessionId: string | null;
  /** ISO-8601 UTC timestamp of the subscription's current paid-through
   * boundary (Stripe subscription item `current_period_end`), or null
   * for records written before this field existed / when it could not
   * be determined. This is the actual boundary
   * lib/activation.ts resolveLeaseEligibility() bounds a license lease
   * against -- see that module for why `status` alone is not used as
   * the sole gate (a payment-retry `past_due` state must not
   * immediately lock out a customer still within an already-paid
   * period). */
  currentPeriodEnd: string | null;
  updatedAt: string;
}

/** Storage-key namespace for this deployment's fulfillment records
 * (entitlements/subscriptions/events/download-claims), separate from
 * the ARTIFACT itself (artifacts/<release-id>/... in lib/release.ts,
 * which IS deliberately shared across environments -- the encrypted
 * release object is one immutable artifact, see
 * docs/release/ECHO_AGENT_LIVE_LAUNCH_AUDIT.md "Fulfillment namespace
 * isolation").
 *
 * Reads ECHO_AGENT_FULFILLMENT_NAMESPACE, an explicit opt-in env var.
 * Unset (the Sandbox/Preview default today, and every existing test)
 * produces the exact same unprefixed keys this module has always
 * used -- a zero-risk default that never touches or reinterprets any
 * record already written by the proven Sandbox flow. Only a
 * deployment that explicitly sets this (Production sets it to
 * "production") gets a distinct, non-colliding key prefix, so a
 * Production entitlement/event/download-claim record can never read,
 * overwrite, or be confused with a Sandbox one (or vice versa) even
 * though both currently share the same private bucket
 * (echo-agent-private-releases) and the same underlying Stripe
 * event/session ID space is already effectively disjoint between test
 * and live mode. Validated by
 * scripts/test-echo-agent-live-launch-safety.mjs. */
function fulfillmentNamespace(): string | null {
  const raw = process.env.ECHO_AGENT_FULFILLMENT_NAMESPACE;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Restrict to a safe, predictable key-path segment -- never let an
  // operator typo turn into a path-traversal-shaped prefix.
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(trimmed)) return null;
  return trimmed;
}

function withNamespace(path: string): string {
  const ns = fulfillmentNamespace();
  return ns ? `fulfillment/${ns}/${path}` : `fulfillment/${path}`;
}

function entitlementKey(checkoutSessionId: string): string {
  return withNamespace(`entitlements/${checkoutSessionId}.json`);
}

function subscriptionKey(subscriptionId: string): string {
  return withNamespace(`subscriptions/${subscriptionId}.json`);
}

function eventKey(eventId: string): string {
  return withNamespace(`events/${eventId}.json`);
}

function downloadClaimKey(jti: string): string {
  const hash = createHash("sha256").update(jti, "utf8").digest("hex");
  return withNamespace(`download-claims/${hash}.json`);
}

// Exported for scripts/test-echo-agent-live-launch-safety.mjs only --
// not used by any request-handling code, which always goes through the
// functions above.
export const __testing = { entitlementKey, subscriptionKey, eventKey, downloadClaimKey, fulfillmentNamespace };

async function readJson<T>(key: string): Promise<T | null> {
  const store = getObjectStore();
  if (!store) return null;
  const head = await store.headObject(key);
  if (!head.exists) return null;
  const buf = await store.getObjectBuffer(key);
  return JSON.parse(buf.toString("utf8")) as T;
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const store = getObjectStore();
  if (!store) throw new Error("storage_not_configured");
  await store.putObject(key, Buffer.from(JSON.stringify(value), "utf8"), "application/json");
}

export async function getEntitlement(checkoutSessionId: string): Promise<EntitlementRecord | null> {
  return readJson<EntitlementRecord>(entitlementKey(checkoutSessionId));
}

/** Read-modify-write upsert. Safe to call repeatedly for the same
 * session (idempotent merge) -- concurrent duplicate webhook delivery
 * for the same event.id is already prevented upstream by
 * recordEventOnce(), so this does not need its own optimistic-lock
 * primitive for v1. */
export async function upsertEntitlement(
  checkoutSessionId: string,
  patch: Partial<Omit<EntitlementRecord, "schema" | "checkoutSessionId" | "createdAt">>,
): Promise<EntitlementRecord> {
  const now = new Date().toISOString();
  const existing = await getEntitlement(checkoutSessionId);
  const record: EntitlementRecord = {
    schema: "veritasforge.echo-agent.entitlement.v1",
    checkoutSessionId,
    priceId: existing?.priceId ?? null,
    mode: existing?.mode ?? "payment",
    customerId: existing?.customerId ?? null,
    subscriptionId: existing?.subscriptionId ?? null,
    status: existing?.status ?? "pending",
    releaseId: existing?.releaseId ?? null,
    checkoutNonceHash: existing?.checkoutNonceHash ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...patch,
  };
  await writeJson(entitlementKey(checkoutSessionId), record);
  return record;
}

export async function getSubscriptionState(subscriptionId: string): Promise<SubscriptionStateRecord | null> {
  return readJson<SubscriptionStateRecord>(subscriptionKey(subscriptionId));
}

export async function upsertSubscriptionState(
  subscriptionId: string,
  status: string,
  checkoutSessionId: string | null,
  currentPeriodEnd: string | null = null,
): Promise<SubscriptionStateRecord> {
  const record: SubscriptionStateRecord = {
    schema: "veritasforge.echo-agent.subscription-state.v1",
    subscriptionId,
    status,
    checkoutSessionId,
    currentPeriodEnd,
    updatedAt: new Date().toISOString(),
  };
  await writeJson(subscriptionKey(subscriptionId), record);
  return record;
}

/** Idempotency guard for Stripe webhook events: creates
 * fulfillment/events/<event-id>.json only if absent (atomic
 * create-if-absent via the storage layer's conditional put). Returns
 * `{ first: true }` the one time this event.id is processed, and
 * `{ first: false }` on every replay -- callers must skip all side
 * effects (entitlement creation, license issuance) when `first` is
 * false. */
export async function recordEventOnce(eventId: string, eventType: string): Promise<{ first: boolean }> {
  const store = getObjectStore();
  if (!store) throw new Error("storage_not_configured");
  const body = Buffer.from(
    JSON.stringify({ eventId, eventType, processedAt: new Date().toISOString() }),
    "utf8",
  );
  const result = await store.putObjectIfAbsent(eventKey(eventId), body, "application/json");
  return { first: result.created };
}

/** One-time download-token consumption: creates
 * fulfillment/download-claims/<sha256(jti)>.json only if absent.
 * `{ claimed: true }` on first (and only) successful consumption;
 * `{ claimed: false }` means this jti was already used (or is being
 * consumed concurrently -- at most one caller ever gets `claimed:
 * true` for a given jti, by the same atomic primitive as
 * recordEventOnce). Callers must respond 410 Gone on `claimed:
 * false`. */
export async function claimDownloadToken(jti: string): Promise<{ claimed: boolean }> {
  const store = getObjectStore();
  if (!store) throw new Error("storage_not_configured");
  const body = Buffer.from(JSON.stringify({ jti, claimedAt: new Date().toISOString() }), "utf8");
  const result = await store.putObjectIfAbsent(downloadClaimKey(jti), body, "application/json");
  return { claimed: result.created };
}
