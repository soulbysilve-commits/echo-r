#!/usr/bin/env node
// Deterministic tests for the ECHO Agent Stripe fulfillment-mode
// integration (manual vs. relay) -- see docs/PAYMENT_OPERATIONS.md §0.
//
// Run with: node --experimental-strip-types scripts/test-echo-agent-fulfillment.mjs
// Requires `npm run build` to have already produced `.next/` (this
// script runs `next start` against real local ports; it never calls
// Stripe's live API -- webhook signature verification is pure local
// HMAC via the Stripe SDK's own constructEvent/generateTestHeaderString,
// exactly as documented in docs/STRIPE_SETUP.md §3).

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import Stripe from "stripe";
import {
  getFulfillmentMode,
  isStripeTestCheckoutEnabled,
  isStripeLiveSalesEnabled,
} from "../lib/stripe.ts";
import { startFakeS3Server } from "./lib/fakeS3Server.mjs";
import { getEntitlement, getSubscriptionState } from "../lib/entitlement.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEBHOOK_SECRET = "whsec_test_local_dummy_secret_for_signature_testing_only";
const RELAY_SECRET = "relay_test_local_dummy_secret";

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
}

// ---------------------------------------------------------------
// Part A: unit tests (no server) -- fulfillment mode gate + the
// pre-existing test-checkout / live-sales gates (regression).
// ---------------------------------------------------------------

console.log("=== Part A: unit tests ===\n");

resetEnv();
check("Test 9: missing ECHO_AGENT_FULFILLMENT_MODE -> fail-closed (null)", getFulfillmentMode(), null);

resetEnv();
process.env.ECHO_AGENT_FULFILLMENT_MODE = "";
check("Test 9b: empty string -> fail-closed (null)", getFulfillmentMode(), null);

resetEnv();
process.env.ECHO_AGENT_FULFILLMENT_MODE = "automatic";
check("Test 8: invalid value 'automatic' -> fail-closed (null)", getFulfillmentMode(), null);

resetEnv();
process.env.ECHO_AGENT_FULFILLMENT_MODE = "Manual";
check("Test 8b: wrong-case 'Manual' -> fail-closed (null, never guesses)", getFulfillmentMode(), null);

resetEnv();
process.env.ECHO_AGENT_FULFILLMENT_MODE = "manual";
check("Sanity: exact 'manual' -> 'manual'", getFulfillmentMode(), "manual");

resetEnv();
process.env.ECHO_AGENT_FULFILLMENT_MODE = "relay";
check("Sanity: exact 'relay' -> 'relay'", getFulfillmentMode(), "relay");

resetEnv();
process.env.VERCEL_ENV = "production";
process.env.STRIPE_SECRET_KEY = "sk_test_FAKE";
process.env.STRIPE_ECHO_AGENT_PRICE_ID = "price_test_fake";
process.env.STRIPE_TEST_CHECKOUT_ENABLED = "true";
check(
  "Test 10: VERCEL_ENV=production + sk_test_ + STRIPE_TEST_CHECKOUT_ENABLED=true -> hard-blocked",
  isStripeTestCheckoutEnabled(),
  false
);

resetEnv();
process.env.VERCEL_ENV = "preview";
process.env.STRIPE_SECRET_KEY = "sk_live_FAKE";
process.env.STRIPE_SALES_LIVE_ENABLED = "false";
check("Test 11: STRIPE_SALES_LIVE_ENABLED=false -> live gate closed", isStripeLiveSalesEnabled(), false);

resetEnv();

// ---------------------------------------------------------------
// Part B: live HTTP tests against `next start` server instances.
// ---------------------------------------------------------------

function waitForServer(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/echo-agent", timeout: 2000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error(`server on port ${port} did not become ready`));
        else setTimeout(attempt, 500);
      });
      req.on("timeout", () => req.destroy());
    };
    attempt();
  });
}

function startServer(port, extraEnv) {
  // `npx next start` spawns next-server as a grandchild -- killing just
  // this process would leave that grandchild (and the bound port)
  // running. detached:true puts it in its own process group so
  // stopServer can kill the whole group by PID below.
  const child = spawn("npx", ["next", "start", "-p", String(port)], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.once("exit", () => resolve());
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* group already gone */
      }
      resolve();
    }, 5000);
  });
}

function postJson(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(chunks);
          } catch {
            /* non-JSON body -- leave parsed null */
          }
          resolve({ status: res.statusCode, body: parsed, raw: chunks });
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function signedHeaders(payloadString, secret) {
  return { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload: payloadString, secret }) };
}

function checkoutSessionCompletedEvent({ id, product = "echo-agent" }) {
  return {
    id,
    object: "event",
    api_version: "2025-01-01",
    created: Math.floor(Date.now() / 1000),
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_test_${id}`,
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        customer: "cus_test_x",
        payment_intent: "pi_test_x",
        subscription: null,
        customer_details: { email: "buyer@example.com" },
        amount_total: 5000,
        currency: "usd",
        metadata: { product },
      },
    },
  };
}

function subscriptionCheckoutSessionCompletedEvent({ id, subscriptionId, paymentStatus = "paid", product = "echo-agent" }) {
  return {
    id,
    object: "event",
    api_version: "2025-01-01",
    created: Math.floor(Date.now() / 1000),
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_test_${id}`,
        object: "checkout.session",
        mode: "subscription",
        payment_status: paymentStatus,
        customer: "cus_test_x",
        payment_intent: null,
        subscription: subscriptionId,
        customer_details: { email: "buyer@example.com" },
        amount_total: 5000,
        currency: "usd",
        metadata: { product },
      },
    },
  };
}

function subscriptionStatusEvent({ id, subscriptionId, status, type = "customer.subscription.updated", product = "echo-agent" }) {
  return {
    id,
    object: "event",
    api_version: "2025-01-01",
    created: Math.floor(Date.now() / 1000),
    type,
    data: {
      object: {
        id: subscriptionId,
        object: "subscription",
        status,
        customer: "cus_test_x",
        items: { data: [{ price: { id: "price_test_fake_local" } }] },
        metadata: { product },
      },
    },
  };
}

function invoicePaymentFailedEvent({ id, subscriptionId, product = "echo-agent" }) {
  return {
    id,
    object: "event",
    api_version: "2025-01-01",
    created: Math.floor(Date.now() / 1000),
    type: "invoice.payment_failed",
    data: {
      object: {
        id: `in_test_${id}`,
        object: "invoice",
        customer: "cus_test_x",
        customer_email: "buyer@example.com",
        amount_due: 5000,
        currency: "usd",
        parent: { subscription_details: { subscription: subscriptionId, metadata: { product } } },
        lines: { data: [] },
      },
    },
  };
}

async function runAutomaticDownloadModeTests(port, storageEndpoint) {
  console.log(`\n=== Part B5: automatic_download mode (server on :${port}) -- tests 10-16 ===\n`);

  // This test script's own process reads back entitlement/subscription
  // state through the same lib/entitlement.ts functions the server
  // uses, pointed at the same fake S3-compatible backing store.
  process.env.ECHO_AGENT_STORAGE_ENDPOINT = storageEndpoint;
  process.env.ECHO_AGENT_STORAGE_REGION = "auto";
  process.env.ECHO_AGENT_STORAGE_BUCKET = "test-bucket";
  process.env.ECHO_AGENT_STORAGE_ACCESS_KEY_ID = "test";
  process.env.ECHO_AGENT_STORAGE_SECRET_ACCESS_KEY = "test";
  process.env.ECHO_AGENT_STORAGE_FORCE_PATH_STYLE = "true";

  // Test 10: valid checkout.session.completed (one-time payment) -> 2xx
  // and a "ready" entitlement is durably recorded.
  const ev10 = checkoutSessionCompletedEvent({ id: "evt_auto_1" });
  const payload10 = JSON.stringify(ev10);
  const res10 = await postJson(port, "/api/stripe-webhook", payload10, signedHeaders(payload10, WEBHOOK_SECRET));
  check("Test 10: automatic_download + valid paid event -> 2xx", res10.status >= 200 && res10.status < 300, true);
  const entitlement10 = await getEntitlement(`cs_test_evt_auto_1`);
  check("Test 10: entitlement created with status ready", entitlement10?.status, "ready");

  // Test 11: same event.id resent -> no duplicate entitlement write
  // (the entitlement is idempotent-by-construction anyway, but the
  // event-idempotency marker itself must report duplicate:true).
  const res11 = await postJson(port, "/api/stripe-webhook", payload10, signedHeaders(payload10, WEBHOOK_SECRET));
  check("Test 11: duplicate event.id resend -> 2xx", res11.status >= 200 && res11.status < 300, true);
  check("Test 11: duplicate event.id resend -> duplicate:true", res11.body?.duplicate, true);

  // Test 12: unpaid session -> entitlement recorded but NOT ready (no
  // download eligibility from an incomplete payment).
  const ev12 = checkoutSessionCompletedEvent({ id: "evt_auto_unpaid" });
  ev12.data.object.payment_status = "unpaid";
  const payload12 = JSON.stringify(ev12);
  const res12 = await postJson(port, "/api/stripe-webhook", payload12, signedHeaders(payload12, WEBHOOK_SECRET));
  check("Test 12: unpaid session -> 2xx (recorded, not an error)", res12.status >= 200 && res12.status < 300, true);
  const entitlement12 = await getEntitlement("cs_test_evt_auto_unpaid");
  check("Test 12: unpaid session -> entitlement status is pending, not ready", entitlement12?.status, "pending");

  // Test 13: subscription-mode checkout completes -> entitlement ready
  // and the subscription's own status is recorded separately. (The
  // subscription lookup this triggers -- stripe.subscriptions.retrieve
  // -- hits the real Stripe network with a fake test key here and will
  // fail; that failure is caught and logged without failing the whole
  // webhook, per app/api/stripe-webhook/route.ts's own design, so the
  // entitlement itself is still asserted below.)
  const ev13 = subscriptionCheckoutSessionCompletedEvent({ id: "evt_auto_sub_1", subscriptionId: "sub_test_1" });
  const payload13 = JSON.stringify(ev13);
  const res13 = await postJson(port, "/api/stripe-webhook", payload13, signedHeaders(payload13, WEBHOOK_SECRET));
  check("Test 13: subscription checkout completed -> 2xx", res13.status >= 200 && res13.status < 300, true);
  const entitlement13 = await getEntitlement("cs_test_evt_auto_sub_1");
  check("Test 13: subscription entitlement recorded as subscription mode + ready", entitlement13?.mode === "subscription" && entitlement13?.status === "ready", true);

  // Test 14: customer.subscription.deleted -> subscription state
  // recorded as canceled (a later download-token request must treat
  // this subscription as no longer eligible).
  const ev14 = subscriptionStatusEvent({ id: "evt_auto_sub_deleted", subscriptionId: "sub_test_1", status: "canceled", type: "customer.subscription.deleted" });
  const payload14 = JSON.stringify(ev14);
  const res14 = await postJson(port, "/api/stripe-webhook", payload14, signedHeaders(payload14, WEBHOOK_SECRET));
  check("Test 14: subscription deleted event -> 2xx", res14.status >= 200 && res14.status < 300, true);
  const subState14 = await getSubscriptionState("sub_test_1");
  check("Test 14: subscription state updated to canceled", subState14?.status, "canceled");

  // Test 15: invoice.payment_failed -> subscription state updated.
  const ev15 = invoicePaymentFailedEvent({ id: "evt_auto_invoice_failed", subscriptionId: "sub_test_2" });
  const payload15 = JSON.stringify(ev15);
  const res15 = await postJson(port, "/api/stripe-webhook", payload15, signedHeaders(payload15, WEBHOOK_SECRET));
  check("Test 15: invoice.payment_failed -> 2xx", res15.status >= 200 && res15.status < 300, true);
  const subState15 = await getSubscriptionState("sub_test_2");
  check("Test 15: subscription state updated to payment_failed", subState15?.status, "payment_failed");

  // Test 16: unrelated product -> no entitlement created (metadata gate
  // still applies identically to automatic_download mode).
  const ev16 = checkoutSessionCompletedEvent({ id: "evt_auto_unrelated", product: "some-other-product" });
  const payload16 = JSON.stringify(ev16);
  const res16 = await postJson(port, "/api/stripe-webhook", payload16, signedHeaders(payload16, WEBHOOK_SECRET));
  check("Test 16: unrelated product -> 2xx (no entitlement)", res16.status >= 200 && res16.status < 300, true);
  const entitlement16 = await getEntitlement("cs_test_evt_auto_unrelated");
  check("Test 16: unrelated product -> no entitlement was created", entitlement16, null);

  console.log(
    "\nNOTE: live Stripe price/session re-verification (the actual authorization boundary) lives in app/api/echo-agent-download-token/route.ts and is covered by scripts/test-echo-agent-download-auth.mjs for everything except the Stripe network calls themselves, which require a real Sandbox key -- see that script's own note.",
  );
}

async function runManualModeTests(port) {
  console.log(`\n=== Part B1: manual mode (server on :${port}) -- tests 1, 2, 3, 4 ===\n`);

  // Test 1: manual + valid checkout.session.completed + echo-agent -> 2xx
  const ev1 = checkoutSessionCompletedEvent({ id: "evt_manual_1" });
  const payload1 = JSON.stringify(ev1);
  const res1 = await postJson(port, "/api/stripe-webhook", payload1, signedHeaders(payload1, WEBHOOK_SECRET));
  check("Test 1: manual + valid ECHO Agent event -> 2xx", res1.status >= 200 && res1.status < 300, true);
  check("Test 1: response disposition", res1.body?.disposition, "manual_fulfillment_pending");
  check("Test 1: response fulfillmentMode", res1.body?.fulfillmentMode, "manual");

  // Test 2: same event.id resent -> 2xx again, no relay attempted (the
  // ECHO_AGENT_ORDER_WEBHOOK_URL configured for this server points at
  // an unreachable address as a canary -- see startServer call below;
  // manual mode must never reach it, on the first OR second delivery).
  const res2 = await postJson(port, "/api/stripe-webhook", payload1, signedHeaders(payload1, WEBHOOK_SECRET));
  check("Test 2: duplicate event.id resend -> 2xx again", res2.status >= 200 && res2.status < 300, true);
  check("Test 2: duplicate resend disposition unchanged (no external side effect)", res2.body?.disposition, "manual_fulfillment_pending");

  // Test 3: invalid signature -> 400
  const res3 = await postJson(port, "/api/stripe-webhook", payload1, { "stripe-signature": "t=1,v1=deadbeef" });
  check("Test 3: invalid signature -> 400", res3.status, 400);

  // Test 4: unrelated product -> harmless, no ECHO Agent fulfillment,
  // no retry-storm-inducing error status.
  const ev4 = checkoutSessionCompletedEvent({ id: "evt_manual_unrelated", product: "some-other-product" });
  const payload4 = JSON.stringify(ev4);
  const res4 = await postJson(port, "/api/stripe-webhook", payload4, signedHeaders(payload4, WEBHOOK_SECRET));
  check("Test 4: unrelated product -> 2xx (no retry storm)", res4.status >= 200 && res4.status < 300, true);
  check("Test 4: unrelated product -> not treated as ECHO Agent order", res4.body?.ignored, "unrelated_product");
}

async function runRelayUnsetTest(port) {
  console.log(`\n=== Part B2: relay mode, relay env unset (server on :${port}) -- test 5 ===\n`);
  const ev = checkoutSessionCompletedEvent({ id: "evt_relay_unset_1" });
  const payload = JSON.stringify(ev);
  const res = await postJson(port, "/api/stripe-webhook", payload, signedHeaders(payload, WEBHOOK_SECRET));
  check("Test 5: relay mode + relay env unset -> 500 (fail-closed)", res.status, 500);
}

function startMockRelay(port, secret) {
  const seenEventIds = new Set();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      if (parsed.secret !== secret) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      const duplicate = seenEventIds.has(parsed.eventId);
      seenEventIds.add(parsed.eventId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, duplicate }));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function runRelaySuccessTests(port) {
  console.log(`\n=== Part B3: relay mode, relay reachable (server on :${port}) -- tests 6, 7 ===\n`);
  const ev = checkoutSessionCompletedEvent({ id: "evt_relay_success_1" });
  const payload = JSON.stringify(ev);

  const res6 = await postJson(port, "/api/stripe-webhook", payload, signedHeaders(payload, WEBHOOK_SECRET));
  check("Test 6: relay success -> 2xx", res6.status >= 200 && res6.status < 300, true);
  check("Test 6: relay success -> duplicate:false on first delivery", res6.body?.duplicate, false);

  const res7 = await postJson(port, "/api/stripe-webhook", payload, signedHeaders(payload, WEBHOOK_SECRET));
  check("Test 7: relay resend -> 2xx (duplicate handled as normal)", res7.status >= 200 && res7.status < 300, true);
  check("Test 7: relay resend -> duplicate:true surfaced", res7.body?.duplicate, true);
}

async function runFailClosedModeLiveTest(port, extraEnv, label) {
  console.log(`\n=== Part B4: ${label} (server on :${port}) ===\n`);
  const ev = checkoutSessionCompletedEvent({ id: `evt_${label.replace(/\W+/g, "_")}` });
  const payload = JSON.stringify(ev);
  const res = await postJson(port, "/api/stripe-webhook", payload, signedHeaders(payload, WEBHOOK_SECRET));
  check(`${label} -> 500 (fail-closed)`, res.status, 500);
}

const BASE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_FAKE_LOCAL_TESTING_ONLY",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_ECHO_AGENT_PRICE_ID: "price_test_fake_local",
  VERCEL_ENV: "preview",
};

async function main() {
  let manualServer, relayUnsetServer, relaySuccessServer, invalidModeServer, missingModeServer, mockRelay, automaticDownloadServer, fakeS3;
  try {
    manualServer = startServer(3101, {
      ...BASE_ENV,
      ECHO_AGENT_FULFILLMENT_MODE: "manual",
      // Canary: manual mode must NEVER call this -- it's an
      // unreachable address on purpose (see test 2's comment above).
      ECHO_AGENT_ORDER_WEBHOOK_URL: "http://127.0.0.1:1",
      ECHO_AGENT_ORDER_WEBHOOK_SECRET: "unused_canary_secret",
    });
    await waitForServer(3101);
    await runManualModeTests(3101);
  } finally {
    await stopServer(manualServer);
  }

  try {
    relayUnsetServer = startServer(3102, {
      ...BASE_ENV,
      ECHO_AGENT_FULFILLMENT_MODE: "relay",
    });
    await waitForServer(3102);
    await runRelayUnsetTest(3102);
  } finally {
    await stopServer(relayUnsetServer);
  }

  try {
    // Port 3199 was found occupied by an unrelated, already-running
    // process on this shared host (a stale/foreign next-server from a
    // different project) -- moved to 3299 to avoid that collision.
    // Not a product bug; purely a test-harness port choice.
    mockRelay = await startMockRelay(3299, RELAY_SECRET);
    relaySuccessServer = startServer(3103, {
      ...BASE_ENV,
      ECHO_AGENT_FULFILLMENT_MODE: "relay",
      ECHO_AGENT_ORDER_WEBHOOK_URL: "http://127.0.0.1:3299",
      ECHO_AGENT_ORDER_WEBHOOK_SECRET: RELAY_SECRET,
    });
    await waitForServer(3103);
    await runRelaySuccessTests(3103);
  } finally {
    await stopServer(relaySuccessServer);
    if (mockRelay) await new Promise((r) => mockRelay.close(r));
  }

  try {
    invalidModeServer = startServer(3104, {
      ...BASE_ENV,
      ECHO_AGENT_FULFILLMENT_MODE: "automatic",
    });
    await waitForServer(3104);
    await runFailClosedModeLiveTest(3104, {}, "Test 8 (live): invalid ECHO_AGENT_FULFILLMENT_MODE");
  } finally {
    await stopServer(invalidModeServer);
  }

  try {
    // Deliberately NOT `delete missingEnv.ECHO_AGENT_FULFILLMENT_MODE` --
    // `next start` loads .env.local from disk inside the spawned
    // process regardless of what this harness passes via spawn's `env`
    // option, and dotenv-style loaders do not overwrite a key that is
    // already present in process.env. Explicitly setting it to "" (a
    // value getFulfillmentMode() already treats identically to
    // "missing" -- see lib/stripe.ts) survives that auto-load and
    // actually exercises the intended "missing/empty" fail-closed path,
    // instead of silently inheriting .env.local's real
    // ECHO_AGENT_FULFILLMENT_MODE value.
    const missingEnv = { ...BASE_ENV, ECHO_AGENT_FULFILLMENT_MODE: "" };
    missingModeServer = startServer(3105, missingEnv);
    await waitForServer(3105);
    await runFailClosedModeLiveTest(3105, {}, "Test 9 (live): missing ECHO_AGENT_FULFILLMENT_MODE");
  } finally {
    await stopServer(missingModeServer);
  }

  try {
    fakeS3 = await startFakeS3Server("/tmp/echo-agent-fulfillment-test-s3");
    automaticDownloadServer = startServer(3106, {
      ...BASE_ENV,
      ECHO_AGENT_FULFILLMENT_MODE: "automatic_download",
      ECHO_AGENT_STORAGE_ENDPOINT: fakeS3.endpoint,
      ECHO_AGENT_STORAGE_REGION: "auto",
      ECHO_AGENT_STORAGE_BUCKET: "test-bucket",
      ECHO_AGENT_STORAGE_ACCESS_KEY_ID: "test",
      ECHO_AGENT_STORAGE_SECRET_ACCESS_KEY: "test",
      ECHO_AGENT_STORAGE_FORCE_PATH_STYLE: "true",
    });
    await waitForServer(3106);
    await runAutomaticDownloadModeTests(3106, fakeS3.endpoint);
  } finally {
    await stopServer(automaticDownloadServer);
    if (fakeS3) fakeS3.server.close();
  }

  console.log(`\n${passes} passed, ${failures} failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Test run crashed:", error);
  process.exit(1);
});
