# ECHO Agent — Japan Commerce Disclosure (特定商取引法) Checklist

Phase 9 of the live-launch pass. Populates the fields
特定商取引法に基づく表示 normally requires, for ECHO Agent specifically
(the existing `/legal` page's content is scoped to the ECHO-R Founder
Edition product and must not be read as ECHO Agent's disclosure — see
`docs/legal/ECHO_AGENT_LEGAL_PAGES_AUDIT.md`). Every field below is
either sourced from an existing, verified in-repo record, derived from
the owner-authorized commercial decisions given for this pass, or
explicitly marked `OWNER_FACT_REQUIRED` — nothing is invented.

Published as a new "ECHO Agent" section on `/legal` and `/ja/legal`
(see those files) rather than a separate page, since a single 特定商取引法
page listing each product's terms in its own clearly-labeled section is
a normal, legitimate structure for a multi-product seller and keeps
seller-identity fields in exactly one place.

| Field | Value | Source |
|---|---|---|
| 販売業者 (Seller) | Veritas Forge（屋号） | Verbatim from the existing `/legal` page (pre-dates this pass; not fabricated by it). |
| 運営責任者 (Responsible person) | 鈴木佑人（SoulBySilver） | Verbatim from the existing `/legal` page. |
| 所在地 (Address) | 533-0031 大阪府大阪市東淀川区西淡路3-9-10-804 | Verbatim from the existing `/legal` page. |
| 電話番号 (Phone) | 080-9033-2169（お問い合わせは原則メールにて） | Verbatim from the existing `/legal` page. |
| メールアドレス (Email) | soulbysilver@veritasforge.net | Verbatim from the existing `/legal` page. |
| 販売価格 (Price) | ECHO Agent: 月額3,000円 | Owner-authorized commercial decision for this pass. |
| 事業形態 (Business form) | 個人事業（個人事業主） | Owner-confirmed fact (2026-09-15). |
| 消費税 (Consumption tax) | 免税事業者 | Owner-confirmed fact (2026-09-15): business form individual, consumption-tax status immune (免税事業者), base-period and specific-period taxable sales both not over JPY 10,000,000, no taxable-business election filed. ¥3,000 remains a plain figure — never labeled 税込, 税別, or "+消費税", and no tax amount is invented; the customer pays exactly JPY 3,000 per billing cycle, per explicit owner instruction. |
| 適格請求書発行事業者登録番号 (Qualified Invoice Registration Number) | 未登録（登録番号なし） | Owner-confirmed fact (2026-09-15): invoice registration not filed, no registration number exists. No number is displayed anywhere, since none exists to display. |
| 商品代金以外の必要料金 | クレジットカード決済手数料はお客様負担ではなくStripe手数料は販売価格に含まれます。ECHO Agent利用に必要な外部LLM/API利用料は含まれず、お客様負担です。インターネット接続料金はお客様負担です。 | Derived: Stripe processing fees are standard merchant-side costs (not passed to the customer as a separate line item in this Checkout integration — confirmed by reading `app/api/echo-agent-checkout/route.ts`, which creates a Checkout Session for exactly the configured Price with no separate fee line item); third-party API/model costs are excluded per the owner-authorized EULA §6 and the existing Founder Edition precedent already on `/legal`/`/terms`. |
| 申込の有効期限 | 該当なし（決済完了と同時に自動配信されるため、申込の有効期限という概念は発生しません） | Derived from the actual automatic-fulfillment implementation — no manual approval/expiry window exists in the automatic_download flow. |
| サービス提供の開始時期 | Stripeの決済確認（signature検証済みwebhook）後、直ちに自動配信されます。 | Derived from the actual `checkout.session.completed` → entitlement → license/download-token flow. |
| お支払い方法 | Stripe Checkoutによるクレジットカード決済（Stripeが対応するブランドに準拠） | Derived from the actual Stripe Checkout integration. |
| お支払い時期 | 初回：Checkout完了時。以降：毎月の請求日に自動決済（Stripeのサブスクリプション課金）。 | Derived from Stripe subscription-mode billing behavior. |
| キャンセル・解約について | いつでも解約可能。解約は現在の支払期間終了時に有効となり、解約手数料はかかりません。最低契約期間はありません。 | Owner-authorized commercial decision, matching `docs/legal/ECHO_AGENT_REFUND_CANCELLATION_DECISIONS.md`. **Deliberately does not reuse** the existing Founder Edition section's 12-month-minimum-term language — that policy does not apply to ECHO Agent. |
| 返金について (Refunds) | 提供済み（ライセンス発行済み）のデジタル商品は原則返金いたしません。ただし、二重課金、明確な請求誤り、当方の提供不履行、または当方の責による破損・利用不能な場合、もしくは法令上必要な場合は返金いたします。 | Owner-authorized commercial decision. |
| 動作環境 | Windows（対応環境は導入前に個別確認）、インターネット接続 | Derived from the product page's own existing "Requirements & Dependencies" section — not re-invented. |
| クーリング・オフ (Cooling-off) | 本サービスはデジタルコンテンツの即時提供であり、特定商取引法上のクーリング・オフ制度の適用対象外です。 | Standard disclosure for immediately-delivered digital goods under Japanese law; consistent with (not copied from, since ECHO Agent is B2C-capable unlike the Founder Edition's B2B framing) the existing Founder Edition section's cooling-off note. |
| お問い合わせ窓口 | soulbysilver@veritasforge.net | Verbatim from the existing `/legal` page. |

## What this pass did NOT do

- Did not invent a business registration number, tax ID, or invoice
  registration number.
- Did not relabel ¥3,000 as tax-inclusive or tax-exclusive without
  evidence.
- Did not reuse the Founder Edition's minimum-term/cancellation
  language for ECHO Agent, since the owner-authorized policy for ECHO
  Agent is explicitly different (no minimum term).
- Did not remove or alter the existing Founder Edition disclosure
  content — the new ECHO Agent section is additive.

## Gate

**UPDATE (2026-09-15).** Owner confirmed the authoritative tax facts
(business form: individual/個人事業; consumption-tax status: immune/
免税事業者; invoice registration: not filed, no registration number;
base-period and specific-period taxable sales both not over
JPY 10,000,000). Applied verbatim to `/legal` and `/ja/legal` (new
消費税/適格請求書発行事業者登録 rows in the ECHO Agent table) and to
the EULA's §2 price parenthetical (`/eula`, `/ja/eula`), replacing the
prior "確認中"/pending wording. ¥3,000 remains an unlabeled plain
figure everywhere — never 税込, 税別, or "+消費税" — and no invoice
registration number is displayed, since none exists.

```
TAX_STATUS_DISCLOSURE=PASS
INVOICE_STATUS_DISCLOSURE=PASS
```

The tax-status row that previously blocked `LEGAL_GATE` is resolved.
