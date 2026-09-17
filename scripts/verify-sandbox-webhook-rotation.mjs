// Verifies a rotated Stripe Sandbox webhook secret by triggering ONE genuine
// Stripe-initiated event (a metadata update on an existing real test
// subscription -> customer.subscription.updated) and polling for real,
// unassisted delivery. Never prints any secret value. Never hand-signs
// anything. Never creates a new Checkout Session.
import { readFileSync } from "fs";
import Stripe from "stripe";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

function loadEnvLocal(path) {
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvLocal("/home/silver/echo-r/.env.local");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-08-27.basil" });

const s3 = new S3Client({
  region: process.env.ECHO_AGENT_STORAGE_REGION || "auto",
  endpoint: process.env.ECHO_AGENT_STORAGE_ENDPOINT,
  credentials: {
    accessKeyId: process.env.ECHO_AGENT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.ECHO_AGENT_STORAGE_SECRET_ACCESS_KEY,
  },
});
const BUCKET = process.env.ECHO_AGENT_STORAGE_BUCKET;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const results = {};

  // 1. Find a real, existing test-mode subscription to update (no new Checkout).
  const subs = await stripe.subscriptions.list({ limit: 3, status: "all" });
  if (subs.data.length === 0) {
    results.ERROR = "no_existing_subscription_found";
    console.log(JSON.stringify(results, null, 2));
    process.exit(1);
  }
  const sub = subs.data[0];
  results.SUBSCRIPTION_ID = sub.id;
  results.LIVEMODE = sub.livemode;

  // 2. Trigger a real, safe, harmless update (metadata touch) -> customer.subscription.updated
  const marker = `webhook-secret-rotation-check-${Date.now()}`;
  const updated = await stripe.subscriptions.update(sub.id, {
    metadata: { ...sub.metadata, last_rotation_check: marker },
  });
  results.UPDATE_TRIGGERED = true;

  // 3. Poll Stripe's event list for the resulting event, and check pending_webhooks
  let event = null;
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    const events = await stripe.events.list({
      type: "customer.subscription.updated",
      limit: 5,
    });
    event = events.data.find(
      (e) => e.data.object.id === sub.id && e.data.object.metadata?.last_rotation_check === marker
    );
    if (event) break;
  }
  if (!event) {
    results.ERROR = "event_not_found_after_polling";
    console.log(JSON.stringify(results, null, 2));
    process.exit(1);
  }
  results.EVENT_ID = event.id;
  results.PENDING_WEBHOOKS_AT_DISCOVERY = event.pending_webhooks;

  // 4. Poll again shortly after to see pending_webhooks drop to 0 (real delivery succeeded)
  let finalPending = event.pending_webhooks;
  for (let i = 0; i < 6; i++) {
    await sleep(1500);
    const refreshed = await stripe.events.retrieve(event.id);
    finalPending = refreshed.pending_webhooks;
    if (finalPending === 0) break;
  }
  results.PENDING_WEBHOOKS_FINAL = finalPending;
  results.REAL_DELIVERY_SUCCEEDED = finalPending === 0;

  // 5. Independently confirm via the app's own durable event record in R2 that
  //    signature verification actually happened server-side (not just "Stripe got a 200").
  try {
    const key = `fulfillment/events/${event.id}.json`;
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const chunks = [];
    for await (const c of obj.Body) chunks.push(c);
    const record = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    results.APP_EVENT_RECORD_FOUND = true;
    results.APP_EVENT_RECORD_HAS_PROCESSED_AT = !!record.processedAt;
  } catch (e) {
    results.APP_EVENT_RECORD_FOUND = false;
    results.APP_EVENT_RECORD_ERROR = e.name;
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error("FATAL (no secret values in this message):", e.name, e.message?.slice(0, 300));
  process.exit(1);
});
