import { NextRequest, NextResponse } from "next/server";
import { getStripeClient, isStripeConfigured, getFulfillmentMode } from "../../../lib/stripe";
import { getEntitlement } from "../../../lib/entitlement";

/**
 * Re-verifies a Checkout Session directly against Stripe's own API,
 * server-side, using the secret key. The success page calls this
 * instead of trusting the `session_id` query parameter or anything
 * else the browser supplies -- returning from success_url is never
 * itself treated as proof of payment.
 *
 * This is a read-only status check (source of truth: Stripe's own
 * session AND, for subscription-mode sessions, the subscription
 * object itself -- Checkout completing is not proof a subscription is
 * actually active, so `paid` for a subscription requires both the
 * session's payment_status AND the subscription's own status to be
 * healthy). The webhook (app/api/stripe-webhook/route.ts) remains the
 * authoritative trigger for whatever this deployment's fulfillment
 * mode does (see ECHO_AGENT_FULFILLMENT_MODE, lib/stripe.ts) -- this
 * route only answers "what does Stripe say about this session right
 * now" for the customer's immediate on-screen feedback.
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");

  if (!sessionId || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return NextResponse.json({ error: "invalid session_id" }, { status: 400 });
  }

  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const stripe = getStripeClient();
  if (!stripe) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.product !== "echo-agent") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const paidPaymentStatus =
      session.payment_status === "paid" || session.payment_status === "no_payment_required";

    // Checkout completing is not itself proof that a subscription is
    // actually active -- retrieve the subscription's own status too,
    // and require it to be in a healthy state before this reports
    // "paid" for subscription-mode sessions. A one-time payment has no
    // subscription and relies on paidPaymentStatus alone.
    let subscriptionStatus: string | null = null;
    if (typeof session.subscription === "string") {
      try {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        subscriptionStatus = subscription.status;
      } catch (subError) {
        console.error("ECHO Agent order status: subscription lookup failed:", subError);
      }
    }

    const subscriptionHealthy =
      subscriptionStatus === null || subscriptionStatus === "active" || subscriptionStatus === "trialing";

    const paid = paidPaymentStatus && subscriptionHealthy;

    // Only surfaced for automatic_download -- other modes never touch
    // the entitlement store, so this stays null for them. This is a
    // read of durable state written by the webhook, never a
    // client-trusted value; the actual download-token route
    // independently re-verifies everything again before issuing
    // anything.
    let entitlementStatus: "pending" | "ready" | "failed" | null = null;
    const fulfillmentMode = getFulfillmentMode();
    if (fulfillmentMode === "automatic_download" && paid) {
      try {
        const entitlement = await getEntitlement(sessionId);
        entitlementStatus = entitlement?.status ?? "pending";
      } catch (error) {
        console.error("ECHO Agent order status: entitlement lookup failed:", error);
        entitlementStatus = "failed";
      }
    }

    return NextResponse.json({
      paid,
      mode: session.mode,
      paymentStatus: session.payment_status,
      subscriptionStatus,
      customerEmail: session.customer_details?.email ?? null,
      fulfillmentMode,
      entitlementStatus,
    });
  } catch (error) {
    console.error("ECHO Agent order status lookup failed:", error);
    return NextResponse.json({ error: "lookup failed" }, { status: 502 });
  }
}
