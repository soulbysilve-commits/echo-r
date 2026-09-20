// Hashnode capability-detection connector (mandate section 8: "Implement
// capability detection only initially"). Uses the real official GraphQL API
// (https://gql.hashnode.com) — never a guessed/fabricated schema. Detects
// auth validity and whether the account's GraphQL schema actually exposes
// the publishPost mutation (some plans/setups don't) via real introspection,
// never assumed. publish() intentionally stays a stub that refuses (never a
// live post) until a future pass explicitly builds it, once READY is
// confirmed against a real account — mechanism stays honest either way.
import { requestWithRetry } from './http.mjs';

const API_URL = 'https://gql.hashnode.com';

export const channel = 'hashnode';
export const clientImplemented = 'CAPABILITY_DETECTION_ONLY';
export const REQUIRED_ENV_VARS = ['HASHNODE_API_KEY'];

export const CAPABILITY_STATE = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  PLAN_REQUIRED: 'PLAN_REQUIRED',
  READY: 'READY',
  DISABLED: 'DISABLED',
};

export function isAuthConfigured(env = process.env) {
  return !!env.HASHNODE_API_KEY;
}

export function capabilities() {
  return { text: false, longform: true, links: true, images: true, video: false, tags: true, canonicalUrl: true, publishMutation: 'publishPost' };
}

async function graphql(query, { env, fetchImpl, retryOpts } = {}) {
  return requestWithRetry(
    () => fetchImpl(API_URL, {
      method: 'POST',
      headers: { Authorization: env.HASHNODE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    }),
    retryOpts
  );
}

/**
 * Real capability discovery — never assumes READY merely because a key is
 * present. Two independent real GraphQL calls: (1) `me { id }` for auth
 * validity, (2) schema introspection for whether `publishPost` is actually
 * exposed as a Mutation field on this account's API surface (Hashnode gates
 * some mutations by plan/account type — this is the one honest way to
 * detect that without guessing).
 */
export async function detectCapability({ env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  if (!isAuthConfigured(env)) {
    return { state: CAPABILITY_STATE.AUTH_REQUIRED, reason: `missing ${REQUIRED_ENV_VARS[0]}` };
  }
  const meResult = await graphql('query { me { id username } }', { env, fetchImpl, retryOpts });
  if (!meResult.ok) return { state: CAPABILITY_STATE.AUTH_REQUIRED, reason: `auth check failed: ${meResult.errorClass}` };
  const meData = await meResult.response.json();
  if (meData.errors || !meData.data?.me?.id) {
    return { state: CAPABILITY_STATE.AUTH_REQUIRED, reason: meData.errors ? JSON.stringify(meData.errors) : 'no me.id in response' };
  }

  const introspection = await graphql(
    'query { __type(name: "Mutation") { fields { name } } }',
    { env, fetchImpl, retryOpts }
  );
  if (!introspection.ok) {
    return { state: CAPABILITY_STATE.PLAN_REQUIRED, reason: `introspection unavailable: ${introspection.errorClass}`, identifier: meData.data.me.username };
  }
  const introspectionData = await introspection.response.json();
  const fields = introspectionData?.data?.__type?.fields ?? [];
  const hasPublishPost = fields.some((f) => f.name === 'publishPost');
  if (!hasPublishPost) {
    return { state: CAPABILITY_STATE.PLAN_REQUIRED, reason: 'publishPost mutation not exposed on this account/schema', identifier: meData.data.me.username };
  }
  return { state: CAPABILITY_STATE.READY, identifier: meData.data.me.username };
}

export async function getIdentity(opts = {}) {
  const cap = await detectCapability(opts);
  if (cap.state !== CAPABILITY_STATE.READY && cap.state !== CAPABILITY_STATE.PLAN_REQUIRED) {
    return { ok: false, errorClass: cap.state, message: cap.reason };
  }
  return { ok: true, identifier: cap.identifier };
}

export function status(env = process.env) {
  return { channel, clientImplemented, authConfigured: isAuthConfigured(env) };
}

// Deliberately not yet real (mandate: "Implement capability detection only
// initially") — refuses rather than fabricating a publish, even in DRY_RUN,
// so this channel can never be silently mistaken for one that has been
// through a real end-to-end test.
export async function publish() {
  return { ok: false, error: 'hashnode publish() is not implemented yet — capability detection only this pass', notImplemented: true };
}
