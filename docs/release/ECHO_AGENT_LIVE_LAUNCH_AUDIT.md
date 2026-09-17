# ECHO Agent — Live Launch Preflight Audit

Phase 0 of the live-launch pass (2026-09-13). Read-only findings first,
then a record of what this pass changed. Companion documents:
`ECHO_AGENT_COMMERCIAL_DEFINITION.md`, `ECHO_AGENT_PRICE_MATRIX.md`,
`ECHO_AGENT_LAUNCH_READINESS.md` (all in this directory), and
`docs/legal/*` for the legal-side findings.

## Repo / git state

- Repo: `/home/silver/echo-r`, branch `main`, HEAD at the start of this
  pass: `483bddcac51afddc1594eec18085235d9e2a711e`.
- Working tree had pre-existing uncommitted work from an earlier
  session: modified nav/sitemap files, and a large set of untracked
  files implementing the entire ECHO Agent Stripe/fulfillment stack
  (`app/api/echo-agent-*`, `app/api/stripe-webhook`,
  `app/components/EchoAgent*`, `app/echo-agent/`, `app/ja/echo-agent/`,
  `lib/{stripe,entitlement,license,release,storage,downloadToken,
  checkoutNonce,artifactCrypto,orderRelay}.ts`, `docs/*`, `scripts/*`).
  This pass builds on top of that work; nothing in it was reverted or
  reset. No commit was made by this pass (commits require separate
  explicit authorization).
- Vercel project: `echo-r` (`prj_kJfg3LN6nrxPa1nuaSEPkDaA8AQ2`), team
  `Veritas Forge` (`team_DtWfq8yXPVjlSkoxD9XuzJ9Y`). Three other,
  apparently-orphaned Vercel projects exist under the same team
  (`echo-r-meje`, `echo-r-q9li`, `echo-r-do4k`) — not touched by this
  pass; out of scope.

## Existing ECHO Agent implementation (verified by direct code reading)

- **Checkout**: `app/api/echo-agent-checkout/route.ts`. Price ID is
  resolved **entirely server-side** from `STRIPE_ECHO_AGENT_PRICE_ID`
  — the browser never supplies or influences a price. Mode
  (`payment`/`subscription`) is inferred from whether the configured
  Price is recurring. A browser-binding nonce (`crypto.randomBytes(32)`,
  HttpOnly cookie, only its SHA-256 hash stored in Stripe metadata) is
  set at Checkout Session creation. Gated on
  `isStripeLiveSalesEnabled() || isStripeTestCheckoutEnabled()` —
  reachable but inert when neither gate is on.
- **Webhook**: `app/api/stripe-webhook/route.ts`. Verifies the Stripe
  signature before reading any event data (fail-closed 400 on bad
  signature). Only acts on `checkout.session.completed`,
  `customer.subscription.updated`, `customer.subscription.deleted`,
  `invoice.payment_failed`. Requires `metadata.product === "echo-agent"`
  (fallback: configured Price ID match) before treating an event as an
  ECHO Agent order — an unrelated Stripe event on the same account is
  acknowledged 2xx with zero side effects, never retried pointlessly.
  Three fulfillment modes, selected by `ECHO_AGENT_FULFILLMENT_MODE`
  (fails closed / HTTP 500 on unset or invalid value — never guesses):
  `manual` (no side effects, Stripe Dashboard is the record of truth),
  `relay` (forwards to an operator webhook), `automatic_download`
  (the mode actually used by Sandbox — durable entitlement + later
  license/download issuance).
- **Fulfillment (`automatic_download`)**: two-layer verification. Layer
  1 (webhook) writes a durable entitlement record
  (`lib/entitlement.ts`, private R2-compatible object storage,
  `lib/storage.ts`) — bookkeeping only. Layer 2
  (`app/api/echo-agent-download-token/route.ts`) is the actual
  authorization boundary: re-fetches the Checkout Session live from
  Stripe, re-derives the price from the session's own line items and
  requires it to match the configured Price ID *right now*, re-checks
  payment/subscription status live, constant-time-verifies the
  checkout-nonce cookie against `session.metadata.checkout_nonce_hash`
  (so `session_id` alone, visible in the success URL, is never
  sufficient), confirms the entitlement is `"ready"`, and confirms a
  release manifest exists — only then issues a signed Ed25519 license
  (`lib/license.ts`) and a short-lived, single-use, HMAC-signed
  download token (`lib/downloadToken.ts`).
- **Download**: `app/api/echo-agent-download/route.ts`. Token read only
  from an HttpOnly cookie (never a URL/query string). One-time
  consumption is a real atomic primitive
  (`putObjectIfAbsent`/`IfNoneMatch: *` on the object store, not an
  in-memory Set) — verified under a real 10-way concurrent race in
  `scripts/test-echo-agent-download-auth.mjs` (exactly one winner).
  Artifact is decrypted (AES-256-GCM) in-memory, streamed straight into
  the HTTP response; never written to disk, never placed under
  `public/` or any other browser-reachable static path (confirmed:
  `find public -type f` shows only pre-existing site assets).
- **Cancellation / entitlement persistence (verified in code, matches
  the known prior finding exactly)**: `customer.subscription.deleted`
  updates the durable subscription-state record to `"canceled"`, which
  blocks *future* download-token issuance (Layer 2, steps 3 and 6 of
  `app/api/echo-agent-download-token/route.ts`) — but there is no code
  path anywhere that revokes a license or download already issued
  before cancellation. This is stated explicitly in the pre-existing
  `docs/ECHO_AGENT_FULFILLMENT.md` ("Subscription limitation, stated
  plainly") and confirmed by reading the actual handler code; see
  `docs/legal/ECHO_AGENT_REFUND_CANCELLATION_DECISIONS.md`.
- **Env var handling**: every secret is read from `process.env` only,
  never hardcoded; every accessor returns `null`/`false` rather than
  throwing at import time, and every caller fails closed (503/500) on
  missing config rather than guessing. No secret value is ever logged
  (verified by reading every `console.error`/`console.log` call site in
  the checkout/webhook/download-token/download routes — all log IDs,
  types, and statuses only).
- **Feature flags**: `STRIPE_SALES_LIVE_ENABLED` (real purchase button),
  `STRIPE_TEST_CHECKOUT_ENABLED` (Preview/dev-only test Checkout,
  hard-blocked on `VERCEL_ENV === "production"` before any other
  check), `ECHO_AGENT_FULFILLMENT_MODE` (required, fails closed).
- **Production deployment config**: standard Next.js 16 / Vercel
  project, no `vercel.json` present (default framework detection).
  `npm run build` has no test step; there is no `npm test` — the
  project's own tests are the standalone scripts under `scripts/`
  (`node --experimental-strip-types scripts/test-*.mjs`), run manually.

## Legal pages (existing, before this pass)

- `/legal` + `/ja/legal`: already a real 特定商取引法 (Japan commerce
  disclosure) page, but scoped to the **ECHO-R Founder Edition**
  product (¥500,000+ auction-style onboarding, ¥450,000+/month
  "protocol fee", 12-month minimum term) — **not** ECHO Agent. It does,
  however, already carry genuine, non-fabricated seller identity:
  販売業者 "Veritas Forge"、運営責任者 "鈴木佑人（SoulBySilver）"、所在地
  "533-0031 大阪府大阪市東淀川区西淡路3-9-10-804"、電話番号
  "080-9033-2169"、メール "soulbysilver@veritasforge.net". This pass
  reuses those verified fields for the new ECHO Agent-specific
  commerce disclosure (see `docs/legal/ECHO_AGENT_JAPAN_COMMERCE_CHECKLIST.md`)
  rather than re-deriving or inventing them.
- `/terms` + `/ja/terms`, `/privacy` + `/ja/privacy`: generic
  AI-personality-consulting-service terms, no software-license,
  digital-download, subscription-cancellation-mechanics, or
  local-execution language. See `docs/legal/*` for the
  COVERED/PARTIAL/MISSING breakdown.
- No EULA existed anywhere in the repo before this pass.
- The EN-locale versions of `/terms`, `/privacy`, `/legal` are, as
  shipped, the same Japanese-language body copy as the JA versions
  (only page chrome/metadata differs) — a pre-existing site-wide
  convention, not something introduced or "fixed" by this pass (out of
  scope; flagged for the owner's awareness only).

## Stripe / environment state (verified via Vercel CLI + `.env.local`)

- `.env.local`: exactly one Stripe secret, `STRIPE_SECRET_KEY` =
  `sk_test_...` (Sandbox). No `sk_live_` value anywhere in this file.
- Vercel env vars (`vercel env ls`): **every** existing ECHO Agent
  variable (Stripe + storage + artifact + license + download-token) is
  scoped only to `Preview, sandbox` — **zero** variables exist under
  `Production`. Confirmed directly (`vercel env ls production` →
  "No Environment Variables found").
- No `sk_live_` Stripe key exists anywhere this pass could find (local
  or Vercel) → `STRIPE_LIVE_SECRET=MISSING` (see
  `ECHO_AGENT_LAUNCH_READINESS.md`).
- Domains: `veritasforge.net` is attached to the `veritas-forge` team,
  but only `echo-agent-sandbox.veritasforge.net` is actually attached
  to the `echo-r` project (per `vercel domains inspect`). The domain
  itself is flagged by Vercel as **not fully configured** for this
  project ("This Domain is not configured properly... Current
  Nameservers ✘"). `echo-r.veritasforge.net` is hardcoded pervasively
  throughout the codebase (canonical URLs, OG tags, the `/legal` page's
  own "ウェブサイト" field, `NEXT_PUBLIC_SITE_URL`'s code-level
  fallback) as the evident *intended* production domain, and currently
  resolves (HTTP 200, served through Cloudflare, real Next.js response
  headers) — but Vercel does not show it as attached/verified to the
  `echo-r` project, so this pass cannot confirm what is actually
  serving it or attach it without a DNS change, which was avoided per
  instruction. The verified, actually-controlled Production URL for
  this project is `https://echo-r-mu.vercel.app` — see
  `PRODUCTION_CANONICAL_URL` in the final report and
  `ECHO_AGENT_LAUNCH_READINESS.md`.

## What this pass changed (summary; see each file for full comments)

- `lib/stripe.ts`: `isStripeLiveSalesEnabled()` now also requires
  `VERCEL_ENV` to be `"production"` or unset (defense-in-depth against
  a future live key + flag accidentally landing on Preview/Sandbox).
  Added `validatePriceForCurrentEnvironment()` — checkout-time guard
  rejecting a live Price outside Production, a test Price inside
  Production, or a live Price whose currency/amount/interval doesn't
  match the owner-authorized JPY 3000/month contract.
- `app/api/echo-agent-checkout/route.ts`: calls the new guard right
  after retrieving the configured Price, before ever creating a
  Checkout Session.
- `lib/entitlement.ts`: storage keys for entitlement/subscription/event/
  download-claim records now go through an explicit, opt-in namespace
  prefix (`ECHO_AGENT_FULFILLMENT_NAMESPACE`) — unset (Sandbox's
  current, unchanged state) reproduces the exact pre-existing key
  shape; Production sets it explicitly so its records can never
  collide with or be confused for Sandbox's.
- `scripts/test-echo-agent-live-launch-safety.mjs`: new, server-free
  regression suite for all of the above (25 checks).
- `app/components/EchoAgentProduct.tsx`, `app/eula/page.tsx` +
  `app/ja/eula/page.tsx`, `app/legal/page.tsx` + `app/ja/legal/page.tsx`:
  see `ECHO_AGENT_COMMERCIAL_DEFINITION.md` and
  `docs/legal/ECHO_AGENT_JAPAN_COMMERCE_CHECKLIST.md`.
- No changes were made to `lib/license.ts`, `lib/downloadToken.ts`,
  `lib/artifactCrypto.ts`, `lib/release.ts`, `lib/storage.ts`, or any
  webhook/download-token/download route logic beyond what's listed
  above — the proven Sandbox fulfillment chain is otherwise untouched.
