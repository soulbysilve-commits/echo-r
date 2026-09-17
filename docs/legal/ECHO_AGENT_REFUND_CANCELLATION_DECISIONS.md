# ECHO Agent — Refund & Cancellation: Technical Audit vs. Policy

Phase 10 of the live-launch pass. Two things, kept clearly separate:
**(A)** what the actual code in this repository does today, read
directly from the route handlers, and **(B)** the owner-authorized
policy language this pass applies on top of it. Where they don't fully
line up, that gap is stated plainly, not smoothed over.

## (A) What the code actually does today

- **No self-service cancellation exists in this codebase.** Confirmed:
  no route calls `stripe.subscriptions.cancel`, `stripe.subscriptions
  .update` with `cancel_at_period_end`, or any Stripe Billing Portal
  API (`grep` across `app/` and `lib/` for all of the above: zero
  matches). `/echo-agent/cancel` and `/ja/echo-agent/cancel` are the
  Stripe Checkout `cancel_url` pages (shown when a customer abandons
  Checkout before paying) — **not** a subscription-cancellation
  feature. This is a real, current gap, not a naming coincidence.
- **What cancelling today actually requires**: the Seller cancelling
  the subscription directly in the Stripe Dashboard (which does
  support choosing "cancel at period end" there), or a customer
  emailing the contact address and the Seller doing the same. Nothing
  in this pass changed this — building a self-service cancel
  endpoint/Billing Portal integration is a real, separate feature, not
  something this documentation phase should silently add to the live
  purchase surface under time pressure. Flagged as
  `OWNER_DECISION_REQUIRED` / a concrete follow-up item, not hidden.
- **What the webhook does on cancellation**
  (`customer.subscription.deleted`, `app/api/stripe-webhook/route.ts`
  → `handleAutomaticDownloadEvent`): updates the durable subscription
  state record (`lib/entitlement.ts` `upsertSubscriptionState`) to
  Stripe's own reported status (typically `"canceled"`). This record
  is read by the download-token route.
- **What a canceled subscription blocks**
  (`app/api/echo-agent-download-token/route.ts`, steps 3 and 6): a
  **new** download-token request re-checks the subscription's live
  Stripe status (must be `active`/`trialing`) and separately re-checks
  this site's own durable subscription-state record (also must be
  `active`/`trialing`). Either check failing returns 403. So:
  cancellation reliably blocks *future* license/download issuance.
- **What a canceled subscription does NOT block**: a license and
  download **already issued before cancellation** are not revoked by
  anything in this codebase. The issued license has its own
  `valid_until` (currently `issued_at + 365 days`,
  `app/api/echo-agent-download-token/route.ts` line ~164) — that date,
  not subscription status, is the only expiry the license itself
  encodes, and there is no revocation-list check anywhere (confirmed:
  no code reads a "revoked licenses" store of any kind). This matches
  the known prior finding exactly and is stated plainly in the
  pre-existing `docs/ECHO_AGENT_FULFILLMENT.md` ("Subscription
  limitation, stated plainly").
- **Payment failure** (`invoice.payment_failed`): updates the
  subscription-state record to `"payment_failed"`, which (same
  active/trialing check above) blocks new download-token issuance.
  Stripe's own retry/dunning behavior (per the Stripe account's
  configured settings, not this codebase) governs what happens next to
  the subscription itself.
- **Deletion of purchaser data**: no code path in this repository
  deletes an entitlement/subscription-state record on cancellation —
  records persist in the private bucket indefinitely (see
  `ECHO_AGENT_PRIVACY_DATA_MAP.md` "Retention"). This is a genuine gap
  relative to a hypothetical "cancel = data deleted" expectation; not
  claimed as implemented here.

## (B) Owner-authorized policy applied on top

- **Cancellation**: cancel anytime; effective at the end of the
  already-paid period; no fee; no minimum term. **This is the stated
  customer-facing policy** (EULA §11, new `/legal` ECHO Agent section,
  pre-checkout disclosure block). Operationally, until a self-service
  cancel/Billing Portal flow is built, the Seller is responsible for
  executing this via the Stripe Dashboard's own "cancel at period end"
  option when a cancellation request comes in by email — Stripe
  Dashboard natively supports this, so the policy is deliverable
  today, just not self-service yet.
- **Refund**: no refund after successful digital fulfillment (a
  license has been issued), except duplicate billing, a demonstrable
  billing error, Seller failure to deliver, Seller-caused
  corrupted/unusable fulfillment, or where required by law. No refund
  automation exists in this codebase (confirmed, matches the
  pre-existing `PAYMENT_OPERATIONS.md` §6) — refunds are issued
  manually in the Stripe Dashboard, same as before this pass.
- **Post-cancellation license persistence**: documented honestly, not
  hidden — see (A) above. The EULA (§9) and this document both state
  it in the same terms.

## Concrete follow-up items (not built by this pass — flagged, not silently deferred)

1. A self-service cancellation path (Stripe Billing Portal session, or
   a dedicated authenticated cancel endpoint) so "cancel anytime" does
   not depend on the Seller manually acting in the Stripe Dashboard for
   every request.
2. A decision on whether an already-issued license should ever be
   revocable (would require a revocation-list check added to whatever
   validates a license at runtime — outside this website repo's scope
   today; the license is verified by the compiled ECHO Agent binary,
   per `echo_agent_license_v1.py` in the separate ECHODiscord版 repo,
   which this pass did not touch).
3. A retention/deletion policy for fulfillment records after
   cancellation (currently: none).

`FULFILLMENT_GATE` in the final report reflects that the automated
parts of this policy (blocking new issuance, recording cancellation
status) are real and tested, while the self-service cancellation UX
and license revocation are not yet built — see the final report for
the exact gate value.
