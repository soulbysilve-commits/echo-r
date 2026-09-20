// Real Reddit connector using a "script"-type OAuth2 app (password grant).
// mechanism: REAL_CLIENT_IMPLEMENTED. Script apps are the supported path for
// a single bot-controlled account posting/replying under its own identity —
// no browser-based install flow needed, unlike a public OAuth app.
import { requestWithRetry } from './http.mjs';

export const channel = 'reddit';
export const clientImplemented = true;
export const REQUIRED_ENV_VARS = ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USERNAME', 'REDDIT_PASSWORD'];

const USER_AGENT = 'veritas-forge-marketing-operator/1.0';

export function isAuthConfigured(env = process.env) {
  return REQUIRED_ENV_VARS.every((name) => !!env[name]);
}

export async function getAccessToken({ env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing one of: ${REQUIRED_ENV_VARS.join(', ')}` };
  }
  const basic = Buffer.from(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'password', username: env.REDDIT_USERNAME, password: env.REDDIT_PASSWORD });

  const result = await requestWithRetry(
    () => fetchImpl('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
    }),
    retryOpts
  );

  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const data = await result.response.json();
  if (!data.access_token) return { ok: false, errorClass: 'AUTH_ERROR', message: 'no access_token in response' };
  return { ok: true, accessToken: data.access_token };
}

/**
 * Submit a self (text) post to a subreddit. Reddit's own submission endpoint
 * is idempotent-ish per (subreddit, title) within a short window on their
 * side, but we don't rely on that — the publication ledger is our source of
 * dedup truth (mandate: idempotency belongs in the ledger, not scattered
 * across every connector).
 */
export async function submitPost(subreddit, title, text, { env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  const auth = await getAccessToken({ env, fetchImpl, retryOpts });
  if (!auth.ok) return auth;

  const body = new URLSearchParams({ sr: subreddit, title, text, kind: 'self', api_type: 'json' });
  const result = await requestWithRetry(
    () => fetchImpl('https://oauth.reddit.com/api/submit', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
    }),
    retryOpts
  );

  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const data = await result.response.json();
  const errors = data?.json?.errors;
  if (errors && errors.length > 0) {
    return { ok: false, errorClass: 'BAD_REQUEST', message: JSON.stringify(errors) };
  }
  const permalink = data?.json?.data?.url;
  return { ok: true, url: permalink, id: data?.json?.data?.id };
}

export async function publish(draft, { dryRun = true, env = process.env, fetchImpl = fetch } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, connectionRequired: true, channel };
  }
  if (dryRun) {
    return { ok: true, dryRun: true, channel, wouldPublish: draft.text };
  }
  if (!draft.subreddit || !draft.title) {
    return { ok: false, error: 'reddit draft requires subreddit and title fields' };
  }
  const result = await submitPost(draft.subreddit, draft.title, draft.text, { env, fetchImpl });
  if (!result.ok) return { ok: false, error: result.message ?? result.errorClass };
  return { ok: true, externalId: result.id, externalUrl: result.url };
}
