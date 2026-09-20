// Auth validation (mandate section 3). Each function makes the safest
// possible authenticated READ-ONLY request for that channel — never a post,
// never a write. Results are meant to be persisted via channelState.mjs so
// `status` never has to make a live network call.
import * as x from '../connectors/x.mjs';
import * as youtube from '../connectors/youtube.mjs';
import { classify } from '../connectors/registry.mjs';
import { withTimeout } from './limits.mjs';

/**
 * Write/upload permission is UNCONFIRMED_UNTIL_CANARY only until a real
 * canary write has actually succeeded — once durable channel_state.
 * canary_passed is true (see lib/channelState.mjs's recordCanary(), only
 * ever set from a real connector response), the permission is a confirmed
 * fact, not a re-derivation of the read-only auth-check's own
 * permissionsSufficient flag. Shared by both `auth-check x` and
 * `auth-check youtube` in cli.mjs — the same staleness bug (reporting
 * UNCONFIRMED_UNTIL_CANARY forever, even after a real canary post/upload
 * succeeded) affected both channels identically.
 */
export function writePermissionStatus({ permissionsSufficient, canaryPass }) {
  if (canaryPass) return true;
  return permissionsSufficient ? 'UNCONFIRMED_UNTIL_CANARY' : false;
}

export async function authCheckX({ env = process.env, fetchImpl } = {}) {
  const info = classify('x', env);
  if (!info.authConfigured) {
    return {
      clientImplemented: true, credentialsPresent: false, authValid: false,
      accountIdentifierSafe: null, accountId: null, accountHandle: null, permissionsSufficient: false,
    };
  }
  const me = await x.getMe({ env, fetchImpl });
  return {
    clientImplemented: true,
    credentialsPresent: true,
    authValid: me.ok,
    accountIdentifierSafe: me.ok ? `@${me.username} (id ${me.id})` : null,
    accountId: me.ok ? me.id : null,
    accountHandle: me.ok ? `@${me.username}` : null,
    // Best-effort: GET /2/users/me only proves the tokens are valid for
    // reading, not that they carry write scope — true write permission is
    // only actually confirmed by a successful canary post.
    permissionsSufficient: me.ok,
    error: me.ok ? undefined : (me.message ?? me.errorClass),
  };
}

export async function authCheckYoutube({ env = process.env, fetchImpl } = {}) {
  const info = classify('youtube', env);
  if (!info.authConfigured) {
    return {
      clientImplemented: true, credentialsPresent: false, authValid: false,
      accountIdentifierSafe: null, channelId: null, channelTitle: null, permissionsSufficient: false,
    };
  }

  // AUTH_VALID is defined as "the refresh token successfully produces an
  // access token from Google's own token endpoint" — a real, scope-independent
  // fact. This was NOT the original design: authCheckYoutube used to treat
  // channels.list?mine=true succeeding as the definition of "valid," which is
  // wrong for a token deliberately scoped to ONLY youtube.upload (the
  // minimum-scope request this project's credentials use) — Google returns
  // 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT for that read under upload-only
  // scope even though the token is perfectly valid for its actual purpose
  // (uploading). Found and fixed by actually running this against the real
  // credential, not assumed.
  const tokenResult = await youtube.getAccessToken({ env, fetchImpl });
  if (!tokenResult.ok) {
    return {
      clientImplemented: true, credentialsPresent: true, authValid: false,
      accountIdentifierSafe: null, channelId: null, channelTitle: null, permissionsSufficient: false,
      error: tokenResult.message ?? tokenResult.errorClass,
    };
  }

  // Channel identity is best-effort enrichment on top of a valid token — it
  // requires broader scope (youtube.readonly or youtube) than upload alone,
  // so its absence must never be reported as an invalid credential.
  const identity = await youtube.getMyChannel({ env, fetchImpl });
  return {
    clientImplemented: true,
    credentialsPresent: true,
    authValid: true,
    accountIdentifierSafe: identity.ok
      ? `${identity.channelTitle} (channel ${identity.channelId})`
      : 'unavailable under upload-only scope (token itself is valid)',
    channelId: identity.ok ? identity.channelId : null,
    channelTitle: identity.ok ? identity.channelTitle : null,
    // A valid access token that can upload is the actual permission that
    // matters; channels.list succeeding is neither necessary nor sufficient
    // proof of it — only a successful canary upload actually confirms it.
    permissionsSufficient: 'UNCONFIRMED_UNTIL_CANARY',
    error: identity.ok ? undefined : `channel lookup requires broader scope than youtube.upload alone (${identity.errorClass ?? identity.status ?? 'unknown'})`,
  };
}

export const AUTH_STATE = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_VALID: 'AUTH_VALID',
  AUTH_INVALID: 'AUTH_INVALID',
  API_ERROR: 'API_ERROR',
};

/**
 * Generic read-only auth-check for any connector exposing
 * isAuthConfigured(env)/getIdentity(opts) (multi-channel expansion: Bluesky,
 * Mastodon, DEV.to, Qiita — same real read-only-identity-call pattern
 * authCheckX/authCheckYoutube already established, generalized once rather
 * than duplicated per channel). Never posts, never drafts, never mutates the
 * publication ledger — the one write this makes is the OPTIONAL durable
 * auth-audit record (channel_state), and only for the two states that are
 * genuinely durable facts (AUTH_VALID / AUTH_INVALID) — a transient
 * API_ERROR must never overwrite a previously-recorded valid/invalid state
 * with a guess (mandate: "network/API error does not become AUTH_VALID" —
 * equally, it must never become a false AUTH_INVALID either). Bounded by
 * `timeoutMs` so a hung network call can never block a caller indefinitely.
 */
export async function authCheckGeneric(channel, mod, { env = process.env, fetchImpl, timeoutMs = 10_000 } = {}) {
  if (!mod.isAuthConfigured(env)) {
    return { channel, state: AUTH_STATE.AUTH_REQUIRED, accountId: null, accountName: null, error: `missing ${mod.REQUIRED_ENV_VARS?.join(' / ') ?? 'credentials'}` };
  }
  let identity;
  try {
    identity = await withTimeout(mod.getIdentity({ env, fetchImpl }), timeoutMs, `authCheck(${channel})`);
  } catch (err) {
    if (err?.name === 'RunDurationExceededError') {
      return { channel, state: AUTH_STATE.API_ERROR, accountId: null, accountName: null, error: `timed out after ${timeoutMs}ms` };
    }
    throw err;
  }
  if (identity.ok) {
    return { channel, state: AUTH_STATE.AUTH_VALID, accountId: identity.did ?? identity.accountId ?? identity.username ?? null, accountName: identity.identifier ?? null };
  }
  // AUTH_ERROR (401/403 — genuinely rejected credentials) is the only
  // errorClass that becomes AUTH_INVALID; every other failure mode
  // (TRANSIENT/RATE_LIMITED/BAD_REQUEST/UNKNOWN/network-level throw) is an
  // API_ERROR — a real distinction, not a formality: an API_ERROR must
  // never be treated as proof the credentials themselves are bad.
  const state = identity.errorClass === 'AUTH_ERROR' ? AUTH_STATE.AUTH_INVALID : AUTH_STATE.API_ERROR;
  return { channel, state, accountId: null, accountName: null, error: identity.message ?? identity.errorClass };
}

export const AUTH_CHECKERS = { x: authCheckX, youtube: authCheckYoutube };
export const GENERIC_AUTH_CHECK_CHANNELS = ['bluesky', 'mastodon', 'devto', 'qiita'];
