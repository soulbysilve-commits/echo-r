# ECHO Agent — LIVE Purchase E2E Evidence

Companion to `ECHO_AGENT_LIVE_E2E_RUNBOOK.md` (the procedure) and
`ECHO_AGENT_LAUNCH_READINESS.md` (the full gate status). This document
records what was, and was not, actually executed against Stripe LIVE
mode. No secret value appears anywhere below.

## Status: NOT ATTEMPTED

No real Stripe LIVE Product, Price, webhook, or Checkout Session was
ever created, and no real payment was ever attempted, in any session
of this project to date. This is not an oversight — it is the correct,
required outcome of the hard rule that governed every pass that
touched this area: never substitute a Test credential for a missing
Live one, and never perform a real charge before every prior gate
passes.

## Why

`STRIPE_LIVE_SECRET=MISSING`, confirmed independently, on three
separate dates by three separate sessions, via the same method
(Vercel environment-variable metadata — names and scopes only, no
values):

| Date | Finding |
|---|---|
| 2026-09-13 (Phase 33 launch pass) | Only one Stripe secret exists anywhere in this project: `sk_test_...`, scoped to `Preview,sandbox`. Zero Stripe variables of any kind in Production except `STRIPE_SALES_LIVE_ENABLED`. |
| 2026-09-15 (this pass) | Re-checked via `vercel env ls production` \| `grep -i STRIPE`: identical result — only `STRIPE_SALES_LIVE_ENABLED` (`"false"`) exists in Production. No `STRIPE_SECRET_KEY`, no `STRIPE_ECHO_AGENT_PRICE_ID`, no `STRIPE_WEBHOOK_SECRET`. |

Without a real `sk_live_...` key, none of the following are reachable,
regardless of how ready everything else is:

- Creating/reusing a LIVE Product or the ¥3,000/month LIVE Price
  (requires calling the Stripe API in live mode).
- Creating a LIVE webhook endpoint in Stripe and installing its real
  signing secret.
- `isStripeLiveSalesEnabled()` (`lib/stripe.ts`) returning `true` under
  any circumstance — it structurally requires a key starting with
  `sk_live_`, which does not exist in this environment.
- A real Checkout Session, a real charge, a real signed LIVE webhook
  delivery, or anything downstream of those.

## What WAS independently verified this pass, without a live key

Everything technically reachable without Stripe LIVE access:

- `PRODUCTION_CANONICAL_URL=https://echo-r-mu.vercel.app` (real,
  Vercel-alias-verified, not assumed).
- `GET /api/stripe-webhook` → `405`; unsigned `POST` → `503
  {"error":"webhook not configured"}` — both real, fails-closed
  application responses, no Deployment Protection/SSO interference.
- `¥3,000`/`3,000円` confirmed live on `/echo-agent` and
  `/ja/echo-agent`; no `¥1,000`/`1,000円` string present.
- Full security-boundary proof (R2, KEK, license signer, download-token
  secret) via real Vercel Production (and, for the download-token
  proof, real Sandbox) runtimes — see
  `docs/security/ECHO_AGENT_ENV_SECRET_BOUNDARY.md` §16-19.
- Full regression: 102/102 JS/TS + 32/32 Python, `npm run build` clean.

## Next action

Unchanged from the runbook: the owner creates or retrieves a real
`sk_live_...` Stripe secret key and either hands it to a future session
or installs it (and the resulting LIVE Price ID, once created) directly
into Vercel Production. Only then can `ECHO_AGENT_LIVE_E2E_RUNBOOK.md`'s
procedure — culminating in at most one real ¥3,000 validation charge —
begin.

```
REAL_LIVE_CHECKOUT=NOT_ATTEMPTED
REAL_3000_JPY_PAYMENT=NOT_ATTEMPTED
REAL_LIVE_WEBHOOK=NOT_ATTEMPTED
REAL_ENTITLEMENT=NOT_ATTEMPTED
REAL_LICENSE=NOT_ATTEMPTED
REAL_DOWNLOAD=NOT_ATTEMPTED
STRIPE_LIVE_CREDENTIAL_OWNER_ACTION_REQUIRED=true
```
