#!/usr/bin/env node
// OPERATOR tool: additively rewraps an EXISTING release's DEK under a
// NEW, environment-specific KEK, and writes it into that release's
// manifest.json as a new `wrapped_dek_by_env.<env>` entry -- WITHOUT
// touching, re-encrypting, or re-uploading artifact.enc, and WITHOUT
// modifying the manifest's existing top-level wrapped_dek* fields.
// This is the operational form of the proof in
// scripts/test-echo-agent-crypto.mjs (tests 11-18): the same DEK can
// be wrapped under independent KEKs, each producing a different
// ciphertext that only that KEK can unwrap.
//
// This does NOT require the target environment's Vercel deployment to
// be redeployed to take effect -- app/api/echo-agent-download/route.ts
// already reads wrapped_dek_by_env via lib/release.ts selectWrappedDek()
// keyed by ECHO_AGENT_FULFILLMENT_NAMESPACE, and falls back to the
// legacy top-level fields whenever no entry exists for the current
// namespace -- so every OTHER environment/release is completely
// unaffected by running this.
//
// Never run this against a manifest without first reading both KEKs
// from a trusted source (never hardcode either here) -- the "source"
// KEK (already wrapping the release today, needed to recover the
// DEK) and the "new" KEK (the target environment's own
// ECHO_AGENT_ARTIFACT_KEK_B64) are both read from environment
// variables you set before invoking this script, never from a file,
// never printed, never logged.
//
// Usage (example, run by the owner, who supplies both KEK values in
// their own shell session -- NOT executed by this pass; see
// docs/security/ECHO_AGENT_ENV_SECRET_BOUNDARY.md):
//
//   ECHO_AGENT_SOURCE_KEK_B64=<the KEK the manifest is wrapped under today> \
//   ECHO_AGENT_NEW_ENV_KEK_B64=<the new environment's own KEK> \
//   node --experimental-strip-types scripts/add-environment-wrapped-dek.mjs \
//     --release-id echoagent-win-20260913T022010Z-f950a3424ee4 \
//     --env production \
//     [--dry-run]
//
// --dry-run performs the unwrap/rewrap/verify roundtrip and prints a
// summary WITHOUT writing anything back to storage -- always run this
// first.

import { unwrapDek, wrapDek } from "../lib/artifactCrypto.ts";
import { getReleaseManifest, releaseManifestKey } from "../lib/release.ts";
import { getObjectStore } from "../lib/storage.ts";

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--release-id") args.releaseId = argv[++i];
    else if (a === "--env") args.env = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function readKek(envVarName) {
  const raw = process.env[envVarName];
  if (typeof raw !== "string" || !raw.trim()) {
    console.error(`${envVarName} is not set.`);
    return null;
  }
  const buf = Buffer.from(raw.trim(), "base64");
  if (buf.length !== 32) {
    console.error(`${envVarName} is not a valid 32-byte base64 key.`);
    return null;
  }
  return buf;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.releaseId || !args.env) {
    console.error("Usage: add-environment-wrapped-dek.mjs --release-id <id> --env <token> [--dry-run]");
    process.exit(1);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(args.env)) {
    console.error("--env must match the same safe token shape lib/entitlement.ts requires for ECHO_AGENT_FULFILLMENT_NAMESPACE ([a-z0-9][a-z0-9-]{0,31}).");
    process.exit(1);
  }

  const sourceKek = readKek("ECHO_AGENT_SOURCE_KEK_B64");
  const newKek = readKek("ECHO_AGENT_NEW_ENV_KEK_B64");
  if (!sourceKek || !newKek) process.exit(1);
  if (sourceKek.equals(newKek)) {
    console.error("ECHO_AGENT_SOURCE_KEK_B64 and ECHO_AGENT_NEW_ENV_KEK_B64 are identical -- refusing to add a redundant wrap under the same KEK. If you actually intend to share the KEK, no new entry is needed at all.");
    process.exit(1);
  }

  const manifest = await getReleaseManifest(args.releaseId);
  if (!manifest) {
    console.error(`No manifest found for release ${args.releaseId}.`);
    process.exit(1);
  }
  if (manifest.wrapped_dek_by_env?.[args.env]) {
    console.error(`Manifest already has a wrapped_dek_by_env entry for "${args.env}". Refusing to overwrite an existing environment wrap -- remove it first if you really intend to replace it.`);
    process.exit(1);
  }

  let dek;
  try {
    dek = unwrapDek(
      {
        wrappedDek: Buffer.from(manifest.wrapped_dek, "base64"),
        wrappedDekIv: Buffer.from(manifest.wrapped_dek_iv, "base64"),
        wrappedDekAuthTag: Buffer.from(manifest.wrapped_dek_auth_tag, "base64"),
      },
      sourceKek,
    );
  } catch {
    console.error("ECHO_AGENT_SOURCE_KEK_B64 could not unwrap this manifest's existing wrapped_dek -- wrong KEK. Aborting; nothing was written.");
    process.exit(1);
  }

  const rewrapped = wrapDek(dek, newKek);

  // Verification roundtrip before ever touching storage: the NEW wrap
  // must independently unwrap (under the new KEK only) back to the
  // identical DEK, and must NOT be unwrappable under the source KEK.
  const verifyDek = unwrapDek(rewrapped, newKek);
  if (!verifyDek.equals(dek)) {
    console.error("Internal error: rewrap verification failed (recovered DEK did not match). Aborting; nothing was written.");
    process.exit(1);
  }
  let crossUnwrapSucceeded = true;
  try {
    unwrapDek(rewrapped, sourceKek);
  } catch {
    crossUnwrapSucceeded = false;
  }
  if (crossUnwrapSucceeded) {
    console.error("Internal error: the source KEK could unwrap the new wrap -- KEKs were not actually independent. Aborting; nothing was written.");
    process.exit(1);
  }

  console.log(`Verified: release ${args.releaseId}'s DEK rewraps cleanly under a new, independent KEK for environment "${args.env}".`);
  console.log(`  New wrapped_dek differs from the existing one: ${rewrapped.wrappedDek.toString("base64") !== manifest.wrapped_dek}`);
  console.log(`  New wrap unwraps under the NEW KEK to the identical DEK: true`);
  console.log(`  New wrap is NOT unwrappable under the SOURCE KEK: true`);

  if (args.dryRun) {
    console.log("\n--dry-run set: nothing written to storage.");
    process.exit(0);
  }

  const updatedManifest = {
    ...manifest,
    wrapped_dek_by_env: {
      ...(manifest.wrapped_dek_by_env || {}),
      [args.env]: {
        wrapped_dek: rewrapped.wrappedDek.toString("base64"),
        wrapped_dek_iv: rewrapped.wrappedDekIv.toString("base64"),
        wrapped_dek_auth_tag: rewrapped.wrappedDekAuthTag.toString("base64"),
      },
    },
  };

  const store = getObjectStore();
  if (!store) {
    console.error("ECHO_AGENT_STORAGE_* not configured -- cannot write the updated manifest.");
    process.exit(1);
  }
  // Additive overwrite of manifest.json only -- artifact.enc (the
  // large, immutable ciphertext) is never touched or re-uploaded.
  await store.putObject(releaseManifestKey(args.releaseId), Buffer.from(JSON.stringify(updatedManifest)), "application/json");
  console.log(`\nWrote updated manifest.json for release ${args.releaseId} with a new wrapped_dek_by_env["${args.env}"] entry. All other fields (including the legacy top-level wrapped_dek*, used by every environment that doesn't set ECHO_AGENT_FULFILLMENT_NAMESPACE="${args.env}") are byte-for-byte unchanged.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("add-environment-wrapped-dek failed:", error);
  process.exit(1);
});
