import LanguageSwitch from "../components/LanguageSwitch";
import StatusBadge from "../components/StatusBadge";
import type { Metadata } from "next";
import Link from "next/link";
import { getAllNews } from "@/lib/news";

const SITE_URL = "https://echo-r.veritasforge.net";

export const metadata: Metadata = {
  title: "News | Veritas Forge",
  description:
    "Verified product updates from Veritas Forge — ECHO Agent, ECHO App, ECHO-R, and Noemora. Every article cites the evidence behind it.",
  alternates: {
    canonical: `${SITE_URL}/news`,
    languages: { en: `${SITE_URL}/news`, ja: `${SITE_URL}/ja/news` },
  },
  robots: { index: true, follow: true },
  openGraph: {
    title: "News | Veritas Forge",
    description: "Verified product updates from Veritas Forge.",
    url: `${SITE_URL}/news`,
    images: [`${SITE_URL}/og-image.png`],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "News | Veritas Forge",
    description: "Verified product updates from Veritas Forge.",
    images: [`${SITE_URL}/og-image.png`],
  },
};

export default function NewsPage() {
  const posts = getAllNews("en");

  return (
    <main className="min-h-screen bg-black px-6 py-32 text-white">
      <LanguageSwitch current="en" enHref="/news" jaHref="/ja/news" />
      <section className="mx-auto max-w-5xl">
        <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
          NEWS
        </p>
        <h1 className="text-5xl font-black tracking-tight md:text-7xl">
          Verified updates.
        </h1>
        <p className="mt-6 max-w-3xl text-gray-400">
          Every article here traces to an entry in our public fact registry — status labeled honestly, not marketing-rounded.
        </p>

        <div className="mt-14 grid gap-6">
          {posts.length === 0 && (
            <p className="text-gray-500">No news yet — check back soon.</p>
          )}
          {posts.map((post) => (
            <Link
              key={post.frontmatter.slug}
              href={`/news/${post.frontmatter.slug}`}
              className="block rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition hover:border-blue-500/60 hover:bg-blue-500/10"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-bold text-blue-400">{post.frontmatter.category}</span>
                <StatusBadge status={post.frontmatter.status} />
                <span className="text-sm text-gray-500">{post.frontmatter.date}</span>
              </div>
              <h2 className="mt-3 text-2xl font-bold text-white">{post.frontmatter.title}</h2>
              <p className="mt-2 text-gray-400">{post.frontmatter.description}</p>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
