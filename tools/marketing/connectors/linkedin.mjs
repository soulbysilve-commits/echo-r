// LinkedIn capability/auth-discovery connector (mandate section 9). Never
// browser-automates LinkedIn as a fallback — if approved API access isn't
// present, this channel simply stays not-ready, honestly. Uses LinkedIn's
// real OpenID Connect userinfo endpoint (part of "Sign In with LinkedIn",
// broadly available) for identity, and requires an explicit configured
// organization URN before ever claiming organization-post readiness (that
// part of the API needs a separately approved product — no generic
// "discover my permissions" endpoint exists, so this is honest about what
// it can and can't verify, rather than guessing).
import { requestWithRetry } from './http.mjs';

const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';

export const channel = 'linkedin';
export const clientImplemented = 'CAPABILITY_DETECTION_ONLY';
export const REQUIRED_ENV_VARS = ['LINKEDIN_ACCESS_TOKEN'];

export const CAPABILITY_STATE = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  API_APPROVAL_REQUIRED: 'API_APPROVAL_REQUIRED',
  READY: 'READY',
  DISABLED: 'DISABLED',
};

export function isAuthConfigured(env = process.env) {
  return !!env.LINKEDIN_ACCESS_TOKEN;
}

export function capabilities() {
  return { text: true, longform: false, links: true, images: true, video: false, organizationPosts: true };
}

/**
 * Real capability discovery. Token validity is confirmed via the real
 * userinfo endpoint; organization-post readiness additionally requires an
 * explicitly configured organization URN (LINKEDIN_ORGANIZATION_URN) —
 * there is no generic "list my approved products" endpoint to introspect,
 * so this never claims READY without that explicit operator-provided
 * confirmation on top of a valid token.
 */
export async function detectCapability({ env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  if (!isAuthConfigured(env)) {
    return { state: CAPABILITY_STATE.AUTH_REQUIRED, reason: `missing ${REQUIRED_ENV_VARS[0]}` };
  }
  const result = await requestWithRetry(
    () => fetchImpl(USERINFO_URL, { headers: { Authorization: `Bearer ${env.LINKEDIN_ACCESS_TOKEN}` } }),
    retryOpts
  );
  if (!result.ok) {
    return { state: CAPABILITY_STATE.AUTH_REQUIRED, reason: `token invalid or insufficient scope: ${result.errorClass}` };
  }
  const data = await result.response.json();
  if (!data.sub) {
    return { state: CAPABILITY_STATE.AUTH_REQUIRED, reason: 'userinfo response missing sub' };
  }
  if (!env.LINKEDIN_ORGANIZATION_URN) {
    return { state: CAPABILITY_STATE.API_APPROVAL_REQUIRED, reason: 'no LINKEDIN_ORGANIZATION_URN configured — organic company/page posting requires separately approved API access plus an explicit target organization', identifier: data.name ?? data.sub };
  }
  return { state: CAPABILITY_STATE.READY, identifier: data.name ?? data.sub, organizationUrn: env.LINKEDIN_ORGANIZATION_URN };
}

export async function getIdentity(opts = {}) {
  const cap = await detectCapability(opts);
  if (cap.state !== CAPABILITY_STATE.READY && cap.state !== CAPABILITY_STATE.API_APPROVAL_REQUIRED) {
    return { ok: false, errorClass: cap.state, message: cap.reason };
  }
  return { ok: true, identifier: cap.identifier };
}

export function status(env = process.env) {
  return { channel, clientImplemented, authConfigured: isAuthConfigured(env) };
}

// Never a browser-automation fallback (explicit hard rule) — refuses until
// real, approved organization-post API access is built and verified.
export async function publish() {
  return { ok: false, error: 'linkedin publish() is not implemented yet — capability detection only this pass', notImplemented: true };
}
