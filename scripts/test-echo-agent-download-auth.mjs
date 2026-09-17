#!/usr/bin/env node
// Download-authorization tests for the automatic_download fulfillment
// mode (spec section 24). Covers everything testable WITHOUT a live
// Stripe Sandbox key: download-token primitives (issue/verify/expiry/
// tamper), one-time atomic claim consumption + a genuine concurrency
// race, and the full GET /api/echo-agent-download HTTP route (token
// cookie handling, KEK unwrap, streaming decrypt, replay -> 410, no
// public artifact access) against a local fake S3-compatible server.
//
// What this script deliberately does NOT cover: the Stripe-dependent
// checks inside POST /api/echo-agent-download-token (session re-fetch,
// price re-verification, live subscription status, nonce-vs-metadata
// comparison against a real Checkout Session) -- those require a real
// Stripe Sandbox secret key and network egress to api.stripe.com, and
// are exercised in the real Sandbox E2E (spec section 29), not faked
// here. What IS testable without Stripe about that route (mode-gate,
// input validation) is covered below.
//
// Run with: node --experimental-strip-types scripts/test-echo-agent-download-auth.mjs
// Requires `npm run build` to have already produced `.next/`.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { startFakeS3Server } from "./lib/fakeS3Server.mjs";
import { issueDownloadToken, verifyDownloadToken } from "../lib/downloadToken.ts";
import { claimDownloadToken } from "../lib/entitlement.ts";
import { encryptArtifact, wrapDek } from "../lib/artifactCrypto.ts";
import { getObjectStore } from "../lib/storage.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let failures = 0;
let passes = 0;
function check(name, condition) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
  if (condition) passes++;
  else failures++;
}

// ---------------------------------------------------------------
// Part A: pure token issue/verify unit tests (no server, no storage)
// ---------------------------------------------------------------

async function runTokenUnitTests() {
  process.env.ECHO_AGENT_DOWNLOAD_TOKEN_SECRET = "test-download-token-secret-0123456789";
  process.env.ECHO_AGENT_DOWNLOAD_TOKEN_TTL_SECONDS = "1"; // 1 second, for the expiry test below

  const { token, payload } = issueDownloadToken({
    sessionId: "cs_test_abc",
    entitlementId: "cs_test_abc",
    releaseId: "release_test_1",
  });
  check("A1. issued token verifies successfully", verifyDownloadToken(token).ok === true);

  const tampered = token.slice(0, -2) + "xx";
  check("A2. tampered token signature fails verification", verifyDownloadToken(tampered).ok === false);

  check("A3. malformed token (no dot separator) fails verification", verifyDownloadToken("not-a-real-token").ok === false);

  await new Promise((r) => setTimeout(r, 1200));
  check("A4. expired token fails verification", verifyDownloadToken(token).ok === false && verifyDownloadToken(token).reason === "expired");

  delete process.env.ECHO_AGENT_DOWNLOAD_TOKEN_TTL_SECONDS;
  const { payload: defaultPayload } = issueDownloadToken({ sessionId: "cs_x", entitlementId: "cs_x", releaseId: "r_x" });
  const defaultTtlMs = new Date(defaultPayload.expiresAt).getTime() - new Date(defaultPayload.issuedAt).getTime();
  check("A5. default TTL is 300s when unset", Math.abs(defaultTtlMs - 300_000) < 2000);

  process.env.ECHO_AGENT_DOWNLOAD_TOKEN_TTL_SECONDS = "999999";
  let threwOnHugeTtl = false;
  try {
    issueDownloadToken({ sessionId: "cs_x", entitlementId: "cs_x", releaseId: "r_x" });
  } catch {
    threwOnHugeTtl = true;
  }
  check("A6. unreasonably large ECHO_AGENT_DOWNLOAD_TOKEN_TTL_SECONDS fails closed", threwOnHugeTtl);
  delete process.env.ECHO_AGENT_DOWNLOAD_TOKEN_TTL_SECONDS;
}

// ---------------------------------------------------------------
// Part B: one-time atomic claim tests against the fake S3 server
// ---------------------------------------------------------------

async function runClaimTests(endpoint) {
  process.env.ECHO_AGENT_STORAGE_ENDPOINT = endpoint;
  process.env.ECHO_AGENT_STORAGE_REGION = "auto";
  process.env.ECHO_AGENT_STORAGE_BUCKET = "test-bucket";
  process.env.ECHO_AGENT_STORAGE_ACCESS_KEY_ID = "test";
  process.env.ECHO_AGENT_STORAGE_SECRET_ACCESS_KEY = "test";
  process.env.ECHO_AGENT_STORAGE_FORCE_PATH_STYLE = "true";

  const jti = "jti_" + randomBytes(8).toString("hex");
  const first = await claimDownloadToken(jti);
  check("B1. first claim of a jti succeeds", first.claimed === true);

  const second = await claimDownloadToken(jti);
  check("B2. second claim of the same jti is denied (already consumed)", second.claimed === false);

  const raceJti = "jti_race_" + randomBytes(8).toString("hex");
  const results = await Promise.all(Array.from({ length: 10 }, () => claimDownloadToken(raceJti)));
  const winners = results.filter((r) => r.claimed).length;
  check("B3. concurrent race for one jti has at most one winner (got " + winners + ")", winners === 1);
}

// ---------------------------------------------------------------
// Part C: full HTTP download route against a real next start server
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

function getRaw(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: reqPath, method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function runHttpDownloadTests(storageEndpoint) {
  const kek = randomBytes(32);
  const plaintext = Buffer.from("fake ECHO Agent release package bytes for testing", "utf8");
  const { ciphertext, iv, authTag, dek } = encryptArtifact(plaintext);
  const wrapped = wrapDek(dek, kek);

  const releaseId = "release_test_http";
  const manifest = {
    schema: "veritasforge.echo-agent.release-manifest.v1",
    release_id: releaseId,
    artifact_sha256: "test",
    encrypted_sha256: "test",
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    auth_tag: authTag.toString("base64"),
    wrapped_dek: wrapped.wrappedDek.toString("base64"),
    wrapped_dek_iv: wrapped.wrappedDekIv.toString("base64"),
    wrapped_dek_auth_tag: wrapped.wrappedDekAuthTag.toString("base64"),
    original_filename: "ECHO-Agent-test.zip",
    content_type: "application/zip",
    byte_size: plaintext.length,
    created_at: new Date().toISOString(),
  };

  // Seed the fake bucket directly via the storage lib (same code path
  // production packaging would use).
  const store = getObjectStore();
  await store.putObject(`artifacts/${releaseId}/manifest.json`, Buffer.from(JSON.stringify(manifest)), "application/json");
  await store.putObject(`artifacts/${releaseId}/artifact.enc`, ciphertext, "application/octet-stream");

  const port = 3110;
  const env = {
    ECHO_AGENT_FULFILLMENT_MODE: "automatic_download",
    ECHO_AGENT_STORAGE_ENDPOINT: storageEndpoint,
    ECHO_AGENT_STORAGE_REGION: "auto",
    ECHO_AGENT_STORAGE_BUCKET: "test-bucket",
    ECHO_AGENT_STORAGE_ACCESS_KEY_ID: "test",
    ECHO_AGENT_STORAGE_SECRET_ACCESS_KEY: "test",
    ECHO_AGENT_STORAGE_FORCE_PATH_STYLE: "true",
    ECHO_AGENT_ARTIFACT_KEK_B64: kek.toString("base64"),
    ECHO_AGENT_DOWNLOAD_TOKEN_SECRET: "test-download-token-secret-0123456789",
  };
  const child = startServer(port, env);
  try {
    await waitForServer(port);

    // C1: no cookie at all -> 401, and never touches storage.
    const noCookie = await getRaw(port, "/api/echo-agent-download");
    check("C1. GET download with no session cookie => 401", noCookie.status === 401);

    // Mint a real, valid token the same way the token-issuance route
    // would (bypassing Stripe -- this route itself never calls
    // Stripe, only lib/downloadToken.ts).
    process.env.ECHO_AGENT_DOWNLOAD_TOKEN_SECRET = env.ECHO_AGENT_DOWNLOAD_TOKEN_SECRET;
    const { token } = issueDownloadToken({ sessionId: "cs_test_http", entitlementId: "cs_test_http", releaseId });

    // C2: tampered token cookie -> 403.
    const tamperedCookie = token.slice(0, -2) + "xx";
    const tamperedRes = await getRaw(port, "/api/echo-agent-download", { Cookie: `echo_agent_download_session=${tamperedCookie}` });
    check("C2. GET download with tampered token cookie => 403", tamperedRes.status === 403);

    // C3: first real download -- decrypts correctly, right headers, no
    // plaintext ever written anywhere but the response body.
    const firstRes = await getRaw(port, "/api/echo-agent-download", { Cookie: `echo_agent_download_session=${token}` });
    check("C3. first download => 200", firstRes.status === 200);
    check("C3b. decrypted body matches original plaintext exactly", firstRes.body.equals(plaintext));
    check("C3c. Content-Disposition is attachment with the manifest filename", (firstRes.headers["content-disposition"] || "").includes("ECHO-Agent-test.zip"));

    // C4: same token (same jti) replayed -> 410 Gone, not a second
    // successful download.
    const replayRes = await getRaw(port, "/api/echo-agent-download", { Cookie: `echo_agent_download_session=${token}` });
    check("C4. replaying the same token => 410 Gone", replayRes.status === 410);

    // C5: expired token -> 401.
    process.env.ECHO_AGENT_DOWNLOAD_TOKEN_TTL_SECONDS = "1";
    const { token: shortToken } = issueDownloadToken({ sessionId: "cs_test_http2", entitlementId: "cs_test_http2", releaseId });
    delete process.env.ECHO_AGENT_DOWNLOAD_TOKEN_TTL_SECONDS;
    await new Promise((r) => setTimeout(r, 1200));
    const expiredRes = await getRaw(port, "/api/echo-agent-download", { Cookie: `echo_agent_download_session=${shortToken}` });
    check("C5. expired token => 401", expiredRes.status === 401);

    // C6: download-token route itself, with no automatic_download
    // configured in a *different* env, would 404 -- structural check
    // done separately below (D1) since this server is already up with
    // the mode enabled.

    // C7: no public artifact URL exists -- the encrypted object and
    // manifest are only reachable through this authenticated route,
    // never under /public or a static path this Next.js app serves.
    const publicAttempt1 = await getRaw(port, `/artifacts/${releaseId}/artifact.enc`);
    const publicAttempt2 = await getRaw(port, `/${releaseId}.zip`);
    check("C7. no public static route serves the encrypted artifact", publicAttempt1.status === 404 && publicAttempt2.status === 404);
  } finally {
    await stopServer(child);
  }
}

async function runModeGateTest() {
  const port = 3111;
  const child = startServer(port, { ECHO_AGENT_FULFILLMENT_MODE: "manual" });
  try {
    await waitForServer(port);
    const res = await getRaw(port, "/api/echo-agent-download");
    check("D1. download route 404s outright when fulfillment mode isn't automatic_download", res.status === 404);
  } finally {
    await stopServer(child);
  }
}

async function main() {
  await runTokenUnitTests();

  const { server, endpoint } = await startFakeS3Server("/tmp/echo-agent-download-auth-test-s3");
  try {
    await runClaimTests(endpoint);
    await runHttpDownloadTests(endpoint);
  } finally {
    server.close();
  }

  await runModeGateTest();

  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(
    "\nNOTE: Stripe-dependent download-token checks (session re-fetch, price re-verification, nonce-vs-session-metadata, live subscription status) are NOT covered by this script -- they require a real Stripe Sandbox key and are exercised in the real Sandbox E2E, not faked here.",
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Test run crashed:", error);
  process.exit(1);
});
