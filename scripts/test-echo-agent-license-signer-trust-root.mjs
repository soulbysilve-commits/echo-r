#!/usr/bin/env node
// Golden-vector regression for the 2026-09-18 license-signature
// incident: a synthetic, short-lived license signed with this
// environment's ECHO_AGENT_LICENSE_PRIVATE_KEY was rejected
// (HOLD_LICENSE_INVALID_SIGNATURE) by BOTH the 2026-09-14 and
// 2026-09-16 compiled Windows releases. Root-cause forensics proved
// this was NOT a build/binary defect (both binaries embed the
// identical, historically-proven-correct trust root, byte-for-byte)
// -- it was this local environment's ECHO_AGENT_LICENSE_PRIVATE_KEY
// (.env.local) having drifted away from matching that trust root at
// some point after the 2026-09-14/15 proof in
// docs/security/ECHO_AGENT_ENV_SECRET_BOUNDARY.md sec13/18. Production's
// real Vercel-stored key was independently confirmed never modified
// since 2026-09-13 (createdAt == updatedAt), so this was a local-only
// drift, not a Production incident.
//
// This script never packages, never promotes, never touches Production.
// It only proves the comparison MECHANISM is correct (throwaway
// keypairs) and, if ECHO_AGENT_LICENSE_PRIVATE_KEY happens to be set
// in the process environment when this runs, reports (never fails
// the whole suite on) whether it currently matches the shipped
// trust root -- exactly the check that would have caught this
// incident before it ever reached a Windows smoke test.
//
// Run with: node --experimental-strip-types scripts/test-echo-agent-license-signer-trust-root.mjs

import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";

let passes = 0;
let failures = 0;
function check(name, condition) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
  if (condition) passes++;
  else failures++;
}

// Same constant as scripts/verify-license-signer-matches-release.mjs --
// a PUBLIC key, safe to duplicate here. If the release is ever rebuilt
// with a rotated trust root, update both this and that script together.
const RELEASE_TRUSTED_PUBLIC_KEY_B64 = "ZYKec9jMzVJpqBJI2y9bcXaDdFDuFSFvV4Vn6O6dr5k=";

function derivePublicKeyB64(privateKeyDerB64) {
  const der = Buffer.from(privateKeyDerB64, "base64");
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const publicKeyObj = createPublicKey(privateKey);
  const jwk = publicKeyObj.export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

// --- Mechanism proof: a throwaway keypair must NOT match the real
// trust root (sanity check that this comparison can actually detect
// drift, not just always report true). ---
{
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const derived = derivePublicKeyB64(der);
  check("1. throwaway keypair's derived public key does NOT match the release trust root (mechanism sanity check)", derived !== RELEASE_TRUSTED_PUBLIC_KEY_B64);
}

// --- Mechanism proof: deriving twice from the same private key is
// deterministic (no randomness leaking into the comparison itself). ---
{
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  check("2. public-key derivation is deterministic for a fixed private key", derivePublicKeyB64(der) === derivePublicKeyB64(der));
}

// --- The actual golden-vector gate: if this environment has a real
// ECHO_AGENT_LICENSE_PRIVATE_KEY set (e.g. sourced from .env.local by
// the caller), report -- do not silently ignore -- whether it matches
// the shipped release's trust root. This is a report, not a hard
// process-exit failure, so routine `npm test`-style runs (which never
// have this var set) stay green; a caller that DOES set it gets an
// unambiguous PASS/FAIL in the check list above. ---
{
  const raw = process.env.ECHO_AGENT_LICENSE_PRIVATE_KEY;
  if (typeof raw === "string" && raw.trim()) {
    let derived = null;
    try {
      derived = derivePublicKeyB64(raw.trim());
    } catch {
      derived = null;
    }
    check(
      "3. ECHO_AGENT_LICENSE_PRIVATE_KEY (present in this process's environment) matches the shipped release trust root -- if this fails, DO NOT package/smoke-test/promote using this key",
      derived !== null && derived === RELEASE_TRUSTED_PUBLIC_KEY_B64,
    );
  } else {
    console.log("SKIP 3. ECHO_AGENT_LICENSE_PRIVATE_KEY not set in this process's environment -- nothing to check (this is normal for a plain `npm test`-style run).");
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
