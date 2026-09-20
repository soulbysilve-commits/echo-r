// Real Bluesky (AT Protocol) connector. mechanism: REAL_CLIENT_IMPLEMENTED.
// Uses an app password (never the account password itself — Bluesky's own
// recommended mechanism for automation), never browser/credential
// automation.
import { requestWithRetry } from './http.mjs';

export const channel = 'bluesky';
export const clientImplemented = true;
export const REQUIRED_ENV_VARS = ['BLUESKY_IDENTIFIER', 'BLUESKY_APP_PASSWORD'];

const MAX_GRAPHEMES = 300; // Bluesky's own post length limit

function serviceUrl(env) {
  return env.BLUESKY_SERVICE_URL || 'https://bsky.social';
}

export function isAuthConfigured(env = process.env) {
  return REQUIRED_ENV_VARS.every((name) => !!env[name]);
}

export function capabilities() {
  return { text: true, links: true, images: false, video: false, maxTextLength: MAX_GRAPHEMES, threading: false };
}

export function validate(input) {
  const text = input.short_text ?? input.text;
  if (!text) return { ok: false, error: 'bluesky requires short_text' };
  if ([...text].length > MAX_GRAPHEMES) return { ok: false, error: `bluesky text exceeds ${MAX_GRAPHEMES} graphemes` };
  return { ok: true };
}

/**
 * Creates a session (real login via app password) — the one auth call every
 * other real call needs a fresh accessJwt from. Never cached across process
 * invocations (each CLI/operator run is short-lived; a fresh session per run
 * is simpler and safer than persisting a refresh token to disk).
 */
export async function createSession({ env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing one of: ${REQUIRED_ENV_VARS.join(', ')}` };
  }
  const result = await requestWithRetry(
    () => fetchImpl(`${serviceUrl(env)}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: env.BLUESKY_IDENTIFIER, password: env.BLUESKY_APP_PASSWORD }),
    }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const data = await result.response.json();
  if (!data.accessJwt || !data.did) return { ok: false, errorClass: 'AUTH_ERROR', message: 'session response missing accessJwt/did' };
  return { ok: true, accessJwt: data.accessJwt, did: data.did, handle: data.handle };
}

/** Read-only identity check — createSession itself IS the safest read here (Bluesky has no separate "whoami" that doesn't also authenticate). */
export async function getIdentity({ env = process.env, fetchImpl = fetch } = {}) {
  const session = await createSession({ env, fetchImpl });
  if (!session.ok) return session;
  return { ok: true, identifier: `@${session.handle} (did ${session.did})`, did: session.did, handle: session.handle };
}

export async function createPost(text, { env = process.env, fetchImpl = fetch, retryOpts, langs = ['en'] } = {}) {
  const session = await createSession({ env, fetchImpl, retryOpts });
  if (!session.ok) return session;

  const record = { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString(), langs };
  const result = await requestWithRetry(
    () => fetchImpl(`${serviceUrl(env)}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.accessJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', record }),
    }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const data = await result.response.json();
  if (!data.uri) return { ok: false, errorClass: 'AUTH_ERROR', message: 'createRecord response missing uri' };
  const rkey = data.uri.split('/').pop();
  return { ok: true, id: data.uri, cid: data.cid, url: `https://bsky.app/profile/${session.handle}/post/${rkey}` };
}

/**
 * Best-effort duplicate check against the account's own recent posts (never
 * the sole dedup mechanism — publication_ledger's UNIQUE(channel,
 * content_hash) is the durable source of truth; this is real, additional
 * evidence, not a fabricated always-empty stub).
 */
export async function lookupExisting(text, { env = process.env, fetchImpl = fetch, limit = 20 } = {}) {
  const session = await createSession({ env, fetchImpl });
  if (!session.ok) return session;
  const url = `${serviceUrl(env)}/xrpc/com.atproto.repo.listRecords?repo=${session.did}&collection=app.bsky.feed.post&limit=${limit}`;
  const result = await requestWithRetry(
    () => fetchImpl(url, { headers: { Authorization: `Bearer ${session.accessJwt}` } })
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const data = await result.response.json();
  const match = (data.records ?? []).find((r) => r.value?.text === text);
  return { ok: true, found: !!match, uri: match?.uri ?? null };
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
    return { ok: true, dryRun: true, channel, wouldPublish: draft.text };
  }
  const result = await createPost(draft.text, { env, fetchImpl });
  if (!result.ok) return { ok: false, error: result.message ?? result.errorClass };
  // cid is AT Protocol's own content-addressed record identifier (distinct
  // from `uri`/externalId) — passed through so callers that need it (the
  // Bluesky canary, see lib/canary.mjs) never have to re-derive it via a
  // second call.
  return { ok: true, externalId: result.id, externalUrl: result.url, cid: result.cid };
}
