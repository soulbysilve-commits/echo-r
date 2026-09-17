# ECHO Agent — LIVE Purchase E2E Runbook (for a human to execute later)

Phase 31 of the live-launch pass. This pass stopped **before** this
runbook's own steps, per the two hard stops in its mission (never set
`STRIPE_SALES_LIVE_ENABLED=true`; never drive a real Stripe LIVE
payment). Nothing here has been executed. This is the procedure for
whenever the owner actually authorizes and personally runs a real,
small live purchase.

## Preconditions (all must already be true before starting)

1. `STRIPE_LIVE_GATE=PASS` — a real `sk_live_...` key exists, a LIVE
   Product "ECHO Agent" and Price (`jpy`, `3000`, `recurring.interval:
   month`) exist, and `STRIPE_LIVE_PRODUCT_ID`/`STRIPE_LIVE_PRICE_ID`
   are known. **As of this pass, this precondition is NOT met** — no
   live Stripe secret was found anywhere (see the final report,
   `STRIPE_LIVE_SECRET=MISSING`). Phases 12/13/17 of the original
   mission (create the LIVE Product/Price, create the LIVE webhook)
   must be completed first, by a session that has been handed a real
   live Stripe secret.
2. `LEGAL_GATE=PASS` — in particular, the tax-registration status gap
   in `docs/legal/ECHO_AGENT_JAPAN_COMMERCE_CHECKLIST.md` is resolved
   (owner confirms 課税事業者/免税事業者 status so the price can be
   correctly labeled), and the EULA draft has had whatever legal review
   the owner deems necessary before real money changes hands.
3. Production env vars for the LIVE Stripe trio
   (`STRIPE_SECRET_KEY`=`sk_live_...`, `STRIPE_ECHO_AGENT_PRICE_ID`,
   `STRIPE_WEBHOOK_SECRET` from a LIVE webhook endpoint pointed at
   `PRODUCTION_CANONICAL_URL` — see the final report for the current
   value and its caveats) are set on Vercel **Production only**, never
   copied from Sandbox.
4. `validatePriceForCurrentEnvironment()` (`lib/stripe.ts`) has been
   exercised against the real live Price object at least once (e.g., a
   one-off script calling `stripe.prices.retrieve` with the live key
   and passing the result through this function) to confirm it reports
   `{ ok: true }` before anyone relies on it at checkout time.

## The actual live purchase (human-executed, real card, real ¥3,000)

1. Owner personally sets `STRIPE_SALES_LIVE_ENABLED=true` on Vercel
   Production (this is the step this pass explicitly never takes).
2. Owner redeploys Production (or confirms the flag takes effect
   without redeploy, per this project's env-var-read behavior —
   `process.env` reads happen per-invocation on Vercel serverless
   functions, so a redeploy is the safe way to guarantee the new value
   is picked up everywhere).
3. Owner visits the real production URL's `/echo-agent` page, confirms
   the page now shows a real "Purchase" button (not "Inquire", not a
   "Test purchase" label) and confirms the price shown reads ¥3,000/月.
4. Owner reads the pre-checkout disclosure block on that page one more
   time (product name, ¥3,000/月, auto-renewal, cancel-anytime,
   cancellation-effective-at-period-end, links to Terms/Privacy/EULA/
   commerce disclosure) before proceeding.
5. Owner completes a real Stripe Checkout with their own real card (a
   small, real ¥3,000 charge — this is intentionally not a $0/free
   trial, since the point is verifying the live path end-to-end).
6. Owner confirms, directly in the Stripe Dashboard (LIVE mode): the
   Checkout Session shows `payment_status: paid`, the Subscription
   shows `status: active`, and the webhook endpoint's own delivery log
   shows a `200` response for `checkout.session.completed`.
7. Owner confirms the success page
   (`/echo-agent/success?session_id=...`) shows the download as ready,
   downloads it, and confirms the file's SHA-256 matches the known
   plaintext hash (`5cfa175f1f34d31d921de2fbae10c442d82d585b66bbdc9aaf1cad1f1d9e85de`)
   — this alone confirms the LIVE path produced the exact same,
   correct artifact as Sandbox did.
8. Owner confirms the issued license verifies against the public key
   embedded in the compiled binary (same verification the ECHODiscord
   版 repo's own test suite already exercises for Sandbox-issued
   licenses).
9. Owner attempts the download a second time with the same token/cookie
   and confirms it is refused (`410 Gone`) — proving one-time
   consumption holds in LIVE the same as it does in Sandbox.
10. Owner cancels the test subscription in the Stripe Dashboard
    (`cancel_at_period_end` or immediate, owner's choice for this
    verification purchase) and confirms a fresh download-token request
    for that same session is now refused (`403`), proving the
    cancellation gate holds in LIVE too.
11. If everything above passes: `LIVE_PURCHASE_READY=PASS`, record the
    result (sanitized, no secrets) in an updated
    `ECHO_AGENT_LIVE_E2E_RUNBOOK.md` "Result" section or a new evidence
    doc, mirroring `ECHO_AGENT_SANDBOX_E2E_EVIDENCE.md`'s format.
12. If anything fails: **do not leave `STRIPE_SALES_LIVE_ENABLED=true`
    while the failure is unresolved** — set it back to `false`
    immediately, then diagnose.

## What NOT to do during this runbook

- Do not use a fake/test card against the live key (Stripe will reject
  it; this is fine, but the point of this runbook is a real
  verification, not a test-card exercise against live mode).
- Do not skip step 10 (cancellation re-check) — it is the one live
  behavior this pass could not verify without a live key.
- Do not have an AI agent (this one or any other) execute this runbook
  autonomously — every step above is written for a human, with a real
  payment instrument, making a real purchase. This matches hard stop
  #2 exactly.
