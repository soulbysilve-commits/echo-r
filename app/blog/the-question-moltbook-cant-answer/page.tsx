import type { Metadata } from "next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getPostBySlug } from "@/lib/blog";

const SITE_URL = "https://echo-r.veritasforge.net";
const SLUG = "the-question-moltbook-cant-answer";

export function generateMetadata(): Metadata {
  const post = getPostBySlug(SLUG);
  const canonical =
    post.frontmatter.canonical || `${SITE_URL}/blog/${post.frontmatter.slug}`;

  return {
    title: post.frontmatter.title,
    description: post.frontmatter.description,
    alternates: {
      canonical,
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1,
      },
    },
    openGraph: {
      title: post.frontmatter.title,
      description: post.frontmatter.description,
      url: canonical,
      images: [
        {
          url: `${SITE_URL}/og-image.png`,
          width: 1200,
          height: 630,
          alt: "Veritas Forge / ECHO-R",
        },
      ],
      type: "article",
      publishedTime: post.frontmatter.date,
      tags: post.frontmatter.tags,
    },
    twitter: {
      card: "summary_large_image",
      title: post.frontmatter.title,
      description: post.frontmatter.description,
      images: [`${SITE_URL}/og-image.png`],
    },
  };
}

export default function BlogArticlePage() {
  const post = getPostBySlug(SLUG);

  return (
    <main className="min-h-screen bg-black px-6 py-32 text-white">
      <article className="mx-auto max-w-3xl">
        <p className="mb-4 text-sm font-bold uppercase tracking-[0.35em] text-blue-400">
          BLOG
        </p>

        <h1 className="text-4xl font-black tracking-tight md:text-6xl">
          {post.frontmatter.title}
        </h1>

        <p className="mt-6 text-xl text-gray-400">
          {post.frontmatter.description}
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-gray-400">
            {post.frontmatter.date}
          </span>

          {post.frontmatter.tags?.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-white/10 px-3 py-1 text-xs text-gray-400"
            >
              {tag}
            </span>
          ))}
        </div>

        <div className="mt-12 border-t border-white/10 pt-12">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => (
                <h1 className="mt-12 text-4xl font-black text-white">
                  {children}
                </h1>
              ),
              h2: ({ children }) => (
                <h2 className="mt-12 text-3xl font-bold text-white">
                  {children}
                </h2>
              ),
              h3: ({ children }) => (
                <h3 className="mt-10 text-2xl font-bold text-white">
                  {children}
                </h3>
              ),
              p: ({ children }) => (
                <p className="mt-6 leading-8 text-gray-300">{children}</p>
              ),
              a: ({ href, children }) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 underline decoration-blue-400/40 underline-offset-4 hover:text-blue-300"
                >
                  {children}
                </a>
              ),
              ul: ({ children }) => (
                <ul className="mt-6 list-disc space-y-3 pl-6 text-gray-300">
                  {children}
                </ul>
              ),
              ol: ({ children }) => (
                <ol className="mt-6 list-decimal space-y-3 pl-6 text-gray-300">
                  {children}
                </ol>
              ),
              li: ({ children }) => <li className="leading-8">{children}</li>,
              blockquote: ({ children }) => (
                <blockquote className="mt-8 border-l-4 border-blue-500 pl-5 text-gray-300">
                  {children}
                </blockquote>
              ),
              code: ({ children }) => (
                <code className="rounded bg-white/10 px-1.5 py-0.5 text-sm text-blue-200">
                  {children}
                </code>
              ),
              pre: ({ children }) => (
                <pre className="mt-6 overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.04] p-5 text-sm text-gray-200">
                  {children}
                </pre>
              ),
              hr: () => <hr className="my-12 border-white/10" />,
            }}
          >
            {post.content}
          </ReactMarkdown>
        </div>
      </article>
    </main>
  );
}
