import fs from "fs";
import path from "path";
import matter from "gray-matter";

export const NEWS_CATEGORIES = [
  "ECHO Agent",
  "ECHO App",
  "ECHO-R",
  "Noemora",
  "Veritas Forge",
] as const;

export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export type NewsFrontmatter = {
  title: string;
  description: string;
  slug: string;
  date: string;
  category: NewsCategory;
  status: string;
  factIds: string[];
};

export type NewsPost = {
  frontmatter: NewsFrontmatter;
  content: string;
};

function newsDir(locale: "en" | "ja"): string {
  return locale === "ja"
    ? path.join(process.cwd(), "content", "ja", "news")
    : path.join(process.cwd(), "content", "news");
}

function normalizeFrontmatter(data: Record<string, unknown>): NewsFrontmatter {
  const category = String(data.category ?? "Veritas Forge") as NewsCategory;
  return {
    title: String(data.title ?? ""),
    description: String(data.description ?? ""),
    slug: String(data.slug ?? ""),
    date: String(data.date ?? ""),
    category: NEWS_CATEGORIES.includes(category) ? category : "Veritas Forge",
    status: String(data.status ?? ""),
    factIds: Array.isArray(data.factIds) ? data.factIds.map(String) : [],
  };
}

// Every news article is generated from tools/marketing/lib/site.mjs against
// the public fact registry — this module only ever reads and renders what's
// already on disk in content/news, it never writes or fabricates entries.
export function getAllNews(locale: "en" | "ja" = "en"): NewsPost[] {
  const dir = newsDir(locale);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      const parsed = matter(raw);
      return {
        frontmatter: normalizeFrontmatter(parsed.data),
        content: parsed.content,
      };
    })
    .sort((a, b) => new Date(b.frontmatter.date).getTime() - new Date(a.frontmatter.date).getTime());
}

export function getNewsBySlug(locale: "en" | "ja", slug: string): NewsPost | undefined {
  return getAllNews(locale).find((p) => p.frontmatter.slug === slug);
}
