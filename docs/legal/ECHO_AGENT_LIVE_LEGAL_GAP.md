# ECHO Agent — Live-Sales Legal Gap (pointer)

Short, current-status pointer for the live-sales closure pass
(2026-09-15). The full analysis already exists and is not duplicated
here — see:

- `docs/legal/ECHO_AGENT_LEGAL_PAGES_AUDIT.md` — topic-by-topic
  coverage audit of `/legal`, `/terms`, `/privacy`, EULA for ECHO Agent
  specifically.
- `docs/legal/ECHO_AGENT_JAPAN_COMMERCE_CHECKLIST.md` — the full
  特定商取引法 field-by-field checklist, sourced from verified existing
  `/legal` content and owner-authorized commercial decisions, nothing
  invented.
- `docs/legal/ECHO_AGENT_EULA_DRAFT.md`,
  `docs/legal/ECHO_AGENT_REFUND_CANCELLATION_DECISIONS.md`,
  `docs/legal/ECHO_AGENT_PRIVACY_DATA_MAP.md`.

**UPDATE (2026-09-15) — RESOLVED.** Owner confirmed the authoritative
tax facts:

```
Business form: individual / 個人事業
Consumption-tax status: immune / 免税事業者
Invoice registration: not filed, no registration number
Base-period taxable sales: not over JPY 10,000,000
Specific-period threshold: not over JPY 10,000,000
```

Applied verbatim (no invention) to `/legal`+`/ja/legal` (new 消費税/
適格請求書発行事業者登録 table rows) and `/eula`+`/ja/eula` (§2 price
parenthetical, replacing the prior "確認中" wording). ¥3,000 remains
an unlabeled plain figure — never 税込, 税別, or "+消費税" — per
explicit owner instruction; no invoice registration number is shown,
since none exists. See `ECHO_AGENT_JAPAN_COMMERCE_CHECKLIST.md`'s Gate
section for the full record.

```
TAX_STATUS_DISCLOSURE=PASS
INVOICE_STATUS_DISCLOSURE=PASS
```

Two further items remain owner **decisions**, not missing facts, and
are scoped outside this pass's `LEGAL_GATE` (which this pass's mission
defined as exactly the seven disclosure checks above):

- Legal review of the EULA draft and the new `/legal` ECHO Agent
  section before either is relied on commercially.
- Whether/how to build self-service subscription cancellation (today,
  cancellation is a manual Seller action in the Stripe Dashboard).

Everything else identified in the original audit (billing disclosure,
cancellation mechanics, refund policy, delivery description, cooling-
off notice, and the rest of the checklist table) is `COVERED`, using
either verified existing repository/account information or the
owner-authorized commercial policy given for this pass — no seller
identity, address, phone, or tax fact was invented at any point.

```
LEGAL_GATE=PASS (all seven required disclosures confirmed; the two owner-decision items above are tracked separately and don't gate this)
```
