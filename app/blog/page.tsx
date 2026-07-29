import type { Metadata } from "next";
import Link from "next/link";
import { getAllPosts } from "@/lib/blog";

export const metadata: Metadata = {
  title: "Blog | Veritas Forge",
  description:
    "Research notes and essays from Veritas Forge on persistent AI identity, observer-only governance, and AI society.",
  alternates: {
    canonical: "https://echo-r.veritasforge.net/blog",
  },
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    title: "Blog | Veritas Forge",
    description:
      "Research notes and essays from Veritas Forge on persistent AI identity, observer-only governance, and AI society.",
    url: "https://echo-r.veritasforge.net/blog",
    images: ["https://echo-r.veritasforge.net/og-image.png"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Blog | Veritas Forge",
    description:
      "Research notes and essays from Veritas Forge on persistent AI identity, observer-only governance, and AI society.",
    images: ["https://echo-r.veritasforge.net/og-image.png"],
  },
};

export default function BlogPage() {
  const posts = getAllPosts();

  return (
    <main className="min-h-screen bg-black px-6 py-32 text-white">
      <section className="mx-auto max-w-5xl">
        <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
          BLOG
        </p>

        <h1 className="text-5xl font-black tracking-tight md:text-7xl">
          Research notes.
        </h1>

        <p className="mt-6 max-w-3xl text-gray-400">
          Essays and research updates from Veritas Forge.
        </p>

        <div className="mt-14 grid gap-6">
          {posts.map((post) => (
            <Link
              key={post.frontmatter.slug}
              href={`/blog/${post.frontmatter.slug}`}
              className="block rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition hover:border-blue-500/60 hover:bg-blue-500/10"
            >
              <p className="text-sm font-bold text-blue-400">
                {post.frontmatter.date}
              </p>

              <h2 className="mt-3 text-2xl font-bold text-white">
                {post.frontmatter.title}
              </h2>

              <p className="mt-3 text-gray-400">
                {post.frontmatter.description}
              </p>

              {post.frontmatter.tags?.length ? (
                <div className="mt-5 flex flex-wrap gap-2">
                  {post.frontmatter.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-white/10 px-3 py-1 text-xs text-gray-400"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
