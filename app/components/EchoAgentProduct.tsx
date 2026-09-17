import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import LanguageSwitch from "./LanguageSwitch";
import EchoAgentCheckoutButton from "./EchoAgentCheckoutButton";
import { isStripeLiveSalesEnabled, isStripeTestCheckoutEnabled } from "../../lib/stripe";

type Locale = "ja" | "en";
const SITE = "https://echo-r.veritasforge.net";

const copy = {
  ja: {
    title: "ECHO Agent | 開発者向けローカルAIエージェント | Veritas Forge",
    description: "ローカルLLM、継続性、承認付きWindows Computer Useを組み合わせたECHO Agent。開発者向け限定提供・問い合わせ受付中。",
    nav: ["概要", "機能", "検証", "動作環境", "制限", "導入・サポート"],
    heroLabel: "開発者向け限定提供・問い合わせ受付",
    heroTitle: "ローカルで考え、\n継続し、実行する。",
    heroBody: "ECHO Agentは、ローカルLLM・継続性・Computer Useを組み合わせた、開発者向けのローカルAIエージェントです。計画・回答生成とECHOの継続状態を分離し、承認されたWindows操作を実行します。",
    heroNote: "現在は開発者向け限定提供版の技術的検証段階です。一般販売・購入受付は開始していません。",
    priceLabel: "想定価格（開発者向け限定提供）",
    priceLine: "月額3,000円",
    priceNote: "毎月自動更新・いつでも解約可能（解約は現在の支払期間終了時に有効）",
    cta: "ECHO Agentについて問い合わせる",
    secondary: "検証内容を見る",
    overviewLabel: "ECHO AGENT",
    overviewTitle: "LLMを、継続する作業の中へ。",
    overviewBody: "単発の回答だけでなく、記憶の確認から根拠の整理、承認付き操作、結果の再確認までを扱うための開発者向け構成です。ローカル実行を基本とし、ECHOの状態とモデルの役割を分離します。",
    audienceTitle: "想定する利用者",
    audience: ["ローカルLLMを使った開発・検証を行う方", "Windows上の反復作業を、承認と確認を挟んで自動化したい方", "AIの記憶・継続性とツール実行の関係を検証したい方"],
    featuresLabel: "中核機能",
    featuresTitle: "継続性と、境界のある実行。",
    features: [
      ["ローカルLLM", "ローカルモデルによるタスク計画・回答生成を組み合わせます。モデルが提案する内容と、実際に操作を許可する権限は分離します。"],
      ["継続性", "Identity / Memory / Relationship / Affect / Temporal等の状態を、作業の継続に利用します。LLMそのものをECHOの人格や記憶の所有者にはしません。"],
      ["承認付きWindows Computer Use", "Windows上の操作は承認境界を通します。許可された範囲の操作を対象とし、何でも無制限に自律実行する機能ではありません。"],
      ["実行結果の確認", "計画だけで完了とせず、保存や再読込などの観測結果を用いて作業を確認する構成です。すべてのアプリや操作の成功を保証するものではありません。"],
    ],
    workflowLabel: "検証済みワークフロー",
    workflowTitle: "記憶から、保存後の再確認まで。",
    workflowIntro: "直近の開発報告では、コンパイル済み配布物を用いた実E2Eで、次の一連の流れが確認されています。",
    workflow: [
      ["記憶確認", "対象となる記憶や必要な情報を確認します。"],
      ["根拠付きメモ作成", "確認した情報をもとに、根拠を伴うメモを作成します。"],
      ["Windows入力", "承認された操作としてWindows上の入力を行います。"],
      ["保存", "対象のメモを保存します。"],
      ["再読込", "保存結果を再び読み込み、内容を確認します。"],
    ],
    evidenceLabel: "開発者向け限定提供版の技術的検証",
    evidenceTitle: "検証結果を、範囲とともに公開。",
    evidenceBody: "直近の開発報告では、コンパイル済み配布物による実E2Eと、全回帰361件の結果が報告されています。この数値は当該検証の結果であり、一般販売認定やすべての環境・操作の成功保証ではありません。",
    metrics: [["361", "total"], ["360", "pass"], ["0", "fail"], ["1", "skip"]],
    evidenceFoot: "1件のskipを含みます。未実行・未検証の項目まで合格したものとして扱いません。",
    environmentLabel: "動作環境・外部依存",
    environmentTitle: "配布仕様に合わせて、導入環境を確認。",
    environmentIntro: "Windows / WSL2 / Ollama / モデル / Docker等の構成は、対象となる配布パッケージの仕様に合わせて確認します。現時点で確認できない推奨スペックや対応バージョンは掲載しません。",
    environment: [
      ["Windows", "対象のWindows環境を導入前に確認します。未検証のOSへの対応は表明しません。"],
      ["WSL2", "配布構成で利用する場合の導入・有効化状態を確認します。"],
      ["Ollama / ローカルモデル", "配布仕様で指定されるモデル、実行方式、必要な取得物を確認します。モデルの取得や更新に通信が必要となる場合があります。"],
      ["Docker等", "対象パッケージで必要な場合に利用します。必要なコンポーネントとバージョンは導入前に個別案内します。"],
      ["CPU / GPU / RAM / ディスク", "確定した推奨値はここでは提示しません。選択するモデルと配布構成に応じて必要環境を確認します。"],
    ],
    environmentFoot: "外部サービス・モデルの取得、更新、認証、ライセンス確認等の通信が必要となる場合は、対象構成と通信先・用途を導入前に案内します。ローカル実行は、すべての通信が不要であることを意味しません。",
    distributionLabel: "提供・制限",
    distributionTitle: "ソース非公開の限定提供。",
    distributionBody: "ECHO Agentはローカル実行を基本とし、中核をコンパイル済み配布物として提供する方針です。ソースコードを公開する提供形態ではありません。",
    distributionNotes: [
      "WindowsブリッジはPowerShellソースのままです。すべての構成要素がコンパイル済みになるわけではありません。",
      "コンパイル済み中核にも、抽出可能な文字列が残ります。完全な解析防止や、ソース・ロジックの抽出が不可能であることは保証しません。",
      "対応するWindows操作・アプリ・環境は、検証済みの範囲と個別の導入条件に限定します。未実装機能や未検証OSを対応済みとは表示しません。",
      "承認は操作の安全性を保証するものではありません。重要なデータを扱う場合は、バックアップと実行結果の確認が必要です。",
    ],
    supportLabel: "導入・更新・復旧・サポート",
    supportTitle: "提供前の確認から、運用時の相談まで。",
    support: [
      ["01", "導入前確認", "利用目的、Windows環境、モデル、必要な外部依存と対象操作を確認します。"],
      ["02", "導入・動作確認", "対象配布物の手順に沿って導入し、承認境界と限定したワークフローを確認します。"],
      ["03", "更新", "対象バージョンの変更点、互換性、バックアップの要否を確認したうえで更新を案内します。"],
      ["04", "復旧・サポート", "問題発生時はログと再現条件を確認し、必要に応じて旧版・バックアップからの復旧を個別に支援します。自動復旧や無条件のデータ復元は保証しません。"],
    ],
    supportFoot: "サポート範囲、対応時間、更新提供期間、復旧責任などの契約条件は未確定です。正式な提供条件は問い合わせ時に案内します。",
    relatedLabel: "製品・研究の位置づけ",
    relatedTitle: "ECHO Agentは、独立した商品です。",
    related: [
      ["ECHO Agent", "開発者向けのローカルAIエージェント。", ""],
      ["ECHO Founder Edition", "継続するAI人格の提供・共同検証。ECHO Agentとは別の商品です。", "/echo-r"],
      ["ECHO-R", "Identity Continuity等の研究・評価系です。", "/echo-r#research"],
      ["Noemora", "AI住民社会の実証世界です。ECHO Agentの商品そのものではありません。", "/blog/the-question-moltbook-cant-answer"],
    ],
    contactLabel: "お問い合わせ受付",
    contactTitle: "導入目的と環境を、まず相談。",
    contactBody: "現在は開発者向け限定提供の問い合わせを受け付けています。一般販売、購入・決済、確定価格、販売開始日の案内は行っていません。",
    contactHint: "お問い合わせの際は、利用目的、Windows環境、利用予定モデル、実行したい操作をお知らせください。送信先と個人情報の扱いは既存のお問い合わせ導線に従います。",
    footer: ["ECHO Agent", "ECHO Founder Edition", "ECHO-R / Research", "Noemora", "プライバシーポリシー", "利用規約", "お問い合わせ"],
  },
  en: {
    title: "ECHO Agent | Local AI Agent for Developers | Veritas Forge",
    description: "ECHO Agent combines local LLMs, continuity, and approval-gated Windows Computer Use. Limited developer availability; inquiries are open.",
    nav: ["Overview", "Capabilities", "Validation", "Requirements", "Limits", "Support"],
    heroLabel: "LIMITED DEVELOPER AVAILABILITY · INQUIRIES OPEN",
    heroTitle: "Think locally.\nContinue. Execute.",
    heroBody: "ECHO Agent combines a local LLM, continuity, and Computer Use for developers. It separates planning and response generation from ECHO's persistent state and executes Windows operations through an approval boundary.",
    heroNote: "This is a technically validated limited developer offering. General sales and purchases are not open.",
    priceLabel: "Planned price (Developer Limited Release)",
    priceLine: "¥3,000 / month",
    priceNote: "Bills automatically every month. Cancel anytime — cancellation takes effect at the end of the current paid period.",
    cta: "Inquire about ECHO Agent",
    secondary: "View validation",
    overviewLabel: "ECHO AGENT",
    overviewTitle: "Bring the LLM into a continuing workflow.",
    overviewBody: "A developer-oriented configuration for checking memory, preparing evidence-backed notes, performing approved actions, and verifying results. Local execution is the default direction, with model output and ECHO state kept separate.",
    audienceTitle: "Who it is for",
    audience: ["Developers experimenting with local LLMs", "People who want approval-gated automation of repeatable Windows tasks", "Developers evaluating continuity, memory, and tool execution together"],
    featuresLabel: "CAPABILITIES",
    featuresTitle: "Continuity with bounded execution.",
    features: [
      ["Local LLM", "Local-model planning and response generation. Proposed actions and actual execution authority remain separate."],
      ["Continuity", "Identity / Memory / Relationship / Affect / Temporal and related state can support continuing work. The LLM is not the owner of ECHO's identity or memory."],
      ["Approved Windows Computer Use", "Windows actions pass through an approval boundary. Execution is limited to permitted operations, not unrestricted autonomy."],
      ["Result verification", "The workflow uses observed results, including saving and reopening, rather than treating a plan alone as proof of completion. Success is not guaranteed for every application or operation."],
    ],
    workflowLabel: "VALIDATED WORKFLOW",
    workflowTitle: "From memory to a verified saved result.",
    workflowIntro: "The latest development report describes a real end-to-end run using the compiled distribution, covering the following sequence.",
    workflow: [
      ["Recall", "Check the relevant memory and required information."],
      ["Evidence-backed note", "Prepare a note grounded in the information checked."],
      ["Windows input", "Enter the content through an approved Windows operation."],
      ["Save", "Save the note in the target application."],
      ["Reopen", "Read the saved result again and verify its contents."],
    ],
    evidenceLabel: "LIMITED DEVELOPER EDITION · TECHNICAL VALIDATION",
    evidenceTitle: "Report the results—and their limits.",
    evidenceBody: "The latest development report records a real E2E using the compiled distribution and a full regression run of 361 tests. These are results for that validation scope, not certification for general sale or a guarantee across all environments and operations.",
    metrics: [["361", "total"], ["360", "pass"], ["0", "fail"], ["1", "skip"]],
    evidenceFoot: "The result includes one skip. Unrun or unverified cases are not represented as passing.",
    environmentLabel: "REQUIREMENTS & DEPENDENCIES",
    environmentTitle: "Confirm the environment for the actual distribution.",
    environmentIntro: "Windows / WSL2 / Ollama / model / Docker requirements depend on the distribution being provided. Unconfirmed recommended specifications and versions are not invented here.",
    environment: [
      ["Windows", "The target Windows environment is confirmed before onboarding. Support for unverified operating systems is not claimed."],
      ["WSL2", "Installation and enablement are checked where required by the distribution."],
      ["Ollama / local model", "The specified model, runtime, and required downloads are confirmed. Obtaining or updating a model may require network access."],
      ["Docker and related tools", "Used where required by the selected package. Required components and versions are supplied during onboarding."],
      ["CPU / GPU / RAM / storage", "No unverified recommendation is published. Requirements are confirmed for the selected model and distribution."],
    ],
    environmentFoot: "If model downloads, updates, authentication, license checks, or external services require network access, the relevant configuration and communication purposes will be explained before onboarding. Local execution does not imply that every network connection is unnecessary.",
    distributionLabel: "DISTRIBUTION & LIMITS",
    distributionTitle: "Local execution. Closed-source distribution.",
    distributionBody: "The intended distribution uses a compiled core and does not provide its source code. Local execution remains the primary deployment direction.",
    distributionNotes: [
      "The Windows bridge remains PowerShell source. Not every component is compiled.",
      "Extractable strings remain in the compiled core. Complete resistance to analysis or extraction is not guaranteed.",
      "Supported Windows operations, applications, and environments are limited to validated scope and agreed onboarding conditions. Unimplemented features and unverified OS support are not advertised.",
      "Approval does not guarantee safety. Important data should be backed up, and execution results should be checked.",
    ],
    supportLabel: "ONBOARDING, UPDATES & SUPPORT",
    supportTitle: "From environment review to operational support.",
    support: [
      ["01", "Pre-onboarding review", "Confirm the intended use, Windows environment, model, dependencies, and target operations."],
      ["02", "Installation & validation", "Follow the selected distribution's installation instructions and verify the approval boundary and agreed workflow."],
      ["03", "Updates", "Review version changes, compatibility, and backup requirements before updating."],
      ["04", "Recovery & support", "Review logs and reproduction conditions and, where appropriate, assist with recovery from an older version or backup. Automatic recovery and unconditional data restoration are not guaranteed."],
    ],
    supportFoot: "Contractual support scope, response hours, update period, and recovery responsibilities are not yet final. Terms will be provided during the inquiry process.",
    relatedLabel: "PRODUCT & RESEARCH ROLES",
    relatedTitle: "A separate product within Veritas Forge.",
    related: [
      ["ECHO Agent", "A local AI agent for developers.", ""],
      ["ECHO Founder Edition", "Persistent AI personality delivery and joint validation. A separate product.", "/echo-r"],
      ["ECHO-R", "The research and evaluation track for identity continuity and related work.", "/echo-r#research"],
      ["Noemora", "The AI-society demonstration world, not the ECHO Agent product.", "/blog/the-question-moltbook-cant-answer"],
    ],
    contactLabel: "INQUIRIES OPEN",
    contactTitle: "Start with your use case and environment.",
    contactBody: "We are accepting inquiries for limited developer availability. General sales, checkout, confirmed pricing, and a public release date are not being offered.",
    contactHint: "Please include your intended use, Windows environment, planned model, and desired operations. The existing contact route and its personal-data handling remain unchanged.",
    footer: ["ECHO Agent", "ECHO Founder Edition", "ECHO-R / Research", "Noemora", "Privacy Policy", "Terms", "Contact"],
  },
} as const;

export function echoAgentMetadata(locale: Locale): Metadata {
  const c = copy[locale];
  const path = locale === "ja" ? "/ja/echo-agent" : "/echo-agent";
  return {
    title: c.title,
    description: c.description,
    alternates: {
      canonical: `${SITE}${path}`,
      languages: { en: `${SITE}/echo-agent`, ja: `${SITE}/ja/echo-agent` },
    },
    robots: { index: true, follow: true },
    openGraph: {
      title: c.title, description: c.description, url: `${SITE}${path}`,
      siteName: "Veritas Forge", type: "website",
      locale: locale === "ja" ? "ja_JP" : "en_US",
      images: [{ url: `${SITE}/og-image.png`, width: 1200, height: 630, alt: "Veritas Forge" }],
    },
    twitter: { card: "summary_large_image", title: c.title, description: c.description, images: [`${SITE}/og-image.png`] },
  };
}

/**
 * Pre-checkout purchase disclosure -- shown immediately above/below any
 * real or test Checkout button (never shown without one). Anti-dark-
 * pattern by construction: states the product name, the exact price,
 * the recurring/auto-renewing nature, that cancellation is available
 * anytime, and exactly when cancellation takes effect -- all in plain
 * text, no pre-checked consent of any kind, before the customer can
 * reach Stripe Checkout. Links to Terms, Privacy, the ECHO Agent EULA
 * (draft), and the Japan commerce disclosure (特定商取引法, which now
 * carries an ECHO-Agent-specific section -- see app/legal/page.tsx).
 */
function PurchaseDisclosure({ locale, local }: { locale: Locale; local: (path: string) => string }) {
  const linkClass = "underline decoration-gray-600 underline-offset-4 hover:text-white";
  if (locale === "ja") {
    return (
      <div className="mt-4 max-w-2xl rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-xs leading-6 text-gray-400">
        <p className="font-bold text-gray-300">ECHO Agent — 月額3,000円（開発者向け限定提供）</p>
        <p className="mt-1">毎月自動更新・いつでも解約可能。解約は現在の支払期間終了時に有効です。解約手数料はかかりません。最低契約期間はありません。</p>
        <p className="mt-1">Stripeでの決済確認後、直ちに自動配信されます。</p>
        <p className="mt-3">
          購入手続きに進む前に、
          <Link href={local("/terms")} className={linkClass}>利用規約</Link>、
          <Link href={local("/privacy")} className={linkClass}>プライバシーポリシー</Link>、
          <Link href="/eula" className={linkClass}>使用許諾契約書（EULA・草案）</Link>、
          <Link href={local("/legal")} className={linkClass}>特定商取引法に基づく表示</Link>
          をご確認ください。
        </p>
      </div>
    );
  }
  return (
    <div className="mt-4 max-w-2xl rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-xs leading-6 text-gray-400">
      <p className="font-bold text-gray-300">ECHO Agent — ¥3,000 / month (Developer Limited Release)</p>
      <p className="mt-1">Bills automatically every month. Cancel anytime — cancellation takes effect at the end of the current paid period. No cancellation fee. No minimum term.</p>
      <p className="mt-1">Delivered automatically, immediately after your payment is confirmed by Stripe.</p>
      <p className="mt-3">
        Before checkout, please review our{" "}
        <Link href={local("/terms")} className={linkClass}>Terms</Link>,{" "}
        <Link href={local("/privacy")} className={linkClass}>Privacy Policy</Link>,{" "}
        <Link href="/eula" className={linkClass}>EULA (draft)</Link>, and{" "}
        <Link href={local("/legal")} className={linkClass}>Legal / Commerce Disclosure</Link>.
      </p>
    </div>
  );
}

export default function EchoAgentProduct({ locale }: { locale: Locale }) {
  const c = copy[locale];
  const local = (path: string) => locale === "ja" ? `/ja${path}` : path;
  const navIds = ["overview", "capabilities", "validation", "requirements", "limitations", "support"];
  const contact = local("/contact");
  // Only renders a real "Purchase" call to action once the operator
  // has BOTH explicitly opted into live sales AND configured a
  // live-mode Stripe secret key -- see lib/stripe.ts. Absent that,
  // this falls back to the existing Inquire link unchanged, exactly
  // as before Stripe was wired in.
  const salesLive = isStripeLiveSalesEnabled();
  // Preview/development-only, explicit-opt-in, sk_test_-only gate for
  // running a real Stripe TEST MODE Hosted Checkout E2E -- see
  // lib/stripe.ts's isStripeTestCheckoutEnabled(). Never true in
  // Production, and never true at the same time as salesLive (one
  // requires a live key, the other requires a test key).
  const testCheckout = !salesLive && isStripeTestCheckoutEnabled();
  const sectionClass = "mx-auto max-w-7xl px-5 py-20 sm:px-6 md:py-28";
  const labelClass = "text-xs font-bold uppercase tracking-[0.3em] text-blue-400";
  const headingClass = "mt-5 max-w-5xl text-3xl font-black tracking-tight text-white sm:text-4xl md:text-6xl";
  const cardClass = "rounded-3xl border border-white/10 bg-white/[0.04] p-6 md:p-8";
  const primaryClass = "inline-flex items-center justify-center rounded-full bg-blue-500 px-7 py-4 text-sm font-bold text-black transition hover:bg-blue-400 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-300";
  return (
    <main className="min-h-screen overflow-x-hidden bg-black text-white">
      <LanguageSwitch current={locale} enHref="/echo-agent" jaHref="/ja/echo-agent" />
      <nav aria-label={locale === "ja" ? "ECHO Agentナビゲーション" : "ECHO Agent navigation"} className="sticky top-0 z-50 border-b border-white/10 bg-black/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-6">
          <Link href={local("/")} className="flex items-center gap-3" aria-label="Veritas Forge">
            <Image src="/logo.png" alt="" width={36} height={36} className="rounded-lg" />
            <span className="text-sm font-bold tracking-widest">Veritas Forge</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link href={local("/echo-r")} className="hidden text-sm text-gray-400 hover:text-white sm:inline">ECHO-R</Link>
            <Link href={contact} className="rounded-full border border-white/20 px-4 py-2 text-xs font-bold hover:bg-white hover:text-black">{locale === "ja" ? "お問い合わせ" : "Contact"}</Link>
          </div>
        </div>
      </nav>
      <section className={`${sectionClass} pt-20 md:pt-28`}>
        <div className="grid gap-12 lg:grid-cols-[1.15fr_0.85fr] lg:items-center">
          <div>
            <p className={labelClass}>{c.heroLabel}</p>
            <h1 className="mt-6 whitespace-pre-line text-4xl font-black leading-tight tracking-[-0.055em] sm:text-5xl md:text-7xl">{c.heroTitle}</h1>
            <p className="mt-8 max-w-3xl text-lg leading-8 text-gray-400">{c.heroBody}</p>
            <div className="mt-9 flex flex-wrap gap-3">
              {salesLive ? (
                <EchoAgentCheckoutButton locale={locale} className={primaryClass} />
              ) : testCheckout ? (
                <EchoAgentCheckoutButton locale={locale} className={primaryClass} testMode />
              ) : (
                <Link href={contact} className={primaryClass}>{c.cta}</Link>
              )}
              <a href="#validation" className="inline-flex items-center justify-center rounded-full border border-white/20 px-7 py-4 text-sm font-bold hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white">{c.secondary}</a>
            </div>
            {(salesLive || testCheckout) && <PurchaseDisclosure locale={locale} local={local} />}
            <p className="mt-5 max-w-2xl text-sm leading-7 text-gray-500">{c.heroNote}</p>
          </div>
          <div className="rounded-[2rem] border border-blue-400/20 bg-blue-500/[0.04] p-6 sm:p-8">
            <div className="flex items-center gap-3">
              <Image src="/logo.png" alt="" width={48} height={48} className="rounded-xl" />
              <div><p className={labelClass}>VERITAS FORGE</p><p className="mt-1 text-2xl font-black">ECHO Agent</p></div>
            </div>
            <div className="mt-6 rounded-2xl border border-blue-400/30 bg-black/40 p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-blue-400">{c.priceLabel}</p>
              <p className="mt-1 text-3xl font-black tabular-nums text-white">{c.priceLine}</p>
              <p className="mt-2 text-xs leading-6 text-gray-400">{c.priceNote}</p>
            </div>
            <div className="mt-6 space-y-3">
              {["Local LLM", "Identity / Memory / Relationship", "Affect / Temporal", "Approval-gated Computer Use"].map((item, index) => (
                <div key={item} className="flex items-center gap-4 rounded-2xl border border-white/10 bg-black/50 p-4">
                  <span className="text-xs font-bold text-blue-400">{String(index + 1).padStart(2, "0")}</span>
                  <span className="min-w-0 break-words text-sm text-gray-300">{item}</span>
                </div>
              ))}
            </div>
            <p className="mt-6 text-xs leading-6 text-gray-500">{locale === "ja" ? "構成の概念表示です。実際の製品画面ではありません。" : "Conceptual architecture, not an actual product screenshot."}</p>
          </div>
        </div>
      </section>
      <div className="border-t border-white/10" />
      <section id="overview" className={sectionClass}>
        <p className={labelClass}>{c.overviewLabel}</p>
        <h2 className={headingClass}>{c.overviewTitle}</h2>
        <p className="mt-7 max-w-4xl text-lg leading-8 text-gray-400">{c.overviewBody}</p>
        <div className={`${cardClass} mt-10`}>
          <h3 className="text-xl font-bold">{c.audienceTitle}</h3>
          <ul className="mt-5 list-disc space-y-3 pl-5 leading-7 text-gray-400">{c.audience.map(x => <li key={x}>{x}</li>)}</ul>
        </div>
      </section>
      <section id="capabilities" className={`${sectionClass} border-t border-white/10`}>
        <p className={labelClass}>{c.featuresLabel}</p><h2 className={headingClass}>{c.featuresTitle}</h2>
        <div className="mt-12 grid gap-5 md:grid-cols-2">{c.features.map(([title, text]) => <article key={title} className={cardClass}><h3 className="text-xl font-bold">{title}</h3><p className="mt-4 leading-8 text-gray-400">{text}</p></article>)}</div>
      </section>
      <section id="validation" className={`${sectionClass} border-t border-white/10`}>
        <p className={labelClass}>{c.workflowLabel}</p><h2 className={headingClass}>{c.workflowTitle}</h2><p className="mt-7 max-w-4xl leading-8 text-gray-400">{c.workflowIntro}</p>
        <ol className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-5">{c.workflow.map(([title, text], index) => <li key={title} className={cardClass}><span className="text-sm font-bold text-blue-400">{String(index + 1).padStart(2, "0")}</span><h3 className="mt-4 text-lg font-bold">{title}</h3><p className="mt-3 text-sm leading-7 text-gray-400">{text}</p></li>)}</ol>
        <div className="mt-12 rounded-3xl border border-blue-400/20 bg-blue-500/[0.05] p-6 md:p-10">
          <p className={labelClass}>{c.evidenceLabel}</p><h3 className="mt-4 text-2xl font-black md:text-3xl">{c.evidenceTitle}</h3><p className="mt-5 max-w-4xl leading-8 text-gray-400">{c.evidenceBody}</p>
          <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">{c.metrics.map(([value, label]) => <div key={label} className="rounded-2xl border border-white/10 bg-black/40 p-4"><p className="text-3xl font-black tabular-nums">{value}</p><p className="mt-2 text-xs uppercase tracking-widest text-gray-400">{label}</p></div>)}</div>
          <p className="mt-5 text-sm leading-7 text-gray-500">{c.evidenceFoot}</p>
        </div>
      </section>
      <section id="requirements" className={`${sectionClass} border-t border-white/10`}>
        <p className={labelClass}>{c.environmentLabel}</p><h2 className={headingClass}>{c.environmentTitle}</h2><p className="mt-7 max-w-4xl leading-8 text-gray-400">{c.environmentIntro}</p>
        <dl className="mt-10 overflow-hidden rounded-3xl border border-white/10">{c.environment.map(([term, detail]) => <div key={term} className="grid gap-2 border-b border-white/10 p-5 last:border-0 sm:grid-cols-[minmax(0,0.33fr)_minmax(0,0.67fr)] sm:gap-6 md:p-6"><dt className="font-bold text-white">{term}</dt><dd className="min-w-0 text-sm leading-7 text-gray-400">{detail}</dd></div>)}</dl>
        <p className="mt-6 text-sm leading-7 text-gray-500">{c.environmentFoot}</p>
      </section>
      <section id="limitations" className={`${sectionClass} border-t border-white/10`}>
        <p className={labelClass}>{c.distributionLabel}</p><h2 className={headingClass}>{c.distributionTitle}</h2><p className="mt-7 max-w-4xl leading-8 text-gray-400">{c.distributionBody}</p>
        <div className="mt-10 grid gap-4 md:grid-cols-2">{c.distributionNotes.map(text => <div key={text} className={cardClass}><p className="leading-8 text-gray-400">{text}</p></div>)}</div>
      </section>
      <section id="support" className={`${sectionClass} border-t border-white/10`}>
        <p className={labelClass}>{c.supportLabel}</p><h2 className={headingClass}>{c.supportTitle}</h2>
        <ol className="mt-12 grid gap-5 md:grid-cols-2">{c.support.map(([step, title, text]) => <li key={step} className={cardClass}><p className="text-sm font-bold text-blue-400">{step}</p><h3 className="mt-4 text-xl font-bold">{title}</h3><p className="mt-4 leading-8 text-gray-400">{text}</p></li>)}</ol>
        <p className="mt-6 text-sm leading-7 text-gray-500">{c.supportFoot}</p>
      </section>
      <section className={`${sectionClass} border-t border-white/10`}>
        <p className={labelClass}>{c.relatedLabel}</p><h2 className={headingClass}>{c.relatedTitle}</h2>
        <div className="mt-10 grid gap-4 md:grid-cols-2">{c.related.map(([name, description, href]) => <div key={name} className={cardClass}><h3 className="text-lg font-bold">{name}</h3><p className="mt-3 text-sm leading-7 text-gray-400">{description}</p>{href && <Link href={local(href)} className="mt-5 inline-flex text-sm font-bold text-blue-300 hover:text-white">{locale === "ja" ? "詳しく見る →" : "Learn more →"}</Link>}</div>)}</div>
      </section>
      <section className="border-t border-white/10 px-5 py-20 sm:px-6 md:py-28">
        <div className="mx-auto max-w-5xl rounded-[2rem] border border-blue-400/30 bg-blue-500/10 p-7 md:p-12">
          <p className={labelClass}>{c.contactLabel}</p><h2 className="mt-5 text-3xl font-black tracking-tight md:text-5xl">{c.contactTitle}</h2><p className="mt-6 leading-8 text-gray-300">{c.contactBody}</p><p className="mt-4 text-sm leading-7 text-gray-400">{c.contactHint}</p>
          {salesLive ? (
            <>
              <EchoAgentCheckoutButton locale={locale} className={`${primaryClass} mt-8`} />
              <PurchaseDisclosure locale={locale} local={local} />
            </>
          ) : testCheckout ? (
            <>
              <EchoAgentCheckoutButton locale={locale} className={`${primaryClass} mt-8`} testMode />
              <PurchaseDisclosure locale={locale} local={local} />
            </>
          ) : (
            <Link href={contact} className={`${primaryClass} mt-8`}>{c.cta}</Link>
          )}
        </div>
      </section>
      <footer className="border-t border-white/10 px-5 py-10 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 text-sm text-gray-500 md:flex-row md:items-center md:justify-between"><p>© Veritas Forge · ECHO Agent</p><div className="flex flex-wrap gap-x-5 gap-y-3"><Link href={local("/echo-r")} className="hover:text-white">ECHO Founder Edition</Link><Link href={local("/privacy")} className="hover:text-white">{c.footer[4]}</Link><Link href={local("/terms")} className="hover:text-white">{c.footer[5]}</Link><Link href={contact} className="hover:text-white">{c.footer[6]}</Link></div></div>
      </footer>
    </main>
  );
}
