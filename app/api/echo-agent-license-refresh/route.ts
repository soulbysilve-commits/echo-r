import { NextRequest, NextResponse } from "next/server";
import { getFulfillmentMode } from "../../../lib/stripe";
import { getEntitlement } from "../../../lib/entitlement";
import { getReleaseManifest } from "../../../lib/release";
import { issueLicense, serializeLicense } from "../../../lib/license";
import { verifyRefreshAndIssueLease, checkAndRecordRateLimit, hashForRateLimit } from "../../../lib/activation";

/**
 * ECHO Agent automatic entitlement refresh -- exchanges an opaque,
 * previously-issued refresh credential (never the customer's raw
 * activation code) for a NEW short-lived signed license lease, and
 * ROTATES the credential. Called automatically by the Windows client
 * (echo_agent_online_activation_v1.py) as the current lease
 * approaches expiry; never requires the user to re-type anything.
 *
 * Same trust boundary as app/api/echo-agent-activate/route.ts: reuses
 * the existing Ed25519 issuer unchanged, never returns the private
 * key, fails closed on any credential/entitlement problem.
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

  let body: { installation_id?: unknown; refresh_credential?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "WRONG_INSTALLATION" }, { status: 400 });
  }

  const installationId = typeof body.installation_id === "string" ? body.installation_id.trim() : "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(installationId)) {
    return NextResponse.json({ status: "WRONG_INSTALLATION" }, { status: 400 });
  }

  const ipBucket = `ip:${hashForRateLimit(clientIp(request))}`;
  const ipCheck = await checkAndRecordRateLimit(ipBucket);
  if (!ipCheck.allowed) {
    return NextResponse.json({ status: "RATE_LIMITED" }, { status: 429 });
  }
  const installationBucket = `installation:${hashForRateLimit(installationId)}`;
  const installationCheck = await checkAndRecordRateLimit(installationBucket);
  if (!installationCheck.allowed) {
    return NextResponse.json({ status: "RATE_LIMITED" }, { status: 429 });
  }

  const outcome = await verifyRefreshAndIssueLease({
    installationId,
    refreshCredentialRaw: body.refresh_credential,
  });

  if (!outcome.ok) {
    const statusCode =
      outcome.reason === "STORAGE_NOT_CONFIGURED" || outcome.reason === "SIGNING_NOT_CONFIGURED"
        ? 503
        : outcome.reason === "NOT_ENTITLED"
          ? 403
          : 401;
    return NextResponse.json({ status: outcome.reason }, { status: statusCode });
  }

  const entitlement = await getEntitlement(outcome.entitlementId);
  if (!entitlement || !entitlement.releaseId) {
    console.error("echo-agent-license-refresh: entitlement missing release id:", outcome.entitlementId);
    return NextResponse.json({ status: "NOT_ENTITLED" }, { status: 403 });
  }
  const manifest = await getReleaseManifest(entitlement.releaseId).catch(() => null);
  if (!manifest) {
    console.error("echo-agent-license-refresh: release manifest not found:", entitlement.releaseId);
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
    console.error("echo-agent-license-refresh: license signing not configured:", error);
    return NextResponse.json({ status: "SIGNING_NOT_CONFIGURED" }, { status: 503 });
  }

  return NextResponse.json({
    status: "refreshed",
    license: JSON.parse(serializeLicense(licenseEnvelope).toString("utf8")),
    refresh_credential: outcome.refreshCredential,
    valid_until: outcome.validUntil.toISOString(),
    paid_through: outcome.paidThrough,
  });
}
