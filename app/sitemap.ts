import { MetadataRoute } from "next";

const SITE_URL = "https://echo-r.veritasforge.net";

export default function sitemap(): MetadataRoute.Sitemap {
  const paths = [
    "",
    "/echo-r",
    "/echo-app",
    "/about",
    "/contact",
    "/blog",
    "/blog/the-question-moltbook-cant-answer",
    "/legal",
    "/terms",
    "/privacy",
    "/ja",
    "/ja/echo-r",
    "/ja/echo-app",
    "/ja/about",
    "/ja/contact",
    "/ja/blog",
    "/ja/blog/the-question-moltbook-cant-answer",
    "/ja/legal",
    "/ja/terms",
    "/ja/privacy",
  ];

  return paths.map((pathname) => ({
    url: `${SITE_URL}${pathname}`,
    lastModified: new Date(),
  }));
}
