import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripeClient, getStripeWebhookSecret, getFulfillmentMode, getEchoAgentPriceId } from "../../../lib/stripe";
import { relayEchoAgentOrder, type EchoAgentOrderRecord } from "../../../lib/orderRelay";
import { recordEventOnce, upsertEntitlement, upsertSubscriptionState, getSubscriptionState } from "../../../lib/entitlement";
import { normalizeEmail, issueActivationCredential } from "../../../lib/activation";

/**
 * Stripe webhook endpoint -- the ONLY authoritative source of "this
 * ECHO Agent purchase is confirmed" used anywhere in this site.
 * Nothing the browser sends (success_url query params included) is
 * ever treated as proof of payment; only a signature-verified event
 * arriving here is.
 *
 * Node runtime (not edge): keeps this on Stripe's officially
 * documented, most-tested signature-verification path
 * (stripe.webhooks.constructEvent, synchronous, Node crypto) rather
 * than the newer async/Web-Crypto edge variant.
 *
 * Fail-closed: an unverifiable signature is rejected outright (400)
 * before any event data is read. A verified event that we could not
 * durably record (order relay unavailable/misconfigured) returns a
 * non-2xx so Stripe retries with backoff, rather than silently
 * acknowledging an event this site never actually recorded anywhere.
 */

export const runtime = "nodejs";

const RELEVANT_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
]);

export async function POST(request: NextRequest) {
  const webhookSecret = getStripeWebhookSecret();
  const stripe = getStripeClient();

  if (!webhookSecret || !stripe) {
    console.error("Stripe webhook received but STRIPE_WEBHOOK_SECRET / STRIPE_SECRET_KEY is not configured.");
    return NextResponse.json({ error: "webhook not configured" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing signature" }, { status: 400 });
  }

  // Raw body is required for signature verification -- never parse as
  // JSON first, that would invalidate the signature check.
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    console.error(
      "Stripe webhook signature verification failed -- rejecting unverified event:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  if (!RELEVANT_EVENTS.has(event.type)) {
    // Acknowledge but do nothing -- an event type this integration
    // does not act on is not an error.
    return NextResponse.json({ received: true, ignored: event.type });
  }

  const record = buildOrderRecord(event);
  if (!record) {
    // A relevant event TYPE, but not an ECHO Agent product/price (an
    // unrelated Stripe product on the same account, or -- for
    // subscription/invoice events -- a subscription this integration
    // never created). Retrying can never turn this into a match, since
    // the event's own data doesn't change between deliveries, so this
    // acknowledges with 2xx specifically to avoid Stripe retrying an
    // event that will never become processable -- never treated as an
    // ECHO Agent order, and no external side effect of any kind.
    console.log("Stripe webhook event recognized but not an ECHO Agent product/price -- ignored, no side effects:", event.id, event.type);
    return NextResponse.json({ received: true, ignored: "unrelated_product" });
  }

  const mode = getFulfillmentMode();
  if (mode === null) {
    console.error(
      "ECHO_AGENT_FULFILLMENT_MODE is set to an unrecognized value -- failing closed rather than guessing a fulfillment mode:",
      event.id
    );
    return NextResponse.json({ error: "fulfillment mode misconfigured" }, { status: 500 });
  }

  if (mode === "manual") {
    // Phase 1 manual fulfillment: side-effect-free. No relay call, no
    // external write, no license issuance -- Stripe's own Dashboard
    // (Payments/Customers/Subscriptions) is the sole authoritative
    // payment record; an administrator confirms there and delivers
    // ECHO Agent by hand. Logged minimally (event id/type/status only
    // -- never customer email, amount, or any secret) purely for
    // operational debugging, never as a substitute order record.
    console.log("Stripe webhook event verified (manual fulfillment mode, no automatic action taken):", event.id, event.type, record.status);
    return NextResponse.json({
      received: true,
      fulfillmentMode: "manual",
      disposition: "manual_fulfillment_pending",
    });
  }

  if (mode === "automatic_download") {
    return handleAutomaticDownloadEvent(event, record);
  }

  // mode === "relay" -- existing behavior, unchanged.
  const relayResult = await relayEchoAgentOrder(record);

  if (!relayResult.forwarded) {
    // Verified event, but we could not durably record it anywhere.
    // Fail closed: return non-2xx so Stripe retries with backoff
    // instead of this site silently losing a confirmed payment event.
    console.error("Stripe webhook event verified but NOT recorded -- Stripe will retry:", event.id, relayResult.error);
    return NextResponse.json({ error: "order record not persisted" }, { status: 500 });
  }

  if (relayResult.duplicate) {
    console.log("Stripe webhook event already recorded (duplicate delivery, no re-issue):", event.id);
  } else {
    console.log("Stripe webhook event recorded:", event.id, event.type);
  }

  return NextResponse.json({ received: true, duplicate: relayResult.duplicate });
}

/**
 * automatic_download fulfillment: turns a verified, ECHO-Agent-matched
 * Stripe event into durable entitlement/subscription state (private
 * object storage, see lib/entitlement.ts). This creates state, never
 * downloads/licenses directly -- issuing an actual license and
 * download token happens later, in
 * app/api/echo-agent-download-token/route.ts, which independently
 * re-verifies the session/price/payment/subscription/nonce/release
 * before handing anything out. This handler's job is only: "is there
 * now a reason to believe this checkout session/subscription is in
 * good standing," recorded durably and idempotently.
 */
/** Reads the paid-through boundary off a Stripe Subscription object.
 * As of the API version this integration is pinned to, `current_period_end`
 * lives on each subscription ITEM, not the subscription itself (Stripe
 * moved it there) -- this product always creates single-item
 * subscriptions (one price, quantity 1), so the first item's value is
 * authoritative. Returns null (never throws) if the shape is
 * unexpected, so a webhook parsing surprise degrades to "no captured
 * paid-through boundary" (lib/activation.ts resolveLeaseEligibility()
 * falls back to the existing status-based check in that case) rather
 * than failing the whole webhook delivery. */
function extractCurrentPeriodEndIso(subscription: Stripe.Subscription): string | null {
  const item = subscription.items?.data?.[0];
  const seconds = item?.current_period_end;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

async function handleAutomaticDownloadEvent(event: Stripe.Event, record: EchoAgentOrderRecord) {
  const echoAgentPriceId = getEchoAgentPriceId();
  if (!echoAgentPriceId) {
    console.error("automatic_download mode active but STRIPE_ECHO_AGENT_PRICE_ID is not configured:", event.id);
    return NextResponse.json({ error: "price not configured" }, { status: 500 });
  }

  let dedupe: { first: boolean };
  try {
    dedupe = await recordEventOnce(event.id, event.type);
  } catch (error) {
    console.error("automatic_download: could not record webhook event idempotency marker -- Stripe will retry:", event.id, error);
    return NextResponse.json({ error: "fulfillment storage not available" }, { status: 500 });
  }

  if (!dedupe.first) {
    // Replay of an event.id already processed -- no duplicate
    // entitlement/license/side effects. Idempotent by construction.
    console.log("automatic_download: duplicate event delivery, no re-processing:", event.id);
    return NextResponse.json({ received: true, fulfillmentMode: "automatic_download", duplicate: true });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      // Price validation for this event type is intentionally NOT
      // re-derived from a live Stripe API call here (unlike the
      // download-token route, which is the actual authorization
      // boundary and always does this). metadata.product === "echo-agent"
      // (checked in buildOrderRecord before this handler is even
      // reached) is already a strong signal on its own: only this
      // integration's own checkout-creation code
      // (app/api/echo-agent-checkout/route.ts) ever sets it, always
      // using whatever Price was configured AT THAT TIME. What this
      // webhook records is therefore best read as "a session our own
      // checkout flow created," not yet "authorized for download" --
      // that stronger claim (live price/payment/subscription/nonce
      // re-verification) is deferred entirely to
      // app/api/echo-agent-download-token/route.ts, the one place an
      // actual license/download is ever produced. See
      // ECHO_AGENT_FULFILLMENT.md "Two-layer verification".
      const releaseId = process.env.ECHO_AGENT_ARTIFACT_RELEASE_ID?.trim() || null;
      const nonceHash =
        typeof session.metadata?.checkout_nonce_hash === "string" ? session.metadata.checkout_nonce_hash : null;
      const paid = record.status === "paid" || record.status === "no_payment_required";

      await upsertEntitlement(session.id, {
        priceId: echoAgentPriceId,
        mode: session.mode === "subscription" ? "subscription" : "payment",
        customerId: typeof session.customer === "string" ? session.customer : null,
        subscriptionId: typeof session.subscription === "string" ? session.subscription : null,
        status: paid ? "ready" : "pending",
        releaseId,
        checkoutNonceHash: nonceHash,
      });

      if (typeof session.subscription === "string") {
        // Best-effort: fetch the subscription's own status so the
        // download-token route can gate on it independently of this
        // session-level snapshot. A failure here does not fail the
        // whole webhook -- the entitlement itself is already recorded,
        // and the download-token route treats "no subscription state
        // recorded yet" as not-yet-eligible rather than crashing.
        const stripe = getStripeClient();
        if (stripe) {
          try {
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            await upsertSubscriptionState(subscription.id, subscription.status, session.id, extractCurrentPeriodEndIso(subscription));
          } catch (error) {
            console.error("automatic_download: could not fetch subscription status after checkout:", session.subscription, error);
          }
        }
      }

      // Online activation credential: issued once per (paid) checkout,
      // keyed by the customer's own email -- see lib/activation.ts. A
      // failure here does not fail the whole webhook (the entitlement
      // itself, and the existing browser download flow, are already
      // recorded/unaffected); it only means the customer would need
      // the existing manual-file-import recovery path or a re-issued
      // credential from an administrator.
      if (paid) {
        const emailNormalized = normalizeEmail(session.customer_details?.email ?? session.customer_email ?? null);
        if (emailNormalized) {
          try {
            await issueActivationCredential({ entitlementId: session.id, emailNormalized });
          } catch (error) {
            console.error("automatic_download: could not issue activation credential:", session.id, error);
          }
        } else {
          console.error("automatic_download: checkout session has no usable email, activation credential not issued:", session.id);
        }
      }
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const subscription = event.data.object as Stripe.Subscription;
      const existing = await getSubscriptionState(subscription.id);
      await upsertSubscriptionState(subscription.id, subscription.status, existing?.checkoutSessionId ?? null, extractCurrentPeriodEndIso(subscription));
    } else if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = invoice.parent?.subscription_details?.subscription;
      const subId = typeof subscriptionId === "string" ? subscriptionId : subscriptionId?.id;
      if (subId) {
        const existing = await getSubscriptionState(subId);
        // Fetches the subscription's own LIVE status/paid-through
        // boundary rather than writing a synthetic "payment_failed"
        // status -- a failed renewal charge typically leaves Stripe's
        // subscription at "past_due" (not immediately canceled), and
        // lib/activation.ts resolveLeaseEligibility() already derives
        // lease eligibility from the paid-through timestamp, not this
        // status string, so a customer still within an already-paid
        // period is correctly NOT locked out just because one renewal
        // attempt failed. See docs/PAYMENT_OPERATIONS.md §5.
        const stripe = getStripeClient();
        if (stripe) {
          try {
            const subscription = await stripe.subscriptions.retrieve(subId);
            await upsertSubscriptionState(subId, subscription.status, existing?.checkoutSessionId ?? null, extractCurrentPeriodEndIso(subscription));
          } catch (error) {
            console.error("automatic_download: could not fetch live subscription status after invoice.payment_failed:", subId, error);
            await upsertSubscriptionState(subId, "payment_failed", existing?.checkoutSessionId ?? null, existing?.currentPeriodEnd ?? null);
          }
        } else {
          await upsertSubscriptionState(subId, "payment_failed", existing?.checkoutSessionId ?? null, existing?.currentPeriodEnd ?? null);
        }
      }
    }
  } catch (error) {
    console.error("automatic_download: failed to persist entitlement/subscription state -- Stripe will retry:", event.id, error);
    return NextResponse.json({ error: "fulfillment storage write failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true, fulfillmentMode: "automatic_download", duplicate: false });
}

/**
 * Whether a Stripe object should be treated as an ECHO Agent
 * purchase/subscription event. Metadata is the primary, authoritative
 * signal: `product: "echo-agent"` is set by this integration itself,
 * at Checkout Session creation, on both the session
 * (app/api/echo-agent-checkout/route.ts) and, for subscription-mode
 * sessions, the resulting Subscription (via subscription_data.metadata
 * on that same call) -- so nothing else in this codebase can produce
 * that value by accident. The configured Price ID is checked only as
 * a fallback, for objects where metadata might legitimately be absent
 * (e.g. a subscription that predates this metadata being set) -- see
 * "Product validation" in PAYMENT_OPERATIONS.md §0. Neither signal
 * being present means "not an ECHO Agent event," never a guess in the
 * other direction.
 */
function matchesEchoAgentProduct(
  metadata: Stripe.Metadata | null | undefined,
  priceIds: Array<string | null | undefined>
): boolean {
  if (metadata?.product === "echo-agent") return true;
  const configuredPriceId = getEchoAgentPriceId();
  if (!configuredPriceId) return false;
  return priceIds.some((id) => id === configuredPriceId);
}

function buildOrderRecord(event: Stripe.Event): EchoAgentOrderRecord | null {
  const createdAt = new Date(event.created * 1000).toISOString();

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.metadata?.product !== "echo-agent") return null;
    return {
      eventId: event.id,
      eventType: event.type,
      stripeCustomerId: typeof session.customer === "string" ? session.customer : null,
      checkoutSessionId: session.id,
      paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
      subscriptionId: typeof session.subscription === "string" ? session.subscription : null,
      product: "echo-agent",
      status: session.payment_status,
      customerEmail: session.customer_details?.email ?? session.customer_email ?? null,
      amountTotal: session.amount_total ?? null,
      currency: session.currency ?? null,
      createdAt,
    };
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;
    const priceIds = subscription.items.data.map((item) => item.price?.id);
    if (!matchesEchoAgentProduct(subscription.metadata, priceIds)) return null;
    return {
      eventId: event.id,
      eventType: event.type,
      stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : null,
      checkoutSessionId: null,
      paymentIntentId: null,
      subscriptionId: subscription.id,
      product: "echo-agent",
      status: subscription.status,
      customerEmail: null,
      amountTotal: null,
      currency: null,
      createdAt,
    };
  }

  if (event.type === "invoice.payment_failed") {
    const invoice = event.data.object as Stripe.Invoice;
    // The invoice's own `metadata` is a separate field from the
    // subscription's -- the immutable snapshot of the subscription's
    // metadata (taken at invoice finalization) lives under
    // `parent.subscription_details.metadata` instead. See
    // matchesEchoAgentProduct's doc comment for why metadata is the
    // primary signal and price ID only a fallback.
    const subscriptionMetadata = invoice.parent?.subscription_details?.metadata ?? null;
    const priceIds = (invoice.lines?.data ?? []).map((line) => {
      const price = line.pricing?.price_details?.price;
      return typeof price === "string" ? price : price?.id;
    });
    if (!matchesEchoAgentProduct(subscriptionMetadata, priceIds)) return null;
    return {
      eventId: event.id,
      eventType: event.type,
      stripeCustomerId: typeof invoice.customer === "string" ? invoice.customer : null,
      checkoutSessionId: null,
      paymentIntentId: null,
      subscriptionId: null,
      product: "echo-agent",
      status: "payment_failed",
      customerEmail: invoice.customer_email ?? null,
      amountTotal: invoice.amount_due ?? null,
      currency: invoice.currency ?? null,
      createdAt,
    };
  }

  return null;
}
