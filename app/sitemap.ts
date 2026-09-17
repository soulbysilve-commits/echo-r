import { MetadataRoute } from "next";

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
    "/ja/legal",
    "/ja/terms",
    "/ja/privacy",
    "/ja/eula",
  ];

  return paths.map((pathname) => ({
    url: `${SITE_URL}${pathname}`,
    lastModified: new Date(),
  }));
}
