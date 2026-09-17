import { NextRequest, NextResponse } from "next/server";
import { getStripeClient, isStripeConfigured, getFulfillmentMode } from "../../../lib/stripe";
import { getEntitlement } from "../../../lib/entitlement";
import { getActivationCodeForDisplay } from "../../../lib/activation";
import { verifyCheckoutNonceCookie } from "../../../lib/checkoutNonce";

/**
 * Lets the customer's OWN browser (the success page, nonce-cookie-bound
 * to the Checkout Session it created) retrieve the raw activation code
 * issued for their purchase -- see lib/activation.ts
 * issueActivationCredential()'s comment on why this exists (no
 * transactional email system in this repo).
 *
 * Same browser-binding security as app/api/echo-agent-download-token:
 * re-fetches the session live from Stripe, requires the
 * `echo_agent_checkout_nonce` cookie to match
 * session.metadata.checkout_nonce_hash, and requires the entitlement
 * to be `"ready"`. session_id alone is never sufficient.
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
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

  const sessionId = request.nextUrl.searchParams.get("session_id");
  if (!sessionId || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return NextResponse.json({ error: "invalid session_id" }, { status: 400 });
  }

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (error) {
    console.error("activation-code: session lookup failed:", sessionId, error);
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (session.metadata?.product !== "echo-agent") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (!verifyCheckoutNonceCookie(request, session.metadata?.checkout_nonce_hash)) {
    console.error("activation-code: missing/mismatched checkout nonce cookie:", sessionId);
    return NextResponse.json({ error: "denied" }, { status: 403 });
  }

  let entitlement;
  try {
    entitlement = await getEntitlement(sessionId);
  } catch (error) {
    console.error("activation-code: entitlement lookup failed:", sessionId, error);
    return NextResponse.json({ error: "fulfillment storage not available" }, { status: 503 });
  }
  if (!entitlement || entitlement.status !== "ready") {
    return NextResponse.json({ error: "not ready" }, { status: 409 });
  }

  const display = await getActivationCodeForDisplay(sessionId);
  if (!display) {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  return NextResponse.json({
    email: session.customer_details?.email ?? session.customer_email ?? null,
    activationCode: display.activationCode,
  });
}
