# ECHO Agent — Sandbox E2E Evidence Record (sanitized)

Phase 32 of the live-launch pass. No secret values appear anywhere in
this document — presence/absence and pass/fail status only.

## Historical record (from the prior session that built and proved the
Sandbox flow; carried forward as the mission's own verified baseline,
not re-derived from scratch by this pass)

- Environment: `https://echo-agent-sandbox.veritasforge.net`
  (Vercel custom environment `sandbox`).
- Stripe account: `acct_1SYonVQ3JDgHG3iS`, **TEST mode**.
- Price: `price_1UECSHQ3JDgHG3iSKOh1BYFO`, ¥1,000/month, recurring.
- Result: `FULL_PURCHASE_E2E=PASS` — a real Stripe TEST MODE Checkout
  was completed end-to-end (test card, never a real card), the webhook
  fired and was signature-verified, an entitlement was created, a
  license was issued, and a decrypted download was completed and
  verified byte-for-byte against the original artifact.
- Windows release under test: `echoagent-win-20260913T022010Z-f950a3424ee4`
  (encrypted R2 object SHA-256 `e34a36e4f58a28cd02f86123eaed0a03d13a77dee3311e993b8f1c46dc37feb9`,
  plaintext SHA-256 `5cfa175f1f34d31d921de2fbae10c442d82d585b66bbdc9aaf1cad1f1d9e85de`,
  31,156,763 bytes).

## What this pass independently re-verified today (2026-09-13), without
touching or re-running the live Sandbox purchase itself (out of scope
for a website-only pass, and unnecessary — re-running a real Stripe
TEST checkout was not required to confirm the Sandbox price/config
remained untouched)

- `price_1UECSHQ3JDgHG3iSKOh1BYFO` was never referenced, modified, or
  archived by any change in this pass — confirmed by reading every
  diff this pass made (`lib/stripe.ts`, `lib/entitlement.ts`,
  `app/api/echo-agent-checkout/route.ts`, and the new
  `scripts/test-echo-agent-live-launch-safety.mjs`) and by the full
  price-string grep in `ECHO_AGENT_PRICE_MATRIX.md`.
- `https://echo-agent-sandbox.veritasforge.net/` responds `HTTP 200`
  after this pass's Production deployment (deployed to the `production`
  target only — the `sandbox` custom environment/deployment was never
  redeployed or altered by this pass).
- All 4 standalone regression suites re-run clean after every code
  change this pass made:
  - `scripts/test-echo-agent-crypto.mjs` — 14/14 pass.
  - `scripts/test-echo-agent-download-auth.mjs` — 18/18 pass.
  - `scripts/test-echo-agent-fulfillment.mjs` — 37/37 pass (spins up
    real local `next start` servers against fake Stripe-shaped webhook
    payloads — this is the suite that exercises manual/relay/
    automatic_download webhook dispositions and idempotency).
  - `scripts/test-echo-agent-live-launch-safety.mjs` (new this pass) —
    25/25 pass (live-sales environment guard, price/environment
    validation, fulfillment namespace isolation).
  - Total: 94/94 pass, 0 new failures.
- `npm run build` (Next.js production build, Turbopack) succeeds with
  the exact route set expected (all `/api/echo-agent-*` and
  `/api/stripe-webhook` routes still present and dynamic; new `/eula`,
  `/ja/eula` routes present and static).

## What this pass did NOT do (by design, per the two hard stops)

- Did not create or attempt any real Stripe LIVE payment/checkout.
- Did not re-run the Sandbox TEST purchase end-to-end again (the prior
  session's `PASS` result stands; nothing in this pass could have
  invalidated it, per the diff review above).

## Release swap: LICENSE_TRUST_ROOT_BYPASS fix (2026-09-14)

See `docs/security/LICENSE_TRUST_ROOT_BYPASS_REMEDIATION.md` for the
full vulnerability/fix writeup. Summary of what changed for this
document's purposes:

- Prior release `echoagent-win-20260913T022010Z-f950a3424ee4` is now
  `SECURITY_SUPERSEDED` (a customer-controlled runtime env var could
  substitute the license trust root inside the shipped binary) and is
  no longer used for new customer fulfillment. It is retained in
  private R2 storage, unmodified, for audit/history.
- New release `echoagent-win-20260914T072837Z-57d883c6`: built from
  the fixed source (24-file closure, same `docs/PROPRIETARY_RELEASE_BUILD.md`
  procedure) as genuine native Windows `PE32+` binaries (both
  `echo_agent_cli_v1.exe` and `echo_agent_computer_use_service_v1.exe`,
  confirmed via `file(1)` on the actual compiled output, not just
  source). Closure security gate
  (`scripts/release_closure_security_gate_v1.py` in the ECHODiscord版
  repo) confirms `RELEASE_CLOSURE_FORBIDDEN_OVERRIDE=ABSENT` in the
  compiled output. Adversarial smoke test against the actual `.exe`
  (env-var trust-root attack, forged signer, tampered license, missing
  license, and a license genuinely signed by the real production
  private key) all produced the expected fail-closed/accept results —
  see the remediation doc for the full evidence.
- Encrypted, packaged, and uploaded to private R2 via
  `scripts/package-echo-agent-release.mjs`:
  `PLAINTEXT_SHA256=e273694dc04498adcafdc6ca8cff7cbeecf889b6f9cf23c1f9dc4ff2b8414f07`,
  `ENCRYPTED_SHA256=cab1aed14e3fd74a53c215bb1db46c46ae8d523378ccf8dc847166e1a3f7ba77`,
  30,859,212 bytes plaintext and encrypted. Anonymous/public access to
  the encrypted object confirmed rejected (`HTTP 400`, no
  authorization).
- `ECHO_AGENT_ARTIFACT_RELEASE_ID` updated to the new release id in
  Vercel's `Preview`, `sandbox`, and `Production` environments (via
  `vercel env rm` + `vercel env add`, values never printed) and in
  this repo's `.env.local`. No Stripe key, price, or webhook secret was
  touched by this release swap.
- Automated regression re-run after the swap (see
  `docs/security/LICENSE_TRUST_ROOT_BYPASS_REMEDIATION.md` for exact
  pass counts): `test-echo-agent-crypto.mjs`,
  `test-echo-agent-fulfillment.mjs`, `test-echo-agent-download-auth.mjs`,
  `test-echo-agent-live-launch-safety.mjs`, and `npm run build` all
  green. A fresh real Stripe TEST purchase against the new release was
  NOT run in this pass (the automated regression above, plus this
  document's already-proven historical fulfillment chain against the
  same fulfillment code paths, was judged sufficient to establish the
  release swap works structurally; see the remediation doc for the
  explicit reasoning) -- `STRIPE_SALES_LIVE_ENABLED` remained `false`
  throughout.
