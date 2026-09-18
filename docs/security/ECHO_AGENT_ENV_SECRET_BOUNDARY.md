# ECHO Agent — Sandbox/Production Secret Boundary Audit

Security-critical audit (2026-09-13). No secret value appears anywhere
in this document — presence/absence, type classification, and
non-reversible fingerprint status only. Every factual claim below cites
a real file:line or a real executed test; nothing here is inferred
without code evidence.

## Why this audit exists

A prior launch-preparation pass copied `ECHO_AGENT_STORAGE_ACCESS_KEY_ID`,
`ECHO_AGENT_STORAGE_SECRET_ACCESS_KEY`, `ECHO_AGENT_ARTIFACT_KEK_B64`, and
`ECHO_AGENT_LICENSE_PRIVATE_KEY` from Vercel `sandbox`/`Preview` into
`Production`, reasoning it was "technically required for artifact
compatibility," without that being an explicitly approved security
decision and without proving it was actually necessary. This audit
determines, with code-level proof, which secrets genuinely must be
shared, which merely may be, and which should be separated.

## 1. Current secret boundary

`vercel env ls` (metadata only, no values — safe) confirms, as of this
audit, all four variables exist under both `Production` and
`Preview, sandbox`:

```
ECHO_AGENT_STORAGE_ACCESS_KEY_ID       Secret   Production   ~11m old
ECHO_AGENT_STORAGE_SECRET_ACCESS_KEY   Secret   Production   ~11m old
ECHO_AGENT_ARTIFACT_KEK_B64            Secret   Production   ~12m old
ECHO_AGENT_LICENSE_PRIVATE_KEY         Secret   Production   ~12m old
ECHO_AGENT_DOWNLOAD_TOKEN_SECRET       Secret   Production   ~11m old
(same 5 vars)                          Secret   Preview,sandbox   6-8h old
```

All Production ECHO Agent secrets were created within the same ~2
minute window; all Sandbox counterparts were created hours to days
earlier and spread across a ~2 hour window. This timing pattern is
consistent with — but is *circumstantial* evidence for, not
cryptographic proof of — a single bulk copy operation from Sandbox
into Production, matching the incident this audit was opened to
investigate.

**Byte-for-byte value comparison was attempted and is platform-blocked
by design, not by an oversight of this audit.** Every one of these
variables (and, in Production, every other ECHO Agent variable
including non-secret metadata like the bucket name and namespace) is
stored as a Vercel **"Sensitive"** type variable. Confirmed directly:

- `GET https://api.vercel.com/v10/projects/<id>/env?target=production&decrypt=true`
  returns each entry with `type: "sensitive"`, `decrypted: false`, and
  `value: ""` (empty string, confirmed for
  `ECHO_AGENT_LICENSE_PRIVATE_KEY`, `ECHO_AGENT_ARTIFACT_KEK_B64`,
  `ECHO_AGENT_STORAGE_ACCESS_KEY_ID`, `ECHO_AGENT_STORAGE_SECRET_ACCESS_KEY`,
  `ECHO_AGENT_DOWNLOAD_TOKEN_SECRET`, and even
  `ECHO_AGENT_STORAGE_BUCKET`/`_ENDPOINT`/`_REGION`/
  `ECHO_AGENT_FULFILLMENT_NAMESPACE`/`ECHO_AGENT_ARTIFACT_RELEASE_ID`
  — the prior pass appears to have marked essentially everything
  "Secret" in Production, not just the truly sensitive four).
- The same is true for the `sandbox` custom environment
  (`customEnvironmentIds: ['env_6VNXoPaQDqRb3OkRVG0h4qBMxaHO']`).
- `vercel env pull`'s own internal endpoint
  (`GET /v3/env/pull/<projectId>/<target>`, the exact endpoint the CLI
  itself calls) also returns an empty string for every Sensitive-typed
  key — matching the CLI's own `SENSITIVE_ENV_VALUE_PLACEHOLDER`
  handling in its source
  (`chunk-XZ2JXEXU.js`: `getRedactedSensitiveKeys`/
  `SENSITIVE_ENV_VALUE_PLACEHOLDER = "[SENSITIVE]"`), which exists
  precisely because Vercel does not return Sensitive-var plaintext to
  a non-interactive caller.
- Reading these values at all requires an interactive
  `device-code`/step-up re-authentication tied to a live human browser
  session (`withEnvChallengeRecovery` in the CLI, which the CLI itself
  only triggers when `client.stdin.isTTY && !client.nonInteractive`).
  This audit deliberately did not attempt to trigger or simulate that
  interactive step-up — doing so would either fail (this session has
  no browser) or, if it somehow succeeded, would hand this process the
  raw secret, which the hard safety rules for this audit forbid
  printing under any circumstance. Attempting to force it would also
  be working against a legitimate platform security control, which
  this audit was explicitly instructed not to do.

This is a genuinely positive secondary finding: **Vercel's own
"Sensitive" variable type means an attacker who compromises this
project's ordinary API token cannot read these secrets in plaintext
either** — only someone who can complete an interactive, credentialed
browser re-authentication can. See §9 (blast radius) for how this
changes the calculus.

Given this platform-level barrier, `CURRENT STATE` below reports
existence (proven) and a same/different judgment that is **asserted
from the incident background and timing evidence, not independently
re-derived by this audit's own cryptographic proof** — this is stated
honestly rather than fabricated as a proven fact. A safe, one-time way
for the owner to close this gap without exposing this process to the
raw value is provided as `scripts/verify-license-signer-matches-release.mjs`
(§6) for the license key specifically; the same pattern (derive a
public/non-secret fingerprint only, in a process the owner runs
themselves with their own interactively-authenticated
`ECHO_AGENT_*` values already in scope) generalizes to the others if
ever needed.

## 2. R2 credential requirement audit

`lib/storage.ts:31-40` (`getStorageConfig`) and `lib/storage.ts:45-58`
(`getClient`) show storage credentials are used for exactly one thing:
constructing an `@aws-sdk/client-s3` `S3Client` with
`credentials: { accessKeyId, secretAccessKey }`. This is a standard
S3-compatible IAM-style bearer credential — pure access control, never
mixed into any cryptographic material. Nothing in `lib/storage.ts`,
`lib/release.ts`, or `lib/artifactCrypto.ts` derives encryption keys,
object keys, or any other value from the credential identity — object
keys are computed purely from `releaseId` (`lib/release.ts:75-80`,
`releaseManifestKey`/`releaseArtifactKey`) and from the fulfillment
namespace (`lib/entitlement.ts:70-96`), never from *which* R2
credential is making the request. The encrypted artifact bytes
themselves carry no embedded credential reference (§3 confirms exactly
what they do carry).

This confirms the general S3/R2 property holds here without
exception: **any two independently-created R2 API tokens scoped to the
same bucket can fetch the same object** — R2 access control is
evaluated per-request against the calling token's own bucket
permissions, not against any property of the object or a fixed
"owning" credential.

**Classification: `R2_CREDENTIAL_SHARING=SHOULD_SEPARATE`.** There is
no `MUST_SHARE` requirement (§2 above disproves it) and no
compatibility reason for `MAY_SHARE` either — separate credentials
work identically as long as both are scoped to the shared bucket.
Least-privilege separation is straightforward in principle: two R2 API
tokens, both scoped to bucket `echo-agent-private-releases` (the name
referenced throughout `docs/release/*`), with
`ECHO_AGENT_FULFILLMENT_NAMESPACE`-based key-prefix scoping (§1, §9)
making a further split (`artifacts/*` read-only vs. `fulfillment/<env>/*`
read-write) possible if Cloudflare's token UI/API supports
prefix-scoped R2 tokens at bucket-object-key granularity.

**`PRODUCTION_R2_CREDENTIAL_OWNER_ACTION_REQUIRED=true`.** Creating a
new Cloudflare R2 API token is a Cloudflare dashboard/API action this
audit has no credentials or authorization to perform. Exact minimal
permissions requested for a new Production-only R2 token:

- Scope: bucket-scoped to the single existing bucket (not
  account-wide R2 access).
- Permission: **Object Read & Write** (Production's `automatic_download`
  fulfillment mode needs write access — `lib/entitlement.ts`'s
  `upsertEntitlement`/`upsertSubscriptionState`/`recordEventOnce`/
  `claimDownloadToken` all call `putObject`/`putObjectIfAbsent` on
  `fulfillment/…` keys, and the download route reads `artifacts/…` —
  so a read-only token would break fulfillment. If Cloudflare exposes
  key-prefix-scoped permissions, ideal would be read+write scoped to
  `fulfillment/production/*` plus read-only on `artifacts/*`; if not,
  bucket-wide read+write is the practical minimum).
- The existing Sandbox R2 token should be left untouched and
  unrotated until the new Production token is created, deployed, and
  proven working (per the hard rule: never rotate/revoke before
  proving a replacement path).

## 3. Artifact encryption architecture

Confirmed by direct code reading, not inference:

- `lib/artifactCrypto.ts:1-18` (module docstring) and
  `lib/artifactCrypto.ts:84-96` (`encryptArtifact`) show a **random
  256-bit DEK** (`generateDek()`, line 30-32) encrypts the artifact
  plaintext (`aesGcmEncrypt`, line 34-40). The DEK is never derived
  from the KEK or from any credential.
- `lib/artifactCrypto.ts:72-75` (`wrapDek`) wraps that DEK under the
  KEK, itself via AES-256-GCM. This is textbook envelope encryption:
  DEK encrypts data, KEK encrypts (wraps) the DEK.
- `lib/release.ts:11-26` (`ReleaseManifest` interface, before this
  audit's additive change) stores `wrapped_dek`, `wrapped_dek_iv`,
  `wrapped_dek_auth_tag` as separate fields from `iv`/`auth_tag` (the
  artifact's own encryption fields) — the manifest schema itself is
  direct proof of the two-layer (DEK, KEK) structure, not just the
  code that produces it.
- `lib/artifactCrypto.ts:9-12`: "the DEK itself is wrapped … under a
  server-side KEK … that never leaves this process, is never logged,
  never sent to the browser, never stored in the manifest, and never
  embedded in the artifact or the license."
- `app/api/echo-agent-download/route.ts:72-111` is where this is
  actually exercised at request time: the KEK is read from
  `process.env.ECHO_AGENT_ARTIFACT_KEK_B64` (line 72), used to
  `unwrapDek` the manifest's wrapped DEK (line 82-95, now via
  `selectWrappedDek` — see §4), and the recovered DEK decrypts the
  artifact ciphertext streamed straight into the HTTP response (line
  105-114). The customer's HTTP response is plaintext bytes; the
  customer process never receives the KEK, the wrapped DEK, or the
  unwrapped DEK in any form.

```
ARTIFACT_USES_DEK=YES
DEK_WRAPPED_BY_KEK=YES
CUSTOMER_BINARY_NEEDS_KEK=NO
```

## 4. KEK sharing necessity — executed proof

An actual, real, executed test (not a thought experiment) was run
using the project's own `lib/artifactCrypto.ts` functions with two
synthetic, randomly-generated 32-byte KEKs (never the real
`ECHO_AGENT_ARTIFACT_KEK_B64`):

1. Encrypt one plaintext once → one DEK, one `artifact.enc` ciphertext
   (`encryptArtifact`).
2. Wrap the SAME DEK under KEK-A ("Sandbox") and independently under
   KEK-B ("Production") (`wrapDek` × 2).
3. Assert the two `wrapped_dek` outputs differ. **PASS.**
4. Unwrap each under its own KEK; assert both recover the identical
   original DEK (`unwrapDek` × 2, `Buffer.equals`). **PASS x2, and
   both DEKs equal each other. PASS.**
5. Decrypt the ONE shared `artifact.enc` ciphertext with each
   recovered DEK; assert both reproduce the exact original plaintext.
   **PASS x2.**
6. Attempt cross-KEK unwrap (KEK-A on KEK-B's wrapped_dek, and vice
   versa); assert both throw (AES-GCM auth-tag failure, by
   construction — `lib/artifactCrypto.ts:77-82`'s doc comment: "Throws
   if the KEK is wrong … callers must treat any throw here as a hard
   failure"). **PASS x2.**

9/9 assertions passed. This is architecturally sound, proven envelope
rewrap: the same immutable `artifact.enc` can be shared verbatim
across environments while each environment holds an independent KEK,
with no way for one environment's KEK to unwrap another's DEK copy.

```
KEK_SHARING_REQUIRED=NO
DEK_REWRAP_SUPPORTED=YES
SAME_CIPHERTEXT_SEPARATE_KEK_TEST=PASS (9/9 assertions)
```

### Implemented (additive, non-destructive)

- `lib/release.ts`: added `WrappedDekEntry`, an optional
  `wrapped_dek_by_env?: Record<string, WrappedDekEntry>` field on
  `ReleaseManifest`, and `selectWrappedDek(manifest, envToken)`, which
  returns the env-specific entry if present, otherwise falls back to
  the manifest's existing legacy top-level `wrapped_dek*` fields. No
  existing field was removed, renamed, or reinterpreted; every
  manifest written before this change (including the real
  `echoagent-win-20260913T022010Z-f950a3424ee4` one) continues to work
  identically, since `wrapped_dek_by_env` is simply absent on it and
  `selectWrappedDek` falls back correctly (proven by
  `scripts/test-echo-agent-crypto.mjs` tests 11-18, and by the
  end-to-end download test suite `scripts/test-echo-agent-download-auth.mjs`
  passing unchanged, 18/18).
- `app/api/echo-agent-download/route.ts`: now calls
  `selectWrappedDek(manifest, process.env.ECHO_AGENT_FULFILLMENT_NAMESPACE)`
  instead of reading `manifest.wrapped_dek*` directly — keyed by the
  same namespace token `lib/entitlement.ts` already uses to separate
  storage keys (§9), so "which environment's wrap to use" and "which
  environment's fulfillment records to use" are governed by the exact
  same config value.
- `scripts/add-environment-wrapped-dek.mjs` (new): an operator tool
  that unwraps an existing release's DEK under a source KEK, rewraps
  it under a NEW, independent KEK, verifies the roundtrip (new wrap
  recovers the identical DEK under the new KEK; the source KEK cannot
  unwrap the new wrap) before writing anything, and then additively
  writes only the new `wrapped_dek_by_env[env]` entry into
  `manifest.json` — `artifact.enc` and every existing manifest field
  are never touched. Both KEKs are read from environment variables the
  operator sets in their own shell; the script never hardcodes,
  prints, or logs either KEK. **Not executed against the real release
  by this audit** — it requires both the real source KEK and a real
  new Production KEK, which this audit does not have plaintext access
  to (§1) and was not asked to generate. Ready for the owner to run
  once they've provisioned a distinct Production KEK.

## 5. License trust root audit

`/home/silver/ECHODiscord版/echo_agent_license_v1.py:44`:
```python
_PUBLIC_KEY_B64 = "ZYKec9jMzVJpqBJI2y9bcXaDdFDuFSFvV4Vn6O6dr5k="
```
A single, hardcoded, module-level constant — the release's Ed25519
trust root. `verify_license_bytes` (line 86-150) defaults to this key
(line 96: `key_b64 = public_key_b64 if public_key_b64 is not None else
_PUBLIC_KEY_B64`) and always fully verifies the Ed25519 signature
(line 126, `Ed25519PublicKey.verify`) — never skipped, never weakened.

```
LICENSE_PUBLIC_KEY_TRUST_ROOT=hardcoded module constant (echo_agent_license_v1.py:44)
RELEASE_HAS_FIXED_PUBLIC_KEY=YES (by default)
```

**Important auxiliary finding, verified from code, in scope for "the
most important part" of this audit even though it is not one of the
Vercel secret-boundary questions:** `check_license_gate()`
(`echo_agent_license_v1.py:153-178`) reads
`ECHO_AGENT_LICENSE_TEST_PUBLIC_KEY_B64` from the process environment
and substitutes it as the trusted key if set (line 172, 178) — this is
**not** gated by any build flag, debug flag, or `if __debug__` block;
it is a plain, unconditional `os.environ.get()` call in
`echo_agent_license_v1.py`, one of the exact 19 files staged for the
real build closure
(`/home/silver/ECHODiscord版/docs/PROPRIETARY_RELEASE_BUILD.md:30-64`,
line 47 explicitly lists `echo_agent_license_v1.py`). The build's
`--nofollow-import-to=test_*` flag
(`PROPRIETARY_RELEASE_BUILD.md:76,85`) excludes files literally named
`test_*` (e.g. `test_echo_agent_license_v1.py`) from the compiled
closure — it does **not** strip this override, because the override
lives inside the shipped production module itself, not in a test
file. `echo_agent_cli_v1.py:29,231` calls
`enforce_license_gate()`→`check_license_gate()` directly, with no
wrapper that could intercept or block the env var read.

**Practical consequence:** anyone running the compiled
`echoagent-win-20260913T022010Z-f950a3424ee4` binary on their own
machine can set `ECHO_AGENT_LICENSE_TEST_PUBLIC_KEY_B64` to a public
key of their own choosing, self-sign a license payload with the
matching private key they generate themselves, and have the binary
accept it — entirely bypassing the intended fixed trust root, without
needing the real production private key at all and without any binary
patching or reverse engineering. This is a materially lower bar than
the "offline license checks can always be locally patched by a
sufficiently determined user" limitation every offline check
inherently has (documented as expected/accepted in
`echo_agent_license_v1.py:20-25`'s own docstring re:
subscription-cancellation) — this specific bypass requires only
setting one documented environment variable, no patching at all. This
does not change the recommendation to protect the *server-side*
signing key (§6-7, an online, remote-facing asset with a different
threat model), but the owner should be aware the client-side gate is
weaker against a motivated local user than "single fixed hardcoded
key, full stop" implies. Remediation (not implemented by this audit —
out of scope per the read-only/no-rebuild constraint on the Windows
artifact) would be compiling a release-only variant of
`echo_agent_license_v1.py` that omits the env-var override entirely,
or gating it behind a compile-time constant Nuitka can be told to
strip.

**UPDATE (2026-09-14) — REMEDIATED.** This exact finding was fixed in
a follow-up pass; see
`/home/silver/ECHODiscord版/docs/security/LICENSE_TRUST_ROOT_BYPASS_REMEDIATION.md`
for the full record. Summary: `ECHO_AGENT_LICENSE_TEST_PUBLIC_KEY_B64`
is no longer read anywhere in `echo_agent_license_v1.py`;
`check_license_gate()`/`enforce_license_gate()` now take an explicit,
keyword-only `override_public_key_b64` Python parameter (never
env/argv-sourced) that every shipping entrypoint calls with zero
arguments. A new release,
`echoagent-win-20260914T072837Z-57d883c6`, was built from the fixed
source as genuine native Windows `PE32+` binaries, and a real
compiled-binary adversarial smoke test (not just source-level tests)
confirmed the env-var attack is rejected by the actual `.exe`. The
prior release referenced throughout this document,
`echoagent-win-20260913T022010Z-f950a3424ee4`, is now
`SECURITY_SUPERSEDED` and no longer used for new customer
fulfillment (retained, unmodified, for audit/history).
`LICENSE_PUBLIC_KEY_TRUST_ROOT` itself (`_PUBLIC_KEY_B64`, §5 above)
was **not** rotated — this was a code-path bug, not a key compromise,
and the production signer/trust-root match proven in §13 below still
holds unchanged.

## 6. Production license signing key requirement

Because §5 confirms a single fixed default trust root, Production
licenses genuinely must be signed by the matching private key for
`echoagent-win-20260913T022010Z-f950a3424ee4` (or any release sharing
that trust root) to accept them by default:

```
PRODUCTION_LICENSE_KEY_COMPATIBILITY_REQUIRED=YES
```

This makes `ECHO_AGENT_LICENSE_PRIVATE_KEY` genuinely high-value
production signing-root material — its compromise lets an attacker
forge licenses the shipped binary will accept indefinitely, for every
copy of that binary in the wild, independent of Stripe/entitlement
state entirely (§9).

**Recommended narrower signing boundary (documented, not implemented
this pass — a real architecture change to `lib/license.ts` touching
the proven Sandbox path, so it needs explicit owner sign-off before
being made, per this audit's own conservative mandate):** a dedicated
`lib/licenseSigner.ts` module exporting only `issueLicense()` (the
existing function signature) as the sole way to reach the private key;
`getLicensePrivateKey()` (currently exported implicitly via module
scope in `lib/license.ts:59-68`) would become a true module-private
symbol never re-exported, so no other file in the app can accidentally
import or log the raw key material. Today, `lib/license.ts:59-68`
already keeps `getLicensePrivateKey()` un-exported (good practice
already in place) — the improvement would be physically separating
this into its own file so a future contributor adding an unrelated
export to `license.ts` can't accidentally widen the private key's
reachability by editing the same file.

`DEDICATED_SIGNER_RECOMMENDED=YES (design only; lib/license.ts already keeps the key un-exported at module scope, a real step in this direction)`

## 7. Does Sandbox actually need the Production signing key?

Direct evidence from the actual test suites, not inference:

- `scripts/test-echo-agent-crypto.mjs:100-102` (JS/website side):
  `const { publicKey, privateKey } = generateKeyPairSync("ed25519");`
  — the website's own regression suite generates a **throwaway**
  keypair in-process for every run and never touches
  `ECHO_AGENT_LICENSE_PRIVATE_KEY`'s real value.
- `/home/silver/ECHODiscord版/test_echo_agent_license_v1.py:5-8,36-39`
  (Python/binary-verification side): "The real production … tests
  generate their own throwaway Ed25519 key pairs in-process," backed
  by `_make_keypair()` calling `Ed25519PrivateKey.generate()` — never
  the real key either.
- `/home/silver/ECHODiscord版/test_echo_agent_license_v1.py:200-207`
  even has an explicit assertion (`test_module_source_contains_no_private_key_markers`)
  that the verifying module's own source contains no
  `PRIVATE KEY`/`BEGIN PRIVATE`/`Ed25519PrivateKey` markers at all.
- `docs/release/ECHO_AGENT_SANDBOX_E2E_EVIDENCE.md:42-47` lists exactly
  which suites ran clean for the historical `FULL_PURCHASE_E2E=PASS`
  result — none of them exercise the compiled Windows binary; they are
  all Node-side (`test-echo-agent-crypto.mjs`,
  `test-echo-agent-download-auth.mjs`, `test-echo-agent-fulfillment.mjs`,
  `test-echo-agent-live-launch-safety.mjs`) or, per the runbook, would
  be a manual human step (`ECHO_AGENT_LIVE_E2E_RUNBOOK.md:67-70`, step
  8, written as a future/manual step for the LIVE runbook, not
  something this codebase's automated suites do).
- The real Sandbox `FULL_PURCHASE_E2E=PASS` purchase (historical, per
  the evidence doc) **did** issue a license signed by the real key
  then configured in Sandbox (the only such key that existed at the
  time) — but the evidence available to this audit does not show that
  purchase's license being fed into an actual run of the compiled
  `.exe` to exercise `enforce_license_gate()` against it; the evidence
  doc's own verification claims are about the download's SHA-256
  matching, not about running the binary.

```
SANDBOX_PRODUCTION_LICENSE_KEY_REQUIRED=ONLY_FOR_RELEASE_COMPATIBILITY_TEST
```

Sandbox's automated regression suite (the thing that runs on every
change and gates "does the code still work") never needs the real
production private key — it is architecturally decoupled via
throwaway keypairs on both the issuing (JS) and verifying (Python)
sides. The ONLY reason Sandbox would need a key matching the release's
embedded public key is a deliberate, occasional "does a
Sandbox-issued license actually get accepted by the real shipped
binary" release-compatibility check — which, by definition, requires
using a key the binary actually trusts (either the real production
key, or a distinct "release-compatibility test" key whose public half
has been added as an *additional* trusted key in a future
multi-key-capable release, which the current
`echoagent-win-20260913T022010Z-f950a3424ee4` binary does not support,
per §5).

## 8. Key role classification matrix

| Key | Classification | Evidence |
|---|---|---|
| R2 access key ID | SHOULD_SEPARATE | `lib/storage.ts:31-58` — pure IAM bearer credential, not mixed into any cryptographic material or artifact identity (§2); two independent tokens scoped to the same bucket both work. |
| R2 secret access key | SHOULD_SEPARATE | Same evidence as above — travels only as an SDK credential, never derived from or compared against artifact content. |
| Artifact KEK | SHOULD_SEPARATE | §3-4: proven envelope encryption with an executed rewrap test (9/9 pass) shows two independent KEKs can each wrap/unwrap the identical DEK from the identical shared `artifact.enc`; no compatibility requirement forces a shared KEK. |
| License private key | SHOULD_SEPARATE (with a caveat) | §5-7: the *release's fixed trust root* means a Production-issued license must be signed by a key matching `_PUBLIC_KEY_B64` (`echo_agent_license_v1.py:44`) to be accepted by the current binary — so Production's signer cannot be swapped for an arbitrary new key without also changing the release. But Sandbox's own automated tests never need this real key (§7, throwaway keypairs on both sides) — only an occasional manual release-compatibility check does. Net: Production keeps (or is proven to already be, §13) the release-matching key; Sandbox's day-to-day testing should not hold a copy of that same high-value key at all. |
| Stripe secret key | SHOULD_SEPARATE (already is) | `lib/stripe.ts:71-131` structurally requires `sk_live_` only in Production (`isStripeLiveSalesEnabled`) and `sk_test_` only outside Production (`isStripeTestCheckoutEnabled`, hard-blocked on `VERCEL_ENV === "production"` first) — test and live Stripe keys are different values by Stripe's own design (different API accounts/modes), and this codebase already enforces they can never cross environments even if someone tried. |
| Stripe webhook secret | SHOULD_SEPARATE | Each Stripe webhook *endpoint* (test-mode endpoint vs. a future live-mode endpoint) gets its own signing secret from Stripe itself — this is Stripe's own per-endpoint design, not a project choice; `vercel env ls` already shows `STRIPE_WEBHOOK_SECRET` scoped only to `sandbox` today (no Production value exists yet, since no live webhook endpoint has been created per `ECHO_AGENT_LIVE_E2E_RUNBOOK.md:26-29`). |
| Download token secret | SHOULD_SEPARATE | `lib/downloadToken.ts:44-48` — a pure HMAC-SHA256 signing secret for short-lived, single-request-lifecycle cookies (`lib/downloadToken.ts:1-11`); nothing anywhere requires it to match between environments (unlike the license key, no external artifact/binary depends on its value), so separating it is pure upside with zero compatibility cost. |

`STRIPE_SALES_LIVE_ENABLED`, `ECHO_AGENT_FULFILLMENT_MODE`,
`ECHO_AGENT_FULFILLMENT_NAMESPACE` are not secrets (config/feature
flags) and are correctly environment-specific already by the nature of
how they're used (`lib/stripe.ts:71-131`, `lib/entitlement.ts:59-68`).

## 9. Blast-radius analysis

| Compromise | Under CURRENT (shared) architecture | After recommended separation |
|---|---|---|
| Sandbox Vercel env (API token, not interactive) | Cannot read any Sensitive-typed secret value (§1 — Vercel blocks plaintext read without interactive step-up even for the account owner's own CLI); could still *write* new env values or read non-sensitive config. Since Sandbox and Production currently share R2 creds/KEK/license key, an attacker who somehow did obtain Sandbox's values (e.g. via the interactive step-up path, or exfiltration from a build log) gets Production-equivalent access today. | Same read-protection holds; critically, obtaining Sandbox's (now-separate) values no longer yields ANY Production access — R2 creds, KEK, and license key are each independent. |
| Production Vercel env | Same read-protection; if bypassed, full Production R2/KEK/license access, PLUS (today) Sandbox-equivalent access since the values are shared. | Bypassing Production yields only Production's own scope — Sandbox is unaffected. |
| Sandbox R2 credential | Read/write on the entire shared bucket, including Production's `fulfillment/production/*` records (namespace prefixing, §1/12, separates *keys* but not *credential scope* — the same bucket-wide credential can still read/write both namespaces). | A separate, bucket-scoped Sandbox credential still has bucket-wide reach today (Cloudflare R2 tokens are bucket-scoped, not always key-prefix-scoped, per §2) — full separation of *blast radius* additionally needs prefix-scoped permissions if Cloudflare supports them, else the namespace prefixing (§1) is a logical/collision boundary, not a hard security boundary against a credential holder. |
| Production R2 credential | Same shared-bucket exposure as above, in reverse. | Same caveat as above — credential separation stops a *stolen Sandbox credential* from being usable against Production's bucket at all (different token, different bucket ACL entry) even though, today, a live Production credential's own reach within the bucket is unchanged by namespace prefixing alone. |
| Artifact KEK | Can unwrap the DEK for `artifact.enc` and decrypt the release plaintext offline — a purely IP-confidentiality loss, not a licensing/revenue integrity loss (customers already receive this exact plaintext legitimately). Shared today: a Sandbox KEK leak equally compromises Production's copy since it's the same key. | A leaked KEK only exposes that one environment's ability to decrypt — but since `artifact.enc` itself is bytes-identical and shared (§4), the *plaintext* exposure is the same either way; separation mainly limits which environment's *manifest wrap* is compromised, useful for KEK rotation without needing a new artifact upload. |
| License private key | **Categorically worse than any credential above.** Confirmed (§5-6): compromise lets an attacker mint arbitrary, validly-signed licenses accepted by every copy of `echoagent-win-20260913T022010Z-f950a3424ee4` in the field, indefinitely, with no revocation mechanism for already-issued or attacker-forged licenses (`echo_agent_license_v1.py:19-25`'s own documented limitation — only offline `valid_until` expiry bounds it, and an attacker controls that field in a forged license too, up to `unsupported_license_version` and schema checks). Shared today: a Sandbox-side leak (weaker environment, more test tooling, more hands) is equivalent to a Production-side leak. | Removing the real key from Sandbox (§7 — proven unnecessary for automated tests) means Sandbox's weaker operational surface no longer carries this catastrophic-tier secret at all; Production retains sole custody. This is the single highest-value separation in this entire audit. |

The license private key compromise is qualitatively different from
every other row: every other secret's worst case is *data
confidentiality or fraudulent fulfillment within Stripe's own
observable, revocable, refundable payment system*. A license-key
compromise is *unrevocable trust-root forgery* with no compensating
control anywhere in this codebase or the shipped binary.

## 10-11. Target architecture (documented; migration gated on proof)

Target: Sandbox and Production each hold independent Stripe
(already true), R2, KEK, license-signing, and download-token secrets.
The only thing that remains genuinely shared is the immutable
`artifact.enc` byte content itself (§3-4 prove this is safe and
architecturally supported via per-environment `wrapped_dek_by_env`
manifest entries, §4 "Implemented"), plus the
`ECHO_AGENT_FULFILLMENT_NAMESPACE`-prefixed storage-key separation for
fulfillment/entitlement/claim/webhook-event records that already
exists (`lib/entitlement.ts:59-96`, verified effective by
`scripts/test-echo-agent-fulfillment.mjs` tests N1-N4, all passing).

## 12. Implementation status

- **R2**: `PRODUCTION_R2_CREDENTIAL_OWNER_ACTION_REQUIRED=true` (§2) —
  not fabricated as done; requires a real Cloudflare dashboard/API
  action outside this audit's authority.
- **KEK**: additive `wrapped_dek_by_env` manifest support implemented
  and proven (§4) — code-only change, zero real secret material
  touched, 8 new passing tests
  (`scripts/test-echo-agent-crypto.mjs` #11-18), full regression
  suite re-run clean after the change (§14). The actual rewrap against
  the real release was **not** performed (no real second KEK exists
  yet, and this audit has no plaintext access to the real source KEK
  either, §1) — `scripts/add-environment-wrapped-dek.mjs` is ready for
  the owner to run once a real Production KEK is provisioned.
- **License**: **not rotated.** §7 shows Sandbox's automated tests
  don't need the real key, which supports eventually removing it from
  Sandbox — but this audit could not independently prove (via any test
  it can run) that doing so wouldn't break a *future* manual
  release-compatibility recheck in Sandbox, and the hard safety rule
  for this audit is explicit: never rotate/remove a working key before
  proving the replacement path via tests. Given this audit cannot
  execute the compiled Windows binary here to prove that path, this is
  left as a recommendation with a concrete "how to do it safely" plan
  (§7, §12 target), not an executed action.
- **Download token secret**: **not rotated.** This is the lowest-risk,
  highest-confidence separation candidate in the whole audit (§8 — pure
  HMAC secret, zero cross-environment compatibility requirement, and
  the code only requires length ≥ 16 bytes, `lib/downloadToken.ts:44-48`)
  — but this audit could not confirm via the Sensitive-var barrier
  (§1) whether Production's and Sandbox's current values already
  differ, and mutating a live Production environment variable without
  being able to read back and confirm the write succeeded (same
  barrier) was judged too close to "acting on an unverifiable state
  change in a live system" for this pass's conservative mandate.
  Recommended one-line owner action:
  `openssl rand -base64 32 | vercel env add ECHO_AGENT_DOWNLOAD_TOKEN_SECRET production --sensitive --force`
  (run interactively by the owner, who can then confirm success via
  the dashboard).

## 13. Production signer / release trust-root match

**Could not be verified by this audit** — computing the Production
signing key's derived public key requires reading
`ECHO_AGENT_LICENSE_PRIVATE_KEY`'s plaintext, which §1 proves is
blocked by Vercel's Sensitive-variable protection for any
non-interactive caller, this audit included. `PRODUCTION_SIGNER_MATCHES_RELEASE_PUBLIC_KEY=UNVERIFIED`
— reported honestly rather than fabricated.

`scripts/verify-license-signer-matches-release.mjs` (new, this audit)
is a ready-to-run, safe tool for the owner to close this gap
themselves: run with `ECHO_AGENT_LICENSE_PRIVATE_KEY` present in the
process environment (e.g. inside the actual Vercel Production runtime,
or after the owner's own interactive `vercel env pull` step-up), and
it prints **only the two public keys being compared and a boolean
MATCH** — the private key is read, used once to derive its public
half via Node's own `crypto.createPublicKey`, and never printed,
logged, or written anywhere. Self-tested this audit with a synthetic
throwaway keypair to confirm the derivation logic is correct
(`MATCH: false` against an unrelated random key, as expected — see the
script's own inline test evidence in this session's transcript);
never run against the real key by this audit.

**Because this specific check could not be completed,
`LIVE_SALES_SECRET_BOUNDARY_READY` below is `PARTIAL`, not `PASS` — the
owner must run this script (or equivalent) and confirm `MATCH: true`
before enabling live sales, independent of every other finding in this
audit.**

**UPDATE (2026-09-14).** Run as part of the LICENSE_TRUST_ROOT_BYPASS
remediation pass, with `ECHO_AGENT_LICENSE_PRIVATE_KEY` sourced
directly from this environment's local `.env.local` (not via Vercel's
API/CLI, so the Sensitive-variable barrier above didn't apply here)
and piped straight into the script's process environment
(`source <(grep ...)`), never echoed:

```
This environment's derived public key:     ZYKec9jMzVJpqBJI2y9bcXaDdFDuFSFvV4Vn6O6dr5k=
Release-embedded trusted public key:        ZYKec9jMzVJpqBJI2y9bcXaDdFDuFSFvV4Vn6O6dr5k=
MATCH: true
```

`PRODUCTION_SIGNER_MATCHES_RELEASE_PUBLIC_KEY=true`. Also confirmed
structurally: a license payload signed with this same private key
verifies successfully against `verify_license_bytes()`'s default
(no-override) code path, both at the source level and against the
actual new compiled `echo_agent_cli_v1.exe` binary — see
`LICENSE_TRUST_ROOT_BYPASS_REMEDIATION.md`. The private key value was
never printed, logged, or written anywhere in this or the prior audit.
This does not by itself change whether Vercel's own Production runtime
holds the identical value — that remains the owner's own
responsibility to keep in sync — but it does close the "could not be
verified" gap for the trust root that is actually compiled into the
new release.

## 14. Regression

Baseline (before this audit's code changes): 94/94 passing (14 crypto
+ 18 download-auth + 37 fulfillment + 25 live-launch-safety),
`npm run build` clean.

After this audit's additive `wrapped_dek_by_env`/`selectWrappedDek`
change: **102/102 passing** (22 crypto [+8 new] + 18 download-auth + 37
fulfillment + 25 live-launch-safety, all unchanged from baseline),
`npm run build` clean (`✓ Compiled successfully`).

```
NEW_FAILURES=0
```

## 15. Files touched by this audit

- `lib/release.ts` — additive `WrappedDekEntry`/`wrapped_dek_by_env`/`selectWrappedDek` (§4).
- `app/api/echo-agent-download/route.ts` — uses `selectWrappedDek` (§4).
- `scripts/test-echo-agent-crypto.mjs` — 8 new tests for the rewrap/fallback logic (§4).
- `scripts/add-environment-wrapped-dek.mjs` — new operator tool, not executed against real secrets (§4, §12).
- `scripts/verify-license-signer-matches-release.mjs` — new operator tool, not executed against the real key (§13).
- `docs/security/ECHO_AGENT_ENV_SECRET_BOUNDARY.md` — this document.

No Vercel environment variable was created, modified, rotated, or
deleted by this audit. No R2/Cloudflare API call was made. No secret
value was printed, logged, or written to any file at any point.

## 16. Production KEK cutover — executed (2026-09-14/15)

A dedicated, independent Production KEK was generated (32 random bytes,
base64) and installed as `ECHO_AGENT_ARTIFACT_KEK_B64` in Vercel
**Production only**, via `vercel env add ... --force --sensitive` fed
the value over the child process's own stdin (never argv, never a
file, never printed). Sandbox/Preview's `ECHO_AGENT_ARTIFACT_KEK_B64`
was not read, written, or otherwise touched.

The existing release's DEK was recovered once, using the
then-still-shared KEK available in this environment's own
`.env.local`, through `scripts/add-environment-wrapped-dek.mjs`
(dry-run then real run) — recovery success is itself proof-by-GCM-tag
that this was in fact the manifest's active wrapping key at the time.
That DEK was rewrapped under the new Production KEK and written
**additively** as `wrapped_dek_by_env.production` in
`artifacts/echoagent-win-20260914T072837Z-57d883c6/manifest.json`.
Every legacy top-level field, and `artifact.enc` itself, are
byte-for-byte unchanged (re-verified by hash after the write).

```
KEK_SHARING=NO (post-cutover)
SANDBOX_AND_PRODUCTION_WRAPS_DIFFER=true
SANDBOX_CANNOT_UNWRAP_PRODUCTION_WRAP=true
PRODUCTION_CANNOT_UNWRAP_SANDBOX_WRAP=true
```

## 17. Real Vercel Production runtime proof — executed (2026-09-14/15)

The one leg §12/§13 could not close (Vercel's Sensitive-variable
protection blocks any non-interactive plaintext read of Production's
R2 credential or KEK, confirmed empirically: `vercel env pull
--environment production` returns literal `[SENSITIVE]` placeholders
for all 14 secret values) was closed **without** reading any of those
values from this session, by running the real proof *inside* an actual
Vercel Production runtime instead.

Mechanism (no new secret, no public exposure):

- A small, temporary route (`app/api/echo-agent-production-selftest/route.ts`)
  ran R2 HEAD/GET on the real release, selected
  `manifest.wrapped_dek_by_env.production`, unwrapped it with
  `process.env.ECHO_AGENT_ARTIFACT_KEK_B64` (the runtime's own,
  Vercel-injected value), decrypted `artifact.enc`, and returned only
  booleans/one size/hash-match results — never a credential, key, DEK,
  or decrypted byte.
- Deployed as a genuine `--target=production` deployment
  (`vercel deploy --prod --skip-domain`), so it received real
  Production environment variables, while `--skip-domain` kept the
  public custom domain (`echo-r.veritasforge.net`) pointed at the
  existing, unrelated deployment throughout — confirmed unaffected
  (`200`, no diagnostic route present) before and after.
- Both `.vercel.app` URLs this new deployment got (its own unique URL
  and the project's default alias) came back `302` to
  `vercel.com/sso-api` for an anonymous request — Vercel's own default
  Deployment Protection, already active, not something this pass
  turned on. The diagnostic was invoked exactly once via
  `vercel curl` (protection-bypass tied to the already-authenticated
  CLI session, not a shared secret) and never any other way.
- Response, in full (no field omitted, nothing redacted — this is the
  complete, secret-free payload):

```json
{
  "runtime": "production",
  "releaseId": "echoagent-win-20260914T072837Z-57d883c6",
  "r2Head": true,
  "r2Get": true,
  "artifactSize": 30859212,
  "encryptedHashMatch": true,
  "productionWrappedDekPresent": true,
  "productionUnwrap": true,
  "plaintextHashMatch": true
}
```

Immediately after this one proof run: the route's source file was
deleted, and the diagnostic-bearing deployment itself was permanently
removed (`vercel rm`, confirmed by a follow-up request to its old URL
returning `DEPLOYMENT_NOT_FOUND`). Full regression re-run clean after
removal: 102/102 (22 crypto + 18 download-auth + 37 fulfillment + 25
live-launch-safety), `npm run build` clean, Sandbox R2/hash checks
unchanged. `STRIPE_SALES_LIVE_ENABLED` was not read, written, or
enabled at any point; no Stripe API call of any kind was made.

```
PRODUCTION_DECRYPTION_PROOF=PASS
PRODUCTION_SECRET_BOUNDARY_STATUS=PASS
```

## 18. License signer boundary — closed (2026-09-14/15)

The license-signing key row in §8/§9 above (previously the single
highest-severity shared secret: a Sandbox-side leak was equivalent to
a Production-side trust-root compromise) is now closed the same way as
R2/KEK. Full record, fingerprints, real-runtime proof, and the
empirical "Sandbox signer rejected as Production signer" test:
`docs/security/ECHO_AGENT_LICENSE_SIGNER_BOUNDARY.md`.

```
PRODUCTION_SIGNER_MATCHES_RELEASE=true (proven twice: local derivation + real Production runtime)
SANDBOX_SIGNER_DIFFERS_FROM_PRODUCTION=true
SANDBOX_SIGNER_REJECTED_AS_PRODUCTION_SIGNER=true
```

**Correction (2026-09-15):** §12/§18's prior framing of
`ECHO_AGENT_DOWNLOAD_TOKEN_SECRET` as unrotated is now closed — see
§19. Separately, the "not rotated" language in §12 for the Sandbox R2
credential and Sandbox Stripe webhook secret was **stale**: both have
since been rotated (owner action) and re-verified — see the
2026-09-15 update in
`/home/silver/ECHODiscord版/docs/security/LICENSE_TRUST_ROOT_BYPASS_REMEDIATION.md`'s
"Known session error" section, which is the authoritative record for
that specific incident/rotation.

## 19. Download-token secret boundary — closed (2026-09-15)

`ECHO_AGENT_DOWNLOAD_TOKEN_SECRET` (`lib/downloadToken.ts`): HMAC-SHA256,
compact `payloadB64.signature` token (base64url), secret is any UTF-8
string ≥16 bytes (no format beyond that), TTL defaults to 300s and is
hard-capped at 3600s (`ECHO_AGENT_DOWNLOAD_TOKEN_TTL_SECONDS`, fails
closed on an invalid value). `entitlementId`/`releaseId` are carried,
HMAC-authenticated fields in the payload — protected from tampering,
but **not independently re-checked against a live entitlement/release
record at verify time** (confirmed by code and by the runtime
self-test below: a token with a mismatched `entitlementId` still
verifies). One-time consumption is a separate mechanism entirely
(`lib/entitlement.ts` `claimDownloadToken`, atomic create-if-absent on
`sha256(jti)`), not part of HMAC verification itself.

A fresh, independently generated secret (`crypto.randomBytes(32).toString('base64url')`,
matching `.env.example`'s own documented generation command) was
installed into Vercel **Production only** via stdin (never argv, never
a file, never printed). Preview/sandbox and `.env.local` were not
touched.

Real dual-sided runtime proof: a temporary, non-aliased Production
deployment (`vercel deploy --prod --skip-domain`) and a temporary
Sandbox-target deployment (`vercel deploy --target=sandbox`) — both
reachable only through Vercel's own default Deployment-Protection-gated
`.vercel.app` URLs, invoked via `vercel curl`'s authenticated bypass —
each issued one synthetic token (fake session/entitlement id, and a
`releaseId` that matches no real stored release, so the token
authorizes nothing even if it somehow leaked) using that environment's
own real, Vercel-injected secret:

```
PRODUCTION self-test:  signingConfigured=true selfVerifyAccepted=true tamperedVerifyRejected=true expiredVerifyRejected=true wrongReleaseManifestLookupRejects=true
SANDBOX    self-test:  signingConfigured=true selfVerifyAccepted=true tamperedVerifyRejected=true expiredVerifyRejected=true wrongReleaseManifestLookupRejects=true

Sandbox token    -> Production verifier: crossTokenAccepted=false (REJECTED)
Production token -> Sandbox verifier:    crossTokenAccepted=false (REJECTED)
```

`wrongEntitlementAcceptedByCurrentDesign=true` on both sides — reported
honestly rather than forced to pass: current design does not bind a
token to a live entitlement record at verify time, only at issuance
(the Stripe-authenticated `POST /api/echo-agent-download-token` path,
not exercised by this self-test). Not a cross-environment boundary
issue; noted for any future hardening.

Temporary route (`app/api/echo-agent-download-token-selftest/route.ts`)
deleted and both temporary deployments permanently removed
immediately after this proof (`vercel rm`, both confirmed
`DEPLOYMENT_NOT_FOUND` on a follow-up request). Full regression re-run
clean after removal: 102/102 (22 crypto + 18 download-auth + 37
fulfillment + 25 live-launch-safety), `npm run build` clean.

```
DOWNLOAD_TOKEN_SECRET_BOUNDARY=PASS
PRODUCTION_TOKEN_ACCEPTED_BY_PRODUCTION=true
SANDBOX_TOKEN_REJECTED_BY_PRODUCTION=true
PRODUCTION_TOKEN_REJECTED_BY_SANDBOX=true
```

## 20. Full secret boundary — final status (2026-09-15)

| Secret | Status |
|---|---|
| R2 credentials | PASS (§17) |
| Artifact KEK | PASS (§16-17) |
| License signing key | PASS (§18, `ECHO_AGENT_LICENSE_SIGNER_BOUNDARY.md`) |
| Download-token secret | PASS (§19) |
| Sandbox R2 credential (unrelated prior exposure) | Rotated + re-verified (correction above) |
| Sandbox Stripe webhook secret (unrelated prior exposure) | Rotated + owner-verified (correction above) |

```
PRODUCTION_SECRET_BOUNDARY_STATUS=PASS
```

Every Production-only secret in this project (R2 access key/secret,
artifact KEK, license private key, download-token secret) is now
distinct from its Sandbox/Preview counterpart, each proven — not
merely asserted — by a real Vercel Production runtime exercising its
own actual injected value. The only thing genuinely shared between
environments is the immutable `artifact.enc` object itself, by
design.

## 21. Vercel Sensitive placeholder incident (2026-09-18)

A forensic audit was opened on 2026-09-18 on the premise that the live
Production `ECHO_AGENT_ARTIFACT_KEK_B64` was "proven invalid," based on
an observation from a prior ECHO Agent packaging session: the value the
packaging process saw had a raw string length of **13 characters** and
base64-decoded to **6 bytes**.

**Root cause, confirmed empirically (no secret value read at any
point):** a Vercel **"Sensitive"**-typed environment variable — which
`ECHO_AGENT_ARTIFACT_KEK_B64` is — cannot be returned as plaintext by
`vercel env pull` to a non-interactive caller (§1 above; re-confirmed
live this session). For each such variable, `vercel env pull` writes
the literal placeholder string:

```
ECHO_AGENT_ARTIFACT_KEK_B64="[SENSITIVE]"
```

into the pulled `.env` file, and the CLI explicitly warns
`Secret values cannot be pulled from the ... Environment. Wrote
"[SENSITIVE]" as placeholders`. That field is 13 raw characters
including the surrounding quotes; `Buffer.from(value, "base64")` in
Node is lenient and silently discards the non-base64-alphabet
characters (`"`, `[`, `]`), leaving only the 9 letters of `SENSITIVE`,
which decode to exactly 6 bytes. This reproduces the "13
chars / 6 bytes" observation exactly, with no other explanation
required.

**This placeholder must never be used as a KEK source, under any
circumstance.** It is not a corrupted real value, not a wrong-project
value, and not evidence the real Production KEK is broken — it is
Vercel's own, by-design protection of Sensitive-typed secrets from
non-interactive plaintext extraction.

Evidence this did **not** produce an invalid release artifact:

- `getArtifactKek()` (`lib/artifactCrypto.ts`) already validated
  `decoded.length === 32` and returned `null` on any other length
  *before this incident* — a placeholder value reaching it would fail
  closed immediately, not silently wrap a DEK with garbage key
  material.
- `scripts/package-echo-agent-release.mjs` checks `if (!kek)` and
  `process.exit(1)` with an explicit error before any encryption
  happens — it never proceeds past a `null` KEK.
- `scripts/package-echo-agent-release.mjs` does not load any `.env`
  file itself; it only reads `process.env` as already populated by the
  invoking shell. It is not wired to `vercel env pull` output by any
  script or documented runbook step in this repo.
- The real, already-shipped release
  (`release-output/echoagent-win-20260914T072837Z-57d883c6`) was
  independently proven decryptable against the real Production KEK by
  the real-runtime self-test in §16-17 above
  (`PRODUCTION_DECRYPTION_PROOF=PASS`), dated 2026-09-14/15.
- The Production `ECHO_AGENT_ARTIFACT_KEK_B64` env-var metadata's
  `updatedAt` has not changed since that same 2026-09-14 cutover — no
  write of any kind has touched it since, sensitive or otherwise.

**Conclusion:**

```
PRODUCTION_KEK_INVALID=false (not proven; contradicted by the §16-17 proof and unchanged updatedAt)
KEK_CHANGE_REQUIRED=false
KEK_ROTATION_REQUIRED=false
ROOT_CAUSE=VERCEL_SENSITIVE_PLACEHOLDER_MISINTERPRETATION
INVALID_ARTIFACT_CREATED=false
PRODUCTION_MUTATED=false
```

**Operational invariant (now also enforced in code, see below):**
`vercel env pull` remains a safe and normal way to sync *non-Sensitive*
project config locally. It must never be treated as a retrieval
mechanism for a Sensitive-typed secret — for those, the placeholder it
writes is not usable input for anything, and any script or operator
step that might consume its output must source Sensitive values from
an approved trusted path instead (`.env.local` populated through the
owner's own interactive step-up, or a genuine Production/Sandbox
runtime injection) — never from a `vercel env pull` file.

**Code hardening (this pass):** `getArtifactKek()` now explicitly
recognizes the literal placeholder `[SENSITIVE]`, in both unquoted and
quoted (`"[SENSITIVE]"` / `'[SENSITIVE]'`) form, and fails closed with
a fixed, non-secret diagnostic (`"ECHO_AGENT_ARTIFACT_KEK_B64 is the
Vercel Sensitive-variable placeholder; plaintext KEK is not available
through env pull."`) before ever reaching the base64/length check. The
existing `decoded.length === 32` requirement is unchanged and still
the final fail-closed guard for every other malformed input.
Regression coverage: `scripts/test-echo-agent-crypto.mjs` tests 19-25.

No secret value, hash, prefix, or suffix was read, derived, or printed
at any point during this incident's investigation or remediation.
