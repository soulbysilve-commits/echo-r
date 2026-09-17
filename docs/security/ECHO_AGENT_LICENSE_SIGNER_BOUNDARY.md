# ECHO Agent — License Signer Environment Boundary

Closure record for separating the Ed25519 license-signing key between
Production and Sandbox/Preview. No private key value appears anywhere
in this document — public-key fingerprints, booleans, and test counts
only.

## 1. Trust root (re-audited, current source)

`echo_agent_license_v1.py:44`:

```python
_PUBLIC_KEY_B64 = "ZYKec9jMzVJpqBJI2y9bcXaDdFDuFSFvV4Vn6O6dr5k="
```

```
LICENSE_TRUST_ROOT_SOURCE=hardcoded module constant (echo_agent_license_v1.py:44)
RELEASE_HAS_FIXED_PUBLIC_KEY=true
MULTIPLE_SIGNERS_SUPPORTED=false (verify_license_bytes takes one key_b64; no trust list)
```

`check_license_gate()`/`enforce_license_gate()` take an explicit,
keyword-only `override_public_key_b64` Python parameter, never sourced
from env/argv/config; every shipping entrypoint (`echo_agent_cli_v1.main()`,
`echo_agent_computer_use_service_v1.main()`) calls it with zero
arguments. `ECHO_AGENT_LICENSE_TEST_PUBLIC_KEY_B64` is no longer read
anywhere (fixed in `LICENSE_TRUST_ROOT_BYPASS_REMEDIATION.md`, unchanged
here). Confirmed for the **active** release,
`echoagent-win-20260914T072837Z-57d883c6`, via the real compiled
`echo_agent_cli_v1.exe`/`echo_agent_computer_use_service_v1.exe` PE32+
binaries (same remediation doc) — not source inference.

## 2. Production signer — verified twice, two different ways

**A. Local derivation** (this pass, before the Sandbox key was
replaced, using `.env.local`'s then-still-shared value):

```
This environment's derived public key:     ZYKec9jMzVJpqBJI2y9bcXaDdFDuFSFvV4Vn6O6dr5k=
Release-embedded trusted public key:        ZYKec9jMzVJpqBJI2y9bcXaDdFDuFSFvV4Vn6O6dr5k=
MATCH: true
```

**B. Real Vercel Production runtime** (this pass) — a temporary,
Production-only route (`app/api/echo-agent-production-signer-selftest/route.ts`,
deployed via `vercel deploy --prod --skip-domain`, never aliased to
the public domain, reachable only through Vercel's own default
Deployment-Protection-gated `.vercel.app` URL, invoked once via
`vercel curl`'s protection-bypass tied to the already-authenticated
CLI session) read the real `ECHO_AGENT_LICENSE_PRIVATE_KEY` Vercel
injects into Production, issued one synthetic non-customer test
payload, self-verified the signature, and derived its public key —
never returning the private key:

```json
{"runtime":"production","signingConfigured":true,"publicKeyFingerprint":"ZYKec9jMzVJpqBJI2y9bcXaDdFDuFSFvV4Vn6O6dr5k=","matchesReleaseTrustRoot":true,"selfVerify":true}
```

Route source deleted and the temporary deployment permanently removed
immediately after this one proof run (`vercel rm`, confirmed via a
follow-up request returning `DEPLOYMENT_NOT_FOUND`). Full regression
re-run clean after removal (§6).

```
PRODUCTION_SIGNER_PRESENT=true (Production scope, vercel env ls metadata)
PRODUCTION_SIGNER_RUNTIME_PROOF=true
PRODUCTION_PUBLIC_FINGERPRINT=ZYKec9jMzVJpqBJI2y9bcXaDdFDuFSFvV4Vn6O6dr5k=
PRODUCTION_SIGNER_MATCHES_RELEASE=true
```

## 3. Why Sandbox never needed the real signer

Code-level proof, not inference:

- `scripts/test-echo-agent-crypto.mjs:101-103` generates its **own**
  throwaway Ed25519 keypair in-process and explicitly sets
  `process.env.ECHO_AGENT_LICENSE_PRIVATE_KEY` to it before calling
  `issueLicense()` — never reads a pre-existing real value. Line 128
  explicitly `delete`s it afterward to test the not-configured path.
- `issueLicense()` (`lib/license.ts`) is called from exactly one route:
  `app/api/echo-agent-download-token/route.ts:167`. No other route,
  and no automated test script, calls it.
- That route's Stripe-dependent path (the only place a REAL running
  server would issue a REAL license) is explicitly excluded from the
  automated suite in both `scripts/test-echo-agent-download-auth.mjs`'s
  own header comment and `scripts/test-echo-agent-fulfillment.mjs`
  (which only drives `/api/stripe-webhook`, never
  `/api/echo-agent-download-token`) — it requires a real Stripe
  Sandbox key and a real Checkout Session, exercised only in a manual
  real-purchase Sandbox E2E, not the automated regression.
- `scripts/test_echo_agent_license_v1.py` (Python/verifying side)
  generates its own throwaway keypair (`_make_keypair()`,
  `Ed25519PrivateKey.generate()`) and asserts the verifying module's
  own source contains no private-key markers at all.

```
SANDBOX_PRODUCTION_SIGNER_REQUIREMENT=NONE (ordinary/automated Sandbox testing)
```

The only scenario that would ever need a real, release-trusted key
present somewhere is an occasional, manual "does a Sandbox-issued
license get accepted by the real shipped binary" release-compatibility
check — handled by §5 below without the key ever needing to exist in
Sandbox.

## 4. New independent Sandbox/Preview signer

A fresh Ed25519 keypair was generated in-process (never written to
disk except as described next) and installed as
`ECHO_AGENT_LICENSE_PRIVATE_KEY` in Vercel **Preview+sandbox only**
(`vercel env add ... preview,sandbox --force --sensitive`, value on
stdin, never argv/printed) and mirrored into the local `.env.local`
(the actual local/Sandbox dev config on this machine) by an in-place
regex replace that never printed the old or new value. Production's
`ECHO_AGENT_LICENSE_PRIVATE_KEY` was never read or written.

```
SANDBOX_TEST_SIGNER_CREATED=true
SANDBOX_TEST_SIGNER_ACTIVE=true (Preview+sandbox Vercel scope, and .env.local)
SANDBOX_PUBLIC_FINGERPRINT=pjHPJGAo6QOIwSozPwptvPREf0+pfZ0BUUIgWhb6z8k=
SANDBOX_SIGNER_DIFFERS_FROM_PRODUCTION=true
```

## 5. Sandbox signer rejected as the Production release signer — empirical proof

Using the **real** verifying module (`echo_agent_license_v1.py`, no
modification) and a **real** license issued by the new Sandbox private
key (`lib/license.ts`'s actual `issueLicense()`, not a synthetic
stand-in):

```
verify_license_bytes(sandbox_signed_license)                         -> ok=False reason=invalid_signature
verify_license_bytes(sandbox_signed_license, public_key_b64=sandbox) -> ok=True  reason=ok   (positive control: the license itself is well-formed)
```

This is the release-compatibility test working as designed in
reverse: it proves the Sandbox signer is cryptographically rejected by
the exact same fixed trust root a real customer's binary uses, using
the real signing/verifying code on both sides — not a fingerprint
string comparison alone.

## 6. Release-compatibility test — kept separate, non-destructive

`scripts/verify-license-signer-matches-release.mjs` is unchanged and
remains the narrow tool for this specific question. It only ever needs
`ECHO_AGENT_LICENSE_PRIVATE_KEY` in its OWN process's environment —
after this pass, the only places that value is the real Production key
are (a) the actual Vercel Production runtime, and (b) an operator's own
terminal after their own interactive `vercel env pull --environment
production` step-up. It is never required to exist in Sandbox/Preview
again, and issues no license — it only derives and compares a public
key.

```
RELEASE_COMPATIBILITY_TEST=PASS (proven twice this pass, §2; tool itself unchanged, requires no Sandbox-held key going forward)
```

## 7. Full regression after the swap

```
scripts/test-echo-agent-crypto.mjs:              22/22
scripts/test-echo-agent-download-auth.mjs:        18/18
scripts/test-echo-agent-fulfillment.mjs:          37/37
scripts/test-echo-agent-live-launch-safety.mjs:   25/25
test_echo_agent_license_v1.py:                    23/23
test_license_trust_root_shipping_regression_v1.py: 9/9
npm run build:                                    clean
NEW_FAILURES=0
```

Zero of the JS/TS suites changed behavior from the key swap (§3
already predicted this from code, confirmed empirically here) — the
license key is not on any automated code path they exercise.

## 8. Negative-test matrix

| Test | Result |
|---|---|
| Sandbox signer treated as Production signer | REJECTED (`invalid_signature`, §5) |
| Forged/wrong signer | REJECTED (`test_wrong_public_key_fails`, `test_B_wrong_signer_rejected`) |
| Modified payload | REJECTED (`test_tampered_payload_fails`, `test_E_tampered_payload_rejected`) |
| Modified signature | REJECTED (`test_tampered_signature_fails`, `test_F_tampered_signature_rejected`) |
| Missing signature | REJECTED (`test_missing_signature_field_fails`, `test_G_missing_signature_rejected`) |
| Customer-controlled env trust-root override | REJECTED (`test_module_no_longer_reads_test_public_key_env_var_at_all`, `test_C_env_override_attack_rejected_by_real_shipping_entrypoint`) |
| Hypothetical dev/test flag overrides | REJECTED, no effect (`test_D_hypothetical_dev_mode_env_flags_no_effect`) |
| Malformed public key | REJECTED, fails closed (`test_malformed_public_key_fails_closed`) |

## 9. Blast radius (updated)

Before this pass: a Sandbox-side compromise (weaker operational
surface, more test tooling, more hands) was equivalent to a
Production-side compromise of the license trust root — the single
highest-severity row in the original audit (§9 of
`ECHO_AGENT_ENV_SECRET_BOUNDARY.md`), since a leaked signing key lets
an attacker mint arbitrary, validly-signed licenses accepted by every
copy of the shipped binary, indefinitely, with no revocation.

After this pass: a Sandbox/Preview compromise yields only the Sandbox
test signer, which **cannot** produce a license the real shipped
binary accepts (§5, empirically proven, not asserted). Only a genuine
Production compromise reaches the release-trusted signing key.

## 10. Download-token secret — flagged, not rotated

`ECHO_AGENT_DOWNLOAD_TOKEN_SECRET` exists as separate Vercel entries
for Production and Preview/sandbox, but — like the license key and KEK
before their respective fixes — it was part of the same historical
bulk-copy from Sandbox into Production documented in
`ECHO_AGENT_ENV_SECRET_BOUNDARY.md` §1 (created in the same ~2-minute
Production window). Vercel's Sensitive-variable protection blocks a
plaintext comparison, so — per this pass's own instruction not to
pretend a comparison occurred —

```
DOWNLOAD_TOKEN_SECRET_SEPARATION=ASSERTED_SHARED_FROM_PRIOR_MIGRATION (unresolved, not rotated this pass)
```

This is the lowest-risk, highest-confidence remaining separation
candidate (`lib/downloadToken.ts` — a pure HMAC signing secret for
short-lived cookies, zero cross-environment compatibility requirement,
length ≥ 16 bytes is the only real constraint) and is recommended as
the next boundary task.

## 11. Files touched this pass

- `.env.local` (local Sandbox mirror) — `ECHO_AGENT_LICENSE_PRIVATE_KEY`
  line replaced in place with the new Sandbox test key. No other line
  touched.
- Vercel `Preview,sandbox` — `ECHO_AGENT_LICENSE_PRIVATE_KEY` replaced.
  Vercel `Production` — untouched.
- `app/api/echo-agent-production-signer-selftest/route.ts` — created,
  used once via a temporary non-aliased Production deployment, deleted.
  Not present in the working tree.
- `docs/security/ECHO_AGENT_LICENSE_SIGNER_BOUNDARY.md` — this document.
- `docs/security/ECHO_AGENT_ENV_SECRET_BOUNDARY.md` — cross-reference
  added (§18).

No Stripe API call was made. `STRIPE_SALES_LIVE_ENABLED` was not read
or written. No customer-facing code path was touched.
