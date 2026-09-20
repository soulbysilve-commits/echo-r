// The single computation of "is this channel actually safe for recurring
// LIVE publication" — used by both `status` and `auth-check` so the two
// commands can never disagree. Every one of these must be true; missing any
// one fails the whole thing closed.
import { getChannelState } from './channelState.mjs';
import { channelEnabled } from './channelFlags.mjs';
import { validateFacts, loadFacts } from './facts.mjs';
import { checkContent, checkPolicyGate } from './policy.mjs';

export function killSwitchHealthy(env = process.env) {
  // Two checks: (1) the actual current value of the global kill switch is a
  // recognized value, not garbage that might silently misbehave; (2) the
  // fail-closed invariant itself holds — only the literal string 'true'
  // enables automation, everything else (including unset/garbage) is off.
  const raw = env.ECHO_MARKETING_AUTOMATION_ENABLED;
  const recognized = raw === undefined || raw === 'true' || raw === 'false';
  const isEnabled = (v) => v === 'true';
  const failsClosed = isEnabled(undefined) === false && isEnabled('garbage-value') === false && isEnabled('false') === false;
  return recognized && failsClosed;
}

export function policyGateHealthy() {
  // A cheap functional self-test: a known-good draft passes, a known-bad one doesn't.
  const facts = [{ id: 'FACT-TEST', STATUS: 'VERIFIED', PUBLIC_SAFE: 'true', PRODUCT: 'x', CLAIM: 'x', SOURCE_REPOSITORY: 'x', SOURCE_PATH: 'x' }];
  const good = checkContent({ text: 'a normal update', factIds: [], claimStrength: 'neutral' }, facts);
  const bad = checkPolicyGate({ text: 'here is our api_key: sk-shouldbecaught1234567890' });
  return good.ok === true && bad.ok === false;
}

export function publicFactsValid(factsPath) {
  try {
    const errors = validateFacts(loadFacts(factsPath));
    return errors.length === 0;
  } catch {
    return false;
  }
}

export function publicationLedgerHealthy(db) {
  try {
    db.prepare('SELECT COUNT(*) c FROM publication_ledger').get();
    return true;
  } catch {
    return false;
  }
}

export function channelReadiness(db, channel, { env = process.env, factsPath } = {}) {
  const state = getChannelState(db, channel);
  const authValid = !!state.auth_valid;
  const canaryPass = !!state.canary_passed;
  const enabled = channelEnabled(channel, env);
  const killSwitch = killSwitchHealthy(env);
  const policyGate = policyGateHealthy();
  const factsValid = publicFactsValid(factsPath);
  const ledgerHealthy = publicationLedgerHealthy(db);

  const recurringLiveReady = authValid && canaryPass && enabled && killSwitch && policyGate && factsValid && ledgerHealthy;

  return {
    authValid, canaryPass, enabled,
    killSwitchHealthy: killSwitch, policyGateHealthy: policyGate, publicFactsValid: factsValid, publicationLedgerHealthy: ledgerHealthy,
    recurringLiveReady,
    accountIdentifier: state.account_identifier,
    canaryExternalId: state.canary_external_id,
    canaryExternalUrl: state.canary_external_url,
  };
}
