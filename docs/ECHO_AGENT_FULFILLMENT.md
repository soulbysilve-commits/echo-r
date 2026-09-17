# ECHO Agent — `automatic_download` Fulfillment (v1)

Companion to `PAYMENT_OPERATIONS.md` (which covers `manual` and
`relay`) and `STRIPE_SETUP.md` (Stripe Dashboard configuration). This
document covers the third fulfillment mode: `automatic_download`.

**Scope: Stripe Sandbox + Vercel Preview only.** Nothing here changes
`STRIPE_SALES_LIVE_ENABLED` or promotes anything to Production — see
"Production status" at the end of this document.

## What `automatic_download` actually does

Set `ECHO_AGENT_FULFILLMENT_MODE=automatic_download`. After a
signature-verified, ECHO-Agent-matched Stripe webhook event:

1. The webhook (`app/api/stripe-webhook/route.ts`) writes/updates a
   durable **entitlement** record — internal bookkeeping, not itself
   an authorization to download anything.
2. The customer's browser, on the success page, polls
   `GET /api/echo-agent-order-status` until the entitlement is
   `"ready"`, then shows a Download button.
3. Clicking Download calls
   `POST /api/echo-agent-download-token` — this is the **real**
   authorization boundary (see "Two-layer verification" below). It
   independently re-verifies everything against Stripe and issues a
   signed license plus a one-time download token.
4. `GET /api/echo-agent-download` consumes that token exactly once and
   streams the decrypted release artifact.

No public URL for the artifact exists anywhere (`ECHO_AGENT_ENCRYPTED_DISTRIBUTION.md`
covers storage/encryption in detail).

## Two-layer verification

**Layer 1 — the webhook (bookkeeping, fast, low-stakes).** Gated on
`session.metadata.product === "echo-agent"` (the same signal
`manual`/`relay` already use — only this integration's own checkout
route ever sets it). Records an entitlement, marks it `"ready"` only
when the session's own `payment_status` (and, for subscriptions, the
subscription's own status) already look healthy. Idempotent: Stripe
event replay never creates a duplicate entitlement or double-processes
anything (`lib/entitlement.ts` `recordEventOnce`, atomic
create-if-absent).

**Layer 2 — the download-token route (authoritative, slow, the actual
gate — `app/api/echo-agent-download-token/route.ts`).** Before issuing
anything, this route independently re-does, from scratch, against
live Stripe and the browser:

1. Re-fetches the Checkout Session directly from Stripe (never trusts
   anything the browser sent beyond `session_id`).
2. Re-derives the price from the session's own line items and requires
   it to match `STRIPE_ECHO_AGENT_PRICE_ID` *right now* — this is
   deliberately **not** done at the webhook layer (see the code
   comment in `app/api/stripe-webhook/route.ts` for why: it would add
   a live Stripe dependency to every webhook delivery and to local
   testing, for a check this layer already does correctly and is the
   one that actually gates delivery).
3. Re-checks `payment_status` and, for subscriptions, the subscription
   status, live.
4. **Checkout browser binding**: constant-time-compares the
   `echo_agent_checkout_nonce` HttpOnly cookie (set at Checkout Session
   creation, `app/api/echo-agent-checkout/route.ts`) against
   `session.metadata.checkout_nonce_hash`. `session_id` alone (visible
   in the success URL) is never treated as sufficient proof — someone
   who merely learns/guesses a `session_id` without the matching
   cookie is denied.
5. Confirms the durable entitlement is `"ready"` and, for
   subscriptions, that the entitlement's own recorded subscription
   state is still active/trialing (belt-and-suspenders alongside step 3).
6. Confirms a release manifest actually exists for the entitlement's
   `releaseId`.

Only after all six pass does it issue a signed license
(`ECHO_AGENT_LICENSE.md`) and a short-lived, single-use download token
(`ECHO_AGENT_ENCRYPTED_DISTRIBUTION.md` "Download token").

## Entitlement lifecycle

Stored at `fulfillment/entitlements/<checkout-session-id>.json` in the
same private object storage as the artifact. States:

- `pending` — session recorded, not yet confirmed paid/healthy.
- `ready` — looked paid/healthy as of the last webhook event. Not
  itself sufficient to download (see Layer 2 above).
- `failed` — the success page's own status lookup errored; shown to
  the customer as "we couldn't prepare your download," never silently
  stuck on "preparing."

Subscription state is tracked separately
(`fulfillment/subscriptions/<subscription-id>.json`), updated by
`customer.subscription.updated`/`.deleted`/`invoice.payment_failed`.
**Subscription limitation, stated plainly:** canceling a subscription
stops *new* download-token issuance (Layer 2, steps 3 and 5) — it does
not and cannot reach into a customer's machine and revoke a copy
already downloaded, nor the license already issued for it (see
`ECHO_AGENT_LICENSE.md` "What this does not do").

## Checkout browser binding

`crypto.randomBytes(32)` generated at Checkout Session creation,
stored **only** as an `HttpOnly; Secure; SameSite=Lax` cookie
(`echo_agent_checkout_nonce`) on the browser. Only its SHA-256 hash
goes into Stripe metadata (`checkout_nonce_hash`) — the raw nonce
never leaves the cookie. `session_id` alone is never trusted (spec
requirement: `SESSION_ID_ALONE_TRUSTED=false`).

## Download token TTL and one-time semantics

`ECHO_AGENT_DOWNLOAD_TOKEN_SECRET` (HMAC-SHA256), TTL from
`ECHO_AGENT_DOWNLOAD_TOKEN_TTL_SECONDS` (default 300s, hard-capped at
3600s — an unset value uses the default, an invalid or too-large value
fails closed rather than clamping silently; see
`lib/downloadToken.ts`). The token itself is never placed in a
URL/query string — only in a short-lived `HttpOnly` cookie
(`echo_agent_download_session`), set by the token-issuing route and
read back by the download route.

**One-time consumption is a real atomic primitive, not an in-memory
Set** (which would be lost on every serverless cold start/instance
recycle): `lib/entitlement.ts` `claimDownloadToken` does a
conditional, create-if-absent object write
(`fulfillment/download-claims/<sha256(jti)>.json`) via the storage
layer's `IfNoneMatch: "*"` support. Verified this session with a real
10-way concurrent race against the actual code path: exactly one
winner, every time (`scripts/test-echo-agent-download-auth.mjs`, test
B3). A second attempt with the same token — replay, double-click, or a
genuine race loser — gets `410 Gone`.

## Admin reissue

No unauthenticated "resend my download" exists anywhere in this
integration, by design (the spec that drove this work explicitly
prohibits it). If a customer's one-time token/download is consumed but
they never received the file (network failure, etc.), there is
currently no self-service path — an administrator would need to issue
a fresh entitlement/token manually (e.g., by re-running the
`checkout.session.completed` handling for their session, or, in a
future version, a dedicated authenticated admin endpoint). **This v1
does not implement that admin tool** — flagged here as a known gap,
not silently assumed away.

## Production status

`AUTOMATIC_DOWNLOAD_PRODUCTION_READY=false`, regardless of how well
this works in Sandbox/Preview. Going live additionally requires: a
real object storage bucket, real KEK/license keys provisioned outside
this repo, a live Stripe webhook pointed at the production domain, and
an explicit decision to flip `STRIPE_SALES_LIVE_ENABLED=true` — none
of which this integration does on its own, ever.
