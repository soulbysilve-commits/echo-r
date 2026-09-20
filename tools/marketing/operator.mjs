import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, closeDb } from './lib/db.mjs';
import { acquireLock, releaseLock } from './lib/lock.mjs';
import { loadFacts, validateFacts } from './lib/facts.mjs';
import { rankFacts } from './lib/scoring.mjs';
import { draftXPostEn } from './lib/draft.mjs';
import { checkContent, checkPolicyGate, classifyRisk, RISK_CLASS } from './lib/policy.mjs';
import { recordIntent, markPublished, markFailed, todaysPublications } from './lib/ledger.mjs';
import { connectors, connectionStatus } from './connectors/index.mjs';
import { classifyAll } from './connectors/registry.mjs';
import { getLimits, withTimeout, isNestedInvocation, checkDiskGuard } from './lib/limits.mjs';
import { ensureEventsSchema, unprocessedEvents } from './lib/events.mjs';
import { ensureLearningSchema, strategyHistory } from './lib/learning.mjs';
import { ensureExperimentsSchema, listExperiments } from './lib/experiments.mjs';
import { ensureMarketSchema, listMarketEntries } from './lib/market.mjs';
import { statePath } from './lib/paths.mjs';
import { channelEnabled, channelEnvFlagName } from './lib/channelFlags.mjs';
import { channelReadiness } from './lib/channelReadiness.mjs';
import { latestDemoRun, ymm4DemoAllowed, reviewQueue, isRenderLockAvailable } from './lib/videoPipeline.mjs';
import { getYmm4ProcessState } from './lib/ymm4Health.mjs';
import { computeAutonomousRenderReadiness, checkIdleTemplateClean, DEFAULT_MARKETING_IDLE_TEMPLATE } from './lib/ymm4IdleTemplate.mjs';
import { buildChannelStatus, allExpansionChannelNames } from './lib/channelStatusReport.mjs';
import { channelPolicy, CHANNEL_CLASS, MODE } from './lib/channelPolicy.mjs';
import { selectBestCandidate, minVideoScore } from './lib/videoCandidates.mjs';
import { runDailyVideoStage, autoVideosToday, DEFAULT_RENDER_OUTPUT_DIR } from './lib/videoAutomation.mjs';
import { adapters as sourceAdapterList } from './sourceAdapters/index.mjs';
import { scanAllSources } from './lib/sourceIngestion.mjs';
import { allSourceHealth } from './lib/sourceHealth.mjs';
import { toWslPath } from './lib/winPath.mjs';
import * as youtubeConnector from './connectors/youtube.mjs';
import { getActivationBoundary, isPreActivation } from './lib/activation.mjs';
import { publishToChannel } from './lib/multiChannelPublish.mjs';
import { draftBlueskyPost, draftMastodonPost, draftDevToArticle, draftQiitaArticle } from './lib/crossChannelDraft.mjs';
import { getChannelState } from './lib/channelState.mjs';
import { checkFrequencyGuard, checkStagger } from './lib/frequencyGuards.mjs';
import { observeAllDevRepos, devRepoConfigs, devObserverStatus } from './lib/devObserver.mjs';
import { factPromotionStatus, loadCanonicalFacts } from './lib/factPromotion.mjs';
import { selectCandidateForChannel } from './lib/candidateSelection.mjs';

// Lives outside any git worktree (see lib/paths.mjs) — the ledger, memory,
// run lock, strategy/experiment history, and market cache all persist here
// so deleting/recreating this worktree, or eventually reconciling this
// branch into main, never loses operational history.
export const DB_PATH = process.env.MARKETING_DB_PATH || statePath('marketing.db');
export const FACTS_PATH = new URL('../../docs/marketing/VERITAS_FORGE_PUBLIC_FACTS.md', import.meta.url).pathname;

export function getMode() {
  return process.env.MARKETING_MODE === 'LIVE' ? 'LIVE' : 'DRY_RUN';
}

export function automationEnabled() {
  return process.env.ECHO_MARKETING_AUTOMATION_ENABLED === 'true';
}

function log(runId, msg) {
  console.log(`[marketing:${runId}] ${msg}`);
}

/**
 * One full observe -> select -> draft -> policy -> publish -> ledger cycle,
 * PLUS (mandate section 12) the automatic video pipeline's daily attempt —
 * candidate selection through private upload, capped at
 * MAX_AUTO_VIDEOS_PER_DAY. The two stages run with independent timeout
 * budgets (MAX_RUN_DURATION_MS for the text-content cycle,
 * MAX_VIDEO_PIPELINE_RUNTIME_MS inside runDailyVideoStage for the video
 * cycle — the video budget is deliberately longer than a text-post cycle
 * ever needs, so nesting it inside the same MAX_RUN_DURATION_MS window
 * would truncate a legitimate render well before its own bound). A slow or
 * failed video cycle never blocks or corrupts the text-content result —
 * both run to completion (or their own timeout) and are merged into one
 * return value under separate keys.
 *
 * Safe to call repeatedly and concurrently: the operator lock ensures only
 * one text-content run proceeds, the render lock (inside the video stage)
 * does the same for renders, and the ledger's unique(channel, content_hash)
 * / demo_runs' youtube_video_id idempotency make publication safe even if a
 * run crashes mid-cycle and is simply re-invoked (mandate section 18:
 * "idempotent scheduled rerun").
 */
export async function runOnce(opts = {}) {
  const env = opts.env ?? process.env;
  if (isNestedInvocation(env)) {
    return { status: 'RECURSION_BLOCKED' };
  }
  const limits = getLimits(env);
  const dbPath = opts.dbPath ?? DB_PATH;

  // Pre-LIVE hardening: ONE lock protects the entire canonical operator run
  // (text/X + video + bluesky + mastodon + devto + qiita) — not merely the
  // legacy X portion. Before this, runOnceInner() acquired/released this
  // same operator_lock row entirely on its own, independently of every
  // cycle below it, so two concurrent invocations of this function could
  // still run the newer per-channel cycles fully in parallel with no
  // mutual exclusion at all (only X's own slice was ever protected).
  // systemd's own flock (scripts/run-marketing-operator.sh) already
  // prevents overlap for the one production trigger path; this is the
  // in-process backstop for any other invocation (manual CLI, a future
  // second scheduler) — same STALE_MS-bounded stale-lock recovery as
  // before (lib/lock.mjs, unchanged), and independent of the video
  // pipeline's own separate render_lock (a different table/resource, never
  // acquired here, so there is no cross-lock ordering to deadlock on).
  const lockDb = openDb(dbPath);
  const lockRunId = randomUUID();
  const lock = acquireLock(lockDb, lockRunId);
  if (!lock.acquired) {
    closeDb(lockDb);
    return { status: 'SKIP_OVERLAP', holder: lock.holder };
  }

  try {
    const textResult = await withTimeout(runOnceInner(opts), limits.MAX_RUN_DURATION_MS, 'runOnce').catch((err) => {
      if (err?.name === 'RunDurationExceededError') {
        return { status: 'TIMEOUT', message: err.message };
      }
      throw err;
    });

    const video = await runDailyVideoCycle(opts);
    const bluesky = await runBlueskyCycle(opts).catch((err) => ({ status: 'ERROR', message: String(err?.message ?? err) }));
    const mastodon = await runMastodonCycle(opts).catch((err) => ({ status: 'ERROR', message: String(err?.message ?? err) }));
    const devto = await runDevToCycle(opts).catch((err) => ({ status: 'ERROR', message: String(err?.message ?? err) }));
    const qiita = await runQiitaCycle(opts).catch((err) => ({ status: 'ERROR', message: String(err?.message ?? err) }));
    return { ...textResult, video, bluesky, mastodon, devto, qiita };
  } finally {
    releaseLock(lockDb, lockRunId);
    closeDb(lockDb);
  }
}

/**
 * Multi-channel expansion — Bluesky wired into the SAME existing daily
 * operator path `runOnce()` already runs (mandate: "use the existing
 * unattended daily/operator path... do not create another scheduler"),
 * structurally identical in shape to runDailyVideoCycle above: its own
 * db open/close, its own candidate selection, merged into runOnce()'s
 * return value under its own key. Deliberately NOT reusing
 * runOnceInner()'s `alreadyPublished()` (channel-agnostic — it would
 * wrongly treat a fact X already posted about as covered for every OTHER
 * channel too, defeating cross-channel distribution);
 * `alreadyPublishedByChannel()` below is the channel-scoped equivalent.
 * Candidate selection itself goes through lib/candidateSelection.mjs's
 * selectCandidateForChannel(), which skips past a fact only when it is
 * PERMANENTLY ineligible for this channel (pre-activation, or already
 * truly published) — never merely because some earlier attempt recorded a
 * ledger row for a TEMPORARY reason (frequency cap, stagger, DRY_RUN mode,
 * auth/canary not ready), which must remain retryable next cycle. Every
 * actual safety
 * decision (evidence/policy/risk-class/LIVE-mode/kill-switch/enable-flag/
 * activation-boundary/frequency-guard/stagger) is STILL made by
 * lib/multiChannelPublish.mjs's publishToChannel() — this function only
 * selects a candidate and calls it, same division of responsibility
 * runOnceInner already has relative to its own connector.publish() call.
 */
async function runBlueskyCycle({ dbPath = DB_PATH, factsPath = FACTS_PATH, env = process.env, fetchImpl } = {}) {
  // Only ever reachable for a channel whose policy MODE is AUTO_PUBLIC
  // (lib/channelPolicy.mjs) — never for a CONDITIONAL_AUTO/
  // HUMAN_APPROVAL_REQUIRED/AUTO_DRAFT channel, regardless of what else is
  // configured.
  if (channelPolicy('bluesky').mode !== MODE.AUTO_PUBLIC) {
    return { status: 'CHANNEL_NOT_SCHEDULED' };
  }
  const db = openDb(dbPath);
  try {
    let facts;
    try {
      facts = loadCanonicalFacts(factsPath, db);
    } catch {
      return { status: 'NO_FACTS' };
    }
    const ranked = rankFacts(facts);
    const candidate = selectCandidateForChannel(db, 'bluesky', ranked, {
      alreadyPublished: (factId) => alreadyPublishedByChannel(db, 'bluesky', factId),
    });
    if (!candidate) {
      return { status: 'NO_POST' };
    }
    // rankFacts()/candidate.fact has no separate "event" concept (unlike the
    // video pipeline's marketing_events-based candidates) — the fact's own
    // id is the real shared correlation key between what any two channels
    // would be posting about, so it's what checkStagger() keys on to notice
    // "X already posted about this exact fact moments ago."
    return await publishToChannel(db, 'bluesky', candidate.fact, draftBlueskyPost, {
      env, eventId: candidate.fact.id, ...(fetchImpl ? { fetchImpl } : {}),
    });
  } finally {
    closeDb(db);
  }
}

/**
 * Multi-channel expansion — Mastodon wired into the same existing daily
 * operator path, structurally identical to runBlueskyCycle above (same
 * "select exactly one candidate, call publishToChannel(), let it own every
 * real safety decision" division of responsibility). MAX_MASTODON_POSTS_
 * PER_RUN<=1 holds by construction, same reason runBlueskyCycle's own doc
 * comment gives: `ranked.find()` returns at most one candidate per call.
 * AUTH_VALID/CANARY_PASS/enable-flag/activation-boundary/frequency-guard/
 * stagger are all enforced by publishToChannel() itself — this function
 * never re-implements or duplicates any of them.
 */
async function runMastodonCycle({ dbPath = DB_PATH, factsPath = FACTS_PATH, env = process.env, fetchImpl } = {}) {
  if (channelPolicy('mastodon').mode !== MODE.AUTO_PUBLIC) {
    return { status: 'CHANNEL_NOT_SCHEDULED' };
  }
  const db = openDb(dbPath);
  try {
    let facts;
    try {
      facts = loadCanonicalFacts(factsPath, db);
    } catch {
      return { status: 'NO_FACTS' };
    }
    const ranked = rankFacts(facts);
    const candidate = selectCandidateForChannel(db, 'mastodon', ranked, {
      alreadyPublished: (factId) => alreadyPublishedByChannel(db, 'mastodon', factId),
    });
    if (!candidate) {
      return { status: 'NO_POST' };
    }
    return await publishToChannel(db, 'mastodon', candidate.fact, draftMastodonPost, {
      env, eventId: candidate.fact.id, ...(fetchImpl ? { fetchImpl } : {}),
    });
  } finally {
    closeDb(db);
  }
}

/**
 * DEV.to activation — wired into the SAME existing daily operator path,
 * structurally identical to runBlueskyCycle/runMastodonCycle above (own
 * db open/close, own candidate selection via rankFacts(), exactly one
 * candidate per call, every real safety decision — evidence/policy/risk-
 * class/LIVE-mode/kill-switch/enable-flag/per-channel-activation-boundary/
 * AUTH_VALID/CANARY_PASS/frequency-guard/cross-channel-stagger — made by
 * lib/multiChannelPublish.mjs's publishToChannel(), never re-implemented
 * here). Two differences from Bluesky/Mastodon, both already handled
 * entirely inside the existing shared pipeline, not by this function:
 *  - draftDevToArticle() returns null (NO_DRAFT, fails closed) for a fact
 *    without genuine technical substance — DEV.to must never become a
 *    generic announcement mirror (mandate section 4).
 *  - canonicalContentId is passed as the fact's own id, which
 *    checkCanonicalContentStagger() (inside publishToChannel) uses to stop
 *    the SAME long-form content publishing simultaneously across DEV.to/
 *    Qiita/Zenn — the fact id is the correct shared key here because it's
 *    exactly what draftDevToArticle/draftQiitaArticle/draftZennArticle all
 *    derive their long-form content FROM.
 * MAX_DEVTO_ARTICLES_PER_RUN<=1 holds by construction (ranked.find()
 * returns at most one candidate); MAX_DEVTO_ARTICLES_PER_WEEK<=2 is
 * lib/frequencyGuards.mjs's existing devto perWeek default, enforced by
 * publishToChannel — not duplicated here.
 */
export async function runDevToCycle({ dbPath = DB_PATH, factsPath = FACTS_PATH, env = process.env, fetchImpl } = {}) {
  if (channelPolicy('devto').mode !== MODE.AUTO_PUBLIC) {
    return { status: 'CHANNEL_NOT_SCHEDULED' };
  }
  const db = openDb(dbPath);
  try {
    let facts;
    try {
      facts = loadCanonicalFacts(factsPath, db);
    } catch {
      return { status: 'NO_FACTS' };
    }
    const ranked = rankFacts(facts);
    const candidate = selectCandidateForChannel(db, 'devto', ranked, {
      alreadyPublished: (factId) => alreadyPublishedByChannel(db, 'devto', factId),
    });
    if (!candidate) {
      return { status: 'NO_POST' };
    }
    return await publishToChannel(db, 'devto', candidate.fact, draftDevToArticle, {
      env, eventId: candidate.fact.id, canonicalContentId: candidate.fact.id, ...(fetchImpl ? { fetchImpl } : {}),
    });
  } finally {
    closeDb(db);
  }
}

/**
 * Qiita activation — wired into the SAME existing daily operator path,
 * structurally identical to runDevToCycle above (own db open/close, own
 * candidate selection via rankFacts(), exactly one candidate per call,
 * every real safety decision made by publishToChannel(), never
 * re-implemented here). draftQiitaArticle() already defaults to natural
 * Japanese (longFormBody(fact, {language:'ja'})) and already refuses
 * (NO_DRAFT) a fact without genuine technical substance via the same
 * isTechnicalSubstance() gate every other long-form channel uses — DEV.to
 * must never become a generic announcement mirror, same for Qiita.
 * canonicalContentId is the fact's own id, same shared key
 * draftDevToArticle/draftQiitaArticle/draftZennArticle all derive their
 * long-form content from — checkCanonicalContentStagger() (inside
 * publishToChannel) uses it to stop the SAME long-form content publishing
 * simultaneously across DEV.to/Qiita/Zenn. MAX_QIITA_ARTICLES_PER_RUN<=1
 * holds by construction (ranked.find() returns at most one candidate);
 * MAX_QIITA_ARTICLES_PER_WEEK<=2 is lib/frequencyGuards.mjs's existing
 * qiita perWeek default, enforced by publishToChannel — not duplicated
 * here.
 */
export async function runQiitaCycle({ dbPath = DB_PATH, factsPath = FACTS_PATH, env = process.env, fetchImpl } = {}) {
  if (channelPolicy('qiita').mode !== MODE.AUTO_PUBLIC) {
    return { status: 'CHANNEL_NOT_SCHEDULED' };
  }
  const db = openDb(dbPath);
  try {
    let facts;
    try {
      facts = loadCanonicalFacts(factsPath, db);
    } catch {
      return { status: 'NO_FACTS' };
    }
    const ranked = rankFacts(facts);
    const candidate = selectCandidateForChannel(db, 'qiita', ranked, {
      alreadyPublished: (factId) => alreadyPublishedByChannel(db, 'qiita', factId),
    });
    if (!candidate) {
      return { status: 'NO_POST' };
    }
    return await publishToChannel(db, 'qiita', candidate.fact, draftQiitaArticle, {
      env, eventId: candidate.fact.id, canonicalContentId: candidate.fact.id, ...(fetchImpl ? { fetchImpl } : {}),
    });
  } finally {
    closeDb(db);
  }
}

/**
 * Channel-scoped, PUBLISHED-only idempotency check — see runBlueskyCycle's
 * doc comment for why this is deliberately NOT the same as runOnceInner's
 * alreadyPublished(). Deliberately requires published_at IS NOT NULL (a
 * real, terminal publish) rather than "any ledger row exists": a row from
 * a DRY_RUN/BASELINE_SKIPPED/frequency-capped/stagger-blocked attempt must
 * NOT make a fact look permanently covered — lib/candidateSelection.mjs's
 * selectCandidateForChannel() is what actually decides permanent
 * ineligibility (pre-activation, or this check); this function only
 * answers "was it truly already published."
 */
function alreadyPublishedByChannel(db, channel, factId) {
  const row = db
    .prepare("SELECT 1 FROM publication_ledger WHERE channel = ? AND source_evidence LIKE '%' || ? || '%' AND published_at IS NOT NULL LIMIT 1")
    .get(channel, factId);
  return !!row;
}

/**
 * Daily flow (mandate section 14): SOURCE SCAN -> NORMALIZE -> VERIFY ->
 * DEDUP -> INGEST marketing_events -> existing story scoring -> existing
 * video candidate scoring -> existing pipeline. The scan/ingest step is
 * real (never dry-run) here — this is the one daily automatic call that
 * actually populates marketing_events from product-repo evidence, so the
 * video stage that follows in the SAME cycle can see same-day activity
 * rather than waiting for a human to run `cli.mjs event` by hand.
 */
async function runDailyVideoCycle({ dbPath = DB_PATH, factsPath = FACTS_PATH, env = process.env } = {}) {
  const db = openDb(dbPath);
  try {
    const sourceScan = await scanAllSources(db, sourceAdapterList, { dryRun: false, env });

    let facts = [];
    try {
      facts = loadFacts(factsPath);
    } catch {
      // The video stage tolerates a missing/invalid fact registry the same
      // way selectBestCandidate tolerates an empty facts array — candidates
      // with no matching facts just score lower on the fact-dependent
      // dimensions, never a hard failure.
    }
    const video = await runDailyVideoStage(db, { facts, env });
    // Local development observer (mandate: "detect meaningful development
    // progress directly from the user's local PC repositories/worktrees,
    // WITHOUT weakening the existing public-safety/evidence gates") — pure
    // read-only local git/fs observation, zero network calls, zero product-
    // repo writes, never itself publishes anything (see lib/devObserver.mjs).
    // Reuses the SAME facts array already loaded above (never a second load).
    const devObserver = await observeAllDevRepos(db, devRepoConfigs(env), { env, facts });
    return { ...video, sourceScan, devObserver };
  } finally {
    closeDb(db);
  }
}

async function runOnceInner({ dbPath = DB_PATH, factsPath = FACTS_PATH, draftFn = draftXPostEn } = {}) {
  const db = openDb(dbPath);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  // Overlap protection for the whole canonical operator run now lives one
  // level up, in runOnce() — a single operator_lock row guarding this
  // function AND every other channel cycle together, rather than this
  // function acquiring/releasing the same row on its own (which would
  // collide with, not cooperate with, that outer lock: two different runIds
  // trying to hold the same single-row lock at once).
  db.prepare(
    'INSERT INTO run_log (run_id, started_at, status, mode, notes) VALUES (?, ?, ?, ?, ?)'
  ).run(runId, startedAt, 'RUNNING', getMode(), null);

  try {
    const facts = loadCanonicalFacts(factsPath, db);
    const factErrors = validateFacts(facts);
    if (factErrors.length) {
      log(runId, `fact registry has ${factErrors.length} validation error(s); continuing with valid facts only`);
    }

    const ranked = rankFacts(facts);
    if (ranked.length === 0) {
      finishRun(db, runId, 'NO_POST', 'no eligible VERIFIED/PARTIAL public-safe facts');
      return { status: 'NO_POST', runId };
    }

    // Structural bound, not a runtime check: this function selects exactly one
    // candidate and produces exactly one draft per call, satisfying
    // LIMITS.MAX_STORIES_PER_RUN / MAX_DRAFTS_PER_RUN (both default 1) by
    // construction. Scanning past permanently-ineligible facts (pre-
    // activation, already truly published, or policy-blocked claim text)
    // to find the next actionable one is cheap in-memory filtering, not
    // additional drafting — see lib/candidateSelection.mjs. A fact skipped
    // in a PAST cycle only for a temporary reason (frequency cap, stagger,
    // DRY_RUN mode, auth/canary not ready) remains a real candidate here.
    const candidate = selectCandidateForChannel(db, 'x', ranked, {
      alreadyPublished: (factId) => alreadyPublished(db, factId),
    });
    if (!candidate) {
      finishRun(db, runId, 'NO_POST', 'all eligible facts permanently ineligible or already published');
      return { status: 'NO_POST', runId };
    }

    const draft = draftFn(candidate.fact);
    const riskClass = classifyRisk(draft.actionType);
    const contentCheck = checkContent(draft, facts);
    const policyCheck = riskClass === RISK_CLASS.AUTO_WITH_POLICY ? checkPolicyGate(draft) : { ok: true, violations: [] };

    if (!contentCheck.ok || !policyCheck.ok) {
      finishRun(db, runId, 'BLOCKED', `policy violations: ${[...contentCheck.violations, ...policyCheck.violations].join(', ')}`);
      return { status: 'BLOCKED', runId, violations: [...contentCheck.violations, ...policyCheck.violations] };
    }

    const limits = getLimits();
    const isReply = draft.actionType?.endsWith('_reply');
    const dailyCap = isReply ? limits.MAX_REPLIES_PER_DAY : limits.MAX_EXTERNAL_POSTS_PER_DAY;
    const todayCount = todaysPublications(db).filter((row) => {
      const rowIsReply = (row.content_type ?? '').endsWith('_reply');
      return rowIsReply === !!isReply;
    }).length;
    if (riskClass !== RISK_CLASS.HUMAN_APPROVAL_REQUIRED && todayCount >= dailyCap) {
      finishRun(db, runId, 'DAILY_CAP_REACHED', `${isReply ? 'reply' : 'post'} cap ${dailyCap} reached for today`);
      return { status: 'DAILY_CAP_REACHED', runId };
    }

    if (riskClass === RISK_CLASS.HUMAN_APPROVAL_REQUIRED) {
      recordIntent(db, {
        channel: draft.channel, text: draft.text, contentType: draft.actionType,
        sourceEvidence: draft.factIds.join(','), riskClass, approvalState: 'PENDING_HUMAN_APPROVAL',
      });
      finishRun(db, runId, 'PENDING_APPROVAL', 'high-risk action recorded, awaiting human approval');
      return { status: 'PENDING_APPROVAL', runId };
    }

    // eventId = the fact's own id — the real shared correlation key another
    // channel's cycle (e.g. runBlueskyCycle below) posting about the SAME
    // fact keys its own cross-channel stagger check on (mandate: "no
    // same-event simultaneous post with X").
    const row = recordIntent(db, {
      channel: draft.channel, text: draft.text, contentType: draft.actionType,
      sourceEvidence: draft.factIds.join(','), riskClass, approvalState: 'AUTO_APPROVED', eventId: candidate.fact.id,
    });

    const mode = getMode();
    // Safe-activation mandate section 1: a candidate whose evidence
    // predates the durable activation boundary must never auto-publish
    // "merely because LIVE mode was enabled later" — re-checked here as
    // the authoritative gate even though lib/candidateSelection.mjs's
    // selectCandidateForChannel() already filtered pre-activation facts
    // out of candidacy above; this function is the one place that ever
    // actually decides to call a connector, so it never trusts that
    // pre-filter blindly. Also checks this channel's
    // OWN activation boundary (same OR-with-global semantics every other
    // channel's publishToChannel() call already uses — see
    // lib/multiChannelPublish.mjs) — X predates that per-channel boundary
    // concept, so getActivationBoundary(db, draft.channel) simply returns
    // null (never gates anything) until one is explicitly set for 'x'.
    const activationBoundary = getActivationBoundary(db);
    const channelBoundary = getActivationBoundary(db, draft.channel);
    const preActivation = isPreActivation(candidate.fact.VERIFIED_AT, activationBoundary)
      || isPreActivation(candidate.fact.VERIFIED_AT, channelBoundary);
    // Pre-LIVE hardening (parity with every other AUTO_PUBLIC channel's
    // publishToChannel() gate, lib/multiChannelPublish.mjs): a configured
    // credential is not a PROVEN one — real, unattended publishing also
    // requires a durably-recorded passed auth-check AND a passed one-time
    // canary for this exact channel, plus this channel's own frequency
    // guard and cross-channel event stagger. Reuses the exact same
    // functions every other channel's gate already reuses — never a
    // second, X-specific reimplementation of any of them.
    const channelState = getChannelState(db, draft.channel);
    const authValid = !!channelState.auth_valid;
    const canaryPassed = !!channelState.canary_passed;
    const freqGuard = checkFrequencyGuard(db, draft.channel);
    const stagger = checkStagger(db, candidate.fact.id, draft.channel);
    const enabled = channelEnabled(draft.channel);
    // Pre-live hardening: MARKETING_MODE=LIVE + the global kill switch are
    // necessary but NOT sufficient — each channel also needs its own
    // explicit MARKETING_<CHANNEL>_ENABLED=true, a durably-proven
    // AUTH_VALID + CANARY_PASSED, a passed frequency guard, and a passed
    // cross-channel stagger. Missing any one of these fails closed to
    // DRY_RUN, never partially live.
    const liveAllowed = mode === 'LIVE' && automationEnabled() && authValid && canaryPassed
      && enabled && !preActivation && freqGuard.ok && stagger.ok;
    if (!liveAllowed) {
      const activeBoundary = isPreActivation(candidate.fact.VERIFIED_AT, channelBoundary) ? channelBoundary : activationBoundary;
      const reason = mode !== 'LIVE' ? 'DRY_RUN mode'
        : !automationEnabled() ? 'global kill switch off'
        : !authValid ? 'AUTH_INVALID (no passed auth-check recorded for this channel)'
        : !canaryPassed ? 'CANARY_NOT_PASSED'
        : preActivation ? `pre-activation baseline (fact VERIFIED_AT ${candidate.fact.VERIFIED_AT ?? 'unknown'} predates the ${draft.channel} live-not-before boundary ${activeBoundary})`
        : !enabled ? `channel not enabled (${channelEnvFlagName(draft.channel) ?? 'no enable flag for this channel'}=false)`
        : !freqGuard.ok ? freqGuard.reason
        : stagger.reason;
      const status = mode === 'LIVE' && automationEnabled() && authValid && canaryPassed && enabled && preActivation
        ? 'BASELINE_SKIPPED' : 'DRY_RUN_OK';
      finishRun(db, runId, status, `would publish to ${draft.channel} (${reason}): ${draft.text.slice(0, 80)}...`);
      return { status, runId, draft, publicationId: row.publication_id };
    }

    const connector = connectors[draft.channel];
    if (!connector) {
      finishRun(db, runId, 'NO_CONNECTOR', `no connector for channel ${draft.channel}`);
      return { status: 'NO_CONNECTOR', runId };
    }

    const result = await connector.publish(draft, { dryRun: false });
    if (result.connectionRequired) {
      finishRun(db, runId, 'CONNECTION_REQUIRED', `channel ${draft.channel} not configured`);
      return { status: 'CONNECTION_REQUIRED', runId, channel: draft.channel };
    }
    if (!result.ok) {
      markFailed(db, row.publication_id, result.error ?? 'unknown error');
      finishRun(db, runId, 'PUBLISH_FAILED', result.error ?? 'unknown error');
      return { status: 'PUBLISH_FAILED', runId };
    }

    markPublished(db, row.publication_id, { externalId: result.externalId, externalUrl: result.externalUrl, result: 'OK' });
    finishRun(db, runId, 'PUBLISHED', `published to ${draft.channel}`);
    return { status: 'PUBLISHED', runId, publicationId: row.publication_id };
  } catch (err) {
    finishRun(db, runId, 'ERROR', String(err?.stack ?? err));
    throw err;
  } finally {
    closeDb(db);
  }
}

/**
 * Channel-agnostic, PUBLISHED-only idempotency check for X's legacy path
 * (see runBlueskyCycle's doc comment for why this deliberately checks
 * across every channel, not just 'x' — a fact already posted about on any
 * channel is treated as covered for X too, avoiding redundant cross-
 * channel repetition of the same fact). Requires published_at IS NOT NULL
 * (a real, terminal publish) — see alreadyPublishedByChannel() above for
 * why a merely-attempted (DRY_RUN/BASELINE_SKIPPED/temporarily-blocked)
 * row must never count as permanently covered.
 */
function alreadyPublished(db, factId) {
  const row = db
    .prepare("SELECT 1 FROM publication_ledger WHERE source_evidence LIKE '%' || ? || '%' AND published_at IS NOT NULL LIMIT 1")
    .get(factId);
  return !!row;
}

function finishRun(db, runId, status, notes) {
  db.prepare('UPDATE run_log SET completed_at = ?, status = ?, notes = ? WHERE run_id = ?').run(
    new Date().toISOString(), status, notes, runId
  );
}

function checkSystemdTimer(name) {
  try {
    const enabled = execSync(`systemctl --user is-enabled ${name} 2>/dev/null`).toString().trim();
    const active = execSync(`systemctl --user is-active ${name} 2>/dev/null`).toString().trim();
    return { enabled, active };
  } catch (err) {
    // is-enabled/is-active exit non-zero for "disabled"/"inactive" states too
    // (not just "missing") — execSync throws either way; recover the actual
    // stdout it captured before the non-zero exit rather than assuming absence.
    const enabled = err?.stdout?.toString().trim() || 'not-installed';
    return { enabled, active: 'inactive' };
  }
}

export function status({
  dbPath = DB_PATH, factsPath = FACTS_PATH, env = process.env,
  // Injectable only for the idle-template file check below (see
  // ymm4Readiness) — every other real fs/network access in status() is a
  // deliberately real, unmocked local read (e.g. checkDiskGuard), same as
  // this one is by default; tests override these two to avoid depending on
  // whether a real .ymmp file happens to exist on the machine running them.
  idleTemplateExistsImpl, idleTemplateReadFileImpl,
} = {}) {
  const db = openDb(dbPath);
  try {
    let facts = [];
    let factErrors = ['facts file not found or unreadable'];
    try {
      facts = loadFacts(factsPath);
      factErrors = validateFacts(facts);
    } catch { /* keep default error */ }

    const lastRun = db.prepare('SELECT * FROM run_log ORDER BY started_at DESC LIMIT 1').get();
    const today = new Date().toISOString().slice(0, 10);
    const todayPubs = db.prepare("SELECT COUNT(*) c FROM publication_ledger WHERE published_at LIKE ? || '%'").get(today).c;
    const pending = db.prepare('SELECT COUNT(*) c FROM publication_ledger WHERE published_at IS NULL AND result IS NULL').get().c;
    const failed = db.prepare("SELECT COUNT(*) c FROM publication_ledger WHERE result LIKE 'FAILED%'").get().c;

    const connections = classifyAll();
    const siteRoot = new URL('../../', import.meta.url).pathname;
    const fileExists = (rel) => existsSync(join(siteRoot, rel));

    ensureEventsSchema(db);
    ensureLearningSchema(db);
    ensureExperimentsSchema(db);
    ensureMarketSchema(db);
    const pendingEvents = unprocessedEvents(db).length;
    const strategyCount = strategyHistory(db).length;
    const experimentCount = listExperiments(db).length;
    const marketEntryCount = listMarketEntries(db).length;
    const xReadiness = channelReadiness(db, 'x', { factsPath });
    const ytReadiness = channelReadiness(db, 'youtube', { factsPath });
    const latestDemo = latestDemoRun(db);
    const ymm4State = getYmm4ProcessState(db);

    // Non-mutating preview of the next automatic video selection (dryRun:
    // true — see lib/videoCandidates.mjs) so `status` never consumes/marks-
    // processed an event just by being asked what it would do.
    const videoMinScore = minVideoScore(env);
    const videoPreview = selectBestCandidate(db, { facts, minScore: videoMinScore, dryRun: true });
    const pendingVideoReviewCount = reviewQueue(db).filter((r) => r.review_status === 'PENDING').length;
    const videoLimits = getLimits(env);
    const videoDiskGuard = checkDiskGuard(toWslPath(DEFAULT_RENDER_OUTPUT_DIR), env);
    const demoAllowed = ymm4DemoAllowed(env);
    // Reuses the exact canonical readiness computation `ymm4 status` uses
    // (lib/ymm4IdleTemplate.mjs's computeAutonomousRenderReadiness) — never
    // a second, re-derived copy. `status` still makes no live process/bridge
    // call of its own: `ymm4State.health_state` is the enriched label the
    // last real `ymm4 status`/`ymm4 ensure` run already computed and
    // persisted (see lib/ymm4Health.mjs's recordYmm4ProcessState), covering
    // the HEALTHY_EMPTY_MARKETING_SESSION case this field previously missed
    // entirely (it only ever checked bridge_status === 'HEALTHY', which a
    // verified-clean empty bootstrap session — a genuinely READY_NO_PROJECT
    // transport state — never satisfies). idleTemplateClean/renderLockAvailable
    // are cheap local file/DB reads, same as every other inline status check
    // here (e.g. videoDiskGuard above), not a live YMM4 call.
    const ymm4Readiness = computeAutonomousRenderReadiness({
      healthState: ymm4State?.health_state ?? ymm4State?.bridge_status ?? null,
      liveProjectPath: ymm4State?.project ?? null,
      demoAllowed,
      idleTemplateClean: checkIdleTemplateClean(DEFAULT_MARKETING_IDLE_TEMPLATE, {
        existsImpl: idleTemplateExistsImpl, readFileImpl: idleTemplateReadFileImpl,
      }).clean,
      renderLockAvailable: isRenderLockAvailable(db),
    });
    const sourceHealthRows = allSourceHealth(db, sourceAdapterList);
    const sourceHealthBySlug = Object.fromEntries(sourceHealthRows.map((h) => [h.source, h]));
    const devReposStatus = devObserverStatus(db, devRepoConfigs(env));
    const factPromotionStatusResult = factPromotionStatus(db, facts);

    const dailyTimer = checkSystemdTimer('veritas-marketing.timer');
    const weeklyTimer = checkSystemdTimer('veritas-marketing-weekly.timer');

    return {
      OPERATOR: lastRun ? `${lastRun.status} @ ${lastRun.started_at}` : 'never run',
      SCHEDULER: dailyTimer.enabled === 'enabled' || weeklyTimer.enabled === 'enabled' ? 'INSTALLED' : 'NOT_INSTALLED',
      NEXT_RUN: dailyTimer.enabled === 'enabled' ? 'see: systemctl --user list-timers veritas-marketing.timer' : null,

      WEBSITE_AUTOMATION: fileExists('tools/marketing/lib/site.mjs') ? 'PARTIAL' : 'MISSING',
      NEWS: fileExists('app/news/page.tsx') && fileExists('app/ja/news/page.tsx') ? 'EXISTING' : 'MISSING',
      SEO: fileExists('app/news/rss.xml/route.ts') ? 'PARTIAL' : 'MISSING',
      ANALYTICS: fileExists('app/api/marketing-event/route.ts') ? 'PARTIAL (local sink only — see AUTONOMOUS_MARKETING_AUDIT.md)' : 'MISSING',
      MARKET_MONITOR: marketEntryCount > 0 ? 'PARTIAL' : 'PIPELINE_EXISTS_NO_DATA',
      COMPETITOR_MONITOR: 'PIPELINE_EXISTS',

      X_CLIENT: connections.x.clientImplemented,
      X_AUTH: connections.x.authConfigured,
      X_CANARY: xReadiness.canaryPass,
      X_ENABLED: xReadiness.enabled,
      X_MEDIA_UPLOAD: 'BLOCKED_OR_MISSING', // text-only client today; no media/video upload path implemented for X
      X_LIVE_READY: xReadiness.recurringLiveReady,

      DISCORD_CLIENT: connections.discord.clientImplemented,
      DISCORD_AUTH: connections.discord.authConfigured,
      DISCORD_LIVE_READY: connections.discord.liveReady,

      YOUTUBE_CLIENT: connections.youtube.clientImplemented,
      YOUTUBE_AUTH: connections.youtube.authConfigured,
      YOUTUBE_CANARY: ytReadiness.canaryPass,
      YOUTUBE_ENABLED: ytReadiness.enabled,
      YOUTUBE_DEFAULT_PRIVACY: youtubeConnector.DEFAULT_PRIVACY,
      YOUTUBE_LIVE_READY: ytReadiness.recurringLiveReady,
      YOUTUBE: connections.youtube.status,

      REDDIT: connections.reddit.status,
      PRODUCT_HUNT: connections.producthunt.status,
      ZENN: connections.zenn.status,
      QIITA: connections.qiita.status,
      NOTE: connections.note.status,
      HACKER_NEWS: connections.hackernews.status,

      // Multi-channel expansion (mandate section 20) — one uniform
      // CLIENT/AUTH/MODE/LIVE_READY/LAST_PUBLICATION/TODAY_COUNT/BLOCKER
      // block per channel, see lib/channelStatusReport.mjs. Pure local
      // reads only, same as every field above.
      BLUESKY: buildChannelStatus(db, 'bluesky', env),
      MASTODON: buildChannelStatus(db, 'mastodon', env),
      DEVTO: buildChannelStatus(db, 'devto', env),
      ZENN_STATUS: buildChannelStatus(db, 'zenn', env),
      HASHNODE: buildChannelStatus(db, 'hashnode', env),
      LINKEDIN: buildChannelStatus(db, 'linkedin', env),
      REDDIT_STATUS: buildChannelStatus(db, 'reddit', env),
      PRODUCT_HUNT_STATUS: buildChannelStatus(db, 'producthunt', env),
      HACKER_NEWS_STATUS: buildChannelStatus(db, 'hackernews', env),
      NOTE_STATUS: buildChannelStatus(db, 'note', env),
      QIITA_STATUS: buildChannelStatus(db, 'qiita', env),

      // Filtered by MODE (what a channel actually does right now), never by
      // CLASS alone — Zenn's CLASS is AUTO_PUBLIC_ELIGIBLE (policy intent:
      // it's allowed to eventually auto-publish) but its MODE is AUTO_DRAFT
      // (it has no write API at all yet — see connectors/registry.mjs) —
      // reporting it under AUTO_PUBLIC_CHANNELS would wrongly imply it can
      // auto-publish today. AUTO_DRAFT_CHANNELS is the separate, honest
      // bucket for that case.
      AUTO_PUBLIC_CHANNELS: allExpansionChannelNames().filter((ch) => channelPolicy(ch).mode === MODE.AUTO_PUBLIC),
      AUTO_DRAFT_CHANNELS: allExpansionChannelNames().filter((ch) => channelPolicy(ch).mode === MODE.AUTO_DRAFT),
      HUMAN_APPROVAL_CHANNELS: allExpansionChannelNames().filter((ch) => channelPolicy(ch).class === CHANNEL_CLASS.HUMAN_APPROVAL_REQUIRED),
      CONDITIONAL_AUTO_CHANNELS: allExpansionChannelNames().filter((ch) => channelPolicy(ch).class === CHANNEL_CLASS.CONDITIONAL_AUTO),

      YMM4_FOUND: 'EXISTING (elsewhere — ECHODiscord版/local_commentary + Windows-side ymm4MCP plugin; see docs/marketing/YMM4_AUTOMATION_AUDIT.md)',
      YMM4_AUTOMATION: 'EXISTING (reused via tools/marketing/lib/ymm4Bridge.mjs, not duplicated)',
      // Updated 2026-09-16: the blank idle template is no longer merely
      // "implemented, untested" — it was generated using YMM4's own real
      // Project()/Timeline() classes (no MainModel/VoiceFactory/WPF
      // Application involved), independently deserialized and round-tripped
      // (both against the real installed assemblies), installed as
      // marketing_idle_blank.ymmp, verified clean via
      // checkIdleTemplateClean(), and confirmed as the real PID 50188
      // bootstrap launch argument via the live bridge's own state (real OS
      // command line + IsEmptyProject/item-count checks) — see
      // docs/marketing/YMM4_STARTUP_AUDIT.md's "Clean idle template"
      // section for the full trace.
      YMM4_PROJECT_GENERATION: 'IMPLEMENTED AND VERIFIED (generated via real Project()/Timeline() classes, deserialized + round-tripped, installed, detected clean, confirmed as the real live bootstrap argument — see docs/marketing/YMM4_STARTUP_AUDIT.md)',
      YMM4_NARRATION: 'IMPLEMENTED (tools/marketing/lib/videoScript.mjs, evidence-gated)',
      YMM4_RENDER: 'IMPLEMENTED (headless --encode, gated by canAutoEncode()/MARKETING_YMM4_DEMO_ALLOWED)',
      YMM4_RENDER_LOCK: 'IMPLEMENTED (tools/marketing/lib/videoPipeline.mjs render_lock table)',

      REAL_TASK_CAPTURE: 'IMPLEMENTED (tools/marketing/lib/evidence.mjs)',
      PUBLIC_SAFE_EVIDENCE: latestDemo ? latestDemo.evidence_status : 'NO_RUNS_YET',
      LATEST_DEMO_RUN: latestDemo ? latestDemo.demo_run_id : null,
      LATEST_RENDER: latestDemo ? latestDemo.render_status : null,
      LATEST_PRIVATE_UPLOAD: latestDemo?.youtube_video_id ?? null,

      // Recurring-video mandate section 16.
      AUTO_VIDEO_SELECTION: 'IMPLEMENTED (tools/marketing/lib/videoCandidates.mjs — reads verified marketing_events, never raw commits)',
      VIDEO_MIN_SCORE: videoMinScore,
      LATEST_VIDEO_CANDIDATE: videoPreview.selected
        ? { eventType: videoPreview.selected.candidate.eventType, title: videoPreview.selected.candidate.title, sourceEventId: videoPreview.selected.candidate.sourceEventId }
        : null,
      LATEST_VIDEO_SCORE: videoPreview.selected ? videoPreview.selected.total : null,

      YMM4_DEMO_ALLOWED: demoAllowed,
      YMM4_AUTO_RENDER_READY: demoAllowed ? 'READY (YMM4 auto-starts on demand if not already running — see YMM4_AUTO_START)' : 'BLOCKED (MARKETING_YMM4_DEMO_ALLOWED is not true)',

      // YMM4 unattended-startup mandate section 12. Read from the durable
      // ymm4_process_state record (same "status never makes a live network/
      // process call" pattern lib/channelState.mjs already established for
      // X/YouTube auth) — reflects the LAST real health check (from an
      // actual video job or `cli.mjs ymm4 status`/`ymm4 ensure`), not a
      // live check made just for this status call. A genuinely current
      // check is `node tools/marketing/cli.mjs ymm4 status`.
      // Deliberately NOT the same as VIDEO_PIPELINE_LIVE=true: YMM4 is only
      // started on demand, so YMM4_CURRENTLY_RUNNING can be false (or
      // unknown, if never checked) even while the pipeline is fully live.
      YMM4_PROCESS: ymm4State ? (ymm4State.bridge_status === 'HEALTHY' ? `RUNNING (pid ${ymm4State.pid})` : `RUNNING_OR_UNKNOWN (pid ${ymm4State.pid ?? 'unknown'}, last status ${ymm4State.bridge_status})`) : 'UNKNOWN (no health check has run yet — see: node tools/marketing/cli.mjs ymm4 status)',
      YMM4_PROCESS_OWNER: ymm4State?.owner ?? null,
      YMM4_PROCESS_PID: ymm4State?.pid ?? null,
      YMM4_BRIDGE: ymm4State?.bridge_status ?? 'UNKNOWN',
      YMM4_BRIDGE_PORT: 8765, // confirmed via the vendored plugin source (McpHttpServer.cs: public const int Port = 8765) — see lib/ymm4Bridge.mjs
      YMM4_PROJECT: ymm4State?.project ?? null,
      // Same definition `ymm4 status` itself uses (health.status ===
      // HEALTH.READY_NO_PROJECT) — derived from the durable transport
      // status here rather than a live call, same as every other YMM4_*
      // field on this page.
      YMM4_IS_EMPTY_PROJECT: ymm4State?.bridge_status === 'READY_NO_PROJECT',
      // Explicit terminology split (never overwrite one with the other —
      // see lib/ymm4IdleTemplate.mjs's deriveHealthState doc comment):
      // TRANSPORT_STATE is the raw last-recorded process/bridge/project-
      // identity signal; HEALTH_STATE is the further-verified, higher-level
      // concept that actually gates YMM4_READY_FOR_AUTONOMOUS_RENDER below.
      // Both are last-known-from-durable-state here, same as YMM4_BRIDGE —
      // a genuinely current check is `node tools/marketing/cli.mjs ymm4 status`.
      YMM4_TRANSPORT_STATE: ymm4State?.bridge_status ?? 'UNKNOWN',
      YMM4_HEALTH_STATE: ymm4State?.health_state ?? ymm4State?.bridge_status ?? 'UNKNOWN',
      // Both fields above are last-known-from-durable-state (never a live
      // call here) — this timestamp is what actually answers "how current
      // is that". Surfaced specifically because HEALTHY_EMPTY_MARKETING_SESSION
      // requires MARKETING_YMM4_DEMO_ALLOWED to have been set at the time of
      // that last check (see lib/ymm4IdleTemplate.mjs's
      // checkEmptyMarketingSessionReady) — a check run without it recorded
      // will correctly show the plain transport state here until a fresh
      // `ymm4 status` (with the real env) runs again.
      YMM4_HEALTH_STATE_LAST_CHECKED_AT: ymm4State?.last_checked_at ?? null,
      YMM4_AUTO_START: 'IMPLEMENTED (tools/marketing/lib/ymm4Startup.mjs ensureYmm4Ready — one safe GUI launch, never a second instance, never a Noemora project)',
      YMM4_AUTO_RECOVERY: 'IMPLEMENTED (one bounded recovery attempt before an automatic video job; reports YMM4_UNAVAILABLE and skips rather than retrying indefinitely)',
      YMM4_READY_FOR_AUTONOMOUS_RENDER: ymm4Readiness.ready,
      YMM4_READY_FOR_AUTONOMOUS_RENDER_REASONS: ymm4Readiness.reasons,

      YOUTUBE_AUTO_PRIVATE: ytReadiness.recurringLiveReady ? 'READY (uploads are hardcoded privacyStatus=private)' : 'BLOCKED (channel not recurring-live-ready — see YOUTUBE_LIVE_READY)',
      YOUTUBE_PENDING_REVIEW_COUNT: pendingVideoReviewCount,

      LATEST_PRIVATE_VIDEO: latestDemo?.privacy_status === 'private' ? latestDemo.demo_run_id : null,
      LATEST_PRIVATE_VIDEO_URL: latestDemo?.privacy_status === 'private' ? latestDemo.youtube_url : null,

      MAX_AUTO_VIDEOS_PER_DAY: videoLimits.MAX_AUTO_VIDEOS_PER_DAY,
      AUTO_VIDEOS_TODAY: autoVideosToday(db),
      VIDEO_DISK_GUARD: videoDiskGuard.ok ? `OK (${videoDiskGuard.freeBytes} bytes free)` : videoDiskGuard.reason,

      // Recurring-video mandate section 17 — two separate, unambiguous
      // flags rather than one overloaded mode: public social/text
      // publication can still be DRY_RUN while the private video pipeline
      // is genuinely LIVE (real render/transcode/private-upload), because
      // private YouTube upload was explicitly authorized separately from
      // public publication.
      PUBLIC_MARKETING_MODE: getMode(),
      PUBLIC_LIVE_NOT_BEFORE: getActivationBoundary(db),
      PRIVATE_VIDEO_PIPELINE_MODE: demoAllowed ? 'LIVE' : 'LIVE_GATED_BY_YMM4_DEMO_ALLOWED_FALSE',

      // Automatic event ingestion mandate section 17 — per-adapter source health.
      AUTO_SOURCE_INGESTION: 'IMPLEMENTED (tools/marketing/sourceAdapters/ -> lib/sourceIngestion.mjs -> existing marketing_events)',
      ECHO_AGENT_SOURCE: sourceHealthBySlug['echo-agent']?.status ?? 'DISABLED',
      ECHO_AGENT_LAST_SCAN: sourceHealthBySlug['echo-agent']?.lastScanAt ?? null,
      ECHO_AGENT_EVENTS_FOUND: sourceHealthBySlug['echo-agent']?.eventsFound ?? 0,
      ECHO_APP_SOURCE: sourceHealthBySlug['echo-app']?.status ?? 'DISABLED',
      ECHO_APP_LAST_SCAN: sourceHealthBySlug['echo-app']?.lastScanAt ?? null,
      ECHO_APP_EVENTS_FOUND: sourceHealthBySlug['echo-app']?.eventsFound ?? 0,
      NOEMORA_SOURCE: sourceHealthBySlug.noemora?.status ?? 'DISABLED',
      NOEMORA_LAST_SCAN: sourceHealthBySlug.noemora?.lastScanAt ?? null,
      NOEMORA_EVENTS_FOUND: sourceHealthBySlug.noemora?.eventsFound ?? 0,
      OFFICIAL_SITE_SOURCE: sourceHealthBySlug['official-site']?.status ?? 'DISABLED',
      OFFICIAL_SITE_LAST_SCAN: sourceHealthBySlug['official-site']?.lastScanAt ?? null,
      OFFICIAL_SITE_EVENTS_FOUND: sourceHealthBySlug['official-site']?.eventsFound ?? 0,

      // Local development observer — read-only local git/fs observation of
      // the user's PC repositories/worktrees, entirely separate from the
      // canonical Noemora PUBLIC_DEMO seal source above (NOEMORA_SOURCE).
      // Every LOCAL_DEVELOPMENT_CANDIDATE recorded here is Stage A only —
      // never itself publishable; PROMOTED here means a human already
      // curated matching evidence into a real fact, never that this module
      // wrote one. `status` never scans on its own (same convention as
      // every other *_LAST_SCAN field on this page) — it reports whatever
      // the last real runOnce() day cycle observed.
      LOCAL_DEV_OBSERVER: 'IMPLEMENTED (tools/marketing/lib/devObserver.mjs — read-only, zero network calls, zero product-repo writes)',
      NOEMORA_CANONICAL_SEAL_SOURCE_PRESERVED: 'UNCHANGED (sourceAdapters/noemora.mjs — separate module/table, untouched)',
      DEV_REPOS: devReposStatus.map(({ repoKey, repoPath, LAST_HEAD, LAST_SCAN, NEW_CANDIDATES, PROMOTED_PUBLIC_FACTS, BLOCKED_UNVERIFIED }) => ({
        repoKey, repoPath, LAST_HEAD, LAST_SCAN, NEW_CANDIDATES, PROMOTED_PUBLIC_FACTS, BLOCKED_UNVERIFIED,
      })),

      // Evidence -> fact auto-promotion (Stages B/C — see
      // lib/factPromotion.mjs), now wired into the real candidate-selection
      // path for every AUTO_PUBLIC text/social channel (X/Bluesky/Mastodon/
      // DEV.to/Qiita — operator.mjs's loadCanonicalFacts() call sites). A
      // machine fact still has to pass every existing gate unchanged
      // (evidence/policy/activation/frequency/stagger/idempotency/AUTH_VALID/
      // CANARY_PASSED) plus its OWN source-specific activation boundary
      // below — it gets no special privileges. `status` never promotes or
      // creates the boundary on its own; this is read-only reporting.
      AUTO_FACT_PROMOTION: 'IMPLEMENTED (tools/marketing/lib/factPromotion.mjs + lib/evidenceAllowlist.mjs — durable machine_verified_facts table, never writes docs/marketing/VERITAS_FORGE_PUBLIC_FACTS.md)',
      AUTO_FACT_PROMOTION_LIVE_WIRED: true,
      MACHINE_FACT_SOURCE_WIRED: factPromotionStatusResult.sourceWired,
      // null until loadCanonicalFacts()/loadMergedFacts() has actually run
      // for real at least once (it self-initializes, idempotently, on
      // first real use — never created eagerly by `status` itself).
      MACHINE_FACT_LIVE_NOT_BEFORE: factPromotionStatusResult.sourceBoundary,
      MACHINE_FACTS_TOTAL: factPromotionStatusResult.total,
      MACHINE_FACTS_PUBLIC_SAFE: factPromotionStatusResult.publicSafe,
      MACHINE_FACTS_PRE_SOURCE_BOUNDARY: factPromotionStatusResult.preSourceBoundary,
      MACHINE_FACTS_POST_SOURCE_BOUNDARY: factPromotionStatusResult.postSourceBoundary,
      MACHINE_FACTS_CURRENTLY_ELIGIBLE: factPromotionStatusResult.currentlyEligible,
      FACT_PROMOTION_BY_PRODUCT: factPromotionStatusResult.byProduct,
      LATEST_PROMOTED_FACT: factPromotionStatusResult.latestPromoted,

      DAILY_RUN: dailyTimer.enabled,
      WEEKLY_RUN: weeklyTimer.enabled,
      EVENT_TRIGGERS: `IMPLEMENTED (${pendingEvents} unprocessed)`,

      MARKETING_MEMORY: 'IMPLEMENTED',
      LEARNING_LOOP: `IMPLEMENTED (${strategyCount} strategy decision(s) recorded)`,
      EXPERIMENT_ENGINE: `IMPLEMENTED (${experimentCount} experiment(s))`,

      MARKETING_MODE: getMode(),
      AUTOMATION_ENABLED: automationEnabled(),

      // Kept from the original shape for backward compatibility with earlier tooling/tests.
      OPERATOR_LAST_RUN: lastRun?.started_at ?? null,
      OPERATOR_LAST_RESULT: lastRun?.status ?? null,
      CONNECTIONS: connectionStatus(),
      TODAY_PUBLICATIONS: todayPubs,
      PENDING_PUBLICATIONS: pending,
      FAILED_PUBLICATIONS: failed,
      PUBLIC_FACT_COUNT: facts.length,
      UNVERIFIED_CLAIMS_BLOCKED: factErrors.length,
    };
  } finally {
    closeDb(db);
  }
}
