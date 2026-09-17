import { NextRequest, NextResponse } from "next/server";
import { getStripeClient, isStripeConfigured, getFulfillmentMode, getEchoAgentPriceId } from "../../../lib/stripe";
import { getEntitlement, getSubscriptionState } from "../../../lib/entitlement";
import { getReleaseManifest } from "../../../lib/release";
import { issueLicense, serializeLicense } from "../../../lib/license";
import { issueDownloadToken, DOWNLOAD_SESSION_COOKIE } from "../../../lib/downloadToken";
import { verifyCheckoutNonceCookie } from "../../../lib/checkoutNonce";

/**
 * Issues a one-time, short-lived download authorization for the ECHO
 * Agent encrypted artifact, plus the buyer's signed license.
 *
 * This is the single highest-stakes checkpoint in the whole
 * automatic_download flow -- everything upstream (webhook-written
 * entitlement state) is treated as "probably fine," and everything
 * here is re-verified directly against Stripe and the browser-binding
 * cookie before anything is handed out. See ECHO_AGENT_FULFILLMENT.md
 * and ECHO_AGENT_LICENSE.md.
 *
 * Deliberately does NOT stream the artifact itself -- that happens
 * only via app/api/echo-agent-download, gated on the token minted
 * here and consumed exactly once (lib/entitlement.ts
 * claimDownloadToken).
 */

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (getFulfillmentMode() !== "automatic_download") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }
  const stripe = getStripeClient();
  if (!stripe) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const echoAgentPriceId = getEchoAgentPriceId();
  if (!echoAgentPriceId) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  let sessionId: string;
  try {
    const body = await request.json();
    sessionId = typeof body?.session_id === "string" ? body.session_id : "";
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return NextResponse.json({ error: "invalid session_id" }, { status: 400 });
  }

  // 1. Re-fetch the session directly from Stripe -- never trust
  // anything the browser sent beyond the session_id itself.
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (error) {
    console.error("download-token: session lookup failed:", sessionId, error);
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (session.metadata?.product !== "echo-agent") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // 2. Price validation: re-derive from the session's own line items,
  // never assume the metadata gate above is sufficient on its own.
  try {
    const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 10 });
    const matchesPrice = lineItems.data.some((item) => item.price?.id === echoAgentPriceId);
    if (!matchesPrice) {
      console.error("download-token: session line items do not match configured price:", sessionId);
      return NextResponse.json({ error: "denied" }, { status: 403 });
    }
  } catch (error) {
    console.error("download-token: line item lookup failed:", sessionId, error);
    return NextResponse.json({ error: "lookup failed" }, { status: 502 });
  }

  // 3. Payment/subscription state, re-verified live (mirrors
  // app/api/echo-agent-order-status/route.ts's own logic exactly).
  const paidPaymentStatus =
    session.payment_status === "paid" || session.payment_status === "no_payment_required";
  let subscriptionStatus: string | null = null;
  if (typeof session.subscription === "string") {
    try {
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      subscriptionStatus = subscription.status;
    } catch (error) {
      console.error("download-token: subscription lookup failed:", session.subscription, error);
      return NextResponse.json({ error: "lookup failed" }, { status: 502 });
    }
  }
  const subscriptionHealthy =
    subscriptionStatus === null || subscriptionStatus === "active" || subscriptionStatus === "trialing";
  if (!paidPaymentStatus || !subscriptionHealthy) {
    return NextResponse.json({ error: "not paid" }, { status: 403 });
  }

  // 4. Browser-binding nonce: constant-time-compare the cookie against
  // the hash stored in session metadata at checkout time. Missing
  // cookie or mismatch denies the request outright -- session_id
  // visible in the success URL is never sufficient on its own.
  if (!verifyCheckoutNonceCookie(request, session.metadata?.checkout_nonce_hash)) {
    console.error("download-token: missing/mismatched checkout nonce cookie:", sessionId);
    return NextResponse.json({ error: "denied" }, { status: 403 });
  }

  // 5. Entitlement: must exist and be "ready" (written by the webhook
  // after its own independent verification).
  let entitlement;
  try {
    entitlement = await getEntitlement(sessionId);
  } catch (error) {
    console.error("download-token: entitlement lookup failed:", sessionId, error);
    return NextResponse.json({ error: "fulfillment storage not available" }, { status: 503 });
  }
  if (!entitlement || entitlement.status !== "ready") {
    return NextResponse.json({ error: "not ready" }, { status: 409 });
  }

  // 6. Subscription entitlement re-check against our own durable
  // record too (belt-and-suspenders alongside step 3's live Stripe
  // check) -- a canceled/deleted subscription must never authorize a
  // new download token even if Stripe's live object briefly still
  // reports a stale-looking status.
  if (entitlement.mode === "subscription" && entitlement.subscriptionId) {
    const subState = await getSubscriptionState(entitlement.subscriptionId).catch(() => null);
    if (subState && subState.status !== "active" && subState.status !== "trialing") {
      return NextResponse.json({ error: "subscription not active" }, { status: 403 });
    }
  }

  // 7. Release must exist.
  if (!entitlement.releaseId) {
    console.error("download-token: entitlement has no release configured:", sessionId);
    return NextResponse.json({ error: "release not configured" }, { status: 503 });
  }
  const manifest = await getReleaseManifest(entitlement.releaseId).catch(() => null);
  if (!manifest) {
    console.error("download-token: release manifest not found:", entitlement.releaseId);
    return NextResponse.json({ error: "release not available" }, { status: 503 });
  }

  // All checks passed -- issue the license and the download token.
  const validUntil = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  let licenseEnvelope;
  try {
    licenseEnvelope = issueLicense({
      entitlementId: sessionId,
      releaseId: entitlement.releaseId,
      stripeCheckoutSessionId: sessionId,
      stripeSubscriptionId: entitlement.subscriptionId,
      validUntil,
    });
  } catch (error) {
    console.error("download-token: license signing not configured:", error);
    return NextResponse.json({ error: "license signing not configured" }, { status: 503 });
  }

  let tokenResult;
  try {
    tokenResult = issueDownloadToken({
      sessionId,
      entitlementId: sessionId,
      releaseId: entitlement.releaseId,
    });
  } catch (error) {
    console.error("download-token: token signing not configured:", error);
    return NextResponse.json({ error: "download token signing not configured" }, { status: 503 });
  }

  const response = NextResponse.json({
    expiresAt: tokenResult.payload.expiresAt,
    license: JSON.parse(serializeLicense(licenseEnvelope).toString("utf8")),
  });
  const ttlMs = new Date(tokenResult.payload.expiresAt).getTime() - Date.now();
  response.cookies.set(DOWNLOAD_SESSION_COOKIE, tokenResult.token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/echo-agent-download",
    maxAge: Math.max(1, Math.ceil(ttlMs / 1000)),
  });
  return response;
}
