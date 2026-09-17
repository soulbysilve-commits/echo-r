# ECHO Agent — Price String Matrix

Phase 3 of the live-launch pass. Full-repo grep for price-related
strings (`1000`, `1,000`, `¥1,000`/`￥1,000`, `3000`, `3,000`,
`¥3,000`/`￥3,000`, `price_`), excluding `node_modules` and `.next`,
run 2026-09-13. Every hit classified below.

```
grep -rn "1000\|1,000\|３，０００\|3000\|3,000\|１，０００\|price_" \
  --include="*.ts" --include="*.tsx" --include="*.md" --include="*.mjs" . \
  | grep -v node_modules | grep -v ".next/"
```

## Results

| File | Line(s) | Text | Classification |
|---|---|---|---|
| `app/components/EchoAgentOrderStatus.tsx` | 68 | `POLL_INTERVAL_MS = 3000` | UNRELATED — a 3-second UI poll interval, not a price. |
| `app/api/echo-agent-download-token/route.ts` | 164 | `365 * 24 * 60 * 60 * 1000` | UNRELATED — license validity duration math (1 year, in ms). |
| `app/api/stripe-webhook/route.ts` | 266 | `event.created * 1000` | UNRELATED — Unix-seconds-to-ms conversion. |
| `app/api/stripe-webhook/route.ts` | 317 | `line.pricing?.price_details?.price` | UNRELATED — Stripe SDK field name, not a price value. |
| `lib/downloadToken.ts` | 80 | `ttlSeconds * 1000` | UNRELATED — TTL seconds-to-ms conversion. |
| `README.md` | 17 | `localhost:3000` | UNRELATED — dev server port. |
| `scripts/test-echo-agent-download-auth.mjs` | 111 | `timeoutMs = 30000` | UNRELATED — test timeout. |
| `scripts/test-echo-agent-fulfillment.mjs` | 81 | `STRIPE_ECHO_AGENT_PRICE_ID = "price_test_fake"` | SANDBOX_TEST_PRICE — synthetic fixture ID, never a real Stripe object, used only inside this local unit-test harness. |
| `scripts/test-echo-agent-fulfillment.mjs` | 101 | `timeoutMs = 30000` | UNRELATED — test timeout. |
| `scripts/test-echo-agent-fulfillment.mjs` | 189/214/239/259 | `Math.floor(Date.now() / 1000)` | UNRELATED — Unix timestamp math. |
| `scripts/test-echo-agent-fulfillment.mjs` | 247 | `price: { id: "price_test_fake_local" }` | SANDBOX_TEST_PRICE — synthetic fixture, same as above. |
| `scripts/test-echo-agent-fulfillment.mjs` | 454 | `STRIPE_ECHO_AGENT_PRICE_ID: "price_test_fake_local"` | SANDBOX_TEST_PRICE — synthetic fixture. |
| `docs/STRIPE_SETUP.md` | 23, 59 | `price_...` | UNRELATED — placeholder syntax in operator instructions, not a real ID. |
| `scripts/test-echo-agent-crypto.mjs` | 110 | `365 * 24 * 3600 * 1000` | UNRELATED — license validity duration math. |

**No hardcoded ¥1,000, ¥3,000, or numeric "1000"/"3000" price display
exists anywhere in the site's rendered UI** (product pages, checkout,
success/cancel pages) as of the start of this pass — confirmed by
reading `app/components/EchoAgentProduct.tsx` directly: it had no price
display at all (pure "Inquire" / Developer Limited Release framing, no
figure shown). This means Phase 4's job is purely **additive** (add a
¥3,000/month display) with **zero risk of the Sandbox's ¥1,000 test
price ever having been shown on any production-facing page**, since it
never was.

## Real Stripe object IDs (not string-literal — from `.env.local` /
Vercel env, values never printed here)

| Role | Price ID | Amount | Mode | Status |
|---|---|---|---|---|
| Sandbox TEST price | `price_1UECSHQ3JDgHG3iSKOh1BYFO` | ¥1,000/month | `sk_test_...` | PRESENT, proven (`FULL_PURCHASE_E2E=PASS`). **Not modified by this pass.** |
| Production LIVE price | — | ¥3,000/month (target, per `ECHO_AGENT_LIVE_PRICE_CONTRACT` in `lib/stripe.ts`) | `sk_live_...` | **NOT CREATED** — no live Stripe secret was found anywhere (local or Vercel); see `STRIPE_LIVE_GATE=BLOCKED` in the final report. Creating it is Phase 12/13, which could not run. |

## New code-level enforcement added this pass

`lib/stripe.ts`'s `validatePriceForCurrentEnvironment()` (called by
`app/api/echo-agent-checkout/route.ts` right after retrieving the
configured Price, before ever creating a Checkout Session) makes the
matrix above a runtime invariant, not just documentation:

- A live-mode Price is refused outside a production-like environment.
- A test-mode Price is refused inside Vercel Production.
- A live-mode Price is additionally checked against the exact
  commercial contract (`currency: "jpy"`, `unit_amount: 3000`,
  `recurring.interval: "month"`) — a live Price that drifted from this
  (wrong currency, wrong amount, wrong interval, or accidentally
  one-time) is refused rather than silently sold.

25 regression checks for this logic live in
`scripts/test-echo-agent-live-launch-safety.mjs` (all passing — see
the final report's `TESTS_PASS`).
