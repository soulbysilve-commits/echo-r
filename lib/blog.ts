import fs from "fs";
import path from "path";
import matter from "gray-matter";

export type BlogPostFrontmatter = {
  title: string;
  description: string;
  slug: string;
  date: string;
  author?: string;
  tags?: string[];
  canonical?: string;
};

export type BlogPost = {
  frontmatter: BlogPostFrontmatter;
  content: string;
};

const BLOG_DIR = path.join(process.cwd(), "content", "blog");

function normalizeDate(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "string") {
    return value;
  }

  if (value == null) {
    return "";
  }

  return String(value);
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeFrontmatter(data: Record<string, unknown>): BlogPostFrontmatter {
  return {
    title: String(data.title ?? ""),
    description: String(data.description ?? ""),
    slug: String(data.slug ?? ""),
    date: normalizeDate(data.date),
    author: data.author ? String(data.author) : undefined,
    canonical: data.canonical ? String(data.canonical) : undefined,
    tags: normalizeTags(data.tags),
  };
}

export function getAllPosts(): BlogPost[] {
  if (!fs.existsSync(BLOG_DIR)) return [];

  return fs
    .readdirSync(BLOG_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const raw = fs.readFileSync(path.join(BLOG_DIR, file), "utf8");
      const parsed = matter(raw);

      return {
        frontmatter: normalizeFrontmatter(parsed.data),
        content: parsed.content,
      };
    })
    .sort(
      (a, b) =>
        new Date(b.frontmatter.date).getTime() -
        new Date(a.frontmatter.date).getTime(),
    );
}

export function getPostBySlug(slug: string): BlogPost {
  const post = getAllPosts().find((p) => p.frontmatter.slug === slug);

  if (!post) {
    throw new Error(`Blog post not found: ${slug}`);
  }

  return post;
}
