import test from 'node:test';
import assert from 'node:assert/strict';
import { authCheckGeneric, AUTH_STATE } from '../lib/authCheck.mjs';

function fakeMod({ authConfigured = true, identityResult, requiredEnvVars = ['SOME_TOKEN'] } = {}) {
  let publishCalled = false;
  return {
    mod: {
      isAuthConfigured: () => authConfigured,
      REQUIRED_ENV_VARS: requiredEnvVars,
      getIdentity: async () => identityResult,
      publish: async () => { publishCalled = true; throw new Error('publish() must never be called by auth-check'); },
    },
    wasPublishCalled: () => publishCalled,
  };
}

test('authCheckGeneric: no credentials configured -> AUTH_REQUIRED, never calls getIdentity', async () => {
  let getIdentityCalled = false;
  const mod = {
    isAuthConfigured: () => false,
    REQUIRED_ENV_VARS: ['FOO_TOKEN'],
    getIdentity: async () => { getIdentityCalled = true; return { ok: true }; },
  };
  const result = await authCheckGeneric('foo', mod, {});
  assert.equal(result.state, AUTH_STATE.AUTH_REQUIRED);
  assert.equal(getIdentityCalled, false);
  assert.equal(result.accountId, null);
});

test('authCheckGeneric: valid identity -> AUTH_VALID with real account info, distinct from any canary concept', async () => {
  const { mod } = fakeMod({ identityResult: { ok: true, identifier: '@someone', did: 'did:plc:abc' } });
  const result = await authCheckGeneric('bluesky', mod, {});
  assert.equal(result.state, AUTH_STATE.AUTH_VALID);
  assert.equal(result.accountId, 'did:plc:abc');
  assert.equal(result.accountName, '@someone');
  // authCheckGeneric's result shape has no canary-related field at all —
  // canary status is a completely separate, never-touched concept here.
  assert.ok(!('canaryPass' in result) && !('canary_passed' in result));
});

test('authCheckGeneric: AUTH_ERROR from the connector -> AUTH_INVALID (fails closed, never treated as valid)', async () => {
  const { mod } = fakeMod({ identityResult: { ok: false, errorClass: 'AUTH_ERROR', message: 'invalid token' } });
  const result = await authCheckGeneric('mastodon', mod, {});
  assert.equal(result.state, AUTH_STATE.AUTH_INVALID);
});

test('authCheckGeneric: a TRANSIENT/network-level error -> API_ERROR, NEVER AUTH_VALID and NEVER AUTH_INVALID', async () => {
  for (const errorClass of ['TRANSIENT', 'RATE_LIMITED', 'BAD_REQUEST', 'UNKNOWN']) {
    const { mod } = fakeMod({ identityResult: { ok: false, errorClass, message: 'oops' } });
    const result = await authCheckGeneric('devto', mod, {});
    assert.equal(result.state, AUTH_STATE.API_ERROR, `errorClass ${errorClass} must map to API_ERROR`);
  }
});

test('authCheckGeneric: a hung getIdentity() call times out and reports API_ERROR, never hangs the caller', async () => {
  const mod = {
    isAuthConfigured: () => true,
    REQUIRED_ENV_VARS: ['X'],
    getIdentity: () => new Promise(() => {}), // never resolves
  };
  const result = await authCheckGeneric('qiita', mod, { timeoutMs: 50 });
  assert.equal(result.state, AUTH_STATE.API_ERROR);
  assert.match(result.error, /timed out/);
});

test('authCheckGeneric: never calls publish() under any outcome', async () => {
  for (const identityResult of [{ ok: true, identifier: '@x' }, { ok: false, errorClass: 'AUTH_ERROR' }, { ok: false, errorClass: 'TRANSIENT' }]) {
    const { mod, wasPublishCalled } = fakeMod({ identityResult });
    await authCheckGeneric('bluesky', mod, {});
    assert.equal(wasPublishCalled(), false);
  }
});

test('authCheckGeneric: never receives or echoes back raw credential values — result only ever contains account identity, never a token', async () => {
  const SECRET = 'super-secret-app-password-xyz-123';
  const mod = {
    isAuthConfigured: () => true,
    REQUIRED_ENV_VARS: ['BLUESKY_APP_PASSWORD'],
    getIdentity: async ({ env }) => {
      // Simulate a real connector: it RECEIVES the secret to authenticate,
      // but must never put it in the returned identity object.
      assert.equal(env.BLUESKY_APP_PASSWORD, SECRET);
      return { ok: true, identifier: '@someone', did: 'did:plc:abc' };
    },
  };
  const result = await authCheckGeneric('bluesky', mod, { env: { BLUESKY_APP_PASSWORD: SECRET } });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(SECRET));
});

test('authCheckGeneric: is unaffected by MARKETING_<CHANNEL>_ENABLED — it never reads a channel-enable flag at all', async () => {
  const { mod } = fakeMod({ identityResult: { ok: true, identifier: '@someone' } });
  // Auth-check is called with only credential env vars, deliberately never
  // passing/consulting MARKETING_BLUESKY_ENABLED — proving the enable flag
  // plays no role in this function's own logic (it doesn't even accept a
  // channel-enabled parameter).
  const result = await authCheckGeneric('bluesky', mod, { env: { MARKETING_BLUESKY_ENABLED: 'false' } });
  assert.equal(result.state, AUTH_STATE.AUTH_VALID);
});
