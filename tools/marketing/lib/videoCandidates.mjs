// Automatic video candidate selection + scoring (the missing "what should
// the next video be about?" engine). Deliberately built ON TOP of the
// existing verified-event mechanism (lib/events.mjs) rather than a new
// git-log scanner: a candidate is a marketing_event that already carries
// real evidence (rawLogLines and/or factIds) in its payload — the same
// TEST_SUITE_PASS / BUG_FIXED / NEW_FEATURE_VERIFIED / etc. events the
// operator already ingests. This is a deliberate scope boundary, not an
// oversight: automatically MINING arbitrary git history across three
// heterogeneous product repos for "real evidence" (test passes, verifier
// receipts) would need a separate, repo-specific integration per product
// that does not exist yet — see docs/marketing/AUTONOMOUS_MARKETING_AUDIT.md
// for that boundary stated plainly rather than silently assumed away.
import { createHash } from 'node:crypto';
import { unprocessedEvents, markEventProcessed } from './events.mjs';
import { scanEvidence } from './evidence.mjs';
import { scoreNarrative } from './narrativeScore.mjs';
import { ensureVideoPipelineSchema } from './videoPipeline.mjs';

export const DEFAULT_MIN_SCORE = 65; // conservative default — see mandate section 4

export function minVideoScore(env = process.env) {
  const raw = Number(env.MARKETING_VIDEO_MIN_SCORE);
  return Number.isFinite(raw) ? raw : DEFAULT_MIN_SCORE;
}

/**
 * Builds a scorable candidate from a persisted marketing_event row. Returns
 * null if the event carries no usable evidence at all (payload missing or
 * empty) — an event alone, with no rawLogLines and no factId, is exactly
 * the "ordinary commit" case the mandate says must not become a video.
 */
export function candidateFromEvent(eventRow) {
  let payload = {};
  try {
    payload = eventRow.payload ? JSON.parse(eventRow.payload) : {};
  } catch { /* malformed payload -> treated as empty below */ }

  const rawLogLines = Array.isArray(payload.rawLogLines) ? payload.rawLogLines : [];
  const factIds = Array.isArray(payload.factIds) ? payload.factIds : (eventRow.fact_id ? [eventRow.fact_id] : []);
  if (rawLogLines.length === 0 && factIds.length === 0) return null;

  return {
    sourceEventId: eventRow.event_id,
    eventType: eventRow.event_type,
    sourceRepo: eventRow.source_repo,
    receivedAt: eventRow.received_at,
    rawLogLines,
    factIds,
    title: payload.title ?? null,
    description: payload.description ?? null,
  };
}

const CONTINUITY_KEYWORDS = /continuity|identity|memory|checkpoint|resume/i;
const VERIFIER_KEYWORDS = /verifier|verif(y|ied|ication)/i;
const DIFFERENTIATION_KEYWORDS = /persistent|durable|resume|checkpoint|continuity/i;
const LEARNING_KEYWORDS = /skill|learn|promot(e|ion)/i;

/**
 * Scores a candidate 0-100 across the 11 mandated dimensions. Every
 * dimension is derived from something actually present in the candidate
 * (evidence lines, fact claims) — none of them can be inflated by a
 * candidate that doesn't actually contain the relevant signal.
 */
export function scoreCandidate(candidate, { facts = [] } = {}) {
  const { beats } = scoreNarrative(candidate.rawLogLines);
  const relevantFacts = facts.filter((f) => candidate.factIds.includes(f.id));
  const factText = relevantFacts.map((f) => f.CLAIM ?? '').join(' ');
  const eventText = `${candidate.title ?? ''} ${candidate.description ?? ''} ${candidate.rawLogLines.join(' ')}`;

  const evidenceScan = candidate.rawLogLines.map((line) => scanEvidence(line));
  const privacySafetyScore = evidenceScan.every((s) => s.clean) ? 100 : 0; // fail closed, not partial credit

  const dimensions = {
    REAL_TASK_VALUE: candidate.rawLogLines.length > 0 ? 70 : (candidate.factIds.length > 0 ? 40 : 0),
    TENSION: beats.failure || beats.verifierRejection ? 80 : 20,
    RECOVERY: beats.retry ? 80 : (beats.checkpoint ? 50 : 20),
    ECHO_DIFFERENTIATION: DIFFERENTIATION_KEYWORDS.test(factText + eventText) ? 80 : 30,
    VERIFIER_VALUE: VERIFIER_KEYWORDS.test(factText + eventText) || beats.verifierRejection ? 90 : 20,
    CONTINUITY_VALUE: CONTINUITY_KEYWORDS.test(factText + eventText) ? 80 : 30,
    LEARNING_VALUE: LEARNING_KEYWORDS.test(factText + eventText) || candidate.eventType === 'SKILL_PROMOTION' ? 80 : 30,
    VISUAL_VALUE: candidate.rawLogLines.length >= 4 ? 60 : 30, // enough log lines to actually narrate/overlay
    PUBLIC_INTEREST: relevantFacts.some((f) => f.STATUS === 'VERIFIED') ? 70 : 40,
    EVIDENCE_QUALITY: relevantFacts.length > 0 && candidate.rawLogLines.length > 0 ? 85 : (candidate.rawLogLines.length > 0 ? 55 : 30),
    PRIVACY_SAFETY: privacySafetyScore,
  };

  const total = Math.round(Object.values(dimensions).reduce((a, b) => a + b, 0) / Object.keys(dimensions).length);
  return { total, dimensions, narrativeBeats: beats, evidenceClean: evidenceScan.every((s) => s.clean) };
}

/**
 * Deterministic fingerprint for duplicate-story prevention — same fact ids
 * + same evidence content always produces the same fingerprint, regardless
 * of which event or run it arrived through.
 */
export function computeStoryFingerprint(candidate) {
  const material = JSON.stringify({
    factIds: [...candidate.factIds].sort(),
    rawLogLines: candidate.rawLogLines,
  });
  return createHash('sha256').update(material).digest('hex');
}

export function isDuplicateStory(db, fingerprint) {
  ensureVideoPipelineSchema(db);
  const row = db.prepare('SELECT 1 FROM demo_runs WHERE story_fingerprint = ? LIMIT 1').get(fingerprint);
  return !!row;
}

/**
 * Scans unprocessed marketing_events for usable, non-duplicate candidates,
 * scores them, and returns the best one above `minScore` — or null, which
 * is the CORRECT result (NO_VIDEO) when nothing qualifies, not a failure.
 * Every considered event is marked processed regardless of outcome, so a
 * rejected/low-scoring event is never re-scored on every future run.
 *
 * `dryRun: true` runs the exact same scan/scoring/dedup logic but never
 * calls markEventProcessed() — used by status reporting (mandate section
 * 16: LATEST_VIDEO_CANDIDATE/LATEST_VIDEO_SCORE) and by the standalone
 * selection-preview check (mandate section 19), neither of which may have
 * the side effect of consuming events that a real run would still need to
 * see.
 */
export function selectBestCandidate(db, { facts = [], minScore = DEFAULT_MIN_SCORE, dryRun = false } = {}) {
  const events = unprocessedEvents(db);
  const scored = [];

  for (const eventRow of events) {
    const candidate = candidateFromEvent(eventRow);
    if (!candidate) {
      if (!dryRun) markEventProcessed(db, eventRow.event_id, 'no usable evidence for a video candidate');
      continue;
    }
    const fingerprint = computeStoryFingerprint(candidate);
    if (isDuplicateStory(db, fingerprint)) {
      if (!dryRun) markEventProcessed(db, eventRow.event_id, `duplicate story (fingerprint ${fingerprint.slice(0, 12)}...)`);
      continue;
    }
    const result = scoreCandidate(candidate, { facts });
    if (!dryRun) markEventProcessed(db, eventRow.event_id, `scored ${result.total} for video candidacy`);
    scored.push({ candidate, fingerprint, ...result });
  }

  scored.sort((a, b) => b.total - a.total);
  const best = scored.find((s) => s.total >= minScore && s.evidenceClean);
  return { selected: best ?? null, allScored: scored, minScore };
}
