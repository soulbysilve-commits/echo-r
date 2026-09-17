import { randomBytes, createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  getStripeClient,
  getEchoAgentPriceId,
  isStripeConfigured,
  isStripeLiveSalesEnabled,
  isStripeTestCheckoutEnabled,
  validatePriceForCurrentEnvironment,
} from "../../../lib/stripe";
import { CHECKOUT_NONCE_COOKIE } from "../../../lib/checkoutNonce";

/**
 * Creates a Stripe Checkout Session for the ECHO Agent product.
 *
 * The Price ID (and therefore the amount) comes ONLY from server-side
 * configuration (STRIPE_ECHO_AGENT_PRICE_ID) -- the browser can never
 * supply or influence a price or amount here. A client that is paid
 * or not paid is decided later, by Stripe's own webhook (see
 * app/api/stripe-webhook/route.ts), never by this route's response
 * and never by whatever the browser does with success_url.
 */

export const runtime = "nodejs";

const SITE = process.env.NEXT_PUBLIC_SITE_URL || "https://echo-r.veritasforge.net";

export async function POST(request: NextRequest) {
  try {
    // Server-side authorization, independent of whatever CTA the
    // browser happens to render: a session is only ever created when
    // this exact request is allowed by either the live-sales gate or
    // the Preview-only test-checkout gate (see lib/stripe.ts for both).
    // Neither gate being satisfied is treated the same as "not
    // configured" below -- this endpoint being reachable at all was
    // never itself sufficient, only the UI button's visibility used to
    // imply that; now both the UI and this route agree.
    if (!isStripeLiveSalesEnabled() && !isStripeTestCheckoutEnabled()) {
      console.error("Checkout requested but neither the live-sales gate nor the test-checkout gate is enabled.");
      return NextResponse.json(
        { error: "現在、ECHO Agentの購入手続きは準備中です。" },
        { status: 503 }
      );
    }

    if (!isStripeConfigured()) {
      console.error("Checkout requested but STRIPE_SECRET_KEY is not configured.");
      return NextResponse.json(
        { error: "現在、ECHO Agentの購入手続きは準備中です。" },
        { status: 503 }
      );
    }

    const priceId = getEchoAgentPriceId();
    if (!priceId) {
      console.error("Checkout requested but STRIPE_ECHO_AGENT_PRICE_ID is not configured.");
      return NextResponse.json(
        { error: "現在、ECHO Agentの購入手続きは準備中です。" },
        { status: 503 }
      );
    }

    const stripe = getStripeClient();
    if (!stripe) {
      return NextResponse.json(
        { error: "現在、ECHO Agentの購入手続きは準備中です。" },
        { status: 503 }
      );
    }

    let locale: "ja" | "en" = "en";
    try {
      const body = await request.json().catch(() => ({}));
      if (body?.locale === "ja") locale = "ja";
    } catch {
      // no body / not JSON -- default locale stands
    }

    const successPath = locale === "ja" ? "/ja/echo-agent/success" : "/echo-agent/success";
    const cancelPath = locale === "ja" ? "/ja/echo-agent/cancel" : "/echo-agent/cancel";

    // mode "subscription" is used automatically by Stripe when the
    // configured Price is recurring, and "payment" when it is
    // one-time -- Checkout Sessions infer this from the Price itself,
    // so this route does not need to hardcode a pricing model (see
    // STRIPE_SETUP.md for how the operator chooses this when creating
    // the Price in the Stripe Dashboard).
    const price = await stripe.prices.retrieve(priceId);

    // Defense-in-depth environment/commercial-contract guard -- see
    // validatePriceForCurrentEnvironment's doc comment (lib/stripe.ts).
    // Never creates a Checkout Session from a Price this environment is
    // not allowed to sell (live Price outside Production, test Price
    // inside Production, or a live Price whose currency/amount/interval
    // drifted from the owner-authorized JPY 3000/month contract).
    const priceCheck = validatePriceForCurrentEnvironment(price);
    if (!priceCheck.ok) {
      console.error(
        "ECHO Agent checkout blocked: configured Price failed the environment safety check:",
        priceCheck.reason
      );
      return NextResponse.json(
        { error: "現在、ECHO Agentの購入手続きは準備中です。" },
        { status: 503 }
      );
    }

    const mode: "payment" | "subscription" = price.recurring ? "subscription" : "payment";

    // Browser-binding nonce (see ECHO_AGENT_FULFILLMENT.md): the raw
    // nonce goes only into an HttpOnly cookie on THIS response, never
    // into Stripe metadata or anywhere else. Only its SHA-256 hash is
    // stored (in Checkout Session / subscription metadata), so nothing
    // that could recreate the cookie value ever leaves this process.
    // Used later (download-token issuance) to prove the browser
    // requesting a download is the same one that created this
    // checkout, so session_id alone -- visible in the success URL --
    // is never sufficient on its own.
    const checkoutNonce = randomBytes(32);
    const checkoutNonceHash = createHash("sha256").update(checkoutNonce).digest("hex");

    const session = await stripe.checkout.sessions.create({
      mode,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${SITE}${successPath}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE}${cancelPath}`,
      allow_promotion_codes: true,
      metadata: {
        product: "echo-agent",
        locale,
        fulfillment_version: "v1",
        checkout_nonce_hash: checkoutNonceHash,
      },
      // Session metadata alone only identifies the Checkout Session
      // itself -- the Subscription object Stripe creates for
      // mode:"subscription" does not inherit it automatically. Setting
      // it here too is what lets the webhook's
      // customer.subscription.updated/deleted and invoice.payment_failed
      // handling (app/api/stripe-webhook/route.ts) recognize this
      // subscription/its invoices as an ECHO Agent event, instead of
      // treating every subscription on this Stripe account as one.
      ...(mode === "subscription"
        ? {
            subscription_data: {
              metadata: { product: "echo-agent", locale, fulfillment_version: "v1", checkout_nonce_hash: checkoutNonceHash },
            },
          }
        : {}),
    });

    if (!session.url) {
      console.error("Stripe Checkout Session was created without a redirect URL:", session.id);
      return NextResponse.json(
        { error: "決済ページの作成に失敗しました。時間を置いてお試しください。" },
        { status: 502 }
      );
    }

    const response = NextResponse.json({ url: session.url });
    response.cookies.set(CHECKOUT_NONCE_COOKIE, checkoutNonce.toString("hex"), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      // Generous -- covers an abandoned-then-resumed checkout; the
      // real authorization is the download-token route's own
      // multi-step server-side re-verification, not this cookie's
      // lifetime alone.
      maxAge: 60 * 60 * 24,
    });
    return response;
  } catch (error) {
    console.error("ECHO Agent checkout session creation failed:", error);
    return NextResponse.json(
      { error: "決済ページの作成に失敗しました。時間を置いてお試しください。" },
      { status: 500 }
    );
  }
}
