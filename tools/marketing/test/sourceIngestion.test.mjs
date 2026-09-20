import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { scanSource, scanAllSources } from '../lib/sourceIngestion.mjs';
import { getCursor } from '../lib/sourceCursors.mjs';
import { buildNormalizedEvent } from '../lib/sourceEventSchema.mjs';
import { candidateFromEvent, scoreCandidate, selectBestCandidate } from '../lib/videoCandidates.mjs';
import { unprocessedEvents } from '../lib/events.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-ingestion-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

/** A minimal mock adapter — deliberately NOT one of the real product
 * adapters, so these tests exercise the orchestrator's own logic in
 * isolation from any real repo's scanning quirks. */
function mockAdapter({ source = 'mock-source', records = [], normalizeFn } = {}) {
  return {
    source,
    scanSince: async () => records,
    normalize: normalizeFn ?? ((raw) => buildNormalizedEvent(raw)),
  };
}

const GOOD_RECORD = {
  source_repository: 'MockRepo', source_kind: 'mock_kind', source_native_id: 'evt-1',
  event_type: 'BUG_FIXED', evidence_refs: ['ref:1'], verification_state: 'VERIFIED', public_safety_state: 'PUBLIC_SAFE',
};

test('a real (non-dry) scan of an INGEST-worthy record persists exactly one marketing_events row', async () => {
  const { dir, db } = tempDb();
  try {
    const adapter = mockAdapter({ records: [GOOD_RECORD] });
    const result = await scanSource(db, adapter, { dryRun: false });
    assert.equal(result.ingest, 1);
    const rows = db.prepare('SELECT COUNT(*) c FROM marketing_events').get().c;
    assert.equal(rows, 1);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('dry-run does not persist any marketing_events row, even for an otherwise-INGEST-worthy record', async () => {
  const { dir, db } = tempDb();
  try {
    const adapter = mockAdapter({ records: [GOOD_RECORD] });
    const result = await scanSource(db, adapter, { dryRun: true });
    assert.equal(result.ingest, 1, 'still reported as "would ingest" for status/preview purposes');
    const rows = db.prepare('SELECT COUNT(*) c FROM marketing_events').get().c;
    assert.equal(rows, 0, 'dry-run must never write a real event row');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('dry-run does not advance the source cursor', async () => {
  const { dir, db } = tempDb();
  try {
    const adapter = mockAdapter({ records: [GOOD_RECORD] });
    await scanSource(db, adapter, { dryRun: true });
    assert.equal(getCursor(db, adapter.source), null);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('a real scan DOES advance the cursor, based on the newest occurred_at seen', async () => {
  const { dir, db } = tempDb();
  try {
    const adapter = mockAdapter({ records: [{ ...GOOD_RECORD, occurred_at: '2026-09-01T00:00:00Z' }] });
    await scanSource(db, adapter, { dryRun: false });
    const cursor = getCursor(db, adapter.source);
    assert.equal(cursor.last_timestamp, '2026-09-01T00:00:00Z');
    assert.ok(cursor.last_scan_at);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('the same underlying source record scanned twice (e.g. cursor not yet advanced, simulating a crash-and-resume) is ingested only once — dedup via the stable fingerprint', async () => {
  const { dir, db } = tempDb();
  try {
    const adapter = mockAdapter({ records: [GOOD_RECORD] }); // same record every call, ignores cursor
    const first = await scanSource(db, adapter, { dryRun: false });
    const second = await scanSource(db, adapter, { dryRun: false });
    assert.equal(first.ingest, 1);
    assert.equal(second.ingest, 0);
    assert.equal(second.ignore, 1, 'the second scan must classify the already-ingested record as a duplicate');
    const rows = db.prepare('SELECT COUNT(*) c FROM marketing_events').get().c;
    assert.equal(rows, 1, 'never a second row for the same underlying record');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('a private/held record is classified but never ingested into marketing_events', async () => {
  const { dir, db } = tempDb();
  try {
    const adapter = mockAdapter({ records: [{ ...GOOD_RECORD, public_safety_state: 'NOT_PUBLIC' }] });
    const result = await scanSource(db, adapter, { dryRun: false });
    assert.equal(result.holdPrivate, 1);
    assert.equal(result.ingest, 0);
    const rows = db.prepare('SELECT COUNT(*) c FROM marketing_events').get().c;
    assert.equal(rows, 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('an adapter that aggregates many raw log lines into ONE candidate before scanSince() returns produces exactly one marketing_events row, not one per line', async () => {
  const { dir, db } = tempDb();
  try {
    // Simulates what sourceAdapters/echoAgent.mjs's groupCompletedTaskRuns()
    // does: 20 raw trajectory rows collapse to 1 raw candidate BEFORE
    // scanSince() even returns — the orchestrator only ever sees the
    // already-aggregated record.
    const adapter = mockAdapter({ records: [{ ...GOOD_RECORD, source_native_id: 'task-run-with-20-events' }] });
    const result = await scanSource(db, adapter, { dryRun: false });
    assert.equal(result.rawRecords, 1, '20 log lines != 20 raw records once the adapter aggregates them itself');
    assert.equal(result.ingest, 1);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- bridge to the EXISTING, unchanged story engine (mandate section 15) ---
// A real integration gap caught while running the section-19 real scan:
// the canonical schema (evidence_refs/summary/contains_*) does not, by
// itself, match what lib/videoCandidates.mjs's candidateFromEvent() reads
// (payload.rawLogLines/factIds/title/description) — without the bridge in
// lib/sourceIngestion.mjs's toLegacyPayload(), every real ingested event
// would silently score as "no usable evidence" and never become a video
// candidate. These tests pin that bridge.

test('an ingested source event is actually consumable by the EXISTING candidateFromEvent() — not silently treated as "no usable evidence"', async () => {
  const { dir, db } = tempDb();
  try {
    const normalized = buildNormalizedEvent({
      source_repository: 'ECHOapp', source_kind: 'git_milestone_tag', source_native_id: 'tag-x',
      event_type: 'NEW_FEATURE_VERIFIED', evidence_refs: ['tag:tag-x'], verification_state: 'VERIFIED',
      public_safety_state: 'PUBLIC_SAFE', title: 'A real milestone', summary: 'A real milestone summary.',
    });
    const adapter = mockAdapter({ records: [normalized] });
    await scanSource(db, adapter, { dryRun: false });

    const [eventRow] = unprocessedEvents(db);
    assert.ok(eventRow, 'the event must actually be persisted and unprocessed');
    const candidate = candidateFromEvent(eventRow);
    assert.ok(candidate, 'candidateFromEvent() must be able to build a candidate from an ingested source event');
    assert.ok(candidate.rawLogLines.length > 0);
    assert.equal(candidate.title, 'A real milestone');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('a bridged event with real story signals (failure + recovery + verifier) scores meaningfully via the existing scoreCandidate()', async () => {
  const { dir, db } = tempDb();
  try {
    const normalized = buildNormalizedEvent({
      source_repository: 'ECHODiscord版', source_kind: 'trajectory_task_run', source_native_id: 'run-x',
      event_type: 'REAL_TASK_RECOVERED', evidence_refs: ['ref:1'], verification_state: 'VERIFIED', public_safety_state: 'PUBLIC_SAFE',
      title: 'ECHO Agent recovered a real task after a failure', summary: 'Task run recovered.',
      contains_failure: true, contains_recovery: true, contains_verifier_result: true,
    });
    const adapter = mockAdapter({ records: [normalized] });
    await scanSource(db, adapter, { dryRun: false });

    const [eventRow] = unprocessedEvents(db);
    const candidate = candidateFromEvent(eventRow);
    const result = scoreCandidate(candidate, { facts: [] });
    assert.ok(result.total > 0);
    assert.equal(result.narrativeBeats.failure, true);
    assert.equal(result.narrativeBeats.retry, true);
    // contains_failure + contains_verifier_result together synthesize a
    // "VERIFIER — REJECT" line (the failed attempt was rejected before the
    // retry succeeded) — the full flagship arc: failure -> reject -> retry.
    assert.equal(result.narrativeBeats.verifierRejection, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('selectBestCandidate() (the actual daily-video selection function) can select a real bridged source event end-to-end', async () => {
  const { dir, db } = tempDb();
  try {
    const normalized = buildNormalizedEvent({
      source_repository: 'ECHODiscord版', source_kind: 'trajectory_task_run', source_native_id: 'run-y',
      event_type: 'REAL_TASK_RECOVERED', evidence_refs: ['ref:1'], verification_state: 'VERIFIED', public_safety_state: 'PUBLIC_SAFE',
      title: 'ECHO Agent recovered a real task after a failure', summary: 'Task run recovered.',
      contains_failure: true, contains_recovery: true, contains_verifier_result: true, contains_checkpoint_resume: true,
    });
    const adapter = mockAdapter({ records: [normalized] });
    await scanSource(db, adapter, { dryRun: false });

    const selection = selectBestCandidate(db, { facts: [], minScore: 0 });
    assert.ok(selection.selected, 'a real, verified, story-signal-rich source event must be selectable as a video candidate');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('scanAllSources runs every adapter and reports one result per source', async () => {
  const { dir, db } = tempDb();
  try {
    const a = mockAdapter({ source: 'a', records: [GOOD_RECORD] });
    const b = mockAdapter({ source: 'b', records: [] });
    const results = await scanAllSources(db, [a, b], { dryRun: false });
    assert.equal(results.length, 2);
    assert.equal(results[0].source, 'a');
    assert.equal(results[0].ingest, 1);
    assert.equal(results[1].source, 'b');
    assert.equal(results[1].rawRecords, 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});
