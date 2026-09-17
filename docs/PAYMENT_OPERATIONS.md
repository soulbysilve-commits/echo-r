# ECHO Agent — Payment Operations

How the Stripe integration actually behaves, what it stores, and what
still requires a human. Companion to `STRIPE_SETUP.md` (Stripe
Dashboard configuration); this document covers the application-level
data flow and day-to-day handling of orders.

## Flow

```
Product page (Purchase button, only shown once live sales are enabled)
  -> POST /api/echo-agent-checkout            (creates a Stripe Checkout Session; price is server-side only)
  -> Stripe-hosted Checkout page              (customer pays here, never on this site)
  -> success_url  /echo-agent/success?session_id=...
       -> GET /api/echo-agent-order-status    (re-checks the session AND, for subscriptions, the subscription
                                                 itself DIRECTLY against Stripe; the session_id query param
                                                 alone is never treated as proof of payment, and Checkout
                                                 completing alone is never treated as proof a subscription
                                                 is active)
  (in parallel, independent of the browser)
  -> Stripe sends a webhook to /api/stripe-webhook
       -> signature verified (stripe.webhooks.constructEvent)
       -> ECHO_AGENT_FULFILLMENT_MODE decides what happens next -- see §0
```

The webhook path is the only one this integration treats as
authoritative for "this order is real." The success page's own
Stripe-side re-check exists purely for the customer's immediate
on-screen feedback and is a separate, independent confirmation — not a
substitute for the webhook.

## 0. Fulfillment mode: manual (current) vs. relay vs. automatic_download

Set by `ECHO_AGENT_FULFILLMENT_MODE` (`lib/stripe.ts`,
`getFulfillmentMode()`). This variable is **required** — it must be
set to exactly `manual`, `relay`, or `automatic_download`. Unset,
empty, or any other value (a typo included) fails the webhook closed
(HTTP 500) instead of guessing a mode; it never silently falls back to
any of the three on an unset/invalid value, since each requires its
own real configuration to be considered active.

**`manual` — Phase 1, current recommended mode.** The webhook route
verifies the Stripe signature, confirms the event is a relevant ECHO
Agent product event, and then does **nothing else**: no relay call, no
external write, no license issuance. It returns
`{ received: true, fulfillmentMode: "manual", disposition: "manual_fulfillment_pending" }`.
**Stripe's own Dashboard (Payments / Customers / Subscriptions) is the
sole authoritative payment record in this mode** — there is no
database, no order table, no "DB-free but somehow still durably
deduplicated" record anywhere in this application. An administrator:

1. Confirms the payment/subscription directly in the Stripe Dashboard.
2. Delivers ECHO Agent to the customer by hand, following the same
   distribution boundaries as the compiled release itself (see the
   ECHODiscord repository's `docs/DEVELOPER_RELEASE_MANIFEST.md`).

Because manual mode's handler is side-effect-free, a Stripe webhook
retry (or an intentional resend of the same `event.id`) is trivially
safe — it repeats the same no-op and returns the same acknowledgment,
never double-delivers or double-charges anything, since nothing was
delivered or charged by this handler in the first place.

**Product validation.** A signature-verified event is never enough by
itself — the webhook also confirms the event is actually about ECHO
Agent before either mode acts on it (`matchesEchoAgentProduct` in
`app/api/stripe-webhook/route.ts`). The primary signal is
`metadata.product === "echo-agent"`, set by this integration itself at
Checkout Session creation (`app/api/echo-agent-checkout/route.ts`) —
for subscription-mode sessions, the same call also sets
`subscription_data.metadata`, so the resulting Subscription (and, via
Stripe's own invoice-finalization snapshot, its Invoices) carry the
marker independently of the originating session. `STRIPE_ECHO_AGENT_PRICE_ID`
is checked only as a fallback signal (line-item/subscription-item price
ID match) for objects where that metadata might legitimately be
absent. An event that matches neither signal — some other product on
the same Stripe account, for instance — is acknowledged with 2xx and
produces no side effect in either mode; retrying it would never change
the outcome, since the event's own data doesn't change between
deliveries, so this also avoids provoking an unnecessary Stripe retry
storm over an event that will never become processable.

**`relay` — original behavior, unchanged, for future automation.**
Forwards the order record to `ECHO_AGENT_ORDER_WEBHOOK_URL` exactly as
described in §1 below, including the fail-closed and idempotency
behavior in §2. Switch to this once a downstream system exists that
can safely receive and deduplicate ECHO Agent order records (see the
relay-reuse investigation this project already went through — the
existing `echo-early-access` relay endpoint's own record shape and
dedup key are not automatically compatible; a dedicated endpoint is
recommended).

**`automatic_download` — Sandbox/Preview only, self-service delivery.**
Creates a durable entitlement, then (after independent re-verification
at download-token time) issues a signed per-purchaser license and a
one-time, encrypted download — no manual/relay step involved. This
mode has its own dedicated document: `ECHO_AGENT_FULFILLMENT.md`
(authorization flow, entitlement lifecycle, admin reissue limitations)
plus `ECHO_AGENT_ENCRYPTED_DISTRIBUTION.md` (storage/encryption) and
`ECHO_AGENT_LICENSE.md` (license signing/verification). Requires
`ECHO_AGENT_STORAGE_*`/`ECHO_AGENT_ARTIFACT_*`/`ECHO_AGENT_LICENSE_*`/
`ECHO_AGENT_DOWNLOAD_TOKEN_*` to be configured — fails closed (500) if
they are not, same as `relay` failing closed on an unset relay
endpoint. `AUTOMATIC_DOWNLOAD_PRODUCTION_READY=false` regardless of
Sandbox/Preview results — see `ECHO_AGENT_FULFILLMENT.md` "Production
status."

## 1. Where orders are actually recorded (`relay` mode only — see §0)

**This site has no database.** A confirmed, signature-verified Stripe
event is forwarded to `ECHO_AGENT_ORDER_WEBHOOK_URL` — the exact same
relay pattern `app/api/echo-early-access/route.ts` already uses for
Early Access signups, not a new system built for this integration.

The record sent (see `lib/orderRelay.ts` for the exact shape):

```json
{
  "eventId": "evt_...",
  "eventType": "checkout.session.completed",
  "stripeCustomerId": "cus_...",
  "checkoutSessionId": "cs_...",
  "paymentIntentId": "pi_...",
  "subscriptionId": null,
  "product": "echo-agent",
  "status": "paid",
  "customerEmail": "buyer@example.com",
  "amountTotal": 50000,
  "currency": "usd",
  "createdAt": "2026-...",
  "secret": "<ECHO_AGENT_ORDER_WEBHOOK_SECRET, so your relay can verify the call came from this site>"
}
```

No card number, CVC, or other card data ever passes through this
site — Stripe Checkout collects payment details directly on Stripe's
own hosted page, which this site never sees.

**This is explicitly "Phase 1"**, matching the option the integration
request allowed: Stripe purchase confirmation + a purchaser record +
admin-mediated delivery, without standing up a dedicated license
server. If you want this to become fully self-service (automatic
license/download delivery), you need real persistent storage (a
database or KV store) wired into the webhook handler and a delivery
mechanism in §3 below — neither was built this session, and doing so
safely (especially the signed-URL delivery approach the original
request suggested) is real, additional work, not a small toggle.

## 2. Idempotency (no double license issuance) — `relay` mode

This section describes `relay` mode's idempotency contract. **In
`manual` mode there is no relay call and nothing is issued or
delivered by this application at all**, so there is no double-delivery
risk to guard against here in the first place — see §0.
Re-emphasizing precisely, since this is easy to overstate: manual
mode's safety is "the handler does nothing, so nothing can be done
twice," not "this application persistently deduplicated the event."
This application has no database in `manual` or `relay` mode.
(`automatic_download` mode is the exception — it uses private object
storage as a small durable store specifically for webhook-event and
download-token idempotency; see `ECHO_AGENT_FULFILLMENT.md`.)

Verified locally this session (Stripe SDK's own
`Stripe.webhooks.generateTestHeaderString()` test-signature generator,
against a local mock of the order-relay endpoint — see the completion
report's `TEST_MODE_E2E` for the exact scenarios run):

- The webhook handler forwards every verified event, including its
  Stripe event ID, to your relay endpoint.
- Your relay endpoint is expected to return `{ ok: true, duplicate: true }`
  if it has already recorded that exact event ID, and `duplicate: false`
  the first time — the same contract `echo-early-access` already uses.
- **The relay endpoint is therefore where real dedup happens.** This
  site's own route has no independent memory of past events (no
  database, stateless serverless functions) — it trusts the relay's
  answer. If your relay endpoint does not itself dedup by `eventId`,
  a Stripe webhook retry (which Stripe does automatically on any
  failure) could reach your relay twice. Confirm your relay
  deduplicates by `eventId` before going live — most no-code
  automation tools (Zapier, Make, Airtable automations, etc.) can do
  this with a "does this record already exist" lookup step keyed on
  `eventId`.

## 3. Delivering ECHO Agent after a confirmed purchase

The ECHO Agent binary is **not** placed anywhere under this site's
`public/` directory or any other route the browser can reach —
confirmed this session (`find public -type f` shows only pre-existing
site assets; nothing ECHO-Agent-related, and a live server was also
tested against plausible public static paths directly — both 404). No
permanent public download link exists anywhere in this integration.

**`manual` mode (default/recommended today) — process is manual:**

1. You receive the order record (§1, `relay` mode) or confirm directly
   in the Stripe Dashboard (`manual` mode — see §0).
2. You independently confirm the order in the Stripe Dashboard if
   needed.
3. You personally deliver ECHO Agent to the customer (e.g. a private,
   time-limited download link you generate through whatever file host
   you use, or a direct handoff) — following the same distribution
   boundaries already established for the compiled release itself
   (see the ECHODiscord repository's `docs/DEVELOPER_RELEASE_MANIFEST.md`
   and related completion reports: source stays private, only the
   compiled artifact and its docs go to a customer).

**`automatic_download` mode (Sandbox/Preview only) — self-service:**
a short-lived, single-use signed download token
(`ECHO_AGENT_DOWNLOAD_TOKEN_SECRET`-signed, not a permanent public
link) is generated only after independent re-verification at request
time, exactly matching the original integration guidance's intent. See
`ECHO_AGENT_FULFILLMENT.md` for the full flow — this mode exists and
is fully implemented/tested, but remains gated to Sandbox/Preview
(`AUTOMATIC_DOWNLOAD_PRODUCTION_READY=false`) until a real storage
bucket and production secrets are provisioned and this is explicitly
turned on for live use.

## 4. Customer data actually stored

Only what's listed in §1's record shape, and only wherever your
`ECHO_AGENT_ORDER_WEBHOOK_URL` endpoint stores it — this site's own
code holds nothing after the HTTP response completes (no database, no
file writes). Stripe itself separately retains full customer/payment
records in your Stripe account, governed by Stripe's own systems, not
this integration's code.

This purchase data is completely separate from ECHO Agent's own local
Memory/WAL continuity state (which lives entirely on a customer's own
machine after they install the product, per the completion reports for
that work) — there is no code path anywhere that could cross-contaminate
the two, since they don't share any storage, process, or account
concept.

## 5. What happens on a failed/incomplete payment

- Customer cancels Checkout → redirected to `/echo-agent/cancel` (or
  `/ja/echo-agent/cancel`). No order record is created (Stripe never
  sends `checkout.session.completed` for an abandoned session).
- Card declined during Checkout → the customer sees Stripe's own
  hosted error UI and can retry; again, no `checkout.session.completed`
  fires unless they succeed.
- A subscription's recurring payment fails after the fact → Stripe
  sends `invoice.payment_failed`, which this integration forwards to
  your relay with `status: "payment_failed"` so you can follow up (this
  integration does not itself pause or revoke access automatically,
  since there is no access-control system on the ECHO Agent side to
  call — see §3).

## 6. Refunds

Handled entirely in the Stripe Dashboard/API — see `STRIPE_SETUP.md`
§6. No refund automation exists in this codebase.
