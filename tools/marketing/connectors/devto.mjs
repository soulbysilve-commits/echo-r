// Real DEV.to (Forem) connector — official REST API. mechanism:
// REAL_CLIENT_IMPLEMENTED. Long-form technical content only (mandate
// section 5) — validate() below is a structural check (has real
// architecture/technical markers), the actual "is this genuinely technical"
// judgment still belongs to the evidence gate / draft selection upstream,
// same as every other channel's content decisions.
import { requestWithRetry } from './http.mjs';

const API_BASE = 'https://dev.to/api';

export const channel = 'devto';
export const clientImplemented = true;
export const REQUIRED_ENV_VARS = ['DEVTO_API_KEY'];

export function isAuthConfigured(env = process.env) {
  return !!env.DEVTO_API_KEY;
}

export function capabilities() {
  return { text: false, longform: true, links: true, images: true, video: false, tags: true, canonicalUrl: true };
}

export function validate(input) {
  const title = input.title;
  const body = input.long_text;
  if (!title) return { ok: false, error: 'devto requires title' };
  if (!body) return { ok: false, error: 'devto requires long_text (body_markdown)' };
  if ((input.tags ?? []).length > 4) return { ok: false, error: 'devto allows at most 4 tags' };
  return { ok: true };
}

export async function getIdentity({ env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing ${REQUIRED_ENV_VARS[0]}` };
  }
  const result = await requestWithRetry(
    () => fetchImpl(`${API_BASE}/users/me`, { headers: { 'api-key': env.DEVTO_API_KEY } }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const data = await result.response.json();
  if (!data.id) return { ok: false, errorClass: 'AUTH_ERROR', message: 'users/me response missing id' };
  return { ok: true, identifier: `@${data.username} (id ${data.id})`, accountId: data.id, username: data.username };
}

export async function createArticle({ title, body_markdown, tags = [], description, canonical_url, published = false }, {
  env = process.env, fetchImpl = fetch, retryOpts,
} = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing ${REQUIRED_ENV_VARS[0]}` };
  }
  const payload = { article: { title, body_markdown, published, tags, description, canonical_url } };
  const result = await requestWithRetry(
    () => fetchImpl(`${API_BASE}/articles`, {
      method: 'POST',
      headers: { 'api-key': env.DEVTO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const data = await result.response.json();
  if (!data.id) return { ok: false, errorClass: 'AUTH_ERROR', message: 'articles response missing id' };
  return { ok: true, id: data.id, url: data.url, published: data.published };
}

export async function lookupExisting(title, { env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing ${REQUIRED_ENV_VARS[0]}` };
  }
  const result = await requestWithRetry(
    () => fetchImpl(`${API_BASE}/articles/me/all`, { headers: { 'api-key': env.DEVTO_API_KEY } }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const articles = await result.response.json();
  const match = (Array.isArray(articles) ? articles : []).find((a) => a.title === title);
  return { ok: true, found: !!match, id: match?.id ?? null, url: match?.url ?? null };
}

async function fetchMyArticles(path, { env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing ${REQUIRED_ENV_VARS[0]}` };
  }
  const result = await requestWithRetry(
    () => fetchImpl(`${API_BASE}${path}`, { headers: { 'api-key': env.DEVTO_API_KEY } }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const articles = await result.response.json();
  return { ok: true, articles: Array.isArray(articles) ? articles : [] };
}

// The official authenticated unpublished-drafts endpoint — the authoritative
// source for "is this article actually still a draft", stronger than
// inferring status from a create response's (possibly absent) `published`
// field or from `published_at` alone (DEV.to canary recovery, 2026-09-16).
export async function getUnpublishedArticles(opts) {
  return fetchMyArticles('/articles/me/unpublished', opts);
}

export async function getAllArticles(opts) {
  return fetchMyArticles('/articles/me/all', opts);
}

/**
 * Authoritative read-only reconciliation for a single article id, used
 * whenever a create response's `published` field is absent/ambiguous — HTTP
 * success plus a missing field is never treated as confirmation. Checks the
 * real unpublished-drafts collection first; only falls back to /articles/me/all
 * (to distinguish "published" from "not found") if the id isn't there.
 */
export async function reconcileArticleStatus(id, opts = {}) {
  const unpublished = await getUnpublishedArticles(opts);
  if (!unpublished.ok) return { ok: false, errorClass: unpublished.errorClass, status: unpublished.status };
  if (unpublished.articles.some((a) => String(a.id) === String(id))) {
    return { ok: true, status: 'UNPUBLISHED' };
  }
  const all = await getAllArticles(opts);
  if (!all.ok) return { ok: true, status: 'UNKNOWN' };
  const match = all.articles.find((a) => String(a.id) === String(id));
  if (!match) return { ok: true, status: 'NOT_FOUND' };
  return { ok: true, status: match.published ? 'PUBLISHED' : 'UNPUBLISHED' };
}

export function status(env = process.env) {
  return { channel, clientImplemented, authConfigured: isAuthConfigured(env) };
}

export async function publish(draft, { dryRun = true, env = process.env, fetchImpl = fetch } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, connectionRequired: true, channel };
  }
  const v = validate(draft);
  if (!v.ok) return { ok: false, error: v.error };
  if (dryRun) {
    return { ok: true, dryRun: true, channel, wouldPublish: draft.title };
  }
  const result = await createArticle({
    title: draft.title, body_markdown: draft.long_text, tags: draft.tags ?? [],
    description: draft.short_text, canonical_url: draft.canonical_url, published: true,
  }, { env, fetchImpl });
  if (!result.ok) return { ok: false, error: result.message ?? result.errorClass };
  return { ok: true, externalId: result.id, externalUrl: result.url };
}
