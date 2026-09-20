import { MetadataRoute } from "next";
import { getAllNews } from "@/lib/news";

const SITE_URL = "https://echo-r.veritasforge.net";

export default function sitemap(): MetadataRoute.Sitemap {
  const paths = [
    "",
    "/echo-r",
    "/echo-app",
    "/echo-agent",
    "/about",
    "/contact",
    "/blog",
    "/blog/the-question-moltbook-cant-answer",
    "/news",
    "/legal",
    "/terms",
    "/privacy",
    "/eula",
    "/ja",
    "/ja/echo-r",
    "/ja/echo-app",
    "/ja/echo-agent",
    "/ja/about",
    "/ja/contact",
    "/ja/blog",
    "/ja/blog/the-question-moltbook-cant-answer",
    "/ja/news",
    "/ja/legal",
    "/ja/terms",
    "/ja/privacy",
    "/ja/eula",
  ];

  // News entries are data-driven (content/news, content/ja/news), so the
  // sitemap picks up new articles automatically rather than needing a
  // manual path added here per post — unlike the hardcoded blog entries above.
  const enNews = getAllNews("en").map((post) => ({
    url: `${SITE_URL}/news/${post.frontmatter.slug}`,
    lastModified: new Date(post.frontmatter.date),
  }));
  const jaNews = getAllNews("ja").map((post) => ({
    url: `${SITE_URL}/ja/news/${post.frontmatter.slug}`,
    lastModified: new Date(post.frontmatter.date),
  }));

  return [
    ...paths.map((pathname) => ({
      url: `${SITE_URL}${pathname}`,
      lastModified: new Date(),
    })),
    ...enNews,
    ...jaNews,
  ];
}
