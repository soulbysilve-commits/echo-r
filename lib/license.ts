import { createPrivateKey, randomBytes, sign as cryptoSign } from "crypto";

/**
 * Issues signed ECHO Agent licenses (Ed25519). See
 * echo_agent_license_v1.py in the ECHODiscord版 repo for the verifying
 * side -- the two must stay byte-for-byte compatible on canonical
 * JSON encoding, since Ed25519 signatures are over the exact payload
 * bytes.
 *
 * ECHO_AGENT_LICENSE_PRIVATE_KEY (PKCS8 DER, base64) lives only in
 * this server-side environment. It is never sent to the client, never
 * written into the artifact, never logged. Only the corresponding
 * public key (raw 32 bytes, base64) is embedded in the ECHO Agent
 * binary for verification.
 */

const SCHEMA = "veritasforge.echo-agent.license.v1";
const PRODUCT = "echo-agent";
const LICENSE_VERSION = 1;

export interface LicensePayload {
  schema: string;
  license_id: string;
  entitlement_id: string;
  product: string;
  release_id: string;
  stripe_checkout_session_id: string | null;
  stripe_subscription_id: string | null;
  issued_at: string;
  valid_until: string;
  license_version: number;
}

export interface LicenseEnvelope {
  payload: LicensePayload;
  signature: string; // base64
}

/** Recursive, key-sorted, whitespace-free JSON serialization. Must
 * match echo_agent_license_v1._canonical_json_bytes() in the agent
 * repo exactly. All license payload fields are ASCII-only by
 * construction (ids, ISO-8601 UTC timestamps with a "Z" suffix,
 * integers), so this never needs to consider non-ASCII escaping
 * differences between JS and Python JSON encoders. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/** Reads ECHO_AGENT_LICENSE_PRIVATE_KEY and reconstructs the Ed25519
 * private key object. Returns null (not throw) if unset/malformed. */
function getLicensePrivateKey() {
  const raw = process.env.ECHO_AGENT_LICENSE_PRIVATE_KEY;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const der = Buffer.from(raw.trim(), "base64");
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    return null;
  }
}

export function isLicenseSigningConfigured(): boolean {
  return getLicensePrivateKey() !== null;
}

export interface IssueLicenseInput {
  entitlementId: string;
  releaseId: string;
  stripeCheckoutSessionId: string | null;
  stripeSubscriptionId: string | null;
  validUntil: Date;
}

/** Signs a new license. Throws if ECHO_AGENT_LICENSE_PRIVATE_KEY is
 * not configured -- callers (download-token route) must catch this
 * and fail closed (503), never issue an unsigned/placeholder
 * license. */
export function issueLicense(input: IssueLicenseInput): LicenseEnvelope {
  const privateKey = getLicensePrivateKey();
  if (!privateKey) {
    throw new Error("license_signing_not_configured");
  }

  const payload: LicensePayload = {
    schema: SCHEMA,
    license_id: `lic_${randomBytes(16).toString("hex")}`,
    entitlement_id: input.entitlementId,
    product: PRODUCT,
    release_id: input.releaseId,
    stripe_checkout_session_id: input.stripeCheckoutSessionId,
    stripe_subscription_id: input.stripeSubscriptionId,
    issued_at: new Date().toISOString(),
    valid_until: input.validUntil.toISOString(),
    license_version: LICENSE_VERSION,
  };

  const data = Buffer.from(canonicalJson(payload), "utf8");
  // Ed25519: algorithm argument to crypto.sign must be null.
  const signature = cryptoSign(null, data, privateKey);

  return { payload, signature: signature.toString("base64") };
}

export function serializeLicense(envelope: LicenseEnvelope): Buffer {
  return Buffer.from(JSON.stringify(envelope), "utf8");
}
