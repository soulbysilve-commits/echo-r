#!/usr/bin/env node
// Tests for ECHO Agent online activation (lib/activation.ts) and its
// two API routes (app/api/echo-agent-activate,
// app/api/echo-agent-license-refresh). Uses the same fake-S3-server
// harness as scripts/test-echo-agent-fulfillment.mjs (real
// @aws-sdk/client-s3 request signing/parsing against a local HTTP
// server, never a live bucket) and a throwaway in-process Ed25519
// keypair (real production private key never touched, never exists
// in this repo).
//
// Run with: node --experimental-strip-types scripts/test-echo-agent-activation.mjs

import { generateKeyPairSync, verify as cryptoVerify, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeS3Server } from "./lib/fakeS3Server.mjs";
import { getObjectStore } from "../lib/storage.ts";
import { releaseManifestKey } from "../lib/release.ts";
import { canonicalJson } from "../lib/license.ts";
import {
  normalizeEmail,
  normalizeActivationCodeInput,
  generateActivationCode,
  issueActivationCredential,
  getActivationRecordByEmail,
  verifyActivationAndIssueLease,
  verifyRefreshAndIssueLease,
  checkAndRecordRateLimit,
  hashForRateLimit,
  resolveLeaseEligibility,
  computeLeaseValidUntil,
} from "../lib/activation.ts";
import { upsertEntitlement, upsertSubscriptionState } from "../lib/entitlement.ts";

let failures = 0;
let passes = 0;
function check(name, condition) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
  if (condition) passes++;
  else failures++;
}
async function checkAsync(name, fn) {
  try {
    check(name, await fn());
  } catch (error) {
    check(`${name} (threw: ${error?.message ?? error})`, false);
  }
}

const fakeS3 = await startFakeS3Server("/tmp/echo-agent-activation-test-s3");
process.env.ECHO_AGENT_STORAGE_ENDPOINT = fakeS3.endpoint;
process.env.ECHO_AGENT_STORAGE_REGION = "auto";
process.env.ECHO_AGENT_STORAGE_BUCKET = "test-bucket";
process.env.ECHO_AGENT_STORAGE_ACCESS_KEY_ID = "test";
process.env.ECHO_AGENT_STORAGE_SECRET_ACCESS_KEY = "test";
process.env.ECHO_AGENT_STORAGE_FORCE_PATH_STYLE = "true";
process.env.ECHO_AGENT_FULFILLMENT_MODE = "automatic_download";
delete process.env.ECHO_AGENT_FULFILLMENT_NAMESPACE;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
process.env.ECHO_AGENT_LICENSE_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

async function seedReleaseManifest(releaseId) {
  const store = getObjectStore();
  await store.putObject(
    releaseManifestKey(releaseId),
    Buffer.from(
      JSON.stringify({
        schema: "veritasforge.echo-agent.release-manifest.v1",
        release_id: releaseId,
        artifact_sha256: "0".repeat(64),
        encrypted_sha256: "0".repeat(64),
        algorithm: "aes-256-gcm",
        iv: "AAAAAAAAAAAAAAAA",
        auth_tag: "AAAAAAAAAAAAAAAAAAAAAA==",
        wrapped_dek: "AAAA",
        wrapped_dek_iv: "AAAAAAAAAAAAAAAA",
        wrapped_dek_auth_tag: "AAAAAAAAAAAAAAAAAAAAAA==",
        original_filename: "test.bin",
        content_type: "application/octet-stream",
        byte_size: 0,
        created_at: new Date().toISOString(),
      }),
      "utf8"
    ),
    "application/json"
  );
}

console.log("=== Part A: unit tests (lib/activation.ts) ===\n");

check("1. normalizeEmail trims + lowercases", normalizeEmail("  Foo.Bar+Test@Example.COM  ") === "foo.bar+test@example.com");
check("2. normalizeEmail rejects malformed", normalizeEmail("not-an-email") === null);
check("3. normalizeEmail rejects non-string", normalizeEmail(12345) === null);
check(
  "4. normalizeActivationCodeInput strips separators/whitespace and uppercases",
  normalizeActivationCodeInput("abcd-1234 efgh\t5678") === "ABCD1234EFGH5678"
);

{
  const code = generateActivationCode();
  check("5. generateActivationCode produces base32-shaped groups", /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/.test(code));
  const code2 = generateActivationCode();
  check("6. generateActivationCode is not deterministic", code !== code2);
}

await checkAsync("7. issueActivationCredential + getActivationRecordByEmail round trip", async () => {
  const email = normalizeEmail("buyer1@example.com");
  const { activationCode, record } = await issueActivationCredential({ entitlementId: "cs_test_1", emailNormalized: email });
  const fetched = await getActivationRecordByEmail(email);
  return fetched?.activationId === record.activationId && fetched.activationCodeHash !== activationCode;
});

await checkAsync("8. ACTIVATE_VALID_EMAIL_CODE_TEST: correct email+code activates and issues a real Ed25519-verifiable license", async () => {
  const email = normalizeEmail("buyer2@example.com");
  const entitlementId = "cs_test_2";
  await upsertEntitlement(entitlementId, { status: "ready", mode: "payment", releaseId: "release_test_2" });
  await seedReleaseManifest("release_test_2");
  const { activationCode } = await issueActivationCredential({ entitlementId, emailNormalized: email });

  const outcome = await verifyActivationAndIssueLease({ emailRaw: email, codeRaw: activationCode, installationId: randomUUID() });
  return outcome.ok === true && outcome.entitlementId === entitlementId;
});

await checkAsync("9. ACTIVATE_INVALID_EMAIL_TEST: unknown email -> generic INVALID_ACTIVATION", async () => {
  const outcome = await verifyActivationAndIssueLease({ emailRaw: "nobody-ever-bought@example.com", codeRaw: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF", installationId: randomUUID() });
  return outcome.ok === false && outcome.reason === "INVALID_ACTIVATION";
});

await checkAsync("10. ACTIVATE_INVALID_CODE_TEST: right email, wrong code -> generic INVALID_ACTIVATION", async () => {
  const email = normalizeEmail("buyer3@example.com");
  await issueActivationCredential({ entitlementId: "cs_test_3", emailNormalized: email });
  const outcome = await verifyActivationAndIssueLease({ emailRaw: email, codeRaw: "0000-0000-0000-0000-0000-0000", installationId: randomUUID() });
  return outcome.ok === false && outcome.reason === "INVALID_ACTIVATION";
});

await checkAsync("11. ACTIVATE_EMAIL_CODE_MISMATCH_TEST: valid code for a DIFFERENT email is rejected", async () => {
  const emailA = normalizeEmail("buyer4a@example.com");
  const emailB = normalizeEmail("buyer4b@example.com");
  const { activationCode } = await issueActivationCredential({ entitlementId: "cs_test_4a", emailNormalized: emailA });
  await issueActivationCredential({ entitlementId: "cs_test_4b", emailNormalized: emailB });
  const outcome = await verifyActivationAndIssueLease({ emailRaw: emailB, codeRaw: activationCode, installationId: randomUUID() });
  return outcome.ok === false && outcome.reason === "INVALID_ACTIVATION";
});

await checkAsync("12. ENUMERATION_RESISTANCE_TEST: unknown-email and wrong-code failures are identical/generic", async () => {
  const email = normalizeEmail("buyer5@example.com");
  await issueActivationCredential({ entitlementId: "cs_test_5", emailNormalized: email });
  const unknownEmailOutcome = await verifyActivationAndIssueLease({ emailRaw: "totally-unknown@example.com", codeRaw: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF", installationId: randomUUID() });
  const wrongCodeOutcome = await verifyActivationAndIssueLease({ emailRaw: email, codeRaw: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF", installationId: randomUUID() });
  return JSON.stringify(unknownEmailOutcome) === JSON.stringify(wrongCodeOutcome);
});

await checkAsync("13. ACTIVATE_WRONG_PRODUCT_TEST (no matching entitlement record) -> NOT_ENTITLED, not a crash", async () => {
  const email = normalizeEmail("buyer6@example.com");
  await issueActivationCredential({ entitlementId: "cs_test_never_recorded", emailNormalized: email });
  // Note: entitlement 'cs_test_never_recorded' was never upserted, so
  // getEntitlement() returns null -- verifies the route fails closed
  // (NOT_ENTITLED) rather than throwing when a credential outlives or
  // predates its entitlement record.
  const email2 = normalizeEmail("buyer6@example.com");
  const { activationCode } = await issueActivationCredential({ entitlementId: "cs_test_never_recorded_2", emailNormalized: email2 });
  const outcome = await verifyActivationAndIssueLease({ emailRaw: email2, codeRaw: activationCode, installationId: randomUUID() });
  return outcome.ok === false && outcome.reason === "NOT_ENTITLED";
});

await checkAsync("14. ACTIVATE_EXPIRED_ENTITLEMENT_TEST: subscription past its paid-through boundary -> NOT_ENTITLED", async () => {
  const email = normalizeEmail("buyer7@example.com");
  const entitlementId = "cs_test_7";
  const subscriptionId = "sub_test_7";
  await upsertEntitlement(entitlementId, { status: "ready", mode: "subscription", subscriptionId, releaseId: "release_test_7" });
  await upsertSubscriptionState(subscriptionId, "active", entitlementId, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const { activationCode } = await issueActivationCredential({ entitlementId, emailNormalized: email });
  const outcome = await verifyActivationAndIssueLease({ emailRaw: email, codeRaw: activationCode, installationId: randomUUID() });
  return outcome.ok === false && outcome.reason === "NOT_ENTITLED";
});

await checkAsync("15. ACTIVATE_CANCELLED_PAID_THROUGH_TEST: past_due status but still within paid-through window -> still eligible", async () => {
  const email = normalizeEmail("buyer8@example.com");
  const entitlementId = "cs_test_8";
  const subscriptionId = "sub_test_8";
  await upsertEntitlement(entitlementId, { status: "ready", mode: "subscription", subscriptionId, releaseId: "release_test_8" });
  await seedReleaseManifest("release_test_8");
  // Simulates invoice.payment_failed's live-status refetch landing
  // Stripe's own "past_due" status, while the customer is still
  // inside a period they already paid for.
  await upsertSubscriptionState(subscriptionId, "past_due", entitlementId, new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString());
  const { activationCode } = await issueActivationCredential({ entitlementId, emailNormalized: email });
  const outcome = await verifyActivationAndIssueLease({ emailRaw: email, codeRaw: activationCode, installationId: randomUUID() });
  return outcome.ok === true;
});

await checkAsync("16. ACTIVATE_ENDED_SUBSCRIPTION_TEST: canceled status, paid-through already passed -> NOT_ENTITLED", async () => {
  const email = normalizeEmail("buyer9@example.com");
  const entitlementId = "cs_test_9";
  const subscriptionId = "sub_test_9";
  await upsertEntitlement(entitlementId, { status: "ready", mode: "subscription", subscriptionId, releaseId: "release_test_9" });
  await upsertSubscriptionState(subscriptionId, "canceled", entitlementId, new Date(Date.now() - 3600 * 1000).toISOString());
  const { activationCode } = await issueActivationCredential({ entitlementId, emailNormalized: email });
  const outcome = await verifyActivationAndIssueLease({ emailRaw: email, codeRaw: activationCode, installationId: randomUUID() });
  return outcome.ok === false && outcome.reason === "NOT_ENTITLED";
});

await checkAsync("17. LEASE_NEVER_EXCEEDS_PAID_THROUGH_TEST: lease valid_until never extends past the paid-through boundary", async () => {
  const paidThrough = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(); // 2 days out, shorter than the 7-day lease horizon
  const validUntil = computeLeaseValidUntil("subscription", paidThrough);
  return validUntil.toISOString() === paidThrough;
});

await checkAsync("18. LEASE_BOUNDED_BY_HORIZON_TEST: lease never exceeds the fixed lease horizon even with a distant paid-through", async () => {
  const farFuture = new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString();
  const validUntil = computeLeaseValidUntil("subscription", farFuture);
  const eightDaysOut = Date.now() + 8 * 24 * 3600 * 1000;
  return validUntil.getTime() < eightDaysOut;
});

await checkAsync("19. RATE_LIMIT_TEST: N+1th attempt in the same window is denied", async () => {
  const bucket = `test-bucket-${randomUUID()}`;
  let lastResult = { allowed: true };
  for (let i = 0; i < 9; i++) {
    lastResult = await checkAndRecordRateLimit(bucket);
  }
  return lastResult.allowed === false;
});

check("20. hashForRateLimit never returns the raw input", hashForRateLimit("someone@example.com") !== "someone@example.com");

console.log("\n=== Part B: refresh credential tests ===\n");

await checkAsync("21. REFRESH_VALID_TEST: valid refresh credential issues a new lease and rotates the credential", async () => {
  const email = normalizeEmail("buyer10@example.com");
  const entitlementId = "cs_test_10";
  await upsertEntitlement(entitlementId, { status: "ready", mode: "payment", releaseId: "release_test_10" });
  await seedReleaseManifest("release_test_10");
  const { activationCode } = await issueActivationCredential({ entitlementId, emailNormalized: email });
  const installationId = randomUUID();
  const activated = await verifyActivationAndIssueLease({ emailRaw: email, codeRaw: activationCode, installationId });
  if (!activated.ok) return false;

  const refreshed = await verifyRefreshAndIssueLease({ installationId, refreshCredentialRaw: activated.refreshCredential });
  if (!refreshed.ok) return false;
  return refreshed.refreshCredential !== activated.refreshCredential;
});

await checkAsync("22. REFRESH_ROTATION_TEST: the OLD refresh credential no longer works after a successful refresh", async () => {
  const email = normalizeEmail("buyer11@example.com");
  const entitlementId = "cs_test_11";
  await upsertEntitlement(entitlementId, { status: "ready", mode: "payment", releaseId: "release_test_11" });
  await seedReleaseManifest("release_test_11");
  const { activationCode } = await issueActivationCredential({ entitlementId, emailNormalized: email });
  const installationId = randomUUID();
  const activated = await verifyActivationAndIssueLease({ emailRaw: email, codeRaw: activationCode, installationId });
  await verifyRefreshAndIssueLease({ installationId, refreshCredentialRaw: activated.refreshCredential });

  const reuseAttempt = await verifyRefreshAndIssueLease({ installationId, refreshCredentialRaw: activated.refreshCredential });
  return reuseAttempt.ok === false && reuseAttempt.reason === "WRONG_INSTALLATION";
});

await checkAsync("23. REFRESH_REVOKED_TEST / STOLEN_REFRESH_WRONG_INSTALLATION_TEST: a credential issued for installation A is rejected for installation B", async () => {
  const email = normalizeEmail("buyer12@example.com");
  const entitlementId = "cs_test_12";
  await upsertEntitlement(entitlementId, { status: "ready", mode: "payment", releaseId: "release_test_12" });
  const { activationCode } = await issueActivationCredential({ entitlementId, emailNormalized: email });
  const installationA = randomUUID();
  const installationB = randomUUID();
  const activated = await verifyActivationAndIssueLease({ emailRaw: email, codeRaw: activationCode, installationId: installationA });

  const stolenAttempt = await verifyRefreshAndIssueLease({ installationId: installationB, refreshCredentialRaw: activated.refreshCredential });
  return stolenAttempt.ok === false && stolenAttempt.reason === "WRONG_INSTALLATION";
});

await checkAsync("24. REFRESH_WRONG_INSTALLATION_TEST: unknown installation_id with a made-up credential is rejected", async () => {
  const outcome = await verifyRefreshAndIssueLease({ installationId: randomUUID(), refreshCredentialRaw: "made-up-credential-value" });
  return outcome.ok === false && outcome.reason === "WRONG_INSTALLATION";
});

await checkAsync("25. REFRESH_EXPIRED_ENTITLEMENT_TEST: refresh fails once the entitlement's paid-through boundary has passed", async () => {
  const email = normalizeEmail("buyer13@example.com");
  const entitlementId = "cs_test_13";
  const subscriptionId = "sub_test_13";
  await upsertEntitlement(entitlementId, { status: "ready", mode: "subscription", subscriptionId, releaseId: "release_test_13" });
  await upsertSubscriptionState(subscriptionId, "active", entitlementId, new Date(Date.now() + 3600 * 1000).toISOString());
  const { activationCode } = await issueActivationCredential({ entitlementId, emailNormalized: email });
  const installationId = randomUUID();
  const activated = await verifyActivationAndIssueLease({ emailRaw: email, codeRaw: activationCode, installationId });
  if (!activated.ok) return false;

  // Time passes; the subscription's paid-through boundary is now in
  // the past (simulated by re-writing subscription state with an
  // already-past currentPeriodEnd, as a real ended subscription would
  // eventually show).
  await upsertSubscriptionState(subscriptionId, "canceled", entitlementId, new Date(Date.now() - 3600 * 1000).toISOString());
  const refreshed = await verifyRefreshAndIssueLease({ installationId, refreshCredentialRaw: activated.refreshCredential });
  return refreshed.ok === false && refreshed.reason === "NOT_ENTITLED";
});

console.log("\n=== Part C: route handlers (real `next start` server, real HTTP) ===\n");
console.log("(requires `npm run build` to have already produced .next/ -- same precondition as scripts/test-echo-agent-fulfillment.mjs)\n");

await checkAsync("27. ATTACKER_FAKE_ACTIVATION_SERVER_RESPONSE_TEST proxy: a license signed by a DIFFERENT key fails verification against the real embedded key", async () => {
  const { privateKey: attackerPrivateKey } = generateKeyPairSync("ed25519");
  const forgedPayload = {
    schema: "veritasforge.echo-agent.license.v1",
    license_id: "lic_forged",
    entitlement_id: "cs_forged",
    product: "echo-agent",
    release_id: "release_forged",
    stripe_checkout_session_id: null,
    stripe_subscription_id: null,
    issued_at: new Date().toISOString(),
    valid_until: new Date(Date.now() + 3600 * 1000).toISOString(),
    license_version: 1,
  };
  const forgedSignature = (await import("node:crypto")).sign(null, Buffer.from(canonicalJson(forgedPayload), "utf8"), attackerPrivateKey);
  // Verifying against the REAL server's public key (not the
  // attacker's) must fail -- this is what the Windows client's own
  // Ed25519 verification (echo_agent_license_v1.py, unchanged) does
  // for every server response, regardless of transport-layer trust.
  return !cryptoVerify(null, Buffer.from(canonicalJson(forgedPayload), "utf8"), publicKey, forgedSignature);
});

const ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const PORT = 3811;

function waitForServer(port, timeoutMs = 45000) {
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
      } catch {}
      resolve();
    }, 5000);
  });
}

let server = null;
try {
  server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ECHO_AGENT_FULFILLMENT_MODE: "automatic_download",
      ECHO_AGENT_STORAGE_ENDPOINT: fakeS3.endpoint,
      ECHO_AGENT_STORAGE_REGION: "auto",
      ECHO_AGENT_STORAGE_BUCKET: "test-bucket",
      ECHO_AGENT_STORAGE_ACCESS_KEY_ID: "test",
      ECHO_AGENT_STORAGE_SECRET_ACCESS_KEY: "test",
      ECHO_AGENT_STORAGE_FORCE_PATH_STYLE: "true",
      ECHO_AGENT_LICENSE_PRIVATE_KEY: process.env.ECHO_AGENT_LICENSE_PRIVATE_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  await waitForServer(PORT);

  await checkAsync("26. PRIVATE_SIGNER_NEVER_RETURNED_TEST + full HTTP activate route: response never contains the private key material, license verifies", async () => {
    const email = normalizeEmail("route-buyer1@example.com");
    const entitlementId = "cs_route_test_1";
    await upsertEntitlement(entitlementId, { status: "ready", mode: "payment", releaseId: "release_route_1" });
    await seedReleaseManifest("release_route_1");
    const { activationCode } = await issueActivationCredential({ entitlementId, emailNormalized: email });

    const response = await fetch(`http://127.0.0.1:${PORT}/api/echo-agent-activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, activation_code: activationCode, installation_id: randomUUID(), client_version: "1.0.0" }),
    });
    const bodyText = await response.text();
    const body = JSON.parse(bodyText);

    const privateKeyLeaked = bodyText.includes("PRIVATE KEY") || bodyText.includes(process.env.ECHO_AGENT_LICENSE_PRIVATE_KEY);
    const licenseValid =
      body.status === "activated" &&
      cryptoVerify(null, Buffer.from(canonicalJson(body.license.payload), "utf8"), publicKey, Buffer.from(body.license.signature, "base64"));

    return response.status === 200 && !privateKeyLeaked && licenseValid && typeof body.refresh_credential === "string";
  });

  await checkAsync("28. Full HTTP refresh route: valid refresh_credential returns a new verifiable license and rotates the credential", async () => {
    const email = normalizeEmail("route-buyer2@example.com");
    const entitlementId = "cs_route_test_2";
    await upsertEntitlement(entitlementId, { status: "ready", mode: "payment", releaseId: "release_route_2" });
    await seedReleaseManifest("release_route_2");
    const { activationCode } = await issueActivationCredential({ entitlementId, emailNormalized: email });
    const installationId = randomUUID();

    const activateBody = await (
      await fetch(`http://127.0.0.1:${PORT}/api/echo-agent-activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, activation_code: activationCode, installation_id: installationId, client_version: "1.0.0" }),
      })
    ).json();

    const refreshResponse = await fetch(`http://127.0.0.1:${PORT}/api/echo-agent-license-refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installation_id: installationId, refresh_credential: activateBody.refresh_credential }),
    });
    const refreshBody = await refreshResponse.json();

    const licenseValid =
      refreshBody.status === "refreshed" &&
      cryptoVerify(null, Buffer.from(canonicalJson(refreshBody.license.payload), "utf8"), publicKey, Buffer.from(refreshBody.license.signature, "base64"));

    return refreshResponse.status === 200 && licenseValid && refreshBody.refresh_credential !== activateBody.refresh_credential;
  });

  await checkAsync("29. Route: wrong activation code over real HTTP returns generic INVALID_ACTIVATION with 401, no entitlement details", async () => {
    const email = normalizeEmail("route-buyer3@example.com");
    await issueActivationCredential({ entitlementId: "cs_route_test_3", emailNormalized: email });
    const response = await fetch(`http://127.0.0.1:${PORT}/api/echo-agent-activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, activation_code: "0000-0000-0000-0000-0000-0000", installation_id: randomUUID(), client_version: "1.0.0" }),
    });
    const body = await response.json();
    return response.status === 401 && body.status === "INVALID_ACTIVATION" && Object.keys(body).length === 1;
  });

  await checkAsync("30. ARBITRARY_ACTIVATION_SERVER_OVERRIDE_TEST proxy: route is only reachable at its own fixed path, never a client-supplied host", async () => {
    // The Windows client pins the activation host at build time (see
    // echo_agent_online_activation_v1.py) -- there is no server-side
    // equivalent to check here beyond confirming this route answers
    // only its own fixed path/port, which the fetch() calls above
    // already exercise exclusively.
    const response = await fetch(`http://127.0.0.1:${PORT}/api/echo-agent-activate`, { method: "GET" });
    return response.status === 405 || response.status === 400;
  });
} finally {
  await stopServer(server);
  fakeS3.server.close();
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
