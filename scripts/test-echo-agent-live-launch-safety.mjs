#!/usr/bin/env node
// Deterministic, server-free unit tests for the live-launch safety
// gates added in this pass (see
// docs/release/ECHO_AGENT_LIVE_LAUNCH_AUDIT.md and
// docs/release/ECHO_AGENT_PRICE_MATRIX.md):
//
//   1. isStripeLiveSalesEnabled() additionally requires a
//      production-like VERCEL_ENV -- a live key + the flag can never
//      show a real Purchase button on Sandbox/Preview.
//   2. validatePriceForCurrentEnvironment() rejects a live Price
//      outside Production, a test Price inside Production, and any
//      live Price whose currency/amount/interval drifted from the
//      owner-authorized JPY 3000/month contract.
//   3. lib/entitlement.ts storage-key namespacing: unset
//      ECHO_AGENT_FULFILLMENT_NAMESPACE reproduces the exact
//      pre-existing (Sandbox) key shape; an explicit namespace
//      produces a distinct, non-colliding prefix; a malformed
//      namespace value is ignored (fails safe to the default, never a
//      guessed/unsafe prefix).
//   4. Sanity: the proven Sandbox TEST price amount (1000) is not the
//      live commercial contract amount (3000) -- documents that the
//      two are intentionally different and neither test touches the
//      other.
//
// Run with: node --experimental-strip-types scripts/test-echo-agent-live-launch-safety.mjs
// Never calls Stripe's live (or test) API -- everything here is pure
// functions against fake env vars / fake Price-shaped objects.

import {
  isStripeLiveSalesEnabled,
  isStripeTestCheckoutEnabled,
  validatePriceForCurrentEnvironment,
  ECHO_AGENT_LIVE_PRICE_CONTRACT,
} from "../lib/stripe.ts";
import { __testing as entitlementTesting } from "../lib/entitlement.ts";

let failures = 0;
let passes = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} ${name} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (ok) passes++;
  else failures++;
  return ok;
}

function resetEnv() {
  delete process.env.VERCEL_ENV;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_ECHO_AGENT_PRICE_ID;
  delete process.env.STRIPE_TEST_CHECKOUT_ENABLED;
  delete process.env.STRIPE_SALES_LIVE_ENABLED;
  delete process.env.ECHO_AGENT_FULFILLMENT_MODE;
  delete process.env.ECHO_AGENT_FULFILLMENT_NAMESPACE;
}

console.log("=== ECHO Agent live-launch safety: unit tests ===\n");

// -----------------------------------------------------------------
// 1. isStripeLiveSalesEnabled() environment guard
// -----------------------------------------------------------------

resetEnv();
process.env.STRIPE_SALES_LIVE_ENABLED = "true";
process.env.STRIPE_SECRET_KEY = "sk_live_FAKE";
process.env.VERCEL_ENV = "production";
check("L1: flag=true + sk_live_ + VERCEL_ENV=production -> live sales enabled", isStripeLiveSalesEnabled(), true);

resetEnv();
process.env.STRIPE_SALES_LIVE_ENABLED = "true";
process.env.STRIPE_SECRET_KEY = "sk_live_FAKE";
// VERCEL_ENV unset -- covers a non-Vercel production-style run.
check("L2: flag=true + sk_live_ + VERCEL_ENV unset -> live sales enabled", isStripeLiveSalesEnabled(), true);

resetEnv();
process.env.STRIPE_SALES_LIVE_ENABLED = "true";
process.env.STRIPE_SECRET_KEY = "sk_live_FAKE";
process.env.VERCEL_ENV = "preview";
check("L3: flag=true + sk_live_ + VERCEL_ENV=preview -> BLOCKED (new guard)", isStripeLiveSalesEnabled(), false);

resetEnv();
process.env.STRIPE_SALES_LIVE_ENABLED = "true";
process.env.STRIPE_SECRET_KEY = "sk_live_FAKE";
process.env.VERCEL_ENV = "sandbox";
check("L4: flag=true + sk_live_ + VERCEL_ENV=sandbox -> BLOCKED (new guard)", isStripeLiveSalesEnabled(), false);

resetEnv();
process.env.STRIPE_SALES_LIVE_ENABLED = "true";
process.env.STRIPE_SECRET_KEY = "sk_live_FAKE";
process.env.VERCEL_ENV = "development";
check("L5: flag=true + sk_live_ + VERCEL_ENV=development -> BLOCKED (new guard)", isStripeLiveSalesEnabled(), false);

resetEnv();
process.env.STRIPE_SALES_LIVE_ENABLED = "true";
process.env.STRIPE_SECRET_KEY = "sk_test_FAKE";
process.env.VERCEL_ENV = "production";
check("L6: flag=true + sk_test_ (wrong key mode) + production -> BLOCKED (unchanged pre-existing gate)", isStripeLiveSalesEnabled(), false);

resetEnv();
process.env.VERCEL_ENV = "preview";
process.env.STRIPE_SECRET_KEY = "sk_test_FAKE";
process.env.STRIPE_ECHO_AGENT_PRICE_ID = "price_test_fake";
process.env.STRIPE_TEST_CHECKOUT_ENABLED = "true";
check("L7: test-checkout gate unaffected by the new live-sales guard", isStripeTestCheckoutEnabled(), true);

resetEnv();

// -----------------------------------------------------------------
// 2. validatePriceForCurrentEnvironment()
// -----------------------------------------------------------------

const livePriceOk = {
  livemode: true,
  currency: "jpy",
  unit_amount: 3000,
  recurring: { interval: "month" },
};
const livePriceWrongCurrency = { ...livePriceOk, currency: "usd" };
const livePriceWrongAmount = { ...livePriceOk, unit_amount: 3300 };
const livePriceOneTime = { ...livePriceOk, recurring: null };
const livePriceWrongInterval = { ...livePriceOk, recurring: { interval: "year" } };
const testPriceSandbox = {
  livemode: false,
  currency: "jpy",
  unit_amount: 1000,
  recurring: { interval: "month" },
};

resetEnv();
process.env.VERCEL_ENV = "production";
check("P1: correct live Price in Production -> ok", validatePriceForCurrentEnvironment(livePriceOk), { ok: true });

resetEnv();
process.env.VERCEL_ENV = "production";
check(
  "P2: live Price, wrong currency, in Production -> rejected",
  validatePriceForCurrentEnvironment(livePriceWrongCurrency),
  { ok: false, reason: "wrong_currency" }
);

resetEnv();
process.env.VERCEL_ENV = "production";
check(
  "P3: live Price, wrong amount (3300 not 3000), in Production -> rejected",
  validatePriceForCurrentEnvironment(livePriceWrongAmount),
  { ok: false, reason: "wrong_amount" }
);

resetEnv();
process.env.VERCEL_ENV = "production";
check(
  "P4: live Price, one-time (not recurring), in Production -> rejected",
  validatePriceForCurrentEnvironment(livePriceOneTime),
  { ok: false, reason: "wrong_interval_or_not_recurring" }
);

resetEnv();
process.env.VERCEL_ENV = "production";
check(
  "P5: live Price, wrong interval (year not month), in Production -> rejected",
  validatePriceForCurrentEnvironment(livePriceWrongInterval),
  { ok: false, reason: "wrong_interval_or_not_recurring" }
);

resetEnv();
process.env.VERCEL_ENV = "production";
check(
  "P6: TEST Price used in Production -> rejected (cannot fall back to Sandbox price)",
  validatePriceForCurrentEnvironment(testPriceSandbox),
  { ok: false, reason: "test_price_in_production" }
);

resetEnv();
process.env.VERCEL_ENV = "preview";
check(
  "P7: LIVE Price used in Preview/Sandbox -> rejected (cannot sell live outside Production)",
  validatePriceForCurrentEnvironment(livePriceOk),
  { ok: false, reason: "live_price_outside_production" }
);

resetEnv();
process.env.VERCEL_ENV = "sandbox";
check(
  "P8: LIVE Price used in the sandbox custom environment -> rejected",
  validatePriceForCurrentEnvironment(livePriceOk),
  { ok: false, reason: "live_price_outside_production" }
);

resetEnv();
process.env.VERCEL_ENV = "preview";
check("P9: correct TEST Price in Preview/Sandbox -> ok (Sandbox flow unaffected)", validatePriceForCurrentEnvironment(testPriceSandbox), { ok: true });

resetEnv();
check("P10: correct TEST Price with VERCEL_ENV unset (local dev) -> ok", validatePriceForCurrentEnvironment(testPriceSandbox), { ok: true });

resetEnv();

// -----------------------------------------------------------------
// 3. Fulfillment storage-key namespacing
// -----------------------------------------------------------------

resetEnv();
check(
  "N1: unset ECHO_AGENT_FULFILLMENT_NAMESPACE -> exact pre-existing (Sandbox) key shape",
  entitlementTesting.entitlementKey("cs_test_abc123"),
  "fulfillment/entitlements/cs_test_abc123.json"
);
check(
  "N1b: unset namespace -> exact pre-existing event key shape",
  entitlementTesting.eventKey("evt_abc123"),
  "fulfillment/events/evt_abc123.json"
);

resetEnv();
process.env.ECHO_AGENT_FULFILLMENT_NAMESPACE = "production";
check(
  "N2: ECHO_AGENT_FULFILLMENT_NAMESPACE=production -> distinct, non-colliding prefix",
  entitlementTesting.entitlementKey("cs_live_abc123"),
  "fulfillment/production/entitlements/cs_live_abc123.json"
);
check(
  "N2b: production namespace -> distinct event key prefix",
  entitlementTesting.eventKey("evt_abc123"),
  "fulfillment/production/events/evt_abc123.json"
);
check(
  "N3: Sandbox default key and Production-namespaced key for the SAME id never collide",
  entitlementTesting.entitlementKey("cs_shared_id") !== "fulfillment/entitlements/cs_shared_id.json",
  true
);

resetEnv();
process.env.ECHO_AGENT_FULFILLMENT_NAMESPACE = "../../etc";
check(
  "N4: malformed/unsafe namespace value -> ignored, falls back to the safe default (never a guessed prefix)",
  entitlementTesting.entitlementKey("cs_test_abc123"),
  "fulfillment/entitlements/cs_test_abc123.json"
);

resetEnv();

// -----------------------------------------------------------------
// 4. Sanity: Sandbox TEST amount vs. LIVE commercial contract amount
// -----------------------------------------------------------------

check(
  "S1: Sandbox proven TEST price amount (1000) is not the LIVE contract amount",
  ECHO_AGENT_LIVE_PRICE_CONTRACT.unitAmount === 1000,
  false
);
check(
  "S2: LIVE commercial contract is exactly JPY 3000/month",
  ECHO_AGENT_LIVE_PRICE_CONTRACT,
  { currency: "jpy", unitAmount: 3000, interval: "month" }
);

console.log(`\n=== ${passes} passed, ${failures} failed ===`);
process.exit(failures === 0 ? 0 : 1);
