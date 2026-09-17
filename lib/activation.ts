import { randomBytes, createHash } from "crypto";
import { getObjectStore } from "./storage.ts";
import { getEntitlement, getSubscriptionState, type EntitlementRecord } from "./entitlement.ts";
import { constantTimeEqualHex } from "./artifactCrypto.ts";

/**
 * ECHO Agent online activation: email + high-entropy activation code
 * -> short-lived signed license lease + opaque refresh credential.
 *
 * Reuses the existing entitlement/subscription/object-storage
 * architecture (lib/entitlement.ts, lib/storage.ts) rather than a
 * second database. Reuses the existing Ed25519 license issuer
 * (lib/license.ts issueLicense()) unchanged -- this module only ever
 * decides WHAT valid_until to pass it, never how a license is signed
 * or verified. No new verifier, no new trust root.
 *
 * Email address alone is never sufficient authentication -- every
 * activation requires BOTH the normalized email AND the matching
 * high-entropy activation code, compared as salted-nothing SHA-256
 * hashes in constant time (constantTimeEqualHex, already used for the
 * checkout-nonce check elsewhere in this codebase).
 */

const SCHEMA_ACTIVATION = "veritasforge.echo-agent.activation.v1" as const;
const SCHEMA_REFRESH = "veritasforge.echo-agent.refresh-credential.v1" as const;

export interface ActivationCodeRecord {
  schema: typeof SCHEMA_ACTIVATION;
  activationId: string;
  entitlementId: string;
  product: "echo-agent";
  emailNormalized: string;
  activationCodeHash: string; // sha256 hex of the normalized code
  createdAt: string;
  revokedAt: string | null;
  lastActivatedAt: string | null;
  activationCount: number;
}

export interface RefreshCredentialRecord {
  schema: typeof SCHEMA_REFRESH;
  entitlementId: string;
  installationId: string;
  refreshCredentialHash: string; // sha256 hex
  createdAt: string;
  rotatedAt: string;
  revokedAt: string | null;
}

// --- Email normalization ------------------------------------------

/** Conservative normalization only: trim + lowercase. Does NOT strip
 * Gmail dots or plus-addressing -- no existing account/billing logic
 * in this repo does provider-specific canonicalization, and inventing
 * one here risks an email that IS the customer's real inbox address
 * failing to match what Stripe recorded at checkout. Returns null
 * (not throw) for anything that isn't a plausible email shape. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 320) return null;
  const lower = trimmed.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) return null;
  return lower;
}

/** Strips everything but the base32 alphabet and uppercases -- so a
 * customer typing "xxxx xxxx xxxx" or "xxxx-xxxx-xxxx" or pasting with
 * stray whitespace still compares correctly. Never throws. */
export function normalizeActivationCodeInput(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
}

// --- Activation code generation (high entropy) ---------------------

// Crockford base32: unambiguous alphabet (no 0/O, 1/I/L confusion).
const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function toBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** 15 cryptographically random bytes (120 bits of entropy) -- vastly
 * more than a 6-digit code and not derived from any predictable
 * sequence (Stripe IDs, license numbers, email). Formatted in groups
 * of 4 for human readability only; the entropy is what actually
 * resists guessing, not the formatting. Rate limiting
 * (checkAndRecordRateLimit below) is defense-in-depth on top of this,
 * not the primary guarantee. */
export function generateActivationCode(): string {
  const raw = randomBytes(15);
  const encoded = toBase32(raw); // 24 base32 chars from 120 bits
  const groups = encoded.match(/.{1,4}/g) ?? [encoded];
  return groups.join("-");
}

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function emailStorageKey(emailNormalized: string): string {
  return sha256Hex(emailNormalized);
}

function activationRecordKey(emailNormalized: string): string {
  return `fulfillment/activations/${emailStorageKey(emailNormalized)}.json`;
}

function refreshRecordKey(installationId: string): string {
  return `fulfillment/refresh-credentials/${installationId}.json`;
}

function activationCodeDisplayKey(checkoutSessionId: string): string {
  return `fulfillment/activation-code-display/${sha256Hex(checkoutSessionId)}.json`;
}

// Exported for scripts/test-echo-agent-activation.mjs only.
export const __testing = { activationRecordKey, refreshRecordKey, emailStorageKey, toBase32 };

async function readJson<T>(key: string): Promise<T | null> {
  const store = getObjectStore();
  if (!store) return null;
  const head = await store.headObject(key);
  if (!head.exists) return null;
  const buf = await store.getObjectBuffer(key);
  return JSON.parse(buf.toString("utf8")) as T;
}

/**
 * Issues (or replaces) the activation credential for an entitlement.
 * Keyed by normalized email, one active credential per email -- if
 * the same email purchases again, the newer credential replaces the
 * older one (the older activation code stops working). This is a
 * deliberate, documented v1 simplification: this product sells one
 * subscription per customer, not multiple concurrent entitlements
 * under the same email.
 *
 * Returns the RAW activation code exactly once, at issuance time --
 * only its SHA-256 hash is ever persisted. Callers must surface this
 * value to the customer immediately (success page) and never log it.
 */
export async function issueActivationCredential(input: {
  entitlementId: string;
  emailNormalized: string;
}): Promise<{ activationCode: string; record: ActivationCodeRecord }> {
  const store = getObjectStore();
  if (!store) throw new Error("storage_not_configured");

  const activationCode = generateActivationCode();
  const record: ActivationCodeRecord = {
    schema: SCHEMA_ACTIVATION,
    activationId: `act_${randomBytes(12).toString("hex")}`,
    entitlementId: input.entitlementId,
    product: "echo-agent",
    emailNormalized: input.emailNormalized,
    // Hash the NORMALIZED form (matches normalizeActivationCodeInput()
    // used at verification time) -- generateActivationCode() itself
    // always returns dash-grouped uppercase, but hashing the
    // normalized form keeps issuance and verification symmetric
    // regardless of how the code is formatted/typed later.
    activationCodeHash: sha256Hex(normalizeActivationCodeInput(activationCode)),
    createdAt: new Date().toISOString(),
    revokedAt: null,
    lastActivatedAt: null,
    activationCount: 0,
  };
  await store.putObject(
    activationRecordKey(input.emailNormalized),
    Buffer.from(JSON.stringify(record), "utf8"),
    "application/json"
  );

  // Raw code, briefly retained ONLY so the customer's own
  // nonce-cookie-bound success page (app/api/echo-agent-activation-code/route.ts,
  // the exact same browser-binding check as the download-token route)
  // can display it once after purchase -- no email delivery system
  // exists in this repo (see docs/PAYMENT_OPERATIONS.md), so this is
  // the "surfaced through the existing post-purchase fulfillment UI"
  // path the product spec asks for. This is the ONLY place the raw
  // code is ever persisted outside the customer's own browser
  // response; every other record (ActivationCodeRecord above) stores
  // only its SHA-256 hash. No TTL/cleanup job exists yet for this key
  // in v1 -- same accepted gap as the rest of this fulfillment system
  // having no admin-reissue tooling (see ECHO_AGENT_FULFILLMENT.md
  // "Admin reissue"), flagged here rather than silently assumed away.
  await store.putObject(
    activationCodeDisplayKey(input.entitlementId),
    Buffer.from(JSON.stringify({ activationCode, createdAt: record.createdAt }), "utf8"),
    "application/json"
  );

  return { activationCode, record };
}

export async function getActivationCodeForDisplay(checkoutSessionId: string): Promise<{ activationCode: string; createdAt: string } | null> {
  return readJson<{ activationCode: string; createdAt: string }>(activationCodeDisplayKey(checkoutSessionId));
}

export async function getActivationRecordByEmail(emailNormalized: string): Promise<ActivationCodeRecord | null> {
  return readJson<ActivationCodeRecord>(activationRecordKey(emailNormalized));
}

async function markActivated(record: ActivationCodeRecord): Promise<void> {
  const store = getObjectStore();
  if (!store) throw new Error("storage_not_configured");
  const updated: ActivationCodeRecord = {
    ...record,
    lastActivatedAt: new Date().toISOString(),
    activationCount: record.activationCount + 1,
  };
  await store.putObject(
    activationRecordKey(record.emailNormalized),
    Buffer.from(JSON.stringify(updated), "utf8"),
    "application/json"
  );
}

// --- Lease eligibility / horizon -----------------------------------

// Short lease -- refreshed automatically well before expiry (see
// echo_agent_online_activation_v1.py in the ECHODiscord版 repo). Never
// an indefinitely-valid subscription license.
const SUBSCRIPTION_LEASE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
// One-time-purchase entitlements have no recurring paid-through
// boundary to bound against; this matches the pre-existing one-year
// grant already used by app/api/echo-agent-download-token/route.ts
// (unchanged for that flow) and is refreshed the same way as a
// subscription lease, so a genuinely revoked one-time entitlement
// (e.g. a refund, handled by an operator out of band) still stops
// gaining new leases going forward even though it isn't bounded by a
// Stripe billing period.
const ONE_TIME_LEASE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

export type LeaseEligibility =
  | { eligible: true; paidThrough: string | null }
  | { eligible: false; paidThrough: string | null };

/** Derives whether a NEW lease may be issued right now, and the
 * paid-through boundary (if any) that bounds its valid_until.
 * Deliberately does not gate on Stripe's raw subscription `status`
 * string alone -- a recurring-payment retry (invoice.payment_failed)
 * can leave `status` at "past_due" for days while the customer is
 * still within a period they already paid for; gating strictly on
 * status would lock them out immediately, which the product spec
 * explicitly says not to do. The real boundary is the paid-through
 * timestamp itself (Stripe subscription item `current_period_end`,
 * captured by the webhook into SubscriptionStateRecord.currentPeriodEnd):
 * eligible as long as `now <= currentPeriodEnd`, regardless of the
 * exact status label, and never eligible for a lease that would
 * extend past it. */
export async function resolveLeaseEligibility(entitlement: EntitlementRecord): Promise<LeaseEligibility> {
  if (entitlement.mode !== "subscription") {
    return { eligible: entitlement.status === "ready", paidThrough: null };
  }
  if (!entitlement.subscriptionId) return { eligible: false, paidThrough: null };

  const subState = await getSubscriptionState(entitlement.subscriptionId);
  if (!subState) {
    // No subscription-state record yet (webhook race, or a record
    // predating this field) -- fall back to the entitlement's own
    // last-known status, matching the existing download-token route's
    // pre-lease behavior exactly.
    return { eligible: entitlement.status === "ready", paidThrough: null };
  }

  if (subState.currentPeriodEnd) {
    const periodEndMs = new Date(subState.currentPeriodEnd).getTime();
    if (Number.isFinite(periodEndMs)) {
      return { eligible: Date.now() <= periodEndMs, paidThrough: subState.currentPeriodEnd };
    }
  }

  // No usable paid-through timestamp captured -- fall back to the
  // status-based healthy check already used elsewhere in this
  // integration (download-token route).
  const healthy = subState.status === "active" || subState.status === "trialing";
  return { eligible: healthy, paidThrough: null };
}

export function computeLeaseValidUntil(mode: "payment" | "subscription", paidThrough: string | null): Date {
  const horizonMs = mode === "subscription" ? SUBSCRIPTION_LEASE_HORIZON_MS : ONE_TIME_LEASE_HORIZON_MS;
  const horizon = new Date(Date.now() + horizonMs);
  if (!paidThrough) return horizon;
  const paidThroughDate = new Date(paidThrough);
  if (!Number.isFinite(paidThroughDate.getTime())) return horizon;
  return paidThroughDate.getTime() < horizon.getTime() ? paidThroughDate : horizon;
}

// --- Refresh credentials --------------------------------------------

function generateRefreshCredential(): string {
  return randomBytes(32).toString("base64url");
}

async function storeRefreshCredential(
  entitlementId: string,
  installationId: string,
  credential: string,
  createdAt?: string
): Promise<void> {
  const store = getObjectStore();
  if (!store) throw new Error("storage_not_configured");
  const now = new Date().toISOString();
  const record: RefreshCredentialRecord = {
    schema: SCHEMA_REFRESH,
    entitlementId,
    installationId,
    refreshCredentialHash: sha256Hex(credential),
    createdAt: createdAt ?? now,
    rotatedAt: now,
    revokedAt: null,
  };
  await store.putObject(refreshRecordKey(installationId), Buffer.from(JSON.stringify(record), "utf8"), "application/json");
}

export async function getRefreshCredentialRecord(installationId: string): Promise<RefreshCredentialRecord | null> {
  return readJson<RefreshCredentialRecord>(refreshRecordKey(installationId));
}

// --- Rate limiting (best-effort, durable) ---------------------------

// Fixed-window counter using the same object-storage primitives as
// the rest of this integration. Documented limitation: this is a
// read-modify-write increment, not an atomic counter (S3-compatible
// storage has no atomic increment primitive) -- a burst of truly
// concurrent requests within the same window could each read the same
// count before any write lands, so this is defense-in-depth alongside
// the activation code's own 120 bits of entropy and the generic
// anti-enumeration failure response, never the sole brute-force
// defense. Same accepted-risk class as lib/entitlement.ts
// upsertEntitlement's own read-modify-write upsert.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 8;

function rateLimitKey(bucketId: string, windowStartMs: number): string {
  return `fulfillment/activation-rate-limit/${bucketId}/${windowStartMs}.json`;
}

/** `bucketId` must already be a safe, non-secret identifier -- callers
 * pass a SHA-256 hash of the IP/email, never the raw value, so no raw
 * secret ever appears in a storage key or (if this were ever logged)
 * a log line. */
export async function checkAndRecordRateLimit(bucketId: string): Promise<{ allowed: boolean }> {
  const store = getObjectStore();
  if (!store) return { allowed: true };

  const windowStart = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
  const key = rateLimitKey(bucketId, windowStart);

  const created = await store.putObjectIfAbsent(key, Buffer.from(JSON.stringify({ count: 1 }), "utf8"), "application/json");
  if (created.created) return { allowed: true };

  const buf = await store.getObjectBuffer(key).catch(() => null);
  const current = buf ? (JSON.parse(buf.toString("utf8")) as { count?: number }) : { count: 0 };
  const nextCount = (current.count ?? 0) + 1;
  await store.putObject(key, Buffer.from(JSON.stringify({ count: nextCount }), "utf8"), "application/json");
  return { allowed: nextCount <= RATE_LIMIT_MAX_ATTEMPTS };
}

export function hashForRateLimit(value: string): string {
  return sha256Hex(value);
}

// --- Activation / refresh orchestration -----------------------------

export type ActivationFailureReason =
  | "INVALID_ACTIVATION" // generic: bad email shape, unknown email, wrong code, revoked -- anti-enumeration
  | "NOT_ENTITLED" // valid credential, but no currently-eligible entitlement
  | "RATE_LIMITED"
  | "SIGNING_NOT_CONFIGURED"
  | "STORAGE_NOT_CONFIGURED";

export interface ActivationSuccess {
  ok: true;
  entitlementId: string;
  paidThrough: string | null;
  validUntil: Date;
  refreshCredential: string;
}
export interface ActivationFailure {
  ok: false;
  reason: ActivationFailureReason;
}
export type ActivationOutcome = ActivationSuccess | ActivationFailure;

/**
 * Validates email+code, resolves lease eligibility, and (on success)
 * mints/rotates the refresh credential for this installation_id.
 * Does NOT itself call issueLicense() -- the route handler does that,
 * since license issuance is entitlement/release-id specific and
 * already lives in lib/license.ts; this function's job stops at
 * "is this activation valid, and what valid_until should the license
 * use."
 *
 * Always compares a constant-time hash even when the email is
 * unknown (against a fixed dummy hash) so "email not found" and
 * "email found, code wrong" take the same code path and, as closely
 * as this can arrange in JS, similar time -- the explicit
 * anti-enumeration requirement.
 */
export async function verifyActivationAndIssueLease(input: {
  emailRaw: unknown;
  codeRaw: unknown;
  installationId: string;
}): Promise<ActivationOutcome> {
  const store = getObjectStore();
  if (!store) return { ok: false, reason: "STORAGE_NOT_CONFIGURED" };

  const emailNormalized = normalizeEmail(input.emailRaw);
  const codeNormalized = normalizeActivationCodeInput(input.codeRaw);

  if (!emailNormalized || !codeNormalized) {
    return { ok: false, reason: "INVALID_ACTIVATION" };
  }

  const record = await getActivationRecordByEmail(emailNormalized);
  const candidateHash = sha256Hex(codeNormalized);
  // Fixed dummy hash of the same length/shape as a real sha256 hex
  // digest, used only so the constant-time compare always executes
  // even when no record exists for this email.
  const dummyHash = sha256Hex("dummy-activation-code-for-constant-time-comparison-only");
  const targetHash = record?.activationCodeHash ?? dummyHash;
  const matches = constantTimeEqualHex(candidateHash, targetHash);

  if (!record || record.revokedAt || !matches) {
    return { ok: false, reason: "INVALID_ACTIVATION" };
  }

  const entitlement = await getEntitlement(record.entitlementId);
  if (!entitlement) {
    return { ok: false, reason: "NOT_ENTITLED" };
  }

  const eligibility = await resolveLeaseEligibility(entitlement);
  if (!eligibility.eligible) {
    return { ok: false, reason: "NOT_ENTITLED" };
  }

  const validUntil = computeLeaseValidUntil(entitlement.mode, eligibility.paidThrough);
  const refreshCredential = generateRefreshCredential();
  await storeRefreshCredential(record.entitlementId, input.installationId, refreshCredential);
  await markActivated(record);

  return {
    ok: true,
    entitlementId: record.entitlementId,
    paidThrough: eligibility.paidThrough,
    validUntil,
    refreshCredential,
  };
}

export type RefreshFailureReason = "REVOKED" | "WRONG_INSTALLATION" | "NOT_ENTITLED" | "RATE_LIMITED" | "SIGNING_NOT_CONFIGURED" | "STORAGE_NOT_CONFIGURED";
export interface RefreshSuccess {
  ok: true;
  entitlementId: string;
  paidThrough: string | null;
  validUntil: Date;
  refreshCredential: string;
}
export interface RefreshFailure {
  ok: false;
  reason: RefreshFailureReason;
}
export type RefreshOutcome = RefreshSuccess | RefreshFailure;

/**
 * Validates an opaque refresh credential for a given installation_id
 * and, on success, issues a new lease and ROTATES the credential
 * (old value stops working the moment the new one is stored -- there
 * is only ever one live credential per installation_id, so a stolen
 * old credential that gets used after the legitimate client already
 * refreshed is rejected as REVOKED on its next use).
 */
export async function verifyRefreshAndIssueLease(input: {
  installationId: string;
  refreshCredentialRaw: unknown;
}): Promise<RefreshOutcome> {
  const store = getObjectStore();
  if (!store) return { ok: false, reason: "STORAGE_NOT_CONFIGURED" };

  if (typeof input.refreshCredentialRaw !== "string" || !input.refreshCredentialRaw) {
    return { ok: false, reason: "WRONG_INSTALLATION" };
  }

  const record = await getRefreshCredentialRecord(input.installationId);
  const dummyHash = sha256Hex("dummy-refresh-credential-for-constant-time-comparison-only");
  const candidateHash = sha256Hex(input.refreshCredentialRaw);
  const targetHash = record?.refreshCredentialHash ?? dummyHash;
  const matches = constantTimeEqualHex(candidateHash, targetHash);

  if (!record || !matches) {
    return { ok: false, reason: "WRONG_INSTALLATION" };
  }
  if (record.revokedAt) {
    return { ok: false, reason: "REVOKED" };
  }

  const entitlement = await getEntitlement(record.entitlementId);
  if (!entitlement) {
    return { ok: false, reason: "NOT_ENTITLED" };
  }
  const eligibility = await resolveLeaseEligibility(entitlement);
  if (!eligibility.eligible) {
    return { ok: false, reason: "NOT_ENTITLED" };
  }

  const validUntil = computeLeaseValidUntil(entitlement.mode, eligibility.paidThrough);
  const newCredential = generateRefreshCredential();
  await storeRefreshCredential(record.entitlementId, input.installationId, newCredential, record.createdAt);

  return {
    ok: true,
    entitlementId: record.entitlementId,
    paidThrough: eligibility.paidThrough,
    validUntil,
    refreshCredential: newCredential,
  };
}
