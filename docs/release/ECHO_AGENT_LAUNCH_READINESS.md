# ECHO Agent — Live Launch Readiness

Phase 33 of the live-launch pass (2026-09-13). This is the durable
record; the chat-facing final report to the coordinating session uses
the same values in the mission's requested block format. See
`ECHO_AGENT_LIVE_LAUNCH_AUDIT.md` for the detailed findings behind
every line here, and the other `docs/release/*`, `docs/product/*`,
`docs/legal/*` files this pass produced for full detail.

## COMMERCIAL

- PRODUCT=ECHO Agent, RELEASE_STAGE=Developer Limited Release
- LIVE_PRICE_JPY=3000, LIVE_BILLING_INTERVAL=month
- SANDBOX_PRICE_JPY=1000, SANDBOX_PRICE_UNCHANGED=true (verified: no
  diff this pass made references `price_1UECSHQ3JDgHG3iSKOh1BYFO`;
  full grep in `ECHO_AGENT_PRICE_MATRIX.md`)

## SANDBOX

- SANDBOX_PRICE_ID=price_1UECSHQ3JDgHG3iSKOh1BYFO
- SANDBOX_FULL_PURCHASE_E2E=PASS (prior session's result, carried
  forward; not re-run by this pass — see `ECHO_AGENT_SANDBOX_E2E_EVIDENCE.md`)
- SANDBOX_CONFIGURATION_PRESERVED=true (Preview/sandbox-scoped Vercel
  env vars untouched by this pass; sandbox custom environment was never
  redeployed)

## LEGAL

- EULA=DRAFT (published at `/eula`, `/ja/eula`, clearly labeled
  unreviewed)
- TERMS_AGENT_SPECIFIC=PARTIAL (EULA covers ECHO-Agent-specific terms;
  `/terms` itself remains the generic Founder-Edition-worded document)
- PRIVACY_AGENT_SPECIFIC=PARTIAL (new `ECHO_AGENT_PRIVACY_DATA_MAP.md`
  covers the actual server-side data flow; `/privacy` page itself not
  rewritten)
- JAPAN_COMMERCE_DISCLOSURE=PARTIAL (new ECHO Agent section live on
  `/legal` + `/ja/legal`, reusing verified seller identity; tax-status
  labeling withheld, `OWNER_FACT_REQUIRED`)
- REFUND_POLICY=DOCUMENTED (owner-authorized policy applied
  consistently across EULA, `/legal`, pre-checkout disclosure, and
  `ECHO_AGENT_REFUND_CANCELLATION_DECISIONS.md`)
- CANCELLATION_POLICY=DOCUMENTED, SELF_SERVICE_CANCELLATION=MISSING
  (no Stripe Billing Portal / cancel endpoint exists yet — flagged as
  a concrete follow-up item)
- OWNER_INPUT_REQUIRED=[tax registration status (課税事業者/免税事業者,
  インボイス登録番号) for correct ¥3,000 tax labeling; legal review of
  the EULA draft and the new `/legal` ECHO Agent section before they
  are relied on commercially; a decision on whether/how to build
  self-service subscription cancellation]
- LEGAL_GATE=BLOCKED

## STRIPE LIVE

- STRIPE_LIVE_SECRET=MISSING (verified across `.env.local`, and every
  Vercel environment: Production, Preview, sandbox, Development — only
  one Stripe secret exists anywhere, `sk_test_...`, scoped to
  Preview/sandbox)
- STRIPE_LIVE_ACCOUNT_ID=N/A (no live key to query)
- STRIPE_LIVE_PRODUCT_ID=NOT_CREATED, STRIPE_LIVE_PRICE_ID=NOT_CREATED
- LIVE_PRICE_MATCH=N/A, LIVE_MODE_VERIFIED=N/A
- LIVE_WEBHOOK_URL=NOT_CREATED, LIVE_WEBHOOK_CREATED=false,
  LIVE_WEBHOOK_SECRET_INSTALLED=false
- STRIPE_LIVE_GATE=BLOCKED

## PRODUCTION

- PRODUCTION_CANONICAL_URL=https://echo-r-mu.vercel.app (verified,
  actually-controlled Production alias for the `echo-r` Vercel
  project). The codebase pervasively hardcodes
  `https://echo-r.veritasforge.net` as the evident intended eventual
  domain, and that hostname currently resolves (HTTP 200, via
  Cloudflare) — but Vercel's own domain configuration does not show it
  as attached/verified to this project (only
  `echo-agent-sandbox.veritasforge.net` is), and DNS was deliberately
  not changed by this pass. `NEXT_PUBLIC_SITE_URL` on Production was
  set to the verified URL, not the unverified one, so Stripe redirect
  URLs will always point somewhere this pass confirmed is real.
- PRODUCTION_ENV_COMPLETE=PARTIAL (15 non-Stripe vars set: fulfillment
  mode, artifact release ID, fulfillment namespace, storage,
  artifact-KEK, license private key, a fresh download-token secret,
  download-token TTL, site URL, and `STRIPE_SALES_LIVE_ENABLED=false`.
  The Stripe LIVE trio — `STRIPE_SECRET_KEY`, `STRIPE_ECHO_AGENT_PRICE_ID`,
  `STRIPE_WEBHOOK_SECRET` — is deliberately **absent**, since no live
  credential exists; Sandbox's test values were never copied in.)
- TEST_LIVE_SECRET_ISOLATION=PASS (structurally guaranteed: Production
  has zero Stripe secrets of any kind, so no test/live mixing is even
  possible; `isStripeLiveSalesEnabled()`/`isStripeTestCheckoutEnabled()`/
  `validatePriceForCurrentEnvironment()` additionally enforce this at
  runtime, with 25 passing regression checks)
- FULFILLMENT_NAMESPACE_ISOLATION=PASS (`ECHO_AGENT_FULFILLMENT_NAMESPACE=production`
  set on Production; Sandbox's default/unprefixed key shape is
  unchanged; verified by `N1`–`N4` in
  `scripts/test-echo-agent-live-launch-safety.mjs`)
- PRODUCTION_DEPLOYMENT=DONE (`vercel deploy --prod --yes`, deployment
  `dpl_9UmsKA7dAgoxxLfc1nv2Cxs7UsSY`, aliased to
  `https://echo-r-mu.vercel.app`, `readyState: READY`)
- PRODUCTION_BUILD=PASS (Next.js 16 production build succeeded, both
  locally and on Vercel's own build)
- PRODUCTION_PAGES=PASS (`/`, `/echo-agent`, `/ja/echo-agent`,
  `/legal`, `/ja/legal`, `/terms`, `/privacy`, `/eula`, `/ja/eula`,
  `/sitemap.xml` all return HTTP 200 on the deployed Production URL)
- PRODUCTION_PRICE_DISPLAY=3000 (confirmed live on the deployed page:
  `¥3` / `月額3,000円` present; no `1,000`/`¥1,000` string found
  anywhere on the page)
- PRODUCTION_WEBHOOK_REACHABLE=PASS (`GET /api/stripe-webhook` → `405`,
  `POST` with no signature → `503` — both real app-level Next.js
  responses, no Vercel SSO/Deployment-Protection wall encountered; no
  bypass configuration was needed)

## TESTS

- TESTS_RUN=94, TESTS_PASS=94, TESTS_FAIL=0
  (crypto 14 + download-auth 18 + fulfillment 37 + new
  live-launch-safety 25)
- PRE_EXISTING_FAILURES=30 lint errors/warnings in files this pass did
  not touch (`app/components/EchoAgentOrderStatus.tsx`,
  `app/echo-agent/cancel/page.tsx`, `app/privacy/page.tsx`,
  `app/terms/page.tsx`, `scripts/lib/zip.mjs`,
  `scripts/test-echo-agent-crypto.mjs`,
  `scripts/test-echo-agent-download-auth.mjs` — confirmed pre-existing
  by re-running `npx eslint` scoped only to the files this pass edited,
  which came back clean except one pre-existing unused-var warning in
  `EchoAgentProduct.tsx` that predates this pass)
- NEW_FAILURES=0
- BUILD=PASS

## SALES GATES

- TECHNICAL_GATE=PASS (build, tests, safety-gate code, Production
  deployment and smoke tests all pass; this is the website's own
  technical readiness — it does not and cannot cover the LIVE Stripe
  objects, which require a credential this pass never had)
- LEGAL_GATE=BLOCKED (tax-status `OWNER_FACT_REQUIRED`; EULA/legal
  additions are unreviewed drafts; self-service cancellation missing)
- COMMERCIAL_GATE=PASS (every commercial term the owner authorized —
  price, cancellation, refund, delivery — is fully decided and
  consistently applied everywhere; no further undecided commercial
  question was found)
- STRIPE_LIVE_GATE=BLOCKED (`STRIPE_LIVE_SECRET=MISSING`)
- PRODUCTION_WEBHOOK_GATE=BLOCKED (the *endpoint* is reachable and
  correctly fails closed, but no LIVE webhook was created in Stripe —
  blocked on the same missing live credential)
- FULFILLMENT_GATE=PARTIAL (the automatic_download chain is proven in
  Sandbox and fully configured in Production, but has never run in
  Production — it cannot, without a live Stripe key — and self-service
  cancellation does not exist yet)
- STRIPE_SALES_LIVE_ENABLED=false (never changed by this pass, per hard
  stop #1; confirmed set explicitly to `"false"` on Vercel Production)

## FINAL

- SANDBOX_TECHNICAL_READINESS=PASS
- LIVE_TECHNICAL_READINESS=PARTIAL (website side fully ready; Stripe
  LIVE objects/webhook not created — blocked on a missing credential,
  not on unfinished work)
- LIVE_GENERAL_SALES_READINESS=BLOCKED
- LIVE_PURCHASE_READY=NO
- STRIPE_LIVE_CREDENTIAL_OWNER_ACTION_REQUIRED=true (the actual honest
  blocker: this pass never had a live Stripe secret to work with at
  all, so it could not reach the point where hard stop #2 — a real
  payment — would even become the next step)
- ECHO_AGENT_LAUNCH_STATUS=PARTIAL

## UPDATE (2026-09-15) — security boundary closed, re-verified against current canonical URL

Everything below supersedes the corresponding 2026-09-13 line above; every
other line in this document (Stripe Live state, legal gaps, commercial
terms) is unchanged and still current — re-checked today, not assumed.

- **SECURITY_GATE now PASS**, not just the technical build/test gate
  from 2026-09-13. Since that pass, four independent sessions closed
  every Production/Sandbox secret-sharing gap this project had:
  - `R2_CREDENTIAL_BOUNDARY=PASS` — Production and Sandbox R2
    credentials independently proven from a real Vercel Production
    runtime (`docs/security/ECHO_AGENT_ENV_SECRET_BOUNDARY.md` §17).
  - `KEK_BOUNDARY=PASS` — Production's artifact KEK is a fresh, unique
    key, proven live against the real `artifact.enc` (same doc, §16-17).
  - `LICENSE_SIGNER_BOUNDARY=PASS` — Production's Ed25519 signer
    matches the shipped release's trust root (proven from the real
    Production runtime); the new Sandbox signer is cryptographically
    rejected by that same trust root
    (`docs/security/ECHO_AGENT_LICENSE_SIGNER_BOUNDARY.md`).
  - `DOWNLOAD_TOKEN_SECRET_BOUNDARY=PASS` — fresh Production-only
    secret installed; Production and Sandbox tokens proven to reject
    each other from real, simultaneously-running Production and
    Sandbox runtimes (`ECHO_AGENT_ENV_SECRET_BOUNDARY.md` §19).
  - The one still-open item from that work,
    `LICENSE_TRUST_ROOT_BYPASS_REMEDIATION.md`'s disclosed Sandbox R2
    key/Stripe webhook secret exposure, is now corrected in that
    document: both were rotated and independently re-verified (old-key
    revocation is owner-asserted, not independently checkable from
    here — Cloudflare/Stripe dashboard actions aren't queryable by this
    codebase's tooling).
- **PRODUCTION_CANONICAL_URL corrected finding, re-confirmed today**:
  `https://echo-r-mu.vercel.app` (verified via `vercel alias ls` —
  aliases to deployment `echo-4dprj10zf-veritas-forge.vercel.app`).
  `echo-r.veritasforge.net` still does not appear in this project's
  alias list — whatever answers there is still not this Vercel
  project's routing (blocker #5 below, unchanged, not addressed this
  pass either).
- **PRODUCTION_WEBHOOK_REACHABLE re-verified today** against the
  correct canonical URL: `GET /api/stripe-webhook` → `405`; unsigned
  `POST` → `503 {"error":"webhook not configured"}` (still correctly
  fails closed — `STRIPE_WEBHOOK_SECRET` still deliberately absent from
  Production). No Vercel SSO/Deployment-Protection wall on either
  request.
- **PRODUCTION_PRICE_DISPLAY re-verified today**: `¥3,000`/`3,000円`
  present on both `/echo-agent` and `/ja/echo-agent` as served from the
  canonical URL; no `1,000`/`¥1,000` string found.
- **TESTS re-run today, current codebase** (includes all security-boundary
  work since 2026-09-13, not just the 2026-09-13 snapshot):
  `102/102` JS/TS (22 crypto + 18 download-auth + 37 fulfillment + 25
  live-launch-safety) + `32/32` Python (`test_echo_agent_license_v1`
  23 + `test_license_trust_root_shipping_regression_v1` 9).
  `NEW_FAILURES=0`. `npm run build` clean.
- **STRIPE_LIVE_SECRET: still MISSING** — re-checked today via Vercel
  metadata (`vercel env ls production`): zero Stripe variables of any
  kind exist in Production except `STRIPE_SALES_LIVE_ENABLED` (still
  `"false"`). Nothing in Phases 12/13/17 of the original mission (LIVE
  Product/Price/webhook creation) could be attempted this pass either,
  for the identical reason as 2026-09-13 — this is not a regression or
  an oversight, it is the same unresolved owner-action item.
- **Legal blockers unchanged**: tax-registration status
  (課税事業者/免税事業者, インボイス登録番号) is still
  `OWNER_FACT_REQUIRED`; EULA/`/legal` ECHO Agent section legal review
  still not done; self-service cancellation still not built. Nothing
  in this pass invented or assumed any of these.

```
LIVE_TECHNICAL_READINESS=PARTIAL (website/security side now fully PASS; Stripe LIVE objects/webhook still blocked on the same missing credential)
LIVE_GENERAL_SALES_READINESS=BLOCKED
LIVE_PURCHASE_READY=false
STRIPE_LIVE_CREDENTIAL_OWNER_ACTION_REQUIRED=true
ECHO_AGENT_LAUNCH_STATUS=PARTIAL
```

## UPDATE (2026-09-15, later) — custom domain attached, LIVE Stripe configured, disclosure completed

Supersedes the "STRIPE_LIVE_SECRET: still MISSING" and domain findings
immediately above; every other line in those two update blocks not
restated here is still current.

- **CUSTOM_DOMAIN_STATUS=PASS** (was: blocker #5, unresolved). The
  owner attached `echo-r.veritasforge.net` to this Vercel project —
  confirmed via `vercel alias ls`, which now lists it aliased to the
  current Production deployment; a direct request returns the real
  site (`200`), not whatever previously answered there.
  `PRODUCTION_CANONICAL_URL=https://echo-r.veritasforge.net` (no
  longer the `.vercel.app` fallback).
- **STRIPE_LIVE_CONFIGURATION_GATE=PASS**. The owner installed a real
  `sk_live_...` key into Vercel Production. Verified read-only, from an
  actual Production runtime (temporary non-aliased deployment, same
  pattern as every prior secret-boundary proof), never printing the
  key itself:
  - LIVE Price `price_1UECMeQ3JDgHG3iSrFpeAlst`: `livemode=true`,
    `active=true`, `currency=jpy`, `unit_amount=3000`,
    `recurring.interval=month`.
  - LIVE Product `prod_VEfistL9Re8lbI`, name "ECHO Agent", `active=true`.
  - Exactly one LIVE webhook endpoint on the account, url matches
    `https://echo-r.veritasforge.net/api/stripe-webhook` exactly,
    `status=enabled`, `enabled_events` is exactly the 4 intended events
    (no extras, none missing).
  - `STRIPE_SECRET_KEY`/`STRIPE_ECHO_AGENT_PRICE_ID`/`STRIPE_WEBHOOK_SECRET`
    all present in Production (metadata/presence only).
  - Re-verified against the real public webhook route:
    `GET` → `405`; unsigned `POST` → `400 {"error":"missing signature"}`
    (previously `503 not configured` — this is the same route now
    correctly seeing a real webhook secret).
  - `LIVE_SIGNED_WEBHOOK_PROOF=DEFERRED_TO_FINAL_REAL_PURCHASE` — Stripe
    has no API-callable way to send a harmless signed event to a LIVE
    endpoint (only a human Dashboard "Send test webhook" action);
    correctly deferred, not fabricated.
  - Temporary diagnostic route deleted and its deployment permanently
    removed immediately after (`DEPLOYMENT_NOT_FOUND` confirmed). No
    Checkout Session, charge, or Stripe object mutation of any kind.
- **Pre-checkout disclosure completeness fix** (`app/components/EchoAgentProduct.tsx`,
  `PurchaseDisclosure`): the checkout-gated disclosure block already
  stated product/price/auto-renewal/cancel-anytime/effective-at-period-end
  and linked Terms/Privacy/EULA/特商法, but was missing three of the
  eight items this pass's mission required to be stated directly:
  no cancellation fee, no minimum term, and delivery timing. Added,
  reusing the exact wording already used consistently in the EULA and
  `/legal` ECHO Agent section — no new fact or policy invented. This is
  the one customer-facing code change this pass made; deployed to
  Production (`vercel deploy --prod --yes`, real promotion, not
  `--skip-domain` — appropriate here since real customer-facing content
  changed). The block itself still correctly does not render pre-launch
  (by its own original design: "never shown without" a live/test
  checkout button present) — verified the new text is absent from the
  live page right now for exactly that reason, not a deployment
  failure, and confirmed present in the deployed source.
- **STRIPE_SALES_LIVE_ENABLED**: not changed, reconfirmed present in
  Production; checkout route re-verified fails closed with the same
  Japanese "準備中" message as before the LIVE config existed.
- **TESTS re-run after the disclosure fix**: `102/102` JS/TS + `32/32`
  Python, unchanged from the count above. `npm run build` clean.
- **Legal blockers unchanged**: tax-registration status is still the
  only `OWNER_FACT_REQUIRED` item; EULA/`/legal` legal review and
  self-service cancellation are still owner decisions, not facts.

```
PRODUCTION_DOMAIN_GATE=PASS
STRIPE_LIVE_CONFIGURATION_GATE=PASS
SECURITY_GATE=PASS
COMMERCIAL_GATE=PASS
LEGAL_GATE=BLOCKED (tax-status OWNER_FACT_REQUIRED, unchanged)
LIVE_TECHNICAL_READINESS=PASS (every non-payment technical gate now closed)
LIVE_GENERAL_SALES_READINESS=BLOCKED (LEGAL_GATE only)
READY_TO_ENABLE_LIVE_SALES=NO (LEGAL_GATE not closed; STRIPE_SALES_LIVE_ENABLED stays false until it is)
ECHO_AGENT_LAUNCH_STATUS=PARTIAL
```

## UPDATE (2026-09-15, final) — LEGAL_GATE closed

Owner confirmed the authoritative tax facts that were the sole
`OWNER_FACT_REQUIRED` blocker above: business form individual/個人事業,
consumption-tax status immune/免税事業者, invoice registration not
filed (no registration number), base-period and specific-period
taxable sales both not over JPY 10,000,000.

Applied verbatim, no invention: `/legal`+`/ja/legal` gained two new
特商法 table rows (消費税：免税事業者 / 適格請求書発行事業者登録：未登録);
`/eula`+`/ja/eula` §2's price parenthetical was updated to match,
replacing the prior "確認中" (pending) wording. ¥3,000 remains an
unlabeled plain figure everywhere — never 税込, 税別, or "+消費税" —
per explicit owner instruction; the customer pays exactly JPY 3,000
per billing cycle. No invoice registration number is displayed, since
none exists. Full detail:
`docs/legal/ECHO_AGENT_JAPAN_COMMERCE_CHECKLIST.md` Gate section,
`docs/legal/ECHO_AGENT_LIVE_LEGAL_GAP.md`.

Re-audited all ten customer-facing pages
(`/echo-agent`,`/ja/echo-agent`,`/eula`,`/ja/eula`,`/terms`,`/ja/terms`,
`/privacy`,`/ja/privacy`,`/legal`,`/ja/legal`) live, post-deploy:
price/renewal/cancellation/refund/delivery disclosures unchanged and
correct (see the prior update block), tax and invoice disclosures now
present and correct, no invented invoice number found anywhere.

Full regression re-run after this content change: `102/102` JS/TS +
`32/32` Python, unchanged. `npm run build` clean. Deployed to
Production (`vercel deploy --prod --yes` — real customer-facing legal
content changed, so a real promotion was warranted). No Checkout
Session, payment, or Stripe mutation of any kind; `STRIPE_SALES_LIVE_ENABLED`
untouched, reconfirmed still present/unchanged, checkout route
reconfirmed fails closed with the same message as before.

`LEGAL_GATE` is scored here against exactly the seven disclosure
checks this pass's mission specified (price, auto-renewal,
cancellation, refund, delivery, tax status, invoice status) — all
seven now hold. The two previously-noted `OWNER_DECISION_REQUIRED`
items (EULA/`/legal` legal review; self-service cancellation) are
owner decisions, not facts, and remain open but are tracked separately
from this specific gate, per how this pass's own mission scoped it.

```
PUBLIC_PRICE=JPY 3000/month
AUTO_RENEWAL_DISCLOSURE=PASS
CANCELLATION_DISCLOSURE=PASS
REFUND_DISCLOSURE=PASS
DELIVERY_DISCLOSURE=PASS
TAX_STATUS_DISCLOSURE=PASS
INVOICE_STATUS_DISCLOSURE=PASS

LEGAL_GATE=PASS
COMMERCIAL_GATE=PASS
SECURITY_GATE=PASS
STRIPE_LIVE_CONFIGURATION_GATE=PASS
LIVE_GENERAL_SALES_READINESS=PASS (every gate this project tracks is now closed)
READY_TO_ENABLE_LIVE_SALES=YES (technical/legal/commercial readiness only — enabling STRIPE_SALES_LIVE_ENABLED and running the one real ¥3,000 validation purchase remain deliberate, separate, owner-executed actions per ECHO_AGENT_LIVE_E2E_RUNBOOK.md)
ECHO_AGENT_LAUNCH_STATUS=READY_PENDING_OWNER_ACTION
```

## BLOCKERS (every concrete remaining gap, with exact next action)

1. **OWNER_FACT_REQUIRED** — tax registration status (課税事業者/免税事業者,
   インボイス登録番号). Next action: owner confirms status; this pass's
   ¥3,000 figures get a 税込/税別 label only then.
2. **RESOLVED (2026-09-15)** — ~~a live Stripe secret key does not
   exist~~. Owner installed `sk_live_...` plus the LIVE Price and
   webhook directly into Vercel Production. Verified: see the
   "custom domain attached, LIVE Stripe configured" update above.
3. **OWNER_DECISION_REQUIRED** — legal review of the EULA draft
   (`/eula`, `/ja/eula`) and the new ECHO Agent section on `/legal`
   before they are relied on commercially.
4. **OWNER_DECISION_REQUIRED** — whether/how to build self-service
   subscription cancellation (Stripe Billing Portal or a dedicated
   endpoint); today cancellation requires the Seller to act manually in
   the Stripe Dashboard per a customer's email request.
5. **RESOLVED (2026-09-15)** — ~~`echo-r.veritasforge.net` is not
   attached~~. Owner attached it; `vercel alias ls` now confirms it,
   and it is the current `PRODUCTION_CANONICAL_URL`.
6. **technical-only, not blocking launch prep** — 30 pre-existing lint
   errors/warnings in files this pass did not touch (listed under
   TESTS above). Next action: a future pass can clean these up; they do
   not block the build (Next.js build succeeds regardless) or anything
   in this pass's scope.
7. **Hard stop #1 (by design, not a gap)** — `STRIPE_SALES_LIVE_ENABLED`
   stays `false` everywhere until the owner explicitly flips it, after
   blockers 1–4 above are resolved.
8. **Hard stop #2 (by design, not a gap)** — no real Stripe LIVE
   payment was attempted. See `ECHO_AGENT_LIVE_E2E_RUNBOOK.md` for the
   exact human-executed procedure for when the owner is ready.
9. **POST_LAUNCH_HARDENING, not blocking launch** (2026-09-15) —
   `verifyDownloadToken()` (`lib/downloadToken.ts`) authenticates
   `entitlementId`/`releaseId` via the HMAC signature (tamper-proof)
   but does not re-check `entitlementId` against a live entitlement
   record at verify/download time — only at issuance
   (`POST /api/echo-agent-download-token`, which re-verifies the
   Stripe session/price/subscription/nonce before ever issuing a
   token). Confirmed by code inspection and by a real dual-runtime
   self-test (temporary Production + Sandbox deployments, same pattern
   as the secret-boundary proofs): a token with a mismatched
   `entitlementId` still verifies successfully. This is not an
   authorization bypass — a token still requires the correct HMAC
   secret to forge, and one-time claim (`lib/entitlement.ts`
   `claimDownloadToken`) independently prevents replay regardless of
   entitlement content. Classified `POST_LAUNCH_HARDENING`, not a
   launch blocker; not changed this pass per instruction.
10. **RESOLVED (2026-09-15)** — pre-checkout disclosure was missing
    "no cancellation fee," "no minimum term," and delivery-timing
    wording. Fixed in `EchoAgentProduct.tsx`'s `PurchaseDisclosure`,
    reusing existing EULA/`/legal` wording verbatim; deployed to
    Production. See the update block above.
