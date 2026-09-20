// Orchestrates: source adapter -> normalize -> quality gate -> ingest into
// marketing_events -> advance cursor (mandate section 14). This is the
// ONLY place that sequences those steps — adapters stay dumb (scan +
// normalize only), and the existing story-scoring engine
// (lib/videoCandidates.mjs, lib/scoring.mjs) is untouched: it keeps
// consuming marketing_events exactly as it always has (mandate: "Do not
// create another story engine").
import { ensureEventsSchema, ingestEvent } from './events.mjs';
import { getCursor, recordScan } from './sourceCursors.mjs';
import { evaluateEventQuality } from './sourceQualityGate.mjs';

/**
 * Bridges the canonical normalized-event schema (lib/sourceEventSchema.mjs)
 * to the payload shape the EXISTING, unchanged story engine actually reads
 * (lib/videoCandidates.mjs candidateFromEvent(): payload.rawLogLines /
 * payload.factIds / payload.title / payload.description — see
 * lib/narrativeScore.mjs for the exact marker vocabulary). Without this,
 * every real event this module ingests would silently score as "no usable
 * evidence" (mandate section 15: "Correct flow: source adapter ->
 * marketing_event -> scoring -> threshold -> DEMO_RUN -> existing YMM4
 * pipeline" — this is the one translation point that makes that flow
 * actually connect, without touching the scoring engine itself).
 *
 * Every synthesized line is built ONLY from the normalized event's own
 * structural boolean flags/event_type — never from payload/evidence
 * content — so this can never leak anything the adapters themselves didn't
 * already put in a public-facing field.
 */
function synthesizeRawLogLines(normalized) {
  const lines = [`TASK: ${normalized.event_type}`];
  if (normalized.contains_failure) lines.push('STEP FAILED');
  if (normalized.contains_verifier_result) lines.push(normalized.contains_failure ? 'VERIFIER — REJECT' : 'VERIFIER — PASS');
  if (normalized.contains_recovery) lines.push('RETRY — correction applied');
  if (normalized.contains_checkpoint_resume) lines.push('CHECKPOINT / RESUME');
  if (normalized.contains_continuity_event) lines.push('CONTINUITY VERIFIED');
  if (normalized.contains_skill_learning) lines.push('SKILL PROMOTION — ACCEPT');
  if (normalized.verification_state === 'VERIFIED' || normalized.verification_state === 'PARTIAL') lines.push('RESULT: SUCCESS');
  return lines;
}

function toLegacyPayload(normalized) {
  return {
    ...normalized,
    rawLogLines: synthesizeRawLogLines(normalized),
    factIds: [], // adapters don't currently resolve FACT-* ids; rawLogLines alone satisfies candidateFromEvent()
    title: normalized.title,
    description: normalized.summary,
  };
}

/**
 * Runs one adapter's scanSince -> normalize -> gate -> ingest cycle.
 * `dryRun: true` (mandate sections 18/22) runs the identical scan/
 * normalize/gate logic but persists nothing: no marketing_events row is
 * written and no cursor is advanced.
 */
export async function scanSource(db, adapter, { dryRun = false, env = process.env, adapterOpts = {} } = {}) {
  ensureEventsSchema(db);
  const cursor = getCursor(db, adapter.source);
  const resolvedOpts = { repoRoot: adapter.defaultRepoRoot?.(env), ...adapterOpts };
  const rawRecords = await adapter.scanSince(cursor, resolvedOpts);

  const result = {
    source: adapter.source, rawRecords: rawRecords.length, normalized: 0,
    ingest: 0, ignore: 0, holdPrivate: 0, needsReview: 0, events: [],
  };
  let newestNativeId = cursor?.last_native_id ?? null;
  let newestTimestamp = cursor?.last_timestamp ?? null;

  for (const raw of rawRecords) {
    const normalized = adapter.normalize(raw);
    result.normalized += 1;

    let classification;
    let reasons;
    if (dryRun) {
      // Read-only duplicate check — never a write, so it's safe during a
      // dry run (ingestEvent() itself would write, so it's never called here).
      const existing = db.prepare('SELECT 1 FROM marketing_events WHERE event_id = ?').get(normalized.event_id);
      const gate = evaluateEventQuality(normalized, { isDuplicate: !!existing });
      classification = gate.classification; reasons = gate.reasons;
    } else {
      const gate = evaluateEventQuality(normalized, { isDuplicate: false });
      if (gate.classification === 'INGEST') {
        const ingestResult = ingestEvent(db, {
          eventType: normalized.event_type, sourceRepo: normalized.source_repository,
          dedupeKey: normalized.event_id, payload: toLegacyPayload(normalized),
        });
        classification = ingestResult.deduped ? 'IGNORE' : 'INGEST';
        reasons = ingestResult.deduped ? ['DUPLICATE'] : [];
      } else {
        classification = gate.classification; reasons = gate.reasons;
      }
    }

    result.events.push({ ...normalized, classification, reasons });
    if (classification === 'INGEST') result.ingest += 1;
    else if (classification === 'HOLD_PRIVATE') result.holdPrivate += 1;
    else if (classification === 'NEEDS_REVIEW') result.needsReview += 1;
    else result.ignore += 1;

    if (normalized.occurred_at && (!newestTimestamp || normalized.occurred_at > newestTimestamp)) {
      newestTimestamp = normalized.occurred_at;
      newestNativeId = normalized.source_native_id;
    }
  }

  recordScan(db, adapter.source, {
    dryRun,
    advance: rawRecords.length > 0 ? { lastNativeId: newestNativeId, lastTimestamp: newestTimestamp, lastHash: null } : null,
  });

  return result;
}

export async function scanAllSources(db, adapters, opts = {}) {
  const results = [];
  for (const adapter of adapters) {
    results.push(await scanSource(db, adapter, opts));
  }
  return results;
}
