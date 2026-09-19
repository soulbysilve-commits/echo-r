#!/usr/bin/env node
// Deterministic, server-free unit tests for lib/releaseIdentity.ts -- the
// payload behind app/api/release-identity, which veritas-release-
// orchestrator's post-validation uses to prove the LIVE Production
// deployment serves the exact candidate revision, and to derive (as a
// boolean only) whether live sales are enabled.
//
// Covers:
//   1. source_revision / deployment_id / environment are exposed only
//      when they match a strict shape; anything else becomes null.
//   2. sales_live_enabled is the derived RESULT of the real
//      isStripeLiveSalesEnabled() gate -- true only when that gate is
//      genuinely open, false in every other configuration.
//   3. No secret can appear in the payload: the sales flag's value, a
//      key, or any fragment of either -- there is no field to carry one.
//
// Run with: node --experimental-strip-types scripts/test-release-identity.mjs
// Never calls Stripe or the network -- fake env vars only.

import { isStripeLiveSalesEnabled } from "../lib/stripe.ts";
import {
  RELEASE_IDENTITY_SCHEMA,
  buildReleaseIdentity,
  normalizeSourceRevision,
  normalizeDeploymentId,
  normalizeEnvironment,
} from "../lib/releaseIdentity.ts";

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
  delete process.env.STRIPE_SALES_LIVE_ENABLED;
}

const SHA = "541d3c0c14c6acf53c5451eadb5fe7f33a4d918a";
const DPL = "dpl_9egDSysqaiL6UW4XBiRQfu6gfBzc";

console.log("=== release identity: unit tests ===\n");

// 1. Shape validation ------------------------------------------------
check("R1: a 40-hex revision is exposed", normalizeSourceRevision(SHA), SHA);
check("R2: an uppercase revision is normalized to lowercase", normalizeSourceRevision(SHA.toUpperCase()), SHA);
check("R3: an empty revision (hand-made deploy, no build-env) is null", normalizeSourceRevision(""), null);
check("R4: an undefined revision is null", normalizeSourceRevision(undefined), null);
check("R5: a short/abbreviated revision is null, never echoed", normalizeSourceRevision("541d3c0"), null);
check("R6: a non-hex 40-char string is null", normalizeSourceRevision("z".repeat(40)), null);
check("R7: revision with trailing junk is null", normalizeSourceRevision(`${SHA} extra`), null);
check("R8: a well-formed deployment id is exposed", normalizeDeploymentId(DPL), DPL);
check("R9: a deployment id without the dpl_ prefix is null", normalizeDeploymentId("9egDSysqaiL6UW4XBiRQfu6gfBzc"), null);
check("R10: a deployment id with path characters is null", normalizeDeploymentId("dpl_../etc/passwd"), null);
check("R11: production/preview/development are recognized", ["production", "preview", "development"].map(normalizeEnvironment), ["production", "preview", "development"]);
check("R12: an unknown environment is null", normalizeEnvironment("staging"), null);

// 2. Sales boolean derived from the real gate ------------------------
resetEnv();
process.env.STRIPE_SALES_LIVE_ENABLED = "true";
process.env.STRIPE_SECRET_KEY = "sk_live_FAKE";
process.env.VERCEL_ENV = "production";
check("S1: gate open (flag + live key + production) -> sales_live_enabled true",
  buildReleaseIdentity({ VERCEL_ENV: process.env.VERCEL_ENV }, isStripeLiveSalesEnabled()).sales_live_enabled, true);

resetEnv();
process.env.VERCEL_ENV = "production";
check("S2: nothing configured -> sales_live_enabled false",
  buildReleaseIdentity({ VERCEL_ENV: process.env.VERCEL_ENV }, isStripeLiveSalesEnabled()).sales_live_enabled, false);

resetEnv();
process.env.STRIPE_SALES_LIVE_ENABLED = "true";
process.env.VERCEL_ENV = "production";
check("S3: flag without a live key -> sales_live_enabled false",
  buildReleaseIdentity({ VERCEL_ENV: process.env.VERCEL_ENV }, isStripeLiveSalesEnabled()).sales_live_enabled, false);

resetEnv();
process.env.STRIPE_SALES_LIVE_ENABLED = "true";
process.env.STRIPE_SECRET_KEY = "sk_live_FAKE";
process.env.VERCEL_ENV = "preview";
check("S4: flag + live key on a Preview deployment -> sales_live_enabled false",
  buildReleaseIdentity({ VERCEL_ENV: process.env.VERCEL_ENV }, isStripeLiveSalesEnabled()).sales_live_enabled, false);

check("S5: a non-boolean truthy value is never reported as true",
  buildReleaseIdentity({}, "true").sales_live_enabled, false);

// 3. No secret can appear in the payload -----------------------------
resetEnv();
process.env.STRIPE_SALES_LIVE_ENABLED = "true";
process.env.STRIPE_SECRET_KEY = "sk_live_FAKE";
process.env.VERCEL_ENV = "production";
const payload = buildReleaseIdentity(
  { VERITAS_RELEASE_SOURCE_REVISION: SHA, VERCEL_DEPLOYMENT_ID: DPL, VERCEL_ENV: "production" },
  isStripeLiveSalesEnabled(),
);
const serialized = JSON.stringify(payload);
check("P1: payload has exactly the documented fields",
  Object.keys(payload).sort(), ["deployment_id", "environment", "sales_live_enabled", "schema", "source_revision"]);
check("P2: schema id is the documented constant", payload.schema, RELEASE_IDENTITY_SCHEMA);
check("P3: serialized payload never contains the key material", serialized.includes("sk_live"), false);
check("P4: serialized payload never contains the flag name", serialized.includes("STRIPE"), false);
check("P5: sales_live_enabled is a boolean", typeof payload.sales_live_enabled, "boolean");
check("P6: full happy-path payload", payload, {
  schema: RELEASE_IDENTITY_SCHEMA,
  source_revision: SHA,
  deployment_id: DPL,
  environment: "production",
  sales_live_enabled: true,
});
resetEnv();

console.log(`\n=== ${passes} passed, ${failures} failed ===`);
process.exit(failures === 0 ? 0 : 1);
