import LanguageSwitch from "../../../components/LanguageSwitch";
import StatusBadge from "../../../components/StatusBadge";
import NewsArticleBody from "../../../components/NewsArticleBody";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAllNews, getNewsBySlug } from "@/lib/news";

const SITE_URL = "https://echo-r.veritasforge.net";

export function generateStaticParams() {
  return getAllNews("ja").map((post) => ({ slug: post.frontmatter.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const post = getNewsBySlug("ja", params.slug);
  if (!post) return {};
  const canonical = `${SITE_URL}/ja/news/${post.frontmatter.slug}`;
  return {
    title: post.frontmatter.title,
    description: post.frontmatter.description,
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: {
      title: post.frontmatter.title,
      description: post.frontmatter.description,
      url: canonical,
      images: [`${SITE_URL}/og-image.png`],
      type: "article",
      publishedTime: post.frontmatter.date,
    },
  };
}

export default function NewsArticlePageJa({ params }: { params: { slug: string } }) {
  const post = getNewsBySlug("ja", params.slug);
  if (!post) notFound();

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: post.frontmatter.title,
    description: post.frontmatter.description,
    datePublished: post.frontmatter.date,
    articleSection: post.frontmatter.category,
    publisher: { "@type": "Organization", name: "Veritas Forge" },
    inLanguage: "ja",
  };

  return (
    <main className="min-h-screen bg-black px-6 py-32 text-white">
      <LanguageSwitch current="ja" enHref={`/news/${post.frontmatter.slug}`} jaHref={`/ja/news/${post.frontmatter.slug}`} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <article className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-bold text-blue-400">{post.frontmatter.category}</span>
          <StatusBadge status={post.frontmatter.status} locale="ja" />
          <span className="text-sm text-gray-500">{post.frontmatter.date}</span>
        </div>
        <h1 className="mt-4 text-4xl font-black tracking-tight text-white md:text-5xl">
          {post.frontmatter.title}
        </h1>
        <div className="mt-10">
          <NewsArticleBody content={post.content} />
        </div>
      </article>
    </main>
  );
}
