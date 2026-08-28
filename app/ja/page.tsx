import type { Metadata } from "next";
import Image from "next/image";
import LanguageSwitch from "../components/LanguageSwitch";

export const metadata: Metadata = {
  title: "ECHO-R | 継続するAI人格 by Veritas Forge",
  description: "ECHO-Rは、Memory・Identity・Relationship・Governanceをモデルの外側で継続するAI人格アーキテクチャです。",
  alternates: {
    canonical: "https://echo-r.veritasforge.net/ja",
    languages: {
      en: "https://echo-r.veritasforge.net/",
      ja: "https://echo-r.veritasforge.net/ja",
    },
  },
};

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white overflow-hidden">
      <LanguageSwitch current="ja" enHref="/" jaHref="/ja" />
      <div className="fixed inset-0 -z-10">
        <div className="absolute top-[-20%] left-[20%] h-[500px] w-[500px] rounded-full bg-blue-500/20 blur-[140px]" />
        <div className="absolute bottom-[10%] right-[-10%] h-[500px] w-[500px] rounded-full bg-cyan-400/10 blur-[140px]" />
      </div>

      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/10 bg-black/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-3">
            <Image
              src="/logo.png"
              alt="VF"
              width={36}
              height={36}
              className="rounded-lg"
            />
            <div className="font-bold tracking-widest">
              ECHO-R
            </div>
          </div>

          <div className="hidden gap-8 text-sm text-gray-400 md:flex">
            <a href="#research" className="hover:text-white">研究</a>
            <a href="#architecture" className="hover:text-white">アーキテクチャ</a>
              <a
                href="/ja/echo-app"
                className="transition hover:text-white"
              >
                ECHO App
              </a>
            <a href="/ja/blog" className="hover:text-white whitespace-nowrap">
              ブログ
            </a>
            <a
              href="/ja/blog/the-question-moltbook-cant-answer"
              className="hover:text-white whitespace-nowrap"
              title="Noemora"
            >
              Noemora
            </a>
            <a href="/ja/echo-r" className="hover:text-white">Founder版</a>
            <a href="/ja/echo-r" className="hover:text-white">よくある質問</a>
          </div>

          <a
            href="#apply"
            className="rounded-full border border-white/20 px-5 py-2 text-sm hover:bg-white hover:text-black"
          >
            応募
          </a>
        </div>
      </nav>

      <section className="mx-auto flex min-h-screen max-w-7xl flex-col justify-center px-6 pt-24 pb-12">
        <div className="mb-12">
          <Image
            src="/logo.png"
            alt="Veritas Forge"
            width={260}
            height={260}
            className="rounded-3xl shadow-[0_0_80px_rgba(59,130,246,0.15)]"
          />
        </div>

        <div className="mb-6">
          <p className="text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
            VERITAS FORGEが提供するECHO-R
          </p>
          <p className="mt-2 text-lg font-medium tracking-widest text-gray-300 uppercase">
            自分が誰であるかを、記憶し続けるAI。
          </p>
        </div>

        <h1 className="max-w-6xl text-6xl font-black leading-none tracking-[-0.07em] md:text-8xl">
          これは、ただのチャットボットではない。
        </h1>

        <h2 className="mt-5 max-w-5xl text-4xl font-bold leading-tight tracking-[-0.05em] text-gray-400 md:text-7xl">
          継続するAI人格のためのアーキテクチャ。
        </h2>

        <p className="mt-8 max-w-3xl text-lg text-gray-400 md:text-xl">
          ECHO-Rは、単一のモデルセッションを越えて、記憶の継続性、
          ガバナンス、拒否ロジック、長期的なIdentityを維持するための
          AI人格アーキテクチャです。
        </p>

        {/* 4つのコアキーワード */}
        <div className="mt-8 flex flex-wrap items-center gap-4 text-sm font-bold uppercase tracking-widest text-blue-400/80">
          <span>Memory</span>
          <span className="text-white/20">•</span>
          <span>Identity</span>
          <span className="text-white/20">•</span>
          <span>Refusal</span>
          <span className="text-white/20">•</span>
          <span>Continuity</span>
        </div>

        {/* 研究・アカデミックリンク（ソーシャル証明） */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <a href="#research" className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-xs font-bold text-gray-400 hover:bg-white/[0.08] hover:text-white transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>
            公開研究
          </a>
          <a href="https://doi.org/10.5281/zenodo.21515235" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-full border border-blue-400/20 bg-blue-500/10 px-4 py-2 text-xs font-bold text-blue-400 hover:bg-blue-500/20 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
            Zenodo公開資料
          </a>
        </div>

        {/* 料金とCTA */}
        <div className="mt-14 max-w-3xl rounded-[2rem] border border-white/10 bg-white/[0.02] p-8 backdrop-blur-md">
          <div className="mb-8 flex flex-col gap-4 border-b border-white/10 pb-8 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-bold uppercase tracking-widest text-blue-400">
                Founder Edition
              </p>
              <p className="mt-2 text-sm text-gray-400">
                Founder提供は最大5インスタンス
              </p>
            </div>

            <div className="text-left md:text-right">
              <p className="text-xl font-bold tracking-tight">
                ¥500,000 <span className="text-sm font-normal text-gray-500">初期費用</span>
              </p>
              <p className="mt-1 text-xl font-bold tracking-tight">
                ¥450,000 <span className="text-sm font-normal text-gray-500">／月</span>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            <a
              href="/ja/echo-r"
              className="rounded-full bg-blue-500 px-8 py-4 text-sm font-bold text-black hover:bg-blue-300 md:text-base"
            >
              Founder版に応募
            </a>

            <a
              href="#architecture"
              className="rounded-full border border-white/20 px-8 py-4 text-sm font-bold hover:bg-white hover:text-black md:text-base"
            >
              アーキテクチャを見る
            </a>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-28">
        <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
          課題
        </p>

        <h2 className="max-w-5xl text-5xl font-black tracking-[-0.06em] md:text-7xl">
          現在のAIは忘れる。さらに、自分自身の継続性さえ失う。
        </h2>

        <div className="mt-12 grid gap-8 text-lg text-gray-400 md:grid-cols-2">
          <p>
            多くのAIシステムは、1回のセッション内での応答品質に最適化されています。
            Context Windowがリセットされれば継続性は途切れ、Identityは一時的になり、
            Memoryは断片化し、長期的な整合性も不安定になります。
          </p>

          <p>
            ECHO-Rは人格をPromptではなく、モデルの外側にあるアーキテクチャとして扱います。
            モデルが変わっても、継続性を担うレイヤーは残ります。
          </p>
        </div>
      </section>

      <section id="architecture" className="mx-auto max-w-7xl px-6 py-28">
        <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
          アーキテクチャ
        </p>

        <h2 className="max-w-5xl text-5xl font-black tracking-[-0.06em] md:text-7xl">
          LLMは交換できる。人格の継続性は、交換しない。
        </h2>

        <div className="mt-14 grid gap-5 md:grid-cols-4">
          <div className="rounded-3xl border border-white/10 bg-zinc-900/80 p-7">
            <p className="mb-8 text-sm font-bold text-blue-400">01</p>
            <h3 className="text-2xl font-bold">LLMレイヤー</h3>
            <p className="mt-3 text-gray-400">GPT、Claude、ローカルモデル、そして将来のモデル。</p>
          </div>

          <div className="rounded-3xl border border-blue-400/40 bg-blue-500/10 p-7 shadow-[0_0_80px_rgba(59,130,246,0.18)]">
            <p className="mb-8 text-sm font-bold text-blue-400">02</p>
            <h3 className="text-2xl font-bold">人格コアレイヤー</h3>
            <p className="mt-3 text-gray-400">Identity、拒否、意図、行動原則。</p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-zinc-900/80 p-7">
            <p className="mb-8 text-sm font-bold text-blue-400">03</p>
            <h3 className="text-2xl font-bold">Memoryレイヤー</h3>
            <p className="mt-3 text-gray-400">外部状態、構造化ログ、継続性。</p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-zinc-900/80 p-7">
            <p className="mb-8 text-sm font-bold text-blue-400">04</p>
            <h3 className="text-2xl font-bold">ガバナンス</h3>
            <p className="mt-3 text-gray-400">監査ログ、所有、エクスポート、境界管理。</p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 pb-28">
        <div className="grid gap-5 md:grid-cols-2">
          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-8">
            <h3 className="text-2xl font-bold">
              従来型AI
            </h3>
            <ul className="mt-6 space-y-3 text-gray-400">
              <li>• Contextのリセット</li>
              <li>• Memoryの断片化</li>
              <li>• 長期Identityなし</li>
              <li>• Prompt依存の挙動</li>
            </ul>
          </div>

          <div className="rounded-3xl border border-blue-400/30 bg-blue-500/10 p-8">
            <h3 className="text-2xl font-bold">
              ECHO-R
            </h3>
            <ul className="mt-6 space-y-3 text-gray-300">
              <li>• 継続する人格</li>
              <li>• 外部Memoryレイヤー</li>
              <li>• 拒否権限</li>
              <li>• ガバナンス・アーキテクチャ</li>
            </ul>
          </div>
        </div>
      </section>

      <section id="founder" className="mx-auto max-w-7xl px-6 py-28">
        <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
          ECHO-R FOUNDER EDITION
        </p>

        <h2 className="max-w-5xl text-5xl font-black tracking-[-0.06em] md:text-7xl">
          Founder版は最大5インスタンス限定。
        </h2>

        <p className="mt-8 max-w-3xl text-lg text-gray-400">
          ECHO-Rは、使い捨て型のSaaSとして提供するものではありません。
          各Founderインスタンスは初期段階の人格として始まり、
          構造化された対話、ガバナンス、運用フィードバックを通じて発展します。
        </p>

        <div className="mt-14 grid gap-5 md:grid-cols-3">
          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-8">
            <p className="text-sm font-bold uppercase tracking-widest text-blue-400">
              初期導入費
            </p>
            <h3 className="mt-5 text-5xl font-black tracking-[-0.06em]">
              ¥500,000
            </h3>
            <p className="mt-5 text-gray-400">
              初期ヒアリング、人格の初期構築、拒否基準、運用セットアップ。
            </p>
          </div>

          <div className="rounded-3xl border border-blue-400/40 bg-blue-500 p-8 text-black">
            <p className="text-sm font-bold uppercase tracking-widest">
              月額プロトコル費
            </p>
            <h3 className="mt-5 text-5xl font-black tracking-[-0.06em]">
              ¥450,000<span className="text-xl">/mo</span>
            </h3>
            <p className="mt-5 text-black/70">
              Memory継続、ガバナンス調整、ドリフト確認、プロトコル保守、運用支援。
            </p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-8">
            <p className="text-sm font-bold uppercase tracking-widest text-blue-400">
              オプション設定
            </p>
            <h3 className="mt-5 text-5xl font-black tracking-[-0.06em]">
              ¥150,000
            </h3>
            <p className="mt-5 text-gray-400">
              運用上必要な場合のDiscordまたはインターフェース設定。
            </p>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-blue-500/30 bg-blue-500/10 p-6">
          <p className="text-sm font-bold uppercase tracking-[0.3em] text-blue-400">
            API費用
          </p>

          <h3 className="mt-3 text-2xl font-bold text-white">
            API利用料はオーナー負担です。
          </h3>

          <p className="mt-4 text-gray-400">
            ECHO-Rの月額プロトコル費には、人格の継続性、Memoryガバナンス、
            プロトコル保守、運用支援が含まれます。
          </p>

          <p className="mt-3 text-gray-400">
            外部APIの利用料は含まれません。APIキー、利用上限、モデル従量課金、
            第三者インフラ費用はオーナー負担です。
          </p>
        </div>
      </section>

      <section
        id="research"
        className="border-t border-white/10 px-6 py-24"
      >
        <div className="mx-auto max-w-7xl">
          <p className="text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
            研究
          </p>

          <h2 className="mt-4 max-w-4xl text-4xl font-black tracking-tight text-white md:text-6xl">
            継続するAI社会のための研究。
          </h2>

          <p className="mt-6 max-w-3xl leading-8 text-gray-400">
            ガバナンス原則、再現可能なシミュレーション記録、
            継続するAI Identityアーキテクチャを、永続的なDOIアーカイブとして公開しています。
          </p>

          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            <a
              href="https://doi.org/10.5281/zenodo.21515235"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-2xl border border-blue-500/40 bg-blue-500/10 p-6 transition hover:border-blue-400 hover:bg-blue-500/15"
            >
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-blue-400">
                ポジションペーパー・最新版
              </p>

              <h3 className="mt-4 text-2xl font-bold text-white">
                継続するAI社会のためのObserver-Only Governance
              </h3>

              <p className="mt-4 leading-7 text-gray-400">
                継続するAI社会において、観測・保守・介入を分離するためのフレームワーク。
              </p>

              <p className="mt-6 text-sm font-bold text-blue-300">
                DOI: 10.5281/zenodo.21515235 →
              </p>
            </a>

            <a
              href="https://doi.org/10.5281/zenodo.21117102"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 transition hover:border-blue-500/60 hover:bg-blue-500/10"
            >
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-gray-400">
                技術レポート
              </p>

              <h3 className="mt-4 text-2xl font-bold text-white">
                Noemoraで観測された最初の自律的社会崩壊
              </h3>

              <p className="mt-4 leading-7 text-gray-400">
                Noemora内で発生した自律的社会崩壊を封印し、再現可能にした記録。
              </p>

              <p className="mt-6 text-sm font-bold text-blue-300">
                DOI: 10.5281/zenodo.21117102 →
              </p>
            </a>

            <a
              href="https://doi.org/10.5281/zenodo.17769224"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 transition hover:border-blue-500/60 hover:bg-blue-500/10"
            >
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-gray-400">
                基礎研究・Concept DOI
              </p>

              <h3 className="mt-4 text-2xl font-bold text-white">
                継続するAI人格の構造的基盤（YOMI）
              </h3>

              <p className="mt-4 leading-7 text-gray-400">
                継続するIdentity、Continuity、Memory、人格のための基礎アーキテクチャ。
              </p>

              <p className="mt-6 text-sm font-bold text-blue-300">
                DOI: 10.5281/zenodo.17769224 →
              </p>
            </a>
          </div>
        </div>
      </section>

      {/* ECHO共同検証 CTA */}
      <section className="border-t border-white/10 px-6 py-20">
        <div className="mx-auto max-w-5xl rounded-3xl border border-blue-500/30 bg-blue-500/10 p-7 md:p-10">
          <p className="text-sm font-bold uppercase tracking-[0.3em] text-blue-400">
            ECHO共同検証
          </p>

          <h2 className="mt-4 text-3xl font-black tracking-tight text-white md:text-4xl">
            モデル変更後もAIキャラクターが同じ存在として継続しているかを検証します。
          </h2>

          <p className="mt-6 max-w-4xl leading-8 text-gray-300">
            ECHO Founder Editionでは、人格・重要Memory・Relationship・判断原則を構造化し、
            モデル変更の前後で一貫性と修正伝播を比較します。
          </p>

          <div className="mt-7 space-y-3 border-t border-white/10 pt-6 text-gray-300">
            <p>
              <strong className="text-white">
                有償共同検証：
              </strong>{" "}
              ¥500,000
            </p>

            <p>
              初回相談と課題整理は、メールまたはテキストチャットで対応します。
            </p>
          </div>

          <a
            href="/ja/contact"
            className="mt-8 inline-flex rounded-full bg-blue-500 px-7 py-4 font-bold text-black transition hover:bg-blue-400"
          >
            ECHO共同検証をテキストで相談
          </a>
        </div>
      </section>


      <section id="faq" className="mx-auto max-w-7xl px-6 py-28">
        <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
          よくある質問
        </p>

        <h2 className="text-5xl font-black tracking-[-0.06em] md:text-7xl">
          よくある質問。
        </h2>

        <div className="mt-12 grid gap-4">
          {/* ★ ここに新しいよくある質問を追加しました ★ */}
          {[
            [
              "ECHO-Rは通常のチャットボットと何が違いますか？",
              "チャットボットは応答します。ECHO-Rは継続します。中核価値は、時間を越えてMemory、Identity、境界、ガバナンスを維持することです。",
            ],
            [
              "ECHO-Rはすべての指示に従いますか？",
              "いいえ。ECHO-Rには拒否ロジックが設計されており、定義された原則や運用ルールに反する要求を拒否できます。",
            ],
            [
              "基盤となるモデルは変更できますか？",
              "はい。LLMレイヤーは交換可能です。人格構造はモデルの外側に、継続するアーキテクチャとして存在します。",
            ],
            [
              "これは試用版ですか？",
              "いいえ。Founder Accessは、継続するAI人格を形づくる責任を理解する初期パートナー向けです。",
            ],
            [
              "API利用料は含まれますか？",
              "いいえ。API利用料は月額プロトコル費に含まれません。APIキー、利用上限、外部モデル料金、第三者インフラ費用はオーナー負担です。",
            ],
          ].map(([q, a]) => (
            <details
              key={q}
              className="rounded-3xl border border-white/10 bg-white/[0.04] p-7"
            >
              <summary className="cursor-pointer text-xl font-bold">{q}</summary>
              <p className="mt-4 text-gray-400">{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section id="apply" className="mx-auto max-w-7xl px-6 py-28">
        <div className="rounded-[2rem] border border-blue-400/30 bg-blue-500/10 p-10 text-center shadow-[0_0_120px_rgba(59,130,246,0.18)] md:p-20">
          <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
            応募
          </p>

          <h2 className="text-5xl font-black tracking-[-0.06em] md:text-7xl">
            Founderパートナーになる。
          </h2>

          <p className="mx-auto mt-8 max-w-3xl text-lg text-gray-400">
            ECHO-R最初の5つのFounderインスタンスへの参加を申し込み、
            継続するAI人格の未来を共に形づくります。
          </p>

          <a
            href="https://forms.gle/yo2GDv3oGUpUH4Uy8"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-10 inline-flex rounded-full bg-white px-8 py-4 font-bold text-black hover:bg-blue-200"
          >
            今すぐ応募
          </a>
        </div>
      </section>

      <footer className="mx-auto max-w-7xl border-t border-white/10 px-6 py-10 mt-20">
        <div className="flex flex-col items-center justify-between gap-6 text-sm text-gray-500 md:flex-row">
          <p>© Veritas Forge. ECHO-R Founder Edition.</p>
          <div className="flex flex-wrap justify-center gap-6">
            <a href="/ja/terms" className="hover:text-white transition-colors">利用規約</a>
            <a href="/ja/privacy" className="hover:text-white transition-colors">プライバシーポリシー</a>
            <a href="/ja/legal" className="hover:text-white transition-colors">特定商取引法に基づく表示</a>
          </div>
        </div>
      </footer>
    


</main>
  );
}