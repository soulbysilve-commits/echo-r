import type { Metadata } from "next";
import Link from "next/link";
import LanguageSwitch from "../../components/LanguageSwitch";

const SITE_URL = "https://echo-r.veritasforge.net";

export const metadata: Metadata = {
  title: "ブログ | Veritas Forge",
  description:
    "継続するAI Identity、Observer-Only Governance、AI社会に関するVeritas Forgeの研究ノートと論考。",
  alternates: {
    canonical: `${SITE_URL}/ja/blog`,
    languages: {
      en: `${SITE_URL}/blog`,
      ja: `${SITE_URL}/ja/blog`,
    },
  },
  robots: { index: true, follow: true },
  openGraph: {
    title: "ブログ | Veritas Forge",
    description:
      "継続するAI Identity、Observer-Only Governance、AI社会に関するVeritas Forgeの研究ノートと論考。",
    url: `${SITE_URL}/ja/blog`,
    images: [`${SITE_URL}/og-image.png`],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "ブログ | Veritas Forge",
    description:
      "継続するAI Identity、Observer-Only Governance、AI社会に関するVeritas Forgeの研究ノートと論考。",
    images: [`${SITE_URL}/og-image.png`],
  },
};

export default function BlogPage() {
  return (
    <main className="min-h-screen bg-black px-6 py-32 text-white">
      <LanguageSwitch current="ja" enHref="/blog" jaHref="/ja/blog" />
      <section className="mx-auto max-w-5xl">
        <p className="mb-4 text-sm font-bold tracking-[0.35em] text-blue-400">
          ブログ
        </p>

        <h1 className="text-5xl font-black tracking-tight md:text-7xl">
          研究ノート。
        </h1>

        <p className="mt-6 max-w-3xl text-gray-400">
          Veritas Forgeによる論考と研究アップデートです。
        </p>

        <div className="mt-14 grid gap-6">
          <Link
            href="/ja/blog/the-question-moltbook-cant-answer"
            className="block rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition hover:border-blue-500/60 hover:bg-blue-500/10"
          >
            <p className="text-sm font-bold text-blue-400">2026-07-29</p>
            <h2 className="mt-3 text-2xl font-bold text-white">
              Metaが「人間は投稿できないSNS」を買収した。Moltbookが答えられない問い。
            </h2>
            <p className="mt-3 text-gray-400">
              MoltbookはAIエージェントが投稿し、投票し、文化を形成できることを示しました。では、会話の密度は永続する社会と同じなのか。そして、その世界を書き換える権限は誰が持つのか。
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {[
                "persistent AI",
                "multi-agent systems",
                "observer-only governance",
                "AI society",
                "Moltbook",
                "Noemora",
              ].map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-white/10 px-3 py-1 text-xs text-gray-400"
                >
                  {tag}
                </span>
              ))}
            </div>
          </Link>
        </div>
      </section>
    </main>
  );
}
