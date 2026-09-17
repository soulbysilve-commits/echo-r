#!/usr/bin/env node
// Proves (public-key fingerprint only -- NEVER prints or logs the
// private key) whether a given environment's ECHO_AGENT_LICENSE_PRIVATE_KEY
// derives the SAME Ed25519 public key that is hardcoded as the trust
// root in the shipped Windows binary's echo_agent_license_v1.py
// (_PUBLIC_KEY_B64, see /home/silver/ECHODiscord版/echo_agent_license_v1.py
// line 44 -- a PUBLIC key, safe to hardcode below; this is the exact
// same string, not a placeholder).
//
// Why this script exists / how to run it: Vercel enforces
// ECHO_AGENT_LICENSE_PRIVATE_KEY as a "Sensitive" environment
// variable, which the Vercel API and CLI both refuse to return in
// plaintext to a non-interactive caller (confirmed during this
// audit -- GET /v10/projects/<id>/env?decrypt=true returns
// `decrypted:false` and an empty value for every Sensitive var, and
// `vercel env pull` requires a fresh interactive
// device-code/step-up re-authentication for the same reason). That
// protection is a good thing and this script does not try to work
// around it -- it only works when run by someone who already has that
// value available in their OWN process environment (e.g. the actual
// Vercel serverless runtime itself, or an operator's own terminal
// after they personally complete the interactive `vercel env pull`
// step-up). This script never reads Vercel's API or CLI itself.
//
// Usage: run this with ECHO_AGENT_LICENSE_PRIVATE_KEY already set in
// the process environment (e.g. `vercel env pull --environment
// production .env.production.local` run interactively by the owner,
// then `node -r dotenv/config --experimental-strip-types
// scripts/verify-license-signer-matches-release.mjs
// dotenv_config_path=.env.production.local`, or simply run inside the
// actual Vercel Production runtime as a one-off diagnostic). Prints
// ONLY `MATCH: true` or `MATCH: false` plus the two base64 public
// keys being compared (public keys are not secret) -- never the
// private key, never any derived secret material.

import { createPrivateKey, createPublicKey } from "node:crypto";

// Public verification key hardcoded in the shipped
// echoagent-win-20260913T022010Z-f950a3424ee4 binary's
// echo_agent_license_v1.py (_PUBLIC_KEY_B64). This is a PUBLIC key --
// safe to hardcode and print. If the release is ever rebuilt with a
// rotated trust root, update this constant to match.
const RELEASE_TRUSTED_PUBLIC_KEY_B64 = "ZYKec9jMzVJpqBJI2y9bcXaDdFDuFSFvV4Vn6O6dr5k=";

function main() {
  const raw = process.env.ECHO_AGENT_LICENSE_PRIVATE_KEY;
  if (typeof raw !== "string" || !raw.trim()) {
    console.error("ECHO_AGENT_LICENSE_PRIVATE_KEY is not set in this process's environment. Nothing to check.");
    process.exit(1);
  }

  let publicKeyB64;
  try {
    const der = Buffer.from(raw.trim(), "base64");
    const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const publicKeyObj = createPublicKey(privateKey);
    // Export as raw 32-byte Ed25519 public key, base64 -- matches the
    // format lib/license.ts's comment says is embedded in the binary.
    const jwk = publicKeyObj.export({ format: "jwk" });
    publicKeyB64 = Buffer.from(jwk.x, "base64url").toString("base64");
  } catch (err) {
    console.error("Could not parse ECHO_AGENT_LICENSE_PRIVATE_KEY as a PKCS8 DER Ed25519 private key:", err.message);
    process.exit(1);
  }

  const match = publicKeyB64 === RELEASE_TRUSTED_PUBLIC_KEY_B64;
  console.log(`This environment's derived public key:     ${publicKeyB64}`);
  console.log(`Release-embedded trusted public key:        ${RELEASE_TRUSTED_PUBLIC_KEY_B64}`);
  console.log(`MATCH: ${match}`);
  if (!match) {
    console.error("\nPRODUCTION_LICENSE_TRUST_ROOT_MISMATCH=true -- licenses signed by this environment's private key will NOT be accepted by the shipped binary. Do not enable live sales until this is resolved.");
    process.exit(2);
  }
  process.exit(0);
}

main();
