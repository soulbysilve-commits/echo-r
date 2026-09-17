# ECHO Agent — Commercial Definition

**Product**: ECHO Agent
**Release stage**: Developer Limited Release
**Price**: ¥3,000 / month (JPY, tax treatment: see
`docs/legal/ECHO_AGENT_JAPAN_COMMERCE_CHECKLIST.md` — no verified tax
registration status was found in-repo, so no 税込/税別 label is
attached to this figure; do not invent one)
**Billing**: Stripe Checkout, subscription mode, monthly recurring
**Distribution**: Windows only, compiled/closed-source core. Active
release: `echoagent-win-20260914T072837Z-57d883c6` (built after the
LICENSE_TRUST_ROOT_BYPASS fix — see
`docs/security/LICENSE_TRUST_ROOT_BYPASS_REMEDIATION.md`). The prior
release, `echoagent-win-20260913T022010Z-f950a3424ee4`, is
`SECURITY_SUPERSEDED` (customer-controlled alternate license trust
root) and is no longer used for new customer fulfillment, though it is
retained in private storage for audit/history — never delete it. No
macOS or Linux build exists — never claim otherwise anywhere
customer-facing.
**Delivery**: automatic, self-service, immediately after payment
confirmation, via the signed-webhook → entitlement → license →
download-authorization → private-download chain already implemented
(`ECHO_AGENT_FULFILLMENT_MODE=automatic_download`).

## Why "Developer Limited Release," not "General Availability"

This framing is preserved deliberately, not just left over from the
pre-sales copy:

- Only one platform (Windows) and one distribution are supported.
- No SLA, no guaranteed support-response time, no guaranteed update
  cadence exists yet (the product page itself already says so).
- The regression evidence cited on the product page (361 tests, 360
  pass / 1 skip) is scoped to the compiled distribution's own E2E
  validation, not a certification for general sale or every
  environment — the page already states this, and this pass does not
  weaken that framing anywhere.
- `AUTOMATIC_DOWNLOAD_PRODUCTION_READY` was `false` as of the last
  fulfillment audit (`docs/ECHO_AGENT_FULFILLMENT.md`) purely because
  Production env vars/storage/domain were not yet provisioned — this
  pass provisions what it safely can (see
  `docs/release/ECHO_AGENT_LAUNCH_READINESS.md`), but going live is
  still gated on real owner action (a live Stripe key, at minimum) —
  see the final report's `STRIPE_LIVE_GATE`.

## Capabilities — CURRENT / EXPERIMENTAL / PLANNED

Cross-checked against the actual ECHO Agent implementation (per the
mission's own known-verified baseline: a full Agent Runtime with
persistent identity/memory/relationship, a planner/DAG/worker-pool/
verifier, a permission gate, the Soul Protocol, procedural
memory/skill engine, a self-evolution pipeline scoped to skills only,
an MCP adapter, and a Docker sandbox backend — all built and tested in
the separate ECHO Agent repo, not re-verified line-by-line by this
website-only pass, but treated as the ceiling of what may be claimed).

**CURRENT** (what the shipped Windows release, per its own validated
E2E, actually does — matches what `EchoAgentProduct.tsx` already
describes and this pass does not expand):
- Local LLM planning/response generation, separated from ECHO's own
  persistent state.
- Identity / Memory / Relationship / Affect / Temporal continuity state
  supporting a continuing task, not owned by the LLM itself.
- Approval-gated Windows Computer Use, limited to the validated
  workflow scope (recall → evidence-backed note → Windows input → save
  → reopen-and-verify), not unrestricted autonomy.
- Result verification via observed outcomes (e.g., reopening a saved
  file), not "plan alone = done."

**QUALIFIED** (real, but explicitly bounded — the product page already
states these limits and this pass preserves them verbatim):
- Windows-operation coverage is limited to validated scope and
  individually agreed onboarding conditions — not "every Windows app."
- The compiled core still contains extractable strings; no claim of
  complete reverse-engineering resistance is made.
- Approval gating reduces but does not guarantee safety — backups and
  result-checking remain the user's responsibility.

**PLANNED / NOT CLAIMED ON THIS SITE** (exists in the broader ECHO
Agent architecture per the mission's own baseline, but this pass does
**not** add marketing claims for any of the following, since a
website-only pass cannot independently re-verify them against the
compiled Windows release the way the ECHO Agent repo's own test suite
already did):
- Self-evolution pipeline (skills-scoped) — not mentioned on the
  product page; left out deliberately rather than asserted.
- MCP adapter / Docker sandbox backend — not customer-facing claims on
  this site; ECHO Agent's product page describes Windows Computer Use
  only.
- macOS/Linux support — does not exist; never claim it.
- SLA / guaranteed support hours / guaranteed update cadence — the page
  already says these are "not yet final," unchanged by this pass.

## Relationship to other products (unchanged)

ECHO Agent remains a separate commercial product from ECHO Founder
Edition (ECHO-R) — different price, different delivery model, different
legal/commerce terms. This pass's Japan commerce disclosure and EULA
are scoped to ECHO Agent only and must never be read as applying to
Founder Edition, and vice versa.
