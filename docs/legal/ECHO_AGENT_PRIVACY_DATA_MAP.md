# ECHO Agent — Privacy Data Map (website/purchase flow scope)

Phase 8 of the live-launch pass. Scope: **this website repository's
own code only** — the purchase, fulfillment, and download flow. The
compiled ECHO Agent Windows application's own runtime data handling
(what it does with a user's files, memory state, or model calls once
installed) lives in a separate repository and is **not** re-verified
line-by-line here; this document does not make claims about it beyond
what the ECHO Agent product page itself already states (e.g., "local
execution does not mean all communication is unnecessary" —
`environmentFoot` copy, unchanged by this pass). No "zero telemetry" or
"fully local, no data leaves your machine" claim is made anywhere by
this document or by the site copy this pass touched, because this pass
did not independently verify that claim against the compiled binary.

## LOCAL (never touches this website's servers)

- The compiled ECHO Agent application's own local state (Identity /
  Memory / Relationship / Affect / Temporal continuity, per the product
  page) — this lives on the purchaser's own machine, per the ECHO
  Agent repo's own prior verification (outside this repo's scope to
  re-confirm).
- The downloaded, decrypted ECHO Agent binary and its license file,
  once delivered to the purchaser's browser/disk.

## SERVER (this website's own Next.js server-side code, Vercel)

Read directly from the actual route handlers (`app/api/echo-agent-*`,
`app/api/stripe-webhook`):

- **Checkout Session creation** (`echo-agent-checkout`): locale
  (`"ja"`/`"en"`), a browser-binding nonce (HttpOnly cookie, only its
  SHA-256 hash retained server-side in Stripe metadata). No name,
  email, or payment data is collected by this route itself — Stripe
  Checkout collects payment details directly on Stripe's own hosted
  page (see STRIPE below).
- **Webhook** (`stripe-webhook`): reads the incoming Stripe event
  (customer ID, checkout session ID, subscription ID, payment status,
  customer email if present, amount, currency — whatever Stripe's own
  event payload contains) to decide fulfillment action. In
  `automatic_download` mode, writes a durable **entitlement record**
  (`lib/entitlement.ts`) to private object storage: checkout session
  ID, price ID, mode, Stripe customer ID, Stripe subscription ID,
  status, release ID, and the checkout-nonce **hash** (not the raw
  nonce). No card/CVC data is ever received or stored — Stripe
  Checkout never sends this site card data at all.
- **Order status / download-token routes**: re-read the same Stripe
  session/subscription objects live (no independent new PII collected
  beyond what's already listed).
- **License issuance** (`lib/license.ts`): the issued license payload
  contains a generated license ID, the entitlement ID (== checkout
  session ID), product name, release ID, Stripe checkout/subscription
  IDs, issuance/expiry timestamps — no purchaser name, email, or
  payment data embedded in the license itself.
- **Logging**: every log call site in the checkout/webhook/download
  routes was read directly for this audit — all log event IDs, types,
  and status strings only; none log a secret, card data, or (in most
  cases) even the customer email. This matches the pre-existing
  `PAYMENT_OPERATIONS.md` claim, verified again for this pass.
- **This site has no database and no user-account system for ECHO
  Agent.** The only durable server-side store is the private object
  storage described below, holding only the fulfillment records listed
  above.

## STRIPE (governed by Stripe's own privacy policy, not this site's)

Stripe Checkout collects payment details (card, billing details,
whatever Stripe's own hosted page asks for) directly — this site never
receives or stores it. Stripe separately retains customer/payment
records under the Seller's Stripe account, per Stripe's own retention
policies. The Seller's identity (for Stripe's own KYC) is Stripe's
relationship with the Seller, not with individual purchasers.

## R2 / PRIVATE OBJECT STORAGE (Cloudflare R2, S3-compatible)

Bucket `echo-agent-private-releases` (never public — verified: no
public bucket policy is set by any code in this repo, and
`getObjectStore()` always requires authenticated S3-API credentials;
see `docs/legal/ECHO_AGENT_JAPAN_COMMERCE_CHECKLIST.md` and
`ECHO_AGENT_ENCRYPTED_DISTRIBUTION.md` for the storage/encryption
model). Holds:
- The encrypted release artifact + manifest (product binary, not
  personal data).
- Entitlement/subscription-state/event/download-claim JSON records —
  the same fields listed under SERVER above, at rest.

## MODEL PROVIDERS (local or third-party, purchaser-configured)

Out of this website's control — see EULA §6/§7. If the purchaser
configures a third-party API-based model, that provider's own privacy
policy applies to whatever the purchaser sends it; this website's code
has no visibility into that traffic.

## OPTIONAL-MCP

Not applicable to this website's purchase/fulfillment flow — MCP
adapters are part of the broader ECHO Agent architecture (per the
mission's own baseline), not something this site's checkout/webhook/
download code touches, configures, or has data visibility into.

## Retention

- Entitlement/subscription/event/download-claim records: retained
  indefinitely in the private bucket today — no automatic deletion job
  exists in this codebase (confirmed: no cron/scheduled deletion code
  found anywhere in this repo). Flagged as an `OWNER_DECISION_REQUIRED`
  item for a future retention policy; not fabricated as already
  handled.
- Stripe's own retention is governed by Stripe, not this codebase.
