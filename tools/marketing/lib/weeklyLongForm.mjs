// Weekly long-form operator support (DEV.to / Qiita only): a genuinely
// separate capability from the daily operator's own devto/qiita cycles
// (tools/marketing/operator.mjs's runDevToCycle/runQiitaCycle), which each
// select and publish ONE fact's worth of article per day. This module
// instead selects a COHERENT SET of several verified facts (same product,
// all technical, all currently eligible) and drafts ONE substantive
// article covering all of them -- "this week's roundup," not "today's
// single fact," and explicitly refuses to draft anything when there isn't
// enough real material (mandate: "publish nothing when there is
// insufficient technical substance").
//
// Every actual safety decision below is made by calling the SAME shared
// primitives the daily operator's own publishToChannel() (lib/
// multiChannelPublish.mjs) already uses, unchanged and unduplicated:
// lib/candidateSelection.mjs's isPermanentlyIneligibleForChannel() (pre-
// activation / already-published exclusion), lib/crossChannelDraft.mjs's
// isTechnicalSubstance(), lib/policy.mjs's checkContent/checkPolicyGate/
// classifyRisk (already natively multi-factId-capable -- no change needed
// there), lib/activation.mjs's getActivationBoundary/isPreActivation, lib/
// frequencyGuards.mjs's checkFrequencyGuard (the SAME shared per-channel
// weekly cap the daily cycle's own devto/qiita articles already count
// against, so this operator can never let combined daily+weekly output
// exceed the one real cap) and checkCanonicalContentStagger, lib/
// channelState.mjs's getChannelState, lib/channelFlags.mjs's
// channelEnabled, lib/ledger.mjs's recordIntent/markPublished/markFailed
// (the SAME publication_ledger, same content-hash idempotency), and the
// SAME connectors/registry.mjs connector modules. publishToChannel() /
// operator.mjs itself are never modified or duplicated -- this is a
// parallel orchestration function only because its input shape (a fact
// SET, not a single fact) genuinely differs, not a second copy of any gate
// logic.
//
// Idempotency: deliberately reuses the EXISTING content-hash-keyed ledger
// idempotency (lib/ledger.mjs's recordIntent/findExisting) rather than
// inventing a second "weekly run key" table -- the same deterministic fact
// set, selected from the same DB state, always drafts the same article
// text, which always hashes to the same ledger row. Overlap with a
// concurrent daily run is prevented by reusing the SAME single-slot
// operator_lock the daily operator uses (see weeklyOperator.mjs), not a
// second parallel lock.
import { createHash } from 'node:crypto';
import { isPermanentlyIneligibleForChannel } from './candidateSelection.mjs';
import { isTechnicalSubstance } from './crossChannelDraft.mjs';
import { checkContent, checkPolicyGate, classifyRisk, RISK_CLASS } from './policy.mjs';
import { getActivationBoundary, isPreActivation } from './activation.mjs';
import { checkFrequencyGuard, checkCanonicalContentStagger } from './frequencyGuards.mjs';
import { getChannelState } from './channelState.mjs';
import { channelEnabled, channelEnvFlagName } from './channelFlags.mjs';
import { recordIntent, markPublished, markFailed } from './ledger.mjs';
import { connectorModule } from '../connectors/registry.mjs';
import { idempotencyKey } from './publicationContract.mjs';

export const MIN_WEEKLY_FACTS = 2;
export const MAX_WEEKLY_FACTS = 5;

/**
 * A coherent SET of currently-eligible, genuinely-technical facts sharing
 * the same PRODUCT as the highest-ranked eligible candidate -- never an
 * arbitrary bag of unrelated facts, and never fewer than MIN_WEEKLY_FACTS
 * (mandate: "select a coherent SET of verified facts suitable for one
 * substantive technical article, not merely the highest single fact").
 * Returns null (NOOP) when there isn't enough real material -- this is the
 * ONLY place that decides "not enough substance," and it is a hard
 * requirement, not a soft preference: no filler article is ever drafted
 * merely because the timer fired.
 *
 * Reuses isPermanentlyIneligibleForChannel() unchanged for exactly the
 * same PRE_ACTIVATION / ALREADY_PUBLISHED exclusion the daily operator's
 * own candidate selection already applies per fact -- a fact that is
 * historical for this channel can never be smuggled into a "new" weekly
 * article just because it's bundled alongside a newer one.
 */
export function selectWeeklyFactSet(db, channel, ranked, {
  alreadyPublished, minFacts = MIN_WEEKLY_FACTS, maxFacts = MAX_WEEKLY_FACTS,
} = {}) {
  const eligible = ranked
    .map((r) => r.fact)
    .filter((fact) => !isPermanentlyIneligibleForChannel(db, channel, fact, { alreadyPublished }).blocked)
    .filter((fact) => isTechnicalSubstance(fact));

  if (eligible.length < minFacts) return null;

  const anchorProduct = eligible[0].PRODUCT;
  const coherent = eligible.filter((fact) => fact.PRODUCT === anchorProduct).slice(0, maxFacts);

  if (coherent.length < minFacts) return null;

  return coherent;
}

function sectionEn(fact, index) {
  const notes = fact.NOTES ? `\n\n_Notes: ${fact.NOTES}_` : '';
  return `## ${index + 1}. ${fact.CLAIM.split('.')[0]}\n\n${fact.CLAIM}\n\n**Verification:** ${fact.SOURCE_EVIDENCE ?? ''}\n\nSource: \`${fact.SOURCE_REPOSITORY}/${fact.SOURCE_PATH}\`${notes}`;
}

function sectionJa(fact, index) {
  const notes = fact.NOTES ? `\n\n_補足: ${fact.NOTES}_` : '';
  return `## ${index + 1}. ${fact.CLAIM.split('.')[0]}\n\n${fact.CLAIM}\n\n**検証内容:** ${fact.SOURCE_EVIDENCE ?? ''}\n\n出典: \`${fact.SOURCE_REPOSITORY}/${fact.SOURCE_PATH}\`${notes}`;
}

/**
 * DEV.to weekly roundup — English, channel-native long-form. Refuses
 * (returns null, NO_DRAFT) unless every fact in the set is genuinely
 * technical and the set meets MIN_WEEKLY_FACTS, exactly mirroring
 * draftDevToArticle()'s own single-fact isTechnicalSubstance() gate.
 */
export function draftWeeklyDevToArticle(factSet, { canonicalUrl } = {}) {
  if (!factSet || factSet.length < MIN_WEEKLY_FACTS || !factSet.every(isTechnicalSubstance)) return null;
  const product = factSet[0].PRODUCT;
  const allVerified = factSet.every((f) => f.STATUS === 'VERIFIED');
  return {
    channel: 'devto',
    title: `${product}: weekly engineering notes (${factSet.length} verified updates)`,
    long_text: factSet.map(sectionEn).join('\n\n'),
    short_text: factSet.map((f) => f.CLAIM).join(' '),
    tags: ['ai', 'architecture'],
    canonical_url: canonicalUrl,
    factIds: factSet.map((f) => f.id),
    claimStrength: allVerified ? 'shipped' : 'planned',
    actionType: 'devto_article',
  };
}

/**
 * Qiita weekly roundup — Japanese, channel-native long-form (NOT a
 * translation of the DEV.to copy — mandate: "DEV.to and Qiita may receive
 * channel-native versions, not necessarily identical copy").
 */
export function draftWeeklyQiitaArticle(factSet, { canonicalUrl } = {}) {
  if (!factSet || factSet.length < MIN_WEEKLY_FACTS || !factSet.every(isTechnicalSubstance)) return null;
  const product = factSet[0].PRODUCT;
  const allVerified = factSet.every((f) => f.STATUS === 'VERIFIED');
  return {
    channel: 'qiita',
    title: `${product}の週次エンジニアリングまとめ（検証済み更新${factSet.length}件）`,
    long_text: factSet.map(sectionJa).join('\n\n'),
    tags: ['AI', 'アーキテクチャ'],
    canonical_url: canonicalUrl,
    factIds: factSet.map((f) => f.id),
    claimStrength: allVerified ? 'shipped' : 'planned',
    actionType: 'qiita_article',
  };
}

/** Deterministic per-fact-set content id, for checkCanonicalContentStagger. */
function weeklyCanonicalContentId(factSet) {
  const key = factSet.map((f) => f.id).slice().sort().join(',');
  return `weekly:${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 24)}`;
}

/**
 * The weekly counterpart of lib/multiChannelPublish.mjs's
 * publishToChannel() — same gate sequence, same status vocabulary
 * (DRY_RUN_OK / BASELINE_SKIPPED / BLOCKED / PUBLISHED / PUBLISH_FAILED /
 * NO_CONNECTOR / NO_DRAFT), same ledger conventions, every real decision
 * delegated to the exact same shared primitives — adapted only because
 * pre-activation must be evaluated across the WHOLE fact set (every fact
 * must be post-activation, not just one) and there is no single
 * eventId/cross-channel-burst concept for a multi-fact article (only the
 * canonical-content stagger applies, keyed on a deterministic hash of the
 * fact set).
 */
export async function publishWeeklyLongForm(db, channel, factSet, draftFn, {
  env = process.env, fetchImpl = fetch, canonicalUrl,
} = {}) {
  const draft = draftFn(factSet, { canonicalUrl });
  if (!draft) {
    return { status: 'NO_DRAFT', reason: 'insufficient technical substance for a coherent weekly article' };
  }

  const text = draft.long_text ?? draft.text ?? draft.title;
  const contentCheck = checkContent({ text, factIds: draft.factIds, claimStrength: draft.claimStrength }, factSet);
  const riskClass = classifyRisk(draft.actionType);
  const policyCheck = riskClass === RISK_CLASS.AUTO_WITH_POLICY ? checkPolicyGate({ text }) : { ok: true, violations: [] };
  if (!contentCheck.ok || !policyCheck.ok) {
    return { status: 'BLOCKED', violations: [...contentCheck.violations, ...policyCheck.violations] };
  }

  const canonicalContentId = weeklyCanonicalContentId(factSet);
  const commonLedgerFields = {
    channel, text, contentType: draft.actionType,
    sourceEvidence: draft.factIds.join(','), canonicalContentId, canonicalUrl,
  };

  const globalBoundary = getActivationBoundary(db);
  const channelBoundary = getActivationBoundary(db, channel);
  // Every fact in the set must independently clear activation — a single
  // historical fact bundled with newer ones must never launder the whole
  // article into "post-activation."
  const preActivation = factSet.some(
    (fact) => isPreActivation(fact.VERIFIED_AT, globalBoundary) || isPreActivation(fact.VERIFIED_AT, channelBoundary)
  );
  const enabled = channelEnabled(channel, env);
  const freqGuard = checkFrequencyGuard(db, channel, env);
  const canonicalStagger = checkCanonicalContentStagger(db, canonicalContentId, channel);
  const channelState = getChannelState(db, channel);
  const authValid = !!channelState.auth_valid;
  const canaryPassed = !!channelState.canary_passed;

  // Deliberately process.env, not the `env` parameter — same trusted-mode-
  // source pattern lib/multiChannelPublish.mjs's publishToChannel() already
  // uses: MARKETING_MODE/ECHO_MARKETING_AUTOMATION_ENABLED must come from
  // the real trusted parent process env (protected by run-marketing-
  // operator.sh's PROTECTED_ENV_VARS snapshot/restore), never from a
  // caller-supplied `env` object a test or .env.local could override.
  const mode = process.env.MARKETING_MODE === 'LIVE' ? 'LIVE' : 'DRY_RUN';
  const automationEnabled = process.env.ECHO_MARKETING_AUTOMATION_ENABLED === 'true';

  const liveAllowed = mode === 'LIVE' && automationEnabled && enabled && authValid && canaryPassed
    && !preActivation && freqGuard.ok && canonicalStagger.ok;

  if (!liveAllowed) {
    const reason = mode !== 'LIVE' ? 'DRY_RUN mode'
      : !automationEnabled ? 'global kill switch off'
      : !authValid ? 'AUTH_INVALID (no passed auth-check recorded for this channel)'
      : !canaryPassed ? 'CANARY_NOT_PASSED'
      : preActivation ? 'pre-activation baseline (one or more facts in this weekly set predate the activation boundary)'
      : !enabled ? `channel not enabled (${channelEnvFlagName(channel) ?? 'no enable flag for this channel'}=false)`
      : !freqGuard.ok ? freqGuard.reason
      : canonicalStagger.reason;
    const status = mode === 'LIVE' && automationEnabled && enabled && authValid && canaryPassed && preActivation ? 'BASELINE_SKIPPED' : 'DRY_RUN_OK';
    const row = recordIntent(db, { ...commonLedgerFields, riskClass, approvalState: 'AUTO_APPROVED' });
    return { status, reason, publicationId: row.publication_id, draft };
  }

  const row = recordIntent(db, { ...commonLedgerFields, riskClass, approvalState: 'AUTO_APPROVED' });
  if (row.published_at) {
    return { status: 'PUBLISHED', idempotent: true, publicationId: row.publication_id, externalId: row.external_id, externalUrl: row.external_url };
  }
  const mod = connectorModule(channel);
  if (!mod) {
    return { status: 'NO_CONNECTOR', reason: `no real connector for ${channel}`, publicationId: row.publication_id };
  }
  const key = idempotencyKey(channel, { content_id: canonicalContentId, title: draft.title, long_text: text });
  const result = await mod.publish(draft, { dryRun: false, env, fetchImpl, idempotencyKey: key });
  if (!result.ok) {
    markFailed(db, row.publication_id, result.error ?? 'unknown error');
    return { status: 'PUBLISH_FAILED', reason: result.error, publicationId: row.publication_id };
  }
  markPublished(db, row.publication_id, { externalId: result.externalId, externalUrl: result.externalUrl, result: 'OK' });
  return { status: 'PUBLISHED', publicationId: row.publication_id, externalId: result.externalId, externalUrl: result.externalUrl };
}
