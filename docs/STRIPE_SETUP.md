# ECHO Agent — Stripe Setup (operator guide)

This covers what the business owner needs to do in the Stripe
Dashboard for the ECHO Agent Checkout integration already wired into
this site (`app/api/echo-agent-checkout`, `app/api/stripe-webhook`,
`app/api/echo-agent-order-status`, `lib/stripe.ts`, `lib/orderRelay.ts`).
No Stripe account action was taken on your behalf — this is a
step-by-step guide for you to run yourself.

## 1. Create the Product and Price

In the Stripe Dashboard (Product catalog):

1. Create a Product named **ECHO Agent**.
2. Add a Price under it. Stripe infers one-time vs. subscription
   automatically from what you choose here:
   - **One-time price** → Checkout runs in `payment` mode (buy-once
     license).
   - **Recurring price** → Checkout runs in `subscription` mode
     (monthly/annual maintenance). This site's code branches on
     `price.recurring` automatically, so switching pricing models
     later needs no code change — only a new Price.
3. Copy the Price ID (`price_...`). This is `STRIPE_ECHO_AGENT_PRICE_ID`.

No price was decided or invented by this integration work — set
whatever figure your own pricing decision settles on (see
`DEVELOPER_RELEASE_BUSINESS_CHECKLIST.md` in the ECHODiscord repository
for the still-open pricing decision).

## 2. API keys

Developers > API keys:

- **Secret key** (`sk_test_...` in test mode, `sk_live_...` in live
  mode) → `STRIPE_SECRET_KEY`.
- **Publishable key** (`pk_...`) → `STRIPE_PUBLISHABLE_KEY` (not
  currently used by any client-side code in this integration, kept for
  completeness).

Never paste these into any file this project tracks in git — only
into your deployment platform's environment variable settings, or a
local `.env.local` (already covered by this repo's `.env*` gitignore
rule).

## 3. Webhook endpoint

Developers > Webhooks > Add endpoint:

- URL: `https://<your-domain>/api/stripe-webhook`
- Events to send (this integration only acts on these; sending more is
  harmless, sending fewer means some order states won't be recorded):
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_failed`
- After creating the endpoint, copy its **Signing secret**
  (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`.

For local development, `stripe listen --forward-to localhost:3000/api/stripe-webhook`
(Stripe CLI) prints a temporary `whsec_...` you can use the same way —
install the CLI from Stripe's own docs if you want to do this;
it was not available in the environment this integration was built in,
so local testing here instead used the Stripe Node SDK's own
`Stripe.webhooks.generateTestHeaderString()` test-signature generator
against this repo's route directly (see `PAYMENT_OPERATIONS.md` for
what was and wasn't verified this way).

## 4. Environment variables (all deployment targets)

Set these wherever this site actually runs (e.g. Vercel Project
Settings > Environment Variables) — copy `.env.example` for the exact
list and comments:

| Variable | Where it comes from |
|---|---|
| `STRIPE_SECRET_KEY` | Dashboard > API keys |
| `STRIPE_WEBHOOK_SECRET` | Dashboard > Webhooks > your endpoint |
| `STRIPE_ECHO_AGENT_PRICE_ID` | Dashboard > Product catalog > ECHO Agent > Price |
| `STRIPE_PUBLISHABLE_KEY` | Dashboard > API keys |
| `STRIPE_SALES_LIVE_ENABLED` | You set this to `true` only when ready to show a real Purchase button (see §6) |
| `ECHO_AGENT_FULFILLMENT_MODE` | `manual` (current, recommended Phase 1), `relay`, or `automatic_download` (Sandbox/Preview only — see `ECHO_AGENT_FULFILLMENT.md`). **Required** — unset, empty, or any other value fails the webhook closed (HTTP 500) rather than guessing a mode. See `PAYMENT_OPERATIONS.md` §0. |
| `ECHO_AGENT_ORDER_WEBHOOK_URL` / `ECHO_AGENT_ORDER_WEBHOOK_SECRET` | **Only used in `relay` mode.** Not required, and safely left unset, in `manual`/`automatic_download` mode. Your own order-recording endpoint — see `PAYMENT_OPERATIONS.md` §1 |
| `STRIPE_TEST_CHECKOUT_ENABLED` | Set `true` on a **Preview** deployment's environment variables only, to run a real Stripe TEST MODE Hosted Checkout E2E — see §5a |
| `ECHO_AGENT_STORAGE_*`, `ECHO_AGENT_ARTIFACT_*`, `ECHO_AGENT_LICENSE_*`, `ECHO_AGENT_DOWNLOAD_TOKEN_*` | **Only used in `automatic_download` mode.** Private storage, artifact encryption, license signing, and download-token secrets — see `ECHO_AGENT_ENCRYPTED_DISTRIBUTION.md`, `ECHO_AGENT_LICENSE.md`, and `.env.example` for the full list with comments. |

### 5a. Running a real TEST MODE Checkout E2E on a Preview deployment

This is separate from, and never affects, the live-sales gate in §5.
On Vercel, set these as **Preview**-scoped environment variables (not
Production):

- `STRIPE_SECRET_KEY` = a **test-mode** key (`sk_test_...`)
- `STRIPE_ECHO_AGENT_PRICE_ID` = a **test-mode** Price ID
- `STRIPE_TEST_CHECKOUT_ENABLED=true`
- `STRIPE_WEBHOOK_SECRET` = the signing secret for a webhook endpoint
  pointed at that Preview deployment's URL (Preview URLs change per
  deployment, so re-point the Dashboard webhook endpoint, or use
  `stripe listen`, whenever the Preview URL changes)

With those set, the product page on that Preview deployment shows a
clearly-labeled "Test purchase ECHO Agent (Stripe test mode)" button
(never the real "Purchase ECHO Agent" wording) and completing it runs
an actual Stripe-hosted test Checkout — pay with
[Stripe's test card numbers](https://docs.stripe.com/testing), never a
real card. This gate is hard-blocked on Production by
`VERCEL_ENV === "production"` inside `isStripeTestCheckoutEnabled()`
(`lib/stripe.ts`) — setting `STRIPE_TEST_CHECKOUT_ENABLED=true` on
Production has no effect there, by design.

## 5. Test mode → Live mode switch

1. Do everything above in **test mode** first (`sk_test_...` /
   `pk_test_...`, a webhook endpoint pointed at your test deployment or
   `stripe listen`, a test-mode Price). Run the checkout flow with
   [Stripe's test card numbers](https://docs.stripe.com/testing) —
   never a real card.
2. Once satisfied, repeat §1–3 in **live mode** (Stripe Dashboard has a
   separate live/test toggle; live Products/Prices/webhook endpoints
   are created separately from test ones).
3. Replace the environment variables with the live-mode values.
4. Only then set `STRIPE_SALES_LIVE_ENABLED=true`. This site's product
   page checks BOTH that flag AND that `STRIPE_SECRET_KEY` starts with
   `sk_live_` before it will show a real "Purchase" button anywhere —
   either alone is not enough (see `lib/stripe.ts`,
   `isStripeLiveSalesEnabled`). This was verified directly this
   session: a live-shaped key with the flag off still shows the
   existing "Inquire" link, and the flag on with a live-shaped key
   shows "Purchase" — both were exercised locally.

**This integration will never flip that switch for you.** It ships
defaulting to off; you enable live sales explicitly when you decide
to.

## 6. Refunds

Refunds are issued directly in the Stripe Dashboard (Payments > find
the payment > Refund) or via the Stripe API/CLI. This integration does
not implement an in-app refund button or webhook-triggered access
revocation — if you refund a payment, separately follow up on
whatever access/delivery you already provided (see
`PAYMENT_OPERATIONS.md` for how delivery works today).

## 7. Confirming a purchase actually happened

Two independent ways, both sourced from Stripe itself (never from a
customer's claim or a URL):

- Stripe Dashboard > Payments, or Customers > the specific customer.
- Whatever endpoint you configured as `ECHO_AGENT_ORDER_WEBHOOK_URL`
  receives a record after Stripe's webhook signature is verified — see
  `PAYMENT_OPERATIONS.md` for the exact fields sent.
