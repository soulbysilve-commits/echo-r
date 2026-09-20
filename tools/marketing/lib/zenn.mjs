// Zenn content-generation pipeline (multi-channel expansion mandate section
// 7). Zenn has no write API — publication is via "git sync" (Zenn watches a
// GitHub repo connected in its own dashboard and auto-publishes markdown
// pushed to it). This module only ever generates real Zenn-formatted
// markdown into a local content directory with `published: false` — it
// never pushes, opens a PR, or touches git in any way (mandate: "Do not
// push anything yet"). AUTO_DRAFT=true / AUTO_PUBLISH=false is enforced by
// simply never flipping the frontmatter's `published` flag to true from
// code; a human (or a later, explicitly-approved pass) does that.
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { draftZennArticle } from './crossChannelDraft.mjs';
import { checkContent } from './policy.mjs';

function slugify(fact) {
  const words = fact.CLAIM.toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/\s+/).slice(0, 6).join('-');
  return `${fact.id.toLowerCase()}-${words}`.slice(0, 80);
}

function frontmatterToYaml({ title, emoji, type, topics, published }) {
  const lines = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `emoji: ${JSON.stringify(emoji)}`,
    `type: ${JSON.stringify(type)}`,
    `topics: [${topics.map((t) => JSON.stringify(t)).join(', ')}]`,
    `published: ${published}`,
    '---',
    '',
  ];
  return lines.join('\n');
}

/**
 * Generates (never writes) the Zenn article for `fact` — null if the fact
 * doesn't have real technical substance (draftZennArticle's own gate,
 * mandate section 5/6/7: never turn promotional copy into an article) or
 * fails the same claim/policy check every other channel's content goes
 * through.
 */
export function generateZennArticle(fact, facts, { canonicalUrl } = {}) {
  const draft = draftZennArticle(fact, { canonicalUrl });
  if (!draft) return { ok: false, reason: 'not technical substance — refusing to generate a Zenn article from promotional copy' };
  const check = checkContent({ text: draft.long_text, factIds: draft.factIds, claimStrength: draft.claimStrength }, facts);
  if (!check.ok) return { ok: false, reason: 'policy violation', violations: check.violations };
  return {
    ok: true,
    frontmatter: { title: draft.title, emoji: '🤖', type: 'tech', topics: draft.tags, published: false },
    body: draft.long_text,
    slug: slugify(fact),
  };
}

/**
 * Writes the generated article to `contentDir` (a real, git-tracked
 * directory the operator later decides — manually — to connect as a Zenn
 * "git sync" repo). Idempotent by fact id, same pattern as
 * lib/site.mjs's writeNewsArticle: never overwrites an existing generated
 * article for the same fact. Never git add/commit/push — a plain file
 * write only.
 */
export function writeZennArticle(fact, facts, { contentDir, canonicalUrl } = {}) {
  const generated = generateZennArticle(fact, facts, { canonicalUrl });
  if (!generated.ok) return { written: false, ...generated };

  mkdirSync(contentDir, { recursive: true });
  const existing = existsSync(contentDir)
    ? readdirSync(contentDir).find((f) => f.toLowerCase().startsWith(fact.id.toLowerCase() + '-'))
    : null;
  if (existing) {
    return { written: false, reason: 'already generated', path: join(contentDir, existing) };
  }

  const path = join(contentDir, `${generated.slug}.md`);
  writeFileSync(path, frontmatterToYaml(generated.frontmatter) + generated.body);
  return { written: true, path, frontmatter: generated.frontmatter };
}

/** Reads back an already-generated article's `published` flag — used by status reporting, never assumes without reading the real file. */
export function readZennPublishedState(path, { readFileImpl = readFileSync, existsImpl = existsSync } = {}) {
  if (!existsImpl(path)) return { exists: false };
  const raw = readFileImpl(path, 'utf8');
  const match = raw.match(/^published:\s*(true|false)/m);
  return { exists: true, published: match ? match[1] === 'true' : null };
}
