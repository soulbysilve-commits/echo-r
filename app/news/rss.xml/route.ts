import { getAllNews } from "@/lib/news";

const SITE_URL = "https://echo-r.veritasforge.net";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET() {
  const posts = getAllNews("en");
  const items = posts
    .map(
      (post) => `
    <item>
      <title>${escapeXml(post.frontmatter.title)}</title>
      <link>${SITE_URL}/news/${post.frontmatter.slug}</link>
      <guid>${SITE_URL}/news/${post.frontmatter.slug}</guid>
      <pubDate>${new Date(post.frontmatter.date).toUTCString()}</pubDate>
      <description>${escapeXml(post.frontmatter.description)}</description>
      <category>${escapeXml(post.frontmatter.category)}</category>
    </item>`
    )
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Veritas Forge News</title>
    <link>${SITE_URL}/news</link>
    <description>Verified product updates from Veritas Forge.</description>
    <language>en</language>${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
