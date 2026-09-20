// Fact -> website News content generation, with the same claim-verification
// gate as social content (mandate section 4/5): "verified public fact ->
// choose whether a website update is justified -> generate content ->
// validate claims -> (build/deploy is a separate, human-reviewed step)".
//
// The generated .md files ARE the data the Next.js app renders — News pages
// are data/content-driven (content/news/*.md), never hardcoded per-article
// components, so this generator is the only place claims get put in front of
// SEO metadata and structured data.
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkContent } from './policy.mjs';

export const NEWS_CATEGORIES = ['ECHO Agent', 'ECHO App', 'ECHO-R', 'Noemora', 'Veritas Forge'];

function slugify(fact) {
  const words = fact.CLAIM.toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/\s+/).slice(0, 6).join('-');
  return `${fact.id.toLowerCase()}-${words}`.slice(0, 80);
}

function categoryFor(fact) {
  const product = (fact.PRODUCT ?? '').toLowerCase();
  if (product.includes('echo agent')) return 'ECHO Agent';
  if (product.includes('echo app')) return 'ECHO App';
  if (product.includes('echo-r')) return 'ECHO-R';
  if (product.includes('noemora')) return 'Noemora';
  return 'Veritas Forge';
}

function claimStrengthFor(fact) {
  return fact.STATUS === 'VERIFIED' ? 'shipped' : fact.STATUS === 'FAILED' ? 'failure' : 'planned';
}

const STATUS_BADGE_EN = {
  VERIFIED: 'Shipped',
  PARTIAL: 'In progress',
  EXPERIMENTAL: 'Experimental',
  PLANNED: 'Planned',
  FAILED: 'Known issue',
  DEPRECATED: 'Deprecated',
};
const STATUS_BADGE_JA = {
  VERIFIED: '実装済み',
  PARTIAL: '開発中',
  EXPERIMENTAL: '実験段階',
  PLANNED: '開発予定',
  FAILED: '既知の課題',
  DEPRECATED: '非推奨',
};

/**
 * Builds the frontmatter + body for a news article about one fact. Does NOT
 * write anything — callers must run this through validateArticle() (which
 * happens automatically inside writeNewsArticle) before it reaches disk.
 */
export function generateArticle(fact, { locale = 'en', now = new Date() } = {}) {
  const date = now.toISOString().slice(0, 10);
  const slug = slugify(fact);
  const category = categoryFor(fact);
  const badge = (locale === 'ja' ? STATUS_BADGE_JA : STATUS_BADGE_EN)[fact.STATUS] ?? fact.STATUS;

  const title = locale === 'ja'
    ? `【${category}】${fact.CLAIM}`
    : `[${category}] ${fact.CLAIM}`;
  const description = locale === 'ja'
    ? `ステータス: ${badge}。根拠: ${fact.SOURCE_REPOSITORY} — ${fact.SOURCE_PATH}`
    : `Status: ${badge}. Evidence: ${fact.SOURCE_REPOSITORY} — ${fact.SOURCE_PATH}`;

  const bodyEn = `**Status: ${badge}**\n\n${fact.CLAIM}\n\n${fact.NOTES ? `**Notes:** ${fact.NOTES}\n\n` : ''}` +
    `Evidence: \`${fact.SOURCE_REPOSITORY}\` — \`${fact.SOURCE_PATH}\` (${fact.SOURCE_EVIDENCE ?? 'see fact registry'}).\n`;
  const bodyJa = `**ステータス: ${badge}**\n\n${fact.CLAIM}\n\n${fact.NOTES ? `**補足:** ${fact.NOTES}\n\n` : ''}` +
    `根拠: \`${fact.SOURCE_REPOSITORY}\` — \`${fact.SOURCE_PATH}\`（${fact.SOURCE_EVIDENCE ?? 'fact registry参照'}）。\n`;

  const frontmatter = {
    title, description, slug, date, category,
    status: fact.STATUS,
    factIds: [fact.id],
  };
  const body = locale === 'ja' ? bodyJa : bodyEn;

  return { frontmatter, body, draftForPolicy: { text: `${title}\n${body}`, factIds: [fact.id], claimStrength: claimStrengthFor(fact) } };
}

/**
 * The claim-verification gate: reuses the exact same policy.checkContent()
 * logic social drafts go through, so a PLANNED/EXPERIMENTAL fact can never
 * be worded as already-shipped in generated SEO-facing content either.
 */
export function validateArticle(article, facts) {
  return checkContent(article.draftForPolicy, facts);
}

function frontmatterToYaml(frontmatter) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => JSON.stringify(v)).join(', ')}]`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Generates and writes one news article for `fact` into `contentDir`
 * (e.g. content/news or content/ja/news), refusing to write if the claim
 * fails policy validation. Idempotent: does nothing if a file for this
 * fact+locale already exists (checked by slug prefix, i.e. fact id).
 */
export function writeNewsArticle(fact, facts, { locale = 'en', contentDir, now } = {}) {
  const article = generateArticle(fact, { locale, now });
  const check = validateArticle(article, facts);
  if (!check.ok) {
    return { written: false, reason: 'policy violation', violations: check.violations };
  }

  mkdirSync(contentDir, { recursive: true });
  const existing = existsSync(contentDir)
    ? readdirSync(contentDir).find((f) => f.toLowerCase().startsWith(fact.id.toLowerCase() + '-'))
    : null;
  if (existing) {
    return { written: false, reason: 'already generated', path: join(contentDir, existing) };
  }

  const path = join(contentDir, `${article.frontmatter.slug}.md`);
  writeFileSync(path, frontmatterToYaml(article.frontmatter) + article.body);
  return { written: true, path, frontmatter: article.frontmatter };
}
