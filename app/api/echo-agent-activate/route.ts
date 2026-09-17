import { NextRequest, NextResponse } from "next/server";
import { getFulfillmentMode } from "../../../lib/stripe";
import { getEntitlement } from "../../../lib/entitlement";
import { getReleaseManifest } from "../../../lib/release";
import { issueLicense, serializeLicense } from "../../../lib/license";
import { verifyActivationAndIssueLease, checkAndRecordRateLimit, hashForRateLimit, normalizeEmail } from "../../../lib/activation";

/**
 * ECHO Agent online activation: the Windows client's PRIMARY activation
 * path (email + activation code), replacing manual license-file import
 * as the default customer experience. See docs/ECHO_AGENT_ONLINE_ACTIVATION.md.
 *
 * Reuses the existing Ed25519 license issuer (lib/license.ts,
 * unchanged) -- this route only decides the valid_until bound
 * (lib/activation.ts computeLeaseValidUntil) and packages a refresh
 * credential alongside it. No second verifier, no new trust root; the
 * production PRIVATE signing key never leaves this server process
 * (same ECHO_AGENT_LICENSE_PRIVATE_KEY env var already used by the
 * existing download-token route).
 *
 * Fails closed and generically on any credential mismatch (email
 * normalization failure, email not found, wrong code, revoked code)
 * -- returns the SAME "INVALID_ACTIVATION" body in every case, so a
 * caller can never learn from this endpoint's response alone whether
 * a given email has ever purchased ECHO Agent.
 */

export const runtime = "nodejs";

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

export async function POST(request: NextRequest) {
  if (getFulfillmentMode() !== "automatic_download") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  let body: { email?: unknown; activation_code?: unknown; installation_id?: unknown; client_version?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "INVALID_ACTIVATION" }, { status: 400 });
  }

  const installationId = typeof body.installation_id === "string" ? body.installation_id.trim() : "";
  // Random UUIDv4-shaped, client-generated (echo_agent_online_activation_v1.py
  // installation_id_v1.json) -- never hardware-derived. Loosely
  // validated here (bounded length, safe charset) since it is only
  // ever used as a non-secret storage-key segment, never trusted as
  // an identity/authorization claim on its own.
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(installationId)) {
    return NextResponse.json({ status: "INVALID_ACTIVATION" }, { status: 400 });
  }

  // Rate limiting: both the requesting IP and the (hashed) email must
  // independently be under the window limit. Neither raw value is
  // ever used as a storage key or logged -- only its SHA-256 hash.
  const ipBucket = `ip:${hashForRateLimit(clientIp(request))}`;
  const ipCheck = await checkAndRecordRateLimit(ipBucket);
  if (!ipCheck.allowed) {
    return NextResponse.json({ status: "RATE_LIMITED" }, { status: 429 });
  }
  const emailNormalized = normalizeEmail(body.email);
  if (emailNormalized) {
    const emailCheck = await checkAndRecordRateLimit(`email:${hashForRateLimit(emailNormalized)}`);
    if (!emailCheck.allowed) {
      return NextResponse.json({ status: "RATE_LIMITED" }, { status: 429 });
    }
  }

  const outcome = await verifyActivationAndIssueLease({
    emailRaw: body.email,
    codeRaw: body.activation_code,
    installationId,
  });

  if (!outcome.ok) {
    const statusCode =
      outcome.reason === "STORAGE_NOT_CONFIGURED" || outcome.reason === "SIGNING_NOT_CONFIGURED" ? 503 : outcome.reason === "NOT_ENTITLED" ? 403 : 401;
    return NextResponse.json({ status: outcome.reason }, { status: statusCode });
  }

  const entitlement = await getEntitlement(outcome.entitlementId);
  if (!entitlement || !entitlement.releaseId) {
    console.error("echo-agent-activate: entitlement missing release id after successful credential check:", outcome.entitlementId);
    return NextResponse.json({ status: "NOT_ENTITLED" }, { status: 403 });
  }
  const manifest = await getReleaseManifest(entitlement.releaseId).catch(() => null);
  if (!manifest) {
    console.error("echo-agent-activate: release manifest not found:", entitlement.releaseId);
    return NextResponse.json({ status: "STORAGE_NOT_CONFIGURED" }, { status: 503 });
  }

  let licenseEnvelope;
  try {
    licenseEnvelope = issueLicense({
      entitlementId: outcome.entitlementId,
      releaseId: entitlement.releaseId,
      stripeCheckoutSessionId: outcome.entitlementId,
      stripeSubscriptionId: entitlement.subscriptionId,
      validUntil: outcome.validUntil,
    });
  } catch (error) {
    console.error("echo-agent-activate: license signing not configured:", error);
    return NextResponse.json({ status: "SIGNING_NOT_CONFIGURED" }, { status: 503 });
  }

  return NextResponse.json({
    status: "activated",
    license: JSON.parse(serializeLicense(licenseEnvelope).toString("utf8")),
    refresh_credential: outcome.refreshCredential,
    valid_until: outcome.validUntil.toISOString(),
    paid_through: outcome.paidThrough,
  });
}
