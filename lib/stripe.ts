import Stripe from "stripe";

/**
 * Shared Stripe access for the ECHO Agent checkout flow.
 *
 * Secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 * STRIPE_ECHO_AGENT_PRICE_ID) are read from process.env only -- never
 * hardcoded, never sent to the client. This module never throws at
 * import time if a variable is missing (so pages that don't touch
 * Stripe still render); callers must check the null/false returns
 * explicitly and fail closed.
 */

let cachedClient: Stripe | null = null;
let cachedClientKey: string | null = null;

export function getStripeSecretKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

export function getStripeWebhookSecret(): string | null {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  return typeof secret === "string" && secret.trim() ? secret.trim() : null;
}

export function getEchoAgentPriceId(): string | null {
  const priceId = process.env.STRIPE_ECHO_AGENT_PRICE_ID;
  return typeof priceId === "string" && priceId.trim() ? priceId.trim() : null;
}

export function getStripePublishableKey(): string | null {
  const key = process.env.STRIPE_PUBLISHABLE_KEY;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

/** Returns a configured Stripe client, or null if STRIPE_SECRET_KEY is
 * not set -- callers must treat null as "checkout is not configured
 * yet" and respond accordingly (never fabricate a session). */
export function getStripeClient(): Stripe | null {
  const key = getStripeSecretKey();
  if (!key) return null;
  if (cachedClient && cachedClientKey === key) return cachedClient;
  cachedClient = new Stripe(key, {
    typescript: true,
  });
  cachedClientKey = key;
  return cachedClient;
}

/** True only when the operator has BOTH explicitly opted into live
 * sales AND configured a live-mode secret key (sk_live_...). Either
 * condition alone is not enough -- this is the single gate the public
 * product page uses to decide whether to render a real "Purchase"
 * call to action instead of the existing "Inquire" one. Defaults to
 * false whenever unset, so a fresh deployment never shows a live
 * purchase button by accident.
 *
 * Environment guard (added for the live-launch pass, see
 * docs/release/ECHO_AGENT_LIVE_LAUNCH_AUDIT.md): also requires
 * VERCEL_ENV to be either "production" or unset (unset covers plain
 * `next start`/local-production-style runs that are not on Vercel at
 * all). This is a defense-in-depth guard against a future
 * misconfiguration where a live key + the flag both end up set on a
 * Preview/sandbox environment by mistake -- Sandbox/Preview must never
 * be able to show a real live purchase button, even if every other
 * condition were somehow true there. This is independent of, and
 * never satisfied at the same time as, isStripeTestCheckoutEnabled()
 * below (that one requires a *test* key and explicitly requires
 * Preview/development). */
export function isStripeLiveSalesEnabled(): boolean {
  const explicit = process.env.STRIPE_SALES_LIVE_ENABLED === "true";
  const key = getStripeSecretKey();
  const isLiveKey = !!key && key.startsWith("sk_live_");
  const env = process.env.VERCEL_ENV;
  const envAllowsLiveSales = env === "production" || env === undefined;
  return explicit && isLiveKey && envAllowsLiveSales;
}

/** True when a secret key is configured, of either mode -- used to
 * decide whether checkout/webhook routes can function at all (as
 * opposed to isStripeLiveSalesEnabled, which additionally gates public
 * visibility of a real purchase button). */
export function isStripeConfigured(): boolean {
  return !!getStripeSecretKey();
}

export function isStripeTestMode(): boolean {
  const key = getStripeSecretKey();
  return !!key && key.startsWith("sk_test_");
}

/** True only in a non-production Vercel environment, with an explicit
 * opt-in flag, a test-mode secret key, and a configured Price. This
 * exists so a real Stripe TEST MODE Hosted Checkout E2E can be run
 * safely against a Preview deployment -- it never affects Production
 * and never touches the live-sales gate above.
 *
 * ALL of the following must hold:
 *   - VERCEL_ENV is "preview" or "development" (Vercel sets this
 *     itself on every deployment; it cannot be set by request data or
 *     by anything this app controls, so a Production deployment can
 *     never satisfy this by manipulating a header or query param).
 *   - STRIPE_TEST_CHECKOUT_ENABLED === "true" (explicit operator
 *     opt-in, defaults to unset/false).
 *   - STRIPE_SECRET_KEY starts with "sk_test_" (a live key present in
 *     the same environment can never be used through this gate).
 *   - STRIPE_ECHO_AGENT_PRICE_ID is configured.
 *
 * Production is hard-blocked first, before any other check, as an
 * explicit belt-and-suspenders guard -- even if every other condition
 * were somehow true, VERCEL_ENV=production always returns false here.
 * This is completely independent of isStripeLiveSalesEnabled(); the
 * two are never both true at once in practice, since one requires a
 * live key and the other requires a test key. */
export function isStripeTestCheckoutEnabled(): boolean {
  if (process.env.VERCEL_ENV === "production") return false;

  const inPreviewOrDev =
    process.env.VERCEL_ENV === "preview" || process.env.VERCEL_ENV === "development";
  if (!inPreviewOrDev) return false;

  if (process.env.STRIPE_TEST_CHECKOUT_ENABLED !== "true") return false;

  const key = getStripeSecretKey();
  if (!key || !key.startsWith("sk_test_")) return false;

  if (!getEchoAgentPriceId()) return false;

  return true;
}

export type FulfillmentMode = "manual" | "relay" | "automatic_download";

/** Reads ECHO_AGENT_FULFILLMENT_MODE and decides how the webhook
 * route (app/api/stripe-webhook/route.ts) should handle a verified,
 * relevant ECHO Agent Stripe event:
 *
 *   - "relay": forward the record to ECHO_AGENT_ORDER_WEBHOOK_URL, as
 *     this integration has always done (see lib/orderRelay.ts). Fails
 *     closed (500) if that relay is unset/unreachable.
 *   - "manual": acknowledge the verified event with 2xx and do
 *     NOTHING else -- no relay call, no external write, no license
 *     issuance. Stripe's own Dashboard/Payments/Subscriptions records
 *     remain the sole authoritative source; an administrator confirms
 *     payment there and delivers ECHO Agent by hand (Phase 1 -- see
 *     PAYMENT_OPERATIONS.md).
 *   - "automatic_download": create/update a durable entitlement record
 *     (lib/entitlement.ts) so a later download-token request can issue
 *     a one-time, encrypted, license-gated download -- see
 *     ECHO_AGENT_FULFILLMENT.md. Sandbox/Preview only; still requires
 *     the ECHO_AGENT_STORAGE, ECHO_AGENT_ARTIFACT, ECHO_AGENT_LICENSE,
 *     and ECHO_AGENT_DOWNLOAD_TOKEN env var groups to actually be
 *     configured, and fails closed (500) if they are not.
 *
 * Unset, empty, or any value other than exactly "manual", "relay", or
 * "automatic_download" (a typo included) returns null, meaning "fail
 * closed, never guess a mode." This deliberately does not default an
 * unset value to any mode: each mode requires its own real
 * configuration to be considered active, and falling back silently
 * would be a real behavior choice made by accident rather than on
 * purpose. Only an explicit ECHO_AGENT_FULFILLMENT_MODE value selects
 * a mode. */
export function getFulfillmentMode(): FulfillmentMode | null {
  const raw = process.env.ECHO_AGENT_FULFILLMENT_MODE;
  if (raw === "relay") return "relay";
  if (raw === "manual") return "manual";
  if (raw === "automatic_download") return "automatic_download";
  return null;
}

/** The owner-authorized LIVE commercial contract for ECHO Agent (see
 * docs/product/ECHO_AGENT_COMMERCIAL_DEFINITION.md): JPY 3000/month.
 * Deliberately NOT applied to test-mode prices -- the Sandbox's own
 * proven TEST price (JPY 1000/month, price_1UECSHQ3JDgHG3iSKOh1BYFO)
 * is intentionally a different amount and must keep working
 * unmodified; see validatePriceForCurrentEnvironment below. */
export const ECHO_AGENT_LIVE_PRICE_CONTRACT = {
  currency: "jpy",
  unitAmount: 3000,
  interval: "month",
} as const;

export type PriceEnvironmentCheck = { ok: true } | { ok: false; reason: string };

/** Defense-in-depth checkout-time guard (called by
 * app/api/echo-agent-checkout/route.ts right after retrieving the
 * configured Price from Stripe -- never trusted from config alone).
 * Two independent checks, both fail closed:
 *
 *   1. Environment/livemode pairing -- a live-mode Price must only
 *      ever be used when this deployment is actually in Vercel
 *      Production (or unset VERCEL_ENV, for a non-Vercel
 *      production-style run); a test-mode Price must never be used on
 *      a real Vercel Production deployment. This is the structural
 *      guarantee that Sandbox/Preview can never sell using a live
 *      Price, and Production can never fall back to Sandbox's test
 *      Price -- see docs/release/ECHO_AGENT_PRICE_MATRIX.md.
 *   2. Live commercial contract -- when the Price is live-mode, its
 *      currency/amount/billing interval must exactly match
 *      ECHO_AGENT_LIVE_PRICE_CONTRACT. A live Price that drifted (wrong
 *      currency, wrong amount, one-time instead of monthly, etc.) is
 *      refused rather than silently used to create a real Checkout
 *      Session. */
export function validatePriceForCurrentEnvironment(price: Stripe.Price): PriceEnvironmentCheck {
  const env = process.env.VERCEL_ENV;
  const isVercelProduction = env === "production";
  const isProdLikeEnv = isVercelProduction || env === undefined;

  if (price.livemode && !isProdLikeEnv) {
    return { ok: false, reason: "live_price_outside_production" };
  }
  if (!price.livemode && isVercelProduction) {
    return { ok: false, reason: "test_price_in_production" };
  }
  if (price.livemode) {
    if (price.currency !== ECHO_AGENT_LIVE_PRICE_CONTRACT.currency) {
      return { ok: false, reason: "wrong_currency" };
    }
    if (price.unit_amount !== ECHO_AGENT_LIVE_PRICE_CONTRACT.unitAmount) {
      return { ok: false, reason: "wrong_amount" };
    }
    if (!price.recurring || price.recurring.interval !== ECHO_AGENT_LIVE_PRICE_CONTRACT.interval) {
      return { ok: false, reason: "wrong_interval_or_not_recurring" };
    }
  }
  return { ok: true };
}
