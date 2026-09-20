// Real Mastodon connector (standard REST API, works against any compatible
// instance — never hardcoded to mastodon.social). mechanism:
// REAL_CLIENT_IMPLEMENTED.
import { randomUUID } from 'node:crypto';
import { requestWithRetry } from './http.mjs';

export const channel = 'mastodon';
export const clientImplemented = true;
export const REQUIRED_ENV_VARS = ['MASTODON_BASE_URL', 'MASTODON_ACCESS_TOKEN'];

const MAX_CHARS_DEFAULT = 500; // most instances default to this; not queried live to keep publish() a single round trip

// mastodon.social's own signup rules (shown to users at signup) require
// disclosure when generative AI is used. This is enforced in validate()
// below — part of this connector's own content validation, so every real
// publish() call (canary or autonomous) fails closed if it's missing,
// regardless of caller. Mastodon-specific only, by design — no other
// connector reads or checks this.
export const AI_DISCLOSURE_EN = 'AI-assisted post.';
export const AI_DISCLOSURE_JA = 'AI支援による投稿です。';
const AI_DISCLOSURE_PATTERN = /AI[- ]assisted|AI[- ]generated|generative AI|AI支援|AI生成/i;

export function hasAiDisclosure(text) {
  return AI_DISCLOSURE_PATTERN.test(text ?? '');
}

export function isAuthConfigured(env = process.env) {
  return REQUIRED_ENV_VARS.every((name) => !!env[name]);
}

function baseUrl(env) {
  return String(env.MASTODON_BASE_URL ?? '').replace(/\/+$/, '');
}

export function capabilities() {
  return { text: true, links: true, images: false, video: false, maxTextLength: MAX_CHARS_DEFAULT, threading: true };
}

export function validate(input) {
  const text = input.short_text ?? input.text;
  if (!text) return { ok: false, error: 'mastodon requires short_text' };
  if (text.length > MAX_CHARS_DEFAULT) return { ok: false, error: `mastodon text exceeds ${MAX_CHARS_DEFAULT} characters (instance default assumed)` };
  if (!hasAiDisclosure(text)) {
    return { ok: false, error: 'missing required AI-use disclosure (mastodon.social signup rules require disclosure of generative-AI use) — text must include an AI-assisted/AI-generated statement, or a Japanese equivalent' };
  }
  return { ok: true };
}

/** Read-only identity check: GET /api/v1/accounts/verify_credentials. */
export async function getIdentity({ env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing one of: ${REQUIRED_ENV_VARS.join(', ')}` };
  }
  const result = await requestWithRetry(
    () => fetchImpl(`${baseUrl(env)}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${env.MASTODON_ACCESS_TOKEN}` },
    }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const data = await result.response.json();
  if (!data.id) return { ok: false, errorClass: 'AUTH_ERROR', message: 'verify_credentials response missing id' };
  return { ok: true, identifier: `@${data.username} (${baseUrl(env)}, id ${data.id})`, accountId: data.id, username: data.username };
}

/**
 * POST /api/v1/statuses with a real Idempotency-Key (Mastodon's own
 * documented mechanism — a retried request with the same key never creates
 * a second status). Deterministic per (text) so a retried publish of the
 * exact same draft is safe even across process restarts.
 */
export async function createStatus(text, { env = process.env, fetchImpl = fetch, retryOpts, idempotencyKey, visibility = 'public' } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing one of: ${REQUIRED_ENV_VARS.join(', ')}` };
  }
  const result = await requestWithRetry(
    () => fetchImpl(`${baseUrl(env)}/api/v1/statuses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.MASTODON_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey ?? randomUUID(),
      },
      body: JSON.stringify({ status: text, visibility }),
    }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const data = await result.response.json();
  if (!data.id) return { ok: false, errorClass: 'AUTH_ERROR', message: 'statuses response missing id' };
  return { ok: true, id: data.id, url: data.url };
}

export async function lookupExisting(text, { env = process.env, fetchImpl = fetch, limit = 20 } = {}) {
  const identity = await getIdentity({ env, fetchImpl });
  if (!identity.ok) return identity;
  const result = await requestWithRetry(
    () => fetchImpl(`${baseUrl(env)}/api/v1/accounts/${identity.accountId}/statuses?limit=${limit}`, {
      headers: { Authorization: `Bearer ${env.MASTODON_ACCESS_TOKEN}` },
    })
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const statuses = await result.response.json();
  const match = (Array.isArray(statuses) ? statuses : []).find((s) => (s.content ?? '').includes(text));
  return { ok: true, found: !!match, id: match?.id ?? null };
}

export function status(env = process.env) {
  return { channel, clientImplemented, authConfigured: isAuthConfigured(env) };
}

export async function publish(draft, { dryRun = true, env = process.env, fetchImpl = fetch, idempotencyKey } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, connectionRequired: true, channel };
  }
  const v = validate(draft);
  if (!v.ok) return { ok: false, error: v.error };
  if (dryRun) {
    return { ok: true, dryRun: true, channel, wouldPublish: draft.text };
  }
  const result = await createStatus(draft.text, { env, fetchImpl, idempotencyKey });
  if (!result.ok) return { ok: false, error: result.message ?? result.errorClass };
  return { ok: true, externalId: result.id, externalUrl: result.url };
}
