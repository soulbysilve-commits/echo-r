#!/usr/bin/env node
// Crypto primitive tests for the automatic_download fulfillment mode:
// AES-256-GCM artifact envelope encryption (lib/artifactCrypto.ts) and
// Ed25519 license issuance (lib/license.ts). See section 22 of the
// integration spec for the required case list.
//
// Full license *verification* semantics (schema/expiry/product/
// tamper/wrong-key/private-key-absence) are tested on the verifying
// side in the ECHODiscord版 repo's test_echo_agent_license_v1.py,
// since that is where the real verifier lives -- this script covers
// the issuing side and the raw crypto primitives only.
//
// Run with: node --experimental-strip-types scripts/test-echo-agent-crypto.mjs

import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import {
  generateDek,
  encryptArtifact,
  decryptArtifact,
  wrapDek,
  unwrapDek,
  constantTimeEqualHex,
  getArtifactKek,
} from "../lib/artifactCrypto.ts";
import { issueLicense, canonicalJson } from "../lib/license.ts";
import { selectWrappedDek } from "../lib/release.ts";

let failures = 0;
let passes = 0;
function check(name, condition) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
  if (condition) passes++;
  else failures++;
}

function expectThrow(name, fn) {
  try {
    fn();
    check(name, false);
  } catch {
    check(name, true);
  }
}

// --- AES-256-GCM artifact envelope tests ---

{
  const plaintext = Buffer.from("ECHO Agent release artifact bytes (test fixture)", "utf8");
  const { ciphertext, iv, authTag, dek } = encryptArtifact(plaintext);
  const decrypted = decryptArtifact(ciphertext, dek, iv, authTag);
  check("1. AES-256-GCM encrypt/decrypt roundtrip", decrypted.equals(plaintext));
}

{
  const plaintext = Buffer.from("tamper test payload", "utf8");
  const { ciphertext, iv, authTag, dek } = encryptArtifact(plaintext);
  const tampered = Buffer.from(ciphertext);
  tampered[0] ^= 0xff;
  expectThrow("2. ciphertext tamper => decrypt fails", () => decryptArtifact(tampered, dek, iv, authTag));
}

{
  const plaintext = Buffer.from("auth tag tamper test payload", "utf8");
  const { ciphertext, iv, authTag, dek } = encryptArtifact(plaintext);
  const tamperedTag = Buffer.from(authTag);
  tamperedTag[0] ^= 0xff;
  expectThrow("3. auth tag tamper => decrypt fails", () => decryptArtifact(ciphertext, dek, iv, tamperedTag));
}

{
  const dek = generateDek();
  const kek = generateDek(); // any 32 random bytes works as a KEK for this test
  const wrongKek = generateDek();
  const wrapped = wrapDek(dek, kek);
  expectThrow("4. wrong KEK => unwrap fails", () => unwrapDek(wrapped, wrongKek));
}

{
  const plaintext = Buffer.from("wrong DEK test payload", "utf8");
  const { ciphertext, iv, authTag } = encryptArtifact(plaintext);
  const wrongDek = generateDek();
  expectThrow("5. wrong DEK => decrypt fails", () => decryptArtifact(ciphertext, wrongDek, iv, authTag));
}

{
  const dek = generateDek();
  const kek = generateDek();
  const wrapped = wrapDek(dek, kek);
  const unwrapped = unwrapDek(wrapped, kek);
  check("5b. DEK wrap/unwrap roundtrip", unwrapped.equals(dek));
}

{
  const a = "aabbcc";
  check("5c. constant-time hex compare: equal => true", constantTimeEqualHex(a, "aabbcc"));
  check("5d. constant-time hex compare: different => false", !constantTimeEqualHex(a, "aabbcd"));
  check("5e. constant-time hex compare: length mismatch => false (no throw)", !constantTimeEqualHex(a, "aabb"));
}

// --- getArtifactKek(): Vercel Sensitive-placeholder hardening ---
// (2026-09-18 incident: `vercel env pull` cannot return plaintext for a
// Sensitive-typed var and writes the literal "[SENSITIVE]" placeholder
// instead; a naive parser that fed that placeholder in as the KEK produced
// a raw string of length 13 (quoted) that lenient base64-decodes to 6
// bytes. getArtifactKek() already failed closed on the wrong byte length --
// these tests additionally prove the placeholder is recognized explicitly.)

{
  const original = process.env.ECHO_AGENT_ARTIFACT_KEK_B64;

  process.env.ECHO_AGENT_ARTIFACT_KEK_B64 = generateDek().toString("base64");
  check("19. getArtifactKek: real 32-byte base64 KEK accepted", getArtifactKek() !== null);

  process.env.ECHO_AGENT_ARTIFACT_KEK_B64 = "[SENSITIVE]";
  check("20. getArtifactKek: unquoted Vercel Sensitive placeholder rejected", getArtifactKek() === null);

  process.env.ECHO_AGENT_ARTIFACT_KEK_B64 = '"[SENSITIVE]"';
  check("21. getArtifactKek: quoted Vercel Sensitive placeholder rejected", getArtifactKek() === null);

  const placeholderStripped = '"[SENSITIVE]"'.replace(/^["']|["']$/g, "");
  const placeholderDecoded = Buffer.from(placeholderStripped, "base64");
  check(
    "22. getArtifactKek: observed 13-char/6-byte placeholder signature reproduced and never treated as a valid KEK",
    '"[SENSITIVE]"'.length === 13 && placeholderDecoded.length === 6 && getArtifactKek() === null,
  );

  process.env.ECHO_AGENT_ARTIFACT_KEK_B64 = "not-valid-base64-and-too-short";
  check("23. getArtifactKek: invalid/short input rejected", getArtifactKek() === null);

  process.env.ECHO_AGENT_ARTIFACT_KEK_B64 = generateDek().subarray(0, 16).toString("base64");
  check("24. getArtifactKek: valid base64 decoding to a length != 32 bytes rejected", getArtifactKek() === null);

  {
    const originalConsoleError = console.error;
    let captured = [];
    console.error = (...args) => {
      captured.push(args.join(" "));
    };
    process.env.ECHO_AGENT_ARTIFACT_KEK_B64 = "[SENSITIVE]";
    getArtifactKek();
    console.error = originalConsoleError;
    const message = captured.join("\n");
    check(
      "25. getArtifactKek: placeholder rejection emits a fixed, non-secret diagnostic (no interpolated value)",
      message === "ECHO_AGENT_ARTIFACT_KEK_B64 is the Vercel Sensitive-variable placeholder; plaintext KEK is not available through env pull.",
    );
  }

  if (original === undefined) delete process.env.ECHO_AGENT_ARTIFACT_KEK_B64;
  else process.env.ECHO_AGENT_ARTIFACT_KEK_B64 = original;
}

// --- Ed25519 license issuance tests ---

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privDer = privateKey.export({ type: "pkcs8", format: "der" });
process.env.ECHO_AGENT_LICENSE_PRIVATE_KEY = privDer.toString("base64");

{
  const envelope = issueLicense({
    entitlementId: "cs_test_fixture",
    releaseId: "release_test_fixture",
    stripeCheckoutSessionId: "cs_test_fixture",
    stripeSubscriptionId: null,
    validUntil: new Date(Date.now() + 365 * 24 * 3600 * 1000),
  });
  const data = Buffer.from(canonicalJson(envelope.payload), "utf8");
  const signature = Buffer.from(envelope.signature, "base64");
  check("6. Ed25519 valid signature verifies", cryptoVerify(null, data, publicKey, signature));

  const tamperedPayload = { ...envelope.payload, entitlement_id: "cs_attacker_injected" };
  const tamperedData = Buffer.from(canonicalJson(tamperedPayload), "utf8");
  check("7. Ed25519 tampered payload fails verification", !cryptoVerify(null, tamperedData, publicKey, signature));

  const { publicKey: otherPublicKey } = generateKeyPairSync("ed25519");
  check("8. Ed25519 wrong public key fails verification", !cryptoVerify(null, data, otherPublicKey, signature));

  check("9. issued license has schema/product/version fields set", envelope.payload.schema === "veritasforge.echo-agent.license.v1" && envelope.payload.product === "echo-agent" && envelope.payload.license_version === 1);
}

{
  delete process.env.ECHO_AGENT_LICENSE_PRIVATE_KEY;
  expectThrow("10. issueLicense throws when signing is not configured (private key absence fails closed)", () =>
    issueLicense({
      entitlementId: "x",
      releaseId: "x",
      stripeCheckoutSessionId: null,
      stripeSubscriptionId: null,
      validUntil: new Date(),
    }),
  );
}

// --- Envelope encryption: same artifact.enc, independent per-environment
// KEK wraps of the identical DEK (see lib/release.ts selectWrappedDek
// and docs/security/ECHO_AGENT_ENV_SECRET_BOUNDARY.md) ---

{
  const plaintext = Buffer.from("shared immutable artifact.enc bytes, same for every environment", "utf8");
  const { ciphertext, iv, authTag, dek } = encryptArtifact(plaintext);

  const sandboxKek = generateDek();
  const productionKek = generateDek();
  check("11. synthetic Sandbox/Production KEKs differ", !sandboxKek.equals(productionKek));

  const legacyWrap = wrapDek(dek, sandboxKek); // stands in for the manifest's existing top-level wrap
  const productionWrap = wrapDek(dek, productionKek); // a NEW, additive per-environment wrap

  check("12. wrapping the same DEK under two different KEKs yields two different ciphertexts", !legacyWrap.wrappedDek.equals(productionWrap.wrappedDek));

  const manifest = {
    schema: "veritasforge.echo-agent.release-manifest.v1",
    release_id: "release_test_fixture",
    artifact_sha256: "unused",
    encrypted_sha256: "unused",
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    auth_tag: authTag.toString("base64"),
    wrapped_dek: legacyWrap.wrappedDek.toString("base64"),
    wrapped_dek_iv: legacyWrap.wrappedDekIv.toString("base64"),
    wrapped_dek_auth_tag: legacyWrap.wrappedDekAuthTag.toString("base64"),
    wrapped_dek_by_env: {
      production: {
        wrapped_dek: productionWrap.wrappedDek.toString("base64"),
        wrapped_dek_iv: productionWrap.wrappedDekIv.toString("base64"),
        wrapped_dek_auth_tag: productionWrap.wrappedDekAuthTag.toString("base64"),
      },
    },
    original_filename: "test.zip",
    content_type: "application/zip",
    byte_size: plaintext.length,
    created_at: new Date().toISOString(),
  };

  const legacySelected = selectWrappedDek(manifest, null);
  check("13. selectWrappedDek(null) returns the legacy top-level fields (unset-namespace / Sandbox default, unchanged)", legacySelected.wrapped_dek === manifest.wrapped_dek);

  const unknownEnvSelected = selectWrappedDek(manifest, "some-other-env-with-no-entry");
  check("14. selectWrappedDek falls back to legacy fields for a namespace with no wrapped_dek_by_env entry", unknownEnvSelected.wrapped_dek === manifest.wrapped_dek);

  const productionSelected = selectWrappedDek(manifest, "production");
  check("15. selectWrappedDek('production') returns the production-specific entry, not the legacy one", productionSelected.wrapped_dek === manifest.wrapped_dek_by_env.production.wrapped_dek && productionSelected.wrapped_dek !== manifest.wrapped_dek);

  const dekFromLegacy = unwrapDek(
    { wrappedDek: Buffer.from(legacySelected.wrapped_dek, "base64"), wrappedDekIv: Buffer.from(legacySelected.wrapped_dek_iv, "base64"), wrappedDekAuthTag: Buffer.from(legacySelected.wrapped_dek_auth_tag, "base64") },
    sandboxKek,
  );
  const dekFromProduction = unwrapDek(
    { wrappedDek: Buffer.from(productionSelected.wrapped_dek, "base64"), wrappedDekIv: Buffer.from(productionSelected.wrapped_dek_iv, "base64"), wrappedDekAuthTag: Buffer.from(productionSelected.wrapped_dek_auth_tag, "base64") },
    productionKek,
  );
  check("16. both selections unwrap (each under its own KEK) to the IDENTICAL original DEK", dekFromLegacy.equals(dek) && dekFromProduction.equals(dek));

  const plaintextFromProductionPath = decryptArtifact(ciphertext, dekFromProduction, iv, authTag);
  check("17. the production-wrapped path decrypts the SAME shared artifact.enc ciphertext to the identical original plaintext", plaintextFromProductionPath.equals(plaintext));

  expectThrow("18. Sandbox KEK cannot unwrap Production's wrapped_dek entry (cross-KEK unwrap fails)", () =>
    unwrapDek(
      { wrappedDek: Buffer.from(productionSelected.wrapped_dek, "base64"), wrappedDekIv: Buffer.from(productionSelected.wrapped_dek_iv, "base64"), wrappedDekAuthTag: Buffer.from(productionSelected.wrapped_dek_auth_tag, "base64") },
      sandboxKek,
    ),
  );
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
