// Real Qiita connector (Qiita API v2, personal access token). mechanism:
// REAL_CLIENT_IMPLEMENTED. Technical articles only — the weekly cap
// (MAX_QIITA_ARTICLES_PER_WEEK) is enforced centrally by
// lib/frequencyGuards.mjs, not duplicated here.
import { requestWithRetry } from './http.mjs';

export const channel = 'qiita';
export const clientImplemented = true;
export const REQUIRED_ENV_VARS = ['QIITA_ACCESS_TOKEN'];

export function isAuthConfigured(env = process.env) {
  return !!env.QIITA_ACCESS_TOKEN;
}

export function capabilities() {
  return { text: false, longform: true, links: true, images: true, video: false, tags: true, canonicalUrl: false };
}

export function validate(input) {
  if (!input.title) return { ok: false, error: 'qiita requires title' };
  if (!(input.long_text ?? input.body)) return { ok: false, error: 'qiita requires long_text (body)' };
  if (!(input.tags ?? []).length) return { ok: false, error: 'qiita requires at least one tag' };
  return { ok: true };
}

export async function getIdentity({ env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing ${REQUIRED_ENV_VARS[0]}` };
  }
  const result = await requestWithRetry(
    () => fetchImpl('https://qiita.com/api/v2/authenticated_user', {
      headers: { Authorization: `Bearer ${env.QIITA_ACCESS_TOKEN}` },
    }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const data = await result.response.json();
  if (!data.id) return { ok: false, errorClass: 'AUTH_ERROR', message: 'authenticated_user response missing id' };
  return { ok: true, identifier: `@${data.id}`, username: data.id };
}

export async function lookupExisting(title, { env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  const identity = await getIdentity({ env, fetchImpl, retryOpts });
  if (!identity.ok) return identity;
  const result = await requestWithRetry(
    () => fetchImpl(`https://qiita.com/api/v2/users/${identity.username}/items`, {
      headers: { Authorization: `Bearer ${env.QIITA_ACCESS_TOKEN}` },
    }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const items = await result.response.json();
  const match = (Array.isArray(items) ? items : []).find((it) => it.title === title);
  return { ok: true, found: !!match, id: match?.id ?? null, url: match?.url ?? null };
}

export function status(env = process.env) {
  return { channel, clientImplemented, authConfigured: isAuthConfigured(env) };
}

export async function createItem({ title, body, tags = [], isPrivate = false }, { env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing ${REQUIRED_ENV_VARS[0]}` };
  }
  const payload = {
    title,
    body,
    tags: tags.map((name) => ({ name })),
    private: isPrivate,
  };

  const result = await requestWithRetry(
    () => fetchImpl('https://qiita.com/api/v2/items', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.QIITA_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }),
    retryOpts
  );

  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const data = await result.response.json();
  return { ok: true, id: data.id, url: data.url, private: data.private };
}

/**
 * The authenticated "my items" endpoint (GET /api/v2/authenticated_user/items)
 * — unlike lookupExisting()'s GET /api/v2/users/:user_id/items (the
 * public-facing profile view, which never includes private items), this one
 * is scoped to the token owner and includes private items too. The
 * authoritative source for "does a private canary item already exist" —
 * stronger than inferring visibility from a create response's (possibly
 * absent) `private` field.
 */
export async function getMyItems({ env = process.env, fetchImpl = fetch, retryOpts, page = 1, perPage = 100 } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing ${REQUIRED_ENV_VARS[0]}` };
  }
  const result = await requestWithRetry(
    () => fetchImpl(`https://qiita.com/api/v2/authenticated_user/items?page=${page}&per_page=${perPage}`, {
      headers: { Authorization: `Bearer ${env.QIITA_ACCESS_TOKEN}` },
    }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const items = await result.response.json();
  return { ok: true, items: Array.isArray(items) ? items : [] };
}

/**
 * Authoritative read-only reconciliation for a single item id, used
 * whenever a create response's `private` field is absent/ambiguous — HTTP
 * success plus a missing field is never treated as confirmation.
 */
export async function reconcileItemStatus(id, opts = {}) {
  const mine = await getMyItems(opts);
  if (!mine.ok) return { ok: false, errorClass: mine.errorClass, status: mine.status };
  const match = mine.items.find((it) => String(it.id) === String(id));
  if (!match) return { ok: true, status: 'NOT_FOUND' };
  return { ok: true, status: match.private ? 'PRIVATE' : 'PUBLIC' };
}

export async function publish(draft, { dryRun = true, env = process.env, fetchImpl = fetch } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, connectionRequired: true, channel };
  }
  // Reuse the module's own validate() (checks long_text ?? body, and tags
  // non-empty) — same "one real check, never a second, looser one" pattern
  // as devto.mjs's publish(). Fixes a real bug: draftQiitaArticle() (and
  // every other qiita draft in this codebase) produces `long_text`, never
  // `body` — the previous ad hoc `!draft.body` check here always failed
  // for a real draft, silently blocking every non-dry-run Qiita publish.
  const v = validate(draft);
  if (!v.ok) return { ok: false, error: v.error };
  if (dryRun) {
    return { ok: true, dryRun: true, channel, wouldPublish: draft.title };
  }
  const result = await createItem({
    title: draft.title, body: draft.long_text ?? draft.body, tags: draft.tags ?? [], isPrivate: draft.isPrivate ?? false,
  }, { env, fetchImpl });
  if (!result.ok) return { ok: false, error: result.message ?? result.errorClass };
  return { ok: true, externalId: result.id, externalUrl: result.url };
}
