// Real X (Twitter) API v2 connector, OAuth 1.0a user-context signed.
// mechanism: REAL_CLIENT_IMPLEMENTED — a full HTTP client exists and is
// tested against mocked responses; whether it can actually run LIVE depends
// solely on whether credentials are present (see isAuthConfigured).
import { buildOAuth1Header } from './oauth1.mjs';
import { requestWithRetry, ERROR_CLASS } from './http.mjs';

export const channel = 'x';
export const clientImplemented = true;

// Exact env var names required — documented once here and in
// docs/marketing/CONNECTION_SETUP.md. Never read any other name.
export const REQUIRED_ENV_VARS = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];

const API_BASE = 'https://api.twitter.com/2';

export function isAuthConfigured(env = process.env) {
  return REQUIRED_ENV_VARS.every((name) => !!env[name]);
}

function credentialsFrom(env) {
  return {
    consumerKey: env.X_API_KEY,
    consumerSecret: env.X_API_SECRET,
    accessToken: env.X_ACCESS_TOKEN,
    accessTokenSecret: env.X_ACCESS_TOKEN_SECRET,
  };
}

async function signedFetch(method, url, credentials, { body, queryParams, fetchImpl = fetch } = {}) {
  const header = buildOAuth1Header(method, url, credentials, { queryParams });
  return fetchImpl(url, {
    method,
    headers: {
      Authorization: header,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * Create a post. Returns { ok, id, url, errorClass, message }.
 * Never called when dryRun is true — the operator only reaches connectors
 * in LIVE mode with automation enabled.
 */
export async function createPost(text, { env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing one of: ${REQUIRED_ENV_VARS.join(', ')}` };
  }
  const credentials = credentialsFrom(env);
  const url = `${API_BASE}/tweets`;

  const result = await requestWithRetry(
    () => signedFetch('POST', url, credentials, { body: { text }, fetchImpl }),
    retryOpts
  );

  if (!result.ok) {
    return { ok: false, errorClass: result.errorClass, status: result.status, message: await safeText(result.response) };
  }
  const data = await result.response.json();
  const id = data?.data?.id;
  return { ok: true, id, url: id ? `https://x.com/i/web/status/${id}` : undefined };
}

export async function replyToPost(text, inReplyToId, { env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing one of: ${REQUIRED_ENV_VARS.join(', ')}` };
  }
  const credentials = credentialsFrom(env);
  const url = `${API_BASE}/tweets`;
  const body = { text, reply: { in_reply_to_tweet_id: inReplyToId } };

  const result = await requestWithRetry(() => signedFetch('POST', url, credentials, { body, fetchImpl }), retryOpts);
  if (!result.ok) {
    return { ok: false, errorClass: result.errorClass, status: result.status, message: await safeText(result.response) };
  }
  const data = await result.response.json();
  const id = data?.data?.id;
  return { ok: true, id, url: id ? `https://x.com/i/web/status/${id}` : undefined };
}

export async function fetchRecentPosts(userId, { env = process.env, fetchImpl = fetch, maxResults = 10, retryOpts } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing one of: ${REQUIRED_ENV_VARS.join(', ')}` };
  }
  const credentials = credentialsFrom(env);
  const queryParams = { max_results: String(maxResults) };
  const url = `${API_BASE}/users/${userId}/tweets`;
  const fullUrl = `${url}?max_results=${maxResults}`;

  const result = await requestWithRetry(
    () => signedFetch('GET', url, credentials, { queryParams, fetchImpl: (u, opts) => fetchImpl(fullUrl, opts) }),
    retryOpts
  );
  if (!result.ok) {
    return { ok: false, errorClass: result.errorClass, status: result.status, message: await safeText(result.response) };
  }
  const data = await result.response.json();
  return { ok: true, posts: data?.data ?? [] };
}

/**
 * Read-only identity check: GET /2/users/me. This is the "safest possible
 * authenticated read-only request" for X — it costs no rate-limit budget
 * meant for posting and never touches the timeline. Used by `auth-check`
 * and internally by `canary` before it ever attempts a real post.
 */
export async function getMe({ env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing one of: ${REQUIRED_ENV_VARS.join(', ')}` };
  }
  const credentials = credentialsFrom(env);
  const url = `${API_BASE}/users/me`;

  const result = await requestWithRetry(() => signedFetch('GET', url, credentials, { fetchImpl }), retryOpts);
  if (!result.ok) {
    return { ok: false, errorClass: result.errorClass, status: result.status, message: await safeText(result.response) };
  }
  const data = await result.response.json();
  return { ok: true, id: data?.data?.id, username: data?.data?.username };
}

async function safeText(response) {
  try {
    return await response?.text?.();
  } catch {
    return undefined;
  }
}

/**
 * Unified interface used by tools/marketing/operator.mjs and the connector registry.
 */
export async function publish(draft, { dryRun = true, env = process.env, fetchImpl = fetch } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, connectionRequired: true, channel };
  }
  if (dryRun) {
    return { ok: true, dryRun: true, channel, wouldPublish: draft.text };
  }
  const result = await createPost(draft.text, { env, fetchImpl });
  if (!result.ok) {
    if (result.errorClass === ERROR_CLASS.RATE_LIMITED) {
      return { ok: false, error: 'rate limited', retryable: true };
    }
    return { ok: false, error: result.message ?? result.errorClass, retryable: result.errorClass === ERROR_CLASS.TRANSIENT };
  }
  return { ok: true, externalId: result.id, externalUrl: result.url };
}
