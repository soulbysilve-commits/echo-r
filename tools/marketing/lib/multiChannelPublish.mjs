// The one publish-decision pipeline every channel's publish attempt routes
// through — both the explicit, human/ops-triggered `channel-run` CLI command
// AND (for the first time, Bluesky specifically — see operator.mjs's
// runOnce()) the unattended daily scheduler. Mirrors runOnceInner's own
// safety logic (operator.mjs) exactly — evidence/policy gate, risk
// classification, LIVE-mode + kill-switch + per-channel-enable +
// GLOBAL-AND-per-channel pre-activation boundary, PLUS per-channel frequency
// guard and cross-channel stagger — so a new channel can never accidentally
// bypass a control an existing channel already enforces, and a channel with
// its own activation boundary (lib/activation.mjs's per-channel key) is
// never less strict than one relying on the global boundary alone.
import { checkContent, checkPolicyGate, classifyRisk, RISK_CLASS } from './policy.mjs';
import { recordIntent, markPublished, markFailed } from './ledger.mjs';
import { channelEnabled, channelEnvFlagName } from './channelFlags.mjs';
import { getActivationBoundary, isPreActivation } from './activation.mjs';
import { checkFrequencyGuard, checkStagger, checkCanonicalContentStagger } from './frequencyGuards.mjs';
import { getChannelState } from './channelState.mjs';
import { connectorModule } from '../connectors/registry.mjs';
import { idempotencyKey } from './publicationContract.mjs';

/**
 * Generates a draft for `channel` from `fact` via `draftFn`, runs it through
 * every existing safety gate, and either records it PENDING_HUMAN_APPROVAL
 * (HUMAN_APPROVAL_REQUIRED risk class — never publishes), records a
 * DRY_RUN_OK/BASELINE_SKIPPED/blocked-reason ledger entry (not LIVE), or
 * actually calls the real connector (only in MARKETING_MODE=LIVE, with the
 * global kill switch AND this channel's own enable flag AND a passed
 * frequency guard AND a passed stagger check AND not pre-activation
 * backlog). Never called from any scheduled/automatic path this pass.
 */
export async function publishToChannel(db, channel, fact, draftFn, {
  env = process.env, fetchImpl = fetch, eventId, canonicalContentId, canonicalUrl, draftArgs = [],
} = {}) {
  const draft = draftFn(fact, ...draftArgs);
  if (!draft) {
    return { status: 'NO_DRAFT', reason: 'draft generator declined (e.g. not technical substance for a long-form channel)' };
  }

  const text = draft.text ?? draft.long_text ?? draft.title;
  const contentCheck = checkContent({ text, factIds: draft.factIds, claimStrength: draft.claimStrength }, [fact]);
  const riskClass = classifyRisk(draft.actionType);
  const policyCheck = riskClass === RISK_CLASS.AUTO_WITH_POLICY ? checkPolicyGate({ text }) : { ok: true, violations: [] };
  if (!contentCheck.ok || !policyCheck.ok) {
    return { status: 'BLOCKED', violations: [...contentCheck.violations, ...policyCheck.violations] };
  }

  const commonLedgerFields = {
    channel, account: draft.subreddit ?? undefined, text, contentType: draft.actionType,
    sourceEvidence: (draft.factIds ?? []).join(','), eventId, canonicalContentId, canonicalUrl,
  };

  if (riskClass === RISK_CLASS.HUMAN_APPROVAL_REQUIRED) {
    const row = recordIntent(db, { ...commonLedgerFields, riskClass, approvalState: 'PENDING_HUMAN_APPROVAL' });
    return { status: 'PENDING_APPROVAL', publicationId: row.publication_id, draft };
  }

  const mode = process.env.MARKETING_MODE === 'LIVE' ? 'LIVE' : 'DRY_RUN';
  const automationEnabled = process.env.ECHO_MARKETING_AUTOMATION_ENABLED === 'true';
  const globalBoundary = getActivationBoundary(db);
  const channelBoundary = getActivationBoundary(db, channel);
  // Never a way to bypass the global boundary — a channel-specific boundary
  // (set at that channel's own activation time, e.g. Bluesky's) is an
  // ADDITIONAL, independent requirement on top of the global one, never a
  // replacement for it.
  const preActivation = isPreActivation(fact.VERIFIED_AT, globalBoundary) || isPreActivation(fact.VERIFIED_AT, channelBoundary);
  const enabled = channelEnabled(channel, env);

  const freqGuard = checkFrequencyGuard(db, channel, env);
  const stagger = checkStagger(db, eventId, channel);
  const canonicalStagger = checkCanonicalContentStagger(db, canonicalContentId, channel);
  // A configured credential is not a PROVEN one — real, unattended
  // publishing additionally requires a passed read-only auth-check (durable
  // channel_state.auth_valid, from lib/authCheck.mjs) AND a passed one-time
  // canary (channel_state.canary_passed, from lib/canary.mjs). Neither the
  // channel's own connector nor `env` presence alone ever satisfies this —
  // both must be real, durably-recorded, positive outcomes.
  const channelState = getChannelState(db, channel);
  const authValid = !!channelState.auth_valid;
  const canaryPassed = !!channelState.canary_passed;

  const liveAllowed = mode === 'LIVE' && automationEnabled && enabled && authValid && canaryPassed && !preActivation && freqGuard.ok && stagger.ok && canonicalStagger.ok;
  if (!liveAllowed) {
    const activeBoundary = isPreActivation(fact.VERIFIED_AT, channelBoundary) ? channelBoundary : globalBoundary;
    const reason = mode !== 'LIVE' ? 'DRY_RUN mode'
      : !automationEnabled ? 'global kill switch off'
      : !authValid ? 'AUTH_INVALID (no passed auth-check recorded for this channel)'
      : !canaryPassed ? 'CANARY_NOT_PASSED'
      : preActivation ? `pre-activation baseline (fact VERIFIED_AT ${fact.VERIFIED_AT ?? 'unknown'} predates the ${channel} live-not-before boundary ${activeBoundary})`
      : !enabled ? `channel not enabled (${channelEnvFlagName(channel) ?? 'no enable flag for this channel'}=false)`
      : !freqGuard.ok ? freqGuard.reason
      : !stagger.ok ? stagger.reason
      : canonicalStagger.reason;
    const status = mode === 'LIVE' && automationEnabled && enabled && authValid && canaryPassed && preActivation ? 'BASELINE_SKIPPED' : 'DRY_RUN_OK';
    const row = recordIntent(db, { ...commonLedgerFields, riskClass, approvalState: 'AUTO_APPROVED' });
    return { status, reason, publicationId: row.publication_id, draft };
  }

  const row = recordIntent(db, { ...commonLedgerFields, riskClass, approvalState: 'AUTO_APPROVED' });
  // Idempotency (mandate section 2: "the same content/event may never
  // accidentally publish twice") — recordIntent() already returns the
  // EXISTING row (by channel+content_hash) rather than inserting a new one
  // when this exact draft was seen before; if that existing row was already
  // published, this call must be a no-op, never a second real publish.
  if (row.published_at) {
    return { status: 'PUBLISHED', idempotent: true, publicationId: row.publication_id, externalId: row.external_id, externalUrl: row.external_url };
  }
  const mod = connectorModule(channel);
  if (!mod) {
    return { status: 'NO_CONNECTOR', reason: `no real connector for ${channel}`, publicationId: row.publication_id };
  }
  const key = idempotencyKey(channel, { content_id: canonicalContentId, event_id: eventId, title: draft.title, short_text: text });
  const result = await mod.publish(draft, { dryRun: false, env, fetchImpl, idempotencyKey: key });
  if (!result.ok) {
    markFailed(db, row.publication_id, result.error ?? 'unknown error');
    return { status: 'PUBLISH_FAILED', reason: result.error, publicationId: row.publication_id };
  }
  markPublished(db, row.publication_id, { externalId: result.externalId, externalUrl: result.externalUrl, result: 'OK' });
  return { status: 'PUBLISHED', publicationId: row.publication_id, externalId: result.externalId, externalUrl: result.externalUrl };
}
