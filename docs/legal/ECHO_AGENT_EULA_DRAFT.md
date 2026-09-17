# ECHO Agent — End User License Agreement (DRAFT)

**Status: DRAFT. Has not been reviewed by legal counsel.** This
document was authored during a commercial-launch-preparation pass
(2026-09-13) by cross-referencing this repository's actual, verified
implementation (checkout, webhook, entitlement, license, and download
code — see `docs/release/ECHO_AGENT_LIVE_LAUNCH_AUDIT.md` for exactly
which files were read) and the owner-authorized commercial decisions
recorded in that same audit. It is published, in identical form, at
`/eula` and `/ja/eula`, each carrying a visible "draft, not yet legally
reviewed" notice. Seller identity fields below are reused verbatim from
the existing, already-published `/legal` (特定商取引法) page — not
invented for this document.

Seller: Veritas Forge（屋号）／ 鈴木佑人（SoulBySilver）
Contact: soulbysilver@veritasforge.net

## 1. License grant

Subject to an active, paid ECHO Agent subscription and this Agreement,
the Seller grants the purchaser a personal, non-exclusive,
non-transferable, non-sublicensable license to install and run one
copy of the compiled ECHO Agent Windows distribution, for the
purchaser's own use, for as long as the subscription remains active (or,
for a license already issued before cancellation, until that license's
own `valid_until` date — see §9 and
`docs/legal/ECHO_AGENT_REFUND_CANCELLATION_DECISIONS.md` for exactly
what persists after cancellation today). This license does not convey
any right to the source code, which is not distributed.

## 2. Subscription dependency

ECHO Agent is sold as a ¥3,000/month subscription (JPY, billed monthly,
auto-renewing) via Stripe. A signed license and a one-time download are
issued automatically, promptly after Stripe confirms payment, through
this site's own webhook → entitlement → license → download-token →
download chain. The license itself is a signed, time-bounded credential
(`lib/license.ts`) issued once per successful Checkout Session, not a
perpetual grant independent of the subscription that produced it.

## 3. Permitted use

- Install and run the software for your own legitimate purposes.
- Configure and use approval-gated Windows Computer Use only for
  operations you have reviewed and approved.
- Use local or third-party LLM/model providers you separately maintain
  access to (see §6).

## 4. Ownership

The ECHO Agent software, its compiled core, documentation, and all
associated intellectual property remain the property of the Seller or
its licensors. No rights are transferred except the limited license in
§1. The purchaser retains ownership of their own data, files, and any
content they create using the software.

## 5. Updates

Update availability, cadence, and compatibility are **not
contractually guaranteed** at this Developer Limited Release stage —
the product page states this plainly, and this section restates it as
a binding term rather than only marketing framing. When an update is
offered, backward compatibility and backup requirements will be
communicated before the purchaser is asked to update.

## 6. Third-party components; API/provider responsibility

ECHO Agent may use local models (e.g., via Ollama) or, where
separately configured, third-party API-based model providers. **The
purchaser is solely responsible for obtaining, paying for, and
complying with the terms of any such third-party model/API access** —
this subscription fee covers ECHO Agent itself, not third-party model
usage costs, exactly as already stated for the Founder Edition product
in `/terms` and consistent with the product page's existing "API Fees"
framing.

## 7. Local execution

ECHO Agent's primary execution model is local: it runs on the
purchaser's own Windows machine. Local execution does not mean zero
network communication — model downloads/updates, license verification,
and update checks may require network access; see
`docs/legal/ECHO_AGENT_PRIVACY_DATA_MAP.md` for the actual data-flow
breakdown, verified against the real code in this repository (this
website's own server-side purchase/fulfillment data only — the
compiled ECHO Agent application's own runtime data handling is outside
this website repository and is not re-verified by this document).

## 8. Agent external actions; user approval and credential responsibility

ECHO Agent can take real actions on the purchaser's Windows machine
through an approval boundary. **The purchaser is responsible for
reviewing and approving each gated action**, for any credentials or
accounts the software is given access to, and for backing up important
data before approving an operation that could modify or delete it.
Approval reduces but does not eliminate risk — this matches the product
page's own existing "Approval does not guarantee safety" statement,
restated here as a binding term.

## 9. What cancellation does and does not do (stated plainly, matching
the actual implementation)

- Cancelling stops future billing, effective at the end of the current
  paid period (see §11).
- Cancelling stops **new** license/download issuance going forward
  (the system will not issue a new signed license or download token for
  a subscription that is no longer active/trialing).
- Cancelling does **not** reach into the purchaser's machine and does
  **not** revoke a license or download already issued before
  cancellation — there is no revocation mechanism in the current
  implementation. A license already obtained remains usable per its own
  `valid_until` date (currently issued for 1 year from issuance)
  regardless of later cancellation. This is a real, current technical
  limitation, not a policy choice being marketed as a feature — see
  `docs/legal/ECHO_AGENT_REFUND_CANCELLATION_DECISIONS.md`.

## 10. Prohibited use

- Reverse engineering beyond what applicable law permits
  notwithstanding this restriction.
- Redistributing, reselling, or sublicensing the compiled core or any
  issued license/download.
- Using approval-gated automation to perform unauthorized, illegal, or
  harmful actions on any system.
- Attempting to bypass the license/entitlement/download-authorization
  mechanism.
- Sharing your Stripe-linked entitlement, license, or download
  credentials with anyone else.

## 11. Cancellation and refunds

- **Cancellation**: cancel anytime; takes effect at the end of the
  current, already-paid billing period; no cancellation fee; no
  minimum contract term. (Confirming the checkout code's actual
  `cancel_at_period_end` support, or the operational equivalent, is
  tracked in `docs/legal/ECHO_AGENT_REFUND_CANCELLATION_DECISIONS.md`
  — this EULA states the owner-authorized policy; that companion
  document states exactly what the Stripe subscription configuration
  needs to guarantee it end-to-end.)
- **Refunds**: as a general rule, no refund is issued after successful
  digital fulfillment (a license/download has been issued), **except**
  for: duplicate billing, a demonstrable billing error, the Seller's
  failure to deliver, corrupted or unusable fulfillment caused by the
  Seller, or where required by applicable law. Refund requests should
  be sent to the contact address above.

## 12. Beta / Developer Limited Release status

ECHO Agent is offered at "Developer Limited Release" stage: single
platform (Windows), no guaranteed SLA, support hours, or update
cadence. This status does not reduce the price or billing obligation,
but is disclosed here, on the product page, and in the pre-checkout
disclosure so the purchaser can make an informed decision.

## 13. Termination

The Seller may terminate a license for violation of §10 (Prohibited
use) or non-payment. The purchaser may terminate by cancelling their
subscription (§11) at any time.

## 14. Warranty disclaimer

ECHO Agent is provided "AS IS" and "AS AVAILABLE," at Developer Limited
Release stage, without warranty of any kind, express or implied,
including merchantability, fitness for a particular purpose, or
non-infringement, to the maximum extent permitted by applicable law.
Nothing here limits statutory rights that cannot be waived under
applicable law (including Japanese consumer-protection law, where it
applies).

## 15. Limitation of liability

To the maximum extent permitted by applicable law, the Seller's total
liability for any claim arising from this Agreement or use of ECHO
Agent is limited to the amount actually paid by the purchaser for the
subscription in the three (3) months preceding the claim. The Seller is
not liable for indirect, incidental, or consequential damages,
including damages arising from an approved Windows operation the
purchaser authorized.

## 16. Governing law

This draft anticipates Japanese law and the same exclusive jurisdiction
already used in `/terms` (Osaka District Court) for consistency with
the Seller's other product terms — to be confirmed on legal review, not
yet finalized.

---

**Fields intentionally left unresolved pending legal review**: none of
the seller-identity fields are unresolved (reused from the verified
`/legal` page); the governing-law/jurisdiction clause and the overall
document are unresolved pending an actual legal review, which has not
happened — see the DRAFT notice at the top of this document and on the
live page.
