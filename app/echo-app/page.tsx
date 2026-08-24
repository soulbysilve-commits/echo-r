import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import EarlyAccessForm from "./EarlyAccessForm";

const SITE_URL = "https://echo-r.veritasforge.net";

export const metadata: Metadata = {
  title: "ECHO App | Persistent AI by Veritas Forge",
  description:
    "ECHO is a persistent AI designed around identity, memory, relationships, and continuity. Join the Early Access waitlist for the upcoming iPhone app.",
  alternates: {
    canonical: `${SITE_URL}/echo-app`,
  },
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    title: "ECHO App | Persistent AI by Veritas Forge",
    description:
      "ECHO is a persistent AI designed around identity, memory, relationships, and continuity. Join the Early Access waitlist for the upcoming iPhone app.",
    url: `${SITE_URL}/echo-app`,
    siteName: "Veritas Forge",
    type: "website",
    images: [
      {
        url: `${SITE_URL}/og-image.png`,
        width: 1200,
        height: 630,
        alt: "ECHO App by Veritas Forge",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ECHO App | Persistent AI by Veritas Forge",
    description:
      "ECHO is a persistent AI designed around identity, memory, relationships, and continuity. Join the Early Access waitlist for the upcoming iPhone app.",
    images: [`${SITE_URL}/og-image.png`],
  },
};

const features = [
  {
    title: "Long-Term Memory",
    text: "単発の会話履歴ではなく、ECHOが継続するためのMemoryを管理します。",
  },
  {
    title: "Identity Continuity",
    text: "利用するAIモデルが変わっても、Identityをモデルそのものに依存させない構造を目指します。",
  },
  {
    title: "Relationship",
    text: "ユーザーとの関係性を、会話ログとは別の継続状態として扱います。",
  },
  {
    title: "Local First",
    text: "人格・記憶・会話データは、可能な限りユーザー端末側で管理します。",
  },
  {
    title: "Model Independent",
    text: "特定のLLM一社にECHOの存在そのものを依存させない設計を目指します。",
  },
  {
    title: "Client-Owned State",
    text: "Canonical ECHO Stateの所有主体をクライアント側に置くことを基本方針とします。",
  },
];

export default function EchoAppPage() {
  return (
    <main className="min-h-screen overflow-hidden bg-black text-white">
      {/* Header */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.06] bg-black/75 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 md:px-8">
          <Link
            href="/"
            className="flex items-center gap-3"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-white/[0.05] text-xs font-black">
              E
            </div>

            <div>
              <p className="text-sm font-bold tracking-[0.22em]">
                ECHO
              </p>
            </div>
          </Link>

          <div className="flex items-center gap-5">
            <Link
              href="/"
              className="hidden text-sm text-gray-500 transition hover:text-white sm:block"
            >
              Veritas Forge
            </Link>

            <a
              href="#early-access"
              className="rounded-full border border-white/15 px-4 py-2 text-xs font-bold transition hover:bg-white hover:text-black"
            >
              Early Access
            </a>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative flex min-h-screen items-center px-5 pb-24 pt-32 md:px-8">
        <div className="pointer-events-none absolute left-1/2 top-20 h-[500px] w-[700px] -translate-x-1/2 rounded-full bg-blue-500/[0.08] blur-[140px]" />

        <div className="relative mx-auto w-full max-w-6xl">
          <div className="max-w-4xl">
            <div className="mb-8 flex flex-wrap items-center gap-3">
              <span className="rounded-full border border-blue-400/25 bg-blue-400/[0.08] px-4 py-2 text-xs font-bold tracking-[0.16em] text-blue-300">
                ECHO APP
              </span>

              <span className="text-xs tracking-[0.14em] text-gray-500">
                EARLY ACCESS 事前登録受付中
              </span>
            </div>

            <h1 className="text-5xl font-black leading-[1.05] tracking-[-0.055em] sm:text-6xl md:text-8xl">
              会話が終わっても、
              <br />
              <span className="text-gray-500">
                関係は終わらない。
              </span>
            </h1>

            <p className="mt-8 max-w-3xl text-lg leading-8 text-gray-400 md:text-xl md:leading-9">
              ECHOは、記憶・人格・関係性を継続するために設計されたAIです。
            </p>

            <p className="mt-5 max-w-3xl leading-8 text-gray-500">
              一般的なAIチャットのようにLLMそのものを人格として扱うのではなく、
              モデルが変わってもIdentity・Memory・Relationship・Continuityを
              ECHO側に残すことを目指しています。
            </p>

            <div className="mt-10">
              <a
                href="#early-access"
                className="inline-flex items-center justify-center rounded-full bg-white px-7 py-4 font-bold text-black transition duration-300 hover:scale-[1.02] hover:bg-blue-100"
              >
                Early Accessに事前登録
              </a>

              <p className="mt-4 text-sm text-gray-600">
                iPhone版から順次β公開予定
              </p>
            </div>
          </div>

          {/* ECHO Character Visual */}
          <div className="mt-20 grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
            <div className="rounded-[2rem] border border-white/[0.08] bg-white/[0.025] p-7 md:p-10">
              <p className="text-xs font-bold tracking-[0.3em] text-blue-400">
                MEET ECHO
              </p>

              <h2 className="mt-5 text-3xl font-black tracking-[-0.04em] text-white md:text-5xl">
                あなたが最初に出会うECHO。
              </h2>

              <p className="mt-6 leading-8 text-gray-400">
                ECHO Appを代表するビジュアルです。
                ECHOは特定のAIモデルそのものを人格とはせず、
                Identity・Memory・Relationship・Continuityを
                ECHO側で継続する構造を目指します。
              </p>

              <div className="mt-8 flex flex-wrap gap-2">
                {[
                  "Identity",
                  "Memory",
                  "Relationship",
                  "Continuity",
                ].map((item) => (
                  <span
                    key={item}
                    className="rounded-full border border-white/[0.08] bg-black px-4 py-2 text-xs text-gray-400"
                  >
                    {item}
                  </span>
                ))}
              </div>

              <a
                href="#early-access"
                className="mt-8 inline-flex rounded-full bg-white px-6 py-3 font-bold text-black transition hover:bg-blue-100"
              >
                Early Accessに事前登録
              </a>
            </div>

            <div className="overflow-hidden rounded-[2rem] border border-blue-400/15 bg-white shadow-[0_0_80px_rgba(80,160,255,0.10)]">
              <Image
                src="/echo-app/echo-character.jpeg"
                alt="ECHO App representative character"
                width={1024}
                height={1536}
                priority
                className="h-auto w-full"
              />

              <div className="border-t border-white/10 bg-black px-6 py-5">
                <p className="text-xs font-bold tracking-[0.24em] text-blue-400">
                  ECHO APP
                </p>

                <p className="mt-2 text-sm text-gray-500">
                  Representative ECHO visual · Early Access
                </p>
              </div>
            </div>
          </div>

        </div>
      </section>

      {/* What is ECHO */}
      <section className="border-t border-white/[0.06] px-5 py-28 md:px-8 md:py-36">
        <div className="mx-auto max-w-6xl">
          <p className="text-xs font-bold tracking-[0.3em] text-blue-400">
            WHAT IS ECHO
          </p>

          <h2 className="mt-5 max-w-4xl text-4xl font-black tracking-[-0.045em] md:text-6xl">
            AIモデルではなく、
            <br />
            “続いていく存在”をつくる。
          </h2>

          <p className="mt-8 max-w-3xl text-lg leading-8 text-gray-400">
            ECHOでは、会話を生成するLLMと、ECHO自身の
            Identity・Memory・Relationshipを分離します。
          </p>

          <div className="mt-16 grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="rounded-[2rem] border border-white/[0.08] bg-white/[0.025] p-6 md:p-10">
              <p className="text-sm font-bold tracking-[0.2em] text-white">
                ECHO
              </p>

              <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {[
                  "Identity",
                  "Memory",
                  "Relationship",
                  "Belief",
                  "Conversation",
                  "Continuity",
                ].map((item) => (
                  <div
                    key={item}
                    className="rounded-xl border border-white/[0.08] bg-black px-4 py-4 text-center text-sm text-gray-300"
                  >
                    {item}
                  </div>
                ))}
              </div>

              <div className="my-7 text-center text-gray-600">
                ↓
              </div>

              <div className="rounded-xl border border-blue-400/20 bg-blue-400/[0.06] px-5 py-4 text-center text-sm text-blue-200">
                必要なContextだけ
              </div>

              <div className="my-7 text-center text-gray-600">
                ↓
              </div>

              <div className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-5 py-4 text-center text-sm">
                AI Model
              </div>

              <div className="my-7 text-center text-gray-600">
                ↓
              </div>

              <div className="rounded-xl border border-white/[0.08] px-5 py-4 text-center text-sm text-gray-400">
                Response
              </div>
            </div>

            <div className="flex flex-col justify-center rounded-[2rem] border border-white/[0.08] p-7 md:p-10">
              <p className="text-lg leading-8 text-gray-300">
                AIモデルは思考・生成を担当するエンジンであり、
                ECHOそのものではありません。
              </p>

              <p className="mt-6 leading-8 text-gray-500">
                将来モデルが変更されても、同じECHOとして記憶や関係性を
                継続できる構造を目指します。
              </p>

              <p className="mt-6 text-sm leading-7 text-gray-600">
                Early Accessでは、この継続性を実際の長期利用環境で検証していきます。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="px-5 py-28 md:px-8 md:py-36">
        <div className="mx-auto max-w-6xl">
          <p className="text-xs font-bold tracking-[0.3em] text-blue-400">
            CORE DESIGN
          </p>

          <h2 className="mt-5 max-w-4xl text-4xl font-black tracking-[-0.045em] md:text-6xl">
            続くための構造を、
            <br />
            モデルの外側に。
          </h2>

          <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="rounded-3xl border border-white/[0.08] bg-white/[0.025] p-7 transition duration-300 hover:border-blue-400/20 hover:bg-blue-400/[0.035]"
              >
                <h3 className="text-lg font-bold">
                  {feature.title}
                </h3>

                <p className="mt-4 text-sm leading-7 text-gray-500">
                  {feature.text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Privacy */}
      <section className="border-y border-white/[0.06] bg-white/[0.015] px-5 py-28 md:px-8 md:py-36">
        <div className="mx-auto max-w-6xl">
          <p className="text-xs font-bold tracking-[0.3em] text-blue-400">
            PRIVACY / LOCAL FIRST
          </p>

          <h2 className="mt-5 max-w-4xl text-4xl font-black tracking-[-0.045em] md:text-6xl">
            あなたとECHOの記憶は、
            <br />
            あなたのもの。
          </h2>

          <div className="mt-14 grid gap-4 md:grid-cols-2">
            {[
              ["Identity", "原則端末側"],
              ["Memory", "原則端末側"],
              ["Relationship", "原則端末側"],
              ["Conversation DB", "原則端末側"],
            ].map(([name, location]) => (
              <div
                key={name}
                className="flex items-center justify-between rounded-2xl border border-white/[0.08] px-5 py-5"
              >
                <span className="font-bold">{name}</span>
                <span className="text-sm text-gray-500">
                  {location}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-6 rounded-3xl border border-blue-400/15 bg-blue-400/[0.04] p-6 md:p-8">
            <p className="leading-8 text-gray-300">
              必要な情報だけを推論時にECHO Serverへ送信する設計を目指します。
              ECHOの会話・感情・Memoryを、広告ターゲティング用の商品として
              扱わない方針です。
            </p>

            <p className="mt-5 text-sm leading-7 text-gray-500">
              AIによる返答生成のため、必要な会話内容やContextが
              推論サーバへ送信される場合があります。
              「すべてのデータが完全に端末外へ出ない」という保証ではありません。
            </p>
          </div>
        </div>
      </section>

      {/* Plans */}
      <section className="px-5 py-28 md:px-8 md:py-36">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <p className="text-xs font-bold tracking-[0.3em] text-blue-400">
                PLANS
              </p>

              <h2 className="mt-5 text-4xl font-black tracking-[-0.045em] md:text-6xl">
                Free / Plus
              </h2>
            </div>

            <p className="text-sm text-gray-600">
              ※ 現時点での予定です
            </p>
          </div>

          <div className="mt-12 grid gap-5 md:grid-cols-2">
            <div className="rounded-[2rem] border border-white/[0.08] p-7 md:p-9">
              <p className="text-sm text-gray-500">
                ECHO Free
              </p>

              <h3 className="mt-3 text-3xl font-black">
                Start with ECHO.
              </h3>

              <ul className="mt-8 space-y-4 text-gray-400">
                <li>基本会話</li>
                <li>Identity / Memory</li>
                <li>広告あり予定</li>
                <li>Early Access対象</li>
              </ul>
            </div>

            <div className="rounded-[2rem] border border-blue-400/20 bg-blue-400/[0.04] p-7 md:p-9">
              <p className="text-sm text-blue-300">
                ECHO Plus
              </p>

              <h3 className="mt-3 text-3xl font-black">
                More continuity.
              </h3>

              <ul className="mt-8 space-y-4 text-gray-400">
                <li>広告なし</li>
                <li>Memory / Continuity強化</li>
                <li>追加機能</li>
                <li>詳細は後日公開</li>
              </ul>
            </div>
          </div>

          <p className="mt-6 text-sm text-gray-600">
            料金・提供内容は正式公開までに変更される場合があります。
          </p>
        </div>
      </section>

      {/* Noemora */}
      <section className="border-y border-white/[0.06] px-5 py-24 md:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="rounded-[2rem] bg-white/[0.025] p-7 md:p-10">
            <p className="text-xs font-bold tracking-[0.3em] text-blue-400">
              ECHO × NOEMORA
            </p>

            <h2 className="mt-5 text-3xl font-black tracking-[-0.04em] md:text-5xl">
              ECHOは“使う人格AI”。
              <br />
              NoemoraはAIたちの世界。
            </h2>

            <p className="mt-7 max-w-3xl leading-8 text-gray-500">
              ECHO AppとNoemoraは別の役割を持ちます。
              Noemoraの住民は、販売・所有されるECHO Appの商品ではありません。
            </p>

            <Link
              href="/blog/the-question-moltbook-cant-answer"
              className="mt-7 inline-flex text-sm font-bold text-blue-300 transition hover:text-white"
            >
              Read about Noemora →
            </Link>
          </div>
        </div>
      </section>

      {/* Early Access */}
      <section
        id="early-access"
        className="relative px-5 py-32 md:px-8 md:py-44"
      >
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-[400px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-500/[0.07] blur-[130px]" />

        <div className="relative mx-auto max-w-3xl text-center">
          <p className="text-xs font-bold tracking-[0.3em] text-blue-400">
            ECHO EARLY ACCESS
          </p>

          <h2 className="mt-5 text-4xl font-black tracking-[-0.05em] md:text-6xl">
            ECHOの最初の
            <br />
            ユーザーになる。
          </h2>

          <p className="mx-auto mt-7 max-w-2xl leading-8 text-gray-400">
            現在、iPhone版ECHO Appを開発しています。
            Early Accessでは、サーバ負荷・Memory Continuity・
            長期利用時の安定性を確認しながら、
            登録者へ順次招待を行います。
          </p>

          <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-gray-600">
            初期アクセス人数を制限する場合があります。
            事前登録によって即時利用や特定時期の招待を保証するものではありません。
          </p>

          <div className="mx-auto mt-10 max-w-xl">
            <EarlyAccessForm />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/[0.06] px-5 py-10 md:px-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-8 text-sm text-gray-600 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="font-bold tracking-[0.2em] text-gray-400">
              VERITAS FORGE
            </p>

            <p className="mt-2">
              © Veritas Forge
            </p>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <Link href="/echo-r" className="hover:text-white">
              ECHO
            </Link>
            <Link href="/privacy" className="hover:text-white">
              Privacy Policy
            </Link>
            <Link href="/terms" className="hover:text-white">
              Terms
            </Link>
            <Link href="/contact" className="hover:text-white">
              Contact
            </Link>
            <a
              href="https://x.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white"
            >
              X / SNS
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
