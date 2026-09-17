# ECHO Agent — Legal Pages Coverage Audit

Phase 6 of the live-launch pass. Audits `/legal`, `/terms`, `/privacy`
(and their `/ja/*` mirrors) as they stood **before** this pass's
additions, against the topics a paid software subscription needs
covered. Status values: COVERED, PARTIAL, MISSING, OWNER_DECISION_REQUIRED.
"After this pass" notes what this pass actually added — see
`app/eula/page.tsx`, `app/ja/eula/page.tsx`, and the ECHO-Agent section
added to `app/legal/page.tsx` / `app/ja/legal/page.tsx`.

| Topic | Before this pass | After this pass |
|---|---|---|
| Software subscription terms | MISSING — `/terms` is written entirely around the ECHO-R Founder Edition consulting/personality-hosting service. | PARTIAL — the new ECHO Agent EULA (`/eula`) covers license/subscription-dependency terms; `/terms` itself was not rewritten (out of scope for a website-copy pass to rewrite an existing legal document without legal review — flagged, not silently left as "covered"). |
| Digital download / one-time license delivery | MISSING | COVERED (technical mechanism) in `docs/ECHO_AGENT_FULFILLMENT.md`; contractual language added in the EULA draft. |
| License grant / scope of use | MISSING | COVERED — EULA draft, "License grant" section. |
| Billing (amount, interval, auto-renewal) | MISSING (no ECHO Agent price existed anywhere before this pass) | COVERED — `/legal` ECHO Agent section (new), product-page disclosure block, EULA. |
| Cancellation mechanics | MISSING for ECHO Agent (the existing `/legal` cancellation section is Founder-Edition-specific: 12-month minimum term, 10-day notice — **does not apply to ECHO Agent** and must never be read as applying to it). | COVERED — new ECHO Agent section states: cancel anytime, effective end of current paid period, no fee, no minimum term (owner-authorized policy; matches `cancel_at_period_end`-shaped behavior — see `docs/legal/ECHO_AGENT_REFUND_CANCELLATION_DECISIONS.md` for what the code actually implements today). |
| Refund policy | MISSING for ECHO Agent (Founder Edition's "no refund" language is separate and not reused verbatim, since the owner-authorized ECHO Agent policy has explicit refund exceptions Founder Edition's text does not). | COVERED — new ECHO Agent section + EULA, using the owner-authorized exception list (duplicate billing, demonstrable billing error, seller non-delivery, corrupted/unusable seller-caused fulfillment, legally required). |
| Service availability / no SLA | PARTIAL (product page already says support terms are "not yet final") | COVERED — EULA "Beta / Developer Limited Release status" section restates this explicitly as a contractual term, not just marketing copy. |
| Account / entitlement model | MISSING | PARTIAL — EULA describes the entitlement-is-tied-to-the-Stripe-purchase model in plain language; no user-facing "account" system exists in the product itself (confirmed: no login system in this codebase for ECHO Agent), so there is little more to cover. |
| Local vs. cloud execution / data location | MISSING | COVERED — EULA "Local execution" section + `docs/legal/ECHO_AGENT_PRIVACY_DATA_MAP.md`. |
| Third-party components / model providers | MISSING | COVERED — EULA "Third-party components; API/provider responsibility" section, consistent with the product page's existing "external services may require network access" language. |
| Intellectual property | PARTIAL (`/terms` §6 is generic, Founder-Edition-worded) | COVERED for ECHO Agent specifically — EULA "Ownership" section. |
| Prohibited use | PARTIAL (`/terms` §5 is generic) | COVERED for ECHO Agent specifically — EULA "Prohibited use" section, includes Agent-specific items (credential misuse, unattended unapproved automation, redistribution of the compiled core). |
| Warranty disclaimer / limitation of liability | PARTIAL (`/terms` §7 is generic, not written for a locally-executing agent that takes real Windows actions) | COVERED for ECHO Agent specifically — EULA sections, explicitly addressing agent-executed actions and user-approval responsibility, matching the product page's own existing "approval does not guarantee safety" language. |
| Developer Limited Release limitations | COVERED already on the product page itself | COVERED, restated as a contractual term in the EULA (not just marketing framing). |
| Japan commerce disclosure (特定商取引法) for ECHO Agent specifically | MISSING (existing `/legal` is Founder-Edition-scoped) | PARTIAL — see `docs/legal/ECHO_AGENT_JAPAN_COMMERCE_CHECKLIST.md`: all fields derivable from verified existing repo/account info are now populated (reusing `/legal`'s existing, genuine seller identity), but this pass found no verified tax-registration status, so no 税込/税別 label is attached to the ¥3,000 figure — flagged `OWNER_FACT_REQUIRED`, not guessed. |

## OWNER_DECISION_REQUIRED items found during this audit

- Whether `/terms` and `/privacy` should eventually be split
  per-product (ECHO Agent vs. ECHO-R Founder Edition) rather than one
  shared, Founder-Edition-worded document with an EULA bolted on for
  ECHO Agent. This pass did not restructure those two pages — doing so
  safely requires a legal-review decision the owner has not made, and
  rewriting a live Terms/Privacy page without that review would itself
  be an overclaim of legal diligence. The EULA draft is explicitly
  labeled as a draft for exactly this reason.
- Whether the EN-locale legal pages should ever contain real English
  content (they are currently Japanese-language body copy under
  English chrome, a pre-existing site-wide convention). Not changed by
  this pass; flagged for awareness only.

## Overall

`LEGAL_GATE` cannot be `PASS` from this audit alone — see
`ECHO_AGENT_JAPAN_COMMERCE_CHECKLIST.md`'s tax-status gap and the
`OWNER_DECISION_REQUIRED` items above, plus the fact that the EULA is
explicitly an unreviewed draft. See the final report for the exact
gate value and the precise remaining blockers.
