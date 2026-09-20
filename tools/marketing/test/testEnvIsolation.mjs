// Shared test-only isolation seam (extracted from operator.test.mjs after an
// incident where this project's own production shell — real connector
// credentials + MARKETING_<CHANNEL>_ENABLED=true for whichever channels are
// actually live — caused runOnce()'s LIVE branch to attempt a real signed
// HTTP call during `node --test`, because operator.mjs reads credentials
// and enable flags straight off process.env and hands connectors[channel]
// .publish() no injected env/fetchImpl (unlike lib/multiChannelPublish.mjs,
// which already threads {env, fetchImpl} to the real connector).
//
// Any test in this suite that drives runOnce() (or anything else that can
// reach a real connector via bare process.env/global fetch) should use
// these two helpers so its result is the same whether launched from a
// clean shell or one with production secrets sourced into it. This is a
// test-local seam only — it does not change any production file.
import { allChannelNames, connectorModule, capabilityOnlyModule } from '../connectors/registry.mjs';
import { channelEnvFlagName } from '../lib/channelFlags.mjs';

const CREDENTIAL_ENV_VAR_NAMES = [...new Set(
  allChannelNames().flatMap((channel) => (connectorModule(channel) ?? capabilityOnlyModule(channel))?.REQUIRED_ENV_VARS ?? [])
)];

/**
 * Call once per test file, at module load (same spot as the ECHO_*_REPO_ROOT
 * stubs) — normalizes every known per-channel enable flag to unset. Each
 * test that wants a flag true still sets/restores its own value on top of
 * this clean baseline; this only removes ambient pollution, never a test's
 * own intent, since it runs before any test body does.
 */
export function normalizeChannelEnableFlags() {
  for (const channel of allChannelNames()) {
    const flag = channelEnvFlagName(channel);
    if (flag) delete process.env[flag];
  }
}

/**
 * Scrubs every real connector credential env var this project knows about
 * (derived from each connector module's own REQUIRED_ENV_VARS via the
 * registry, so a new channel is covered automatically) for the duration of
 * fn(), and installs a global fetch tripwire so any call that still escapes
 * throws UNEXPECTED_REAL_NETWORK_CALL_IN_TEST instead of silently reaching
 * a real API. Restores both in finally.
 */
export async function withIsolatedLiveEnv(fn) {
  const envSnapshot = Object.fromEntries(CREDENTIAL_ENV_VAR_NAMES.map((name) => [name, process.env[name]]));
  for (const name of CREDENTIAL_ENV_VAR_NAMES) delete process.env[name];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input?.url;
    throw new Error(`UNEXPECTED_REAL_NETWORK_CALL_IN_TEST: fetch(${url})`);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    for (const name of CREDENTIAL_ENV_VAR_NAMES) {
      if (envSnapshot[name] === undefined) delete process.env[name];
      else process.env[name] = envSnapshot[name];
    }
  }
}
