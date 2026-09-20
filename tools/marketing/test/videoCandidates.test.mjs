import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { ingestEvent } from '../lib/events.mjs';
import { upsertDemoRun } from '../lib/videoPipeline.mjs';
import {
  candidateFromEvent, scoreCandidate, computeStoryFingerprint, isDuplicateStory,
  selectBestCandidate, minVideoScore, DEFAULT_MIN_SCORE,
} from '../lib/videoCandidates.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-candidates-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

const FACTS = [
  { id: 'FACT-009', CLAIM: 'ECHO Agent gates sensitive actions based on an identity-continuity signal, recomputed from on-disk evidence.', STATUS: 'VERIFIED' },
  { id: 'FACT-999', CLAIM: 'Unrelated capability with no special keywords here.', STATUS: 'PLANNED' },
];

const FULL_ARC_LINES = [
  '[00:02] GOAL ACCEPTED',
  '[00:06] PLAN CREATED — 5 STEPS',
  '[00:31] STEP 3 FAILED',
  '[00:32] VERIFIER — REJECT',
  '[00:34] CHECKPOINT AVAILABLE',
  '[00:55] RETRY',
  '[01:20] STEP 3 PASS',
  '[01:22] VERIFIER — PASS',
];

// --- minVideoScore ---

test('minVideoScore falls back to the conservative default when unset or invalid', () => {
  assert.equal(minVideoScore({}), DEFAULT_MIN_SCORE);
  assert.equal(minVideoScore({ MARKETING_VIDEO_MIN_SCORE: 'not-a-number' }), DEFAULT_MIN_SCORE);
  assert.equal(minVideoScore({ MARKETING_VIDEO_MIN_SCORE: '80' }), 80);
});

// --- candidateFromEvent ---

test('candidateFromEvent returns null for an event with no usable evidence (the "ordinary commit" case)', () => {
  const result = candidateFromEvent({ event_id: 'e1', event_type: 'BUG_FIXED', payload: null, fact_id: null });
  assert.equal(result, null);
});

test('candidateFromEvent builds a candidate from a real evidence payload', () => {
  const row = { event_id: 'e1', event_type: 'BUG_FIXED', source_repo: 'ECHODiscord版', received_at: '2026-09-14T00:00:00Z', fact_id: null, payload: JSON.stringify({ rawLogLines: FULL_ARC_LINES, factIds: ['FACT-009'] }) };
  const candidate = candidateFromEvent(row);
  assert.ok(candidate);
  assert.equal(candidate.rawLogLines.length, 8);
  assert.deepEqual(candidate.factIds, ['FACT-009']);
});

test('candidateFromEvent falls back to the event row\'s own fact_id when payload has no factIds array', () => {
  const row = { event_id: 'e1', event_type: 'NEW_FEATURE_VERIFIED', fact_id: 'FACT-009', payload: JSON.stringify({ rawLogLines: ['[00:01] x'] }) };
  const candidate = candidateFromEvent(row);
  assert.deepEqual(candidate.factIds, ['FACT-009']);
});

// --- scoreCandidate ---

test('scoreCandidate gives a full-arc, fact-backed, clean-evidence candidate a high score', () => {
  const candidate = { rawLogLines: FULL_ARC_LINES, factIds: ['FACT-009'], eventType: 'BUG_FIXED', title: null, description: null };
  const result = scoreCandidate(candidate, { facts: FACTS });
  assert.ok(result.total >= DEFAULT_MIN_SCORE, `expected a strong candidate to score >= ${DEFAULT_MIN_SCORE}, got ${result.total}`);
  assert.equal(result.evidenceClean, true);
  assert.equal(result.dimensions.VERIFIER_VALUE > 50, true);
});

test('scoreCandidate scores a candidate with no real log lines and no facts very low', () => {
  const candidate = { rawLogLines: [], factIds: [], eventType: 'BUG_FIXED', title: 'just a title', description: null };
  const result = scoreCandidate(candidate, { facts: FACTS });
  assert.ok(result.total < DEFAULT_MIN_SCORE);
});

test('scoreCandidate fails PRIVACY_SAFETY (score 0 on that dimension, evidenceClean false) when a log line contains a secret shape', () => {
  const candidate = { rawLogLines: ['DEBUG: STRIPE_SECRET_KEY=sk_live_abc123def456ghi789'], factIds: ['FACT-009'], eventType: 'BUG_FIXED', title: null, description: null };
  const result = scoreCandidate(candidate, { facts: FACTS });
  assert.equal(result.dimensions.PRIVACY_SAFETY, 0);
  assert.equal(result.evidenceClean, false);
});

test('scoreCandidate does not manufacture TENSION/RECOVERY for a routine success', () => {
  const routine = ['[00:02] GOAL ACCEPTED', '[00:10] STEP 1 PASS', '[00:11] RESULT SUCCESS'];
  const candidate = { rawLogLines: routine, factIds: ['FACT-009'], eventType: 'TEST_SUITE_PASS', title: null, description: null };
  const result = scoreCandidate(candidate, { facts: FACTS });
  assert.equal(result.dimensions.TENSION, 20);
  assert.equal(result.dimensions.RECOVERY, 20);
});

// --- fingerprint / duplicate detection ---

test('computeStoryFingerprint is deterministic and content-based, not id-based', () => {
  const a = { factIds: ['FACT-009'], rawLogLines: ['x', 'y'] };
  const b = { factIds: ['FACT-009'], rawLogLines: ['x', 'y'] };
  const c = { factIds: ['FACT-009'], rawLogLines: ['x', 'z'] };
  assert.equal(computeStoryFingerprint(a), computeStoryFingerprint(b));
  assert.notEqual(computeStoryFingerprint(a), computeStoryFingerprint(c));
});

test('isDuplicateStory detects a fingerprint already recorded on an existing demo run', () => {
  const { dir, db } = tempDb();
  try {
    const fp = computeStoryFingerprint({ factIds: ['FACT-009'], rawLogLines: ['x'] });
    assert.equal(isDuplicateStory(db, fp), false);
    upsertDemoRun(db, 'demo1', { story_fingerprint: fp });
    assert.equal(isDuplicateStory(db, fp), true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- selectBestCandidate (the full engine) ---

test('selectBestCandidate returns null (NO_VIDEO) when no ingested event has usable evidence', () => {
  const { dir, db } = tempDb();
  try {
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e1' }); // no payload at all
    const result = selectBestCandidate(db, { facts: FACTS });
    assert.equal(result.selected, null);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('selectBestCandidate selects the highest-scoring qualifying candidate among several', () => {
  const { dir, db } = tempDb();
  try {
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'weak', payload: { rawLogLines: ['[00:01] nothing much happened'], factIds: [] } });
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'strong', payload: { rawLogLines: FULL_ARC_LINES, factIds: ['FACT-009'] } });
    const result = selectBestCandidate(db, { facts: FACTS });
    assert.ok(result.selected);
    assert.deepEqual(result.selected.candidate.factIds, ['FACT-009']);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('selectBestCandidate refuses a candidate whose evidence fails the privacy scan, even if it would otherwise score high', () => {
  const { dir, db } = tempDb();
  try {
    const dirtyLines = [...FULL_ARC_LINES, 'DEBUG: STRIPE_SECRET_KEY=sk_live_abc123def456ghi789'];
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'dirty', payload: { rawLogLines: dirtyLines, factIds: ['FACT-009'] } });
    const result = selectBestCandidate(db, { facts: FACTS });
    assert.equal(result.selected, null);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('selectBestCandidate never re-selects the same story twice (duplicate prevention across runs)', () => {
  const { dir, db } = tempDb();
  try {
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e1', payload: { rawLogLines: FULL_ARC_LINES, factIds: ['FACT-009'] } });
    const first = selectBestCandidate(db, { facts: FACTS });
    assert.ok(first.selected);
    upsertDemoRun(db, 'demo1', { story_fingerprint: first.selected.fingerprint });

    // A second, textually-identical event arrives later (e.g. a repeated notification of the same underlying fix).
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e2', payload: { rawLogLines: FULL_ARC_LINES, factIds: ['FACT-009'] } });
    const second = selectBestCandidate(db, { facts: FACTS });
    assert.equal(second.selected, null, 'must not select the same story fingerprint twice');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('selectBestCandidate marks every considered event processed, so re-running does not re-score the same events', () => {
  const { dir, db } = tempDb();
  try {
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e1', payload: { rawLogLines: FULL_ARC_LINES, factIds: ['FACT-009'] } });
    selectBestCandidate(db, { facts: FACTS });
    const stillUnprocessed = db.prepare('SELECT COUNT(*) c FROM marketing_events WHERE processed_at IS NULL').get().c;
    assert.equal(stillUnprocessed, 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('selectBestCandidate respects a custom minScore threshold', () => {
  const { dir, db } = tempDb();
  try {
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e1', payload: { rawLogLines: FULL_ARC_LINES, factIds: ['FACT-009'] } });
    const result = selectBestCandidate(db, { facts: FACTS, minScore: 99 });
    assert.equal(result.selected, null, 'even a strong candidate should not qualify against an unreachably high threshold');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- dryRun preview (status reporting / selection-preview, mandate sections 16 & 19) ---

test('selectBestCandidate with dryRun:true returns the same selection as a real run, but marks nothing processed', () => {
  const { dir, db } = tempDb();
  try {
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e1', payload: { rawLogLines: FULL_ARC_LINES, factIds: ['FACT-009'] } });
    const preview = selectBestCandidate(db, { facts: FACTS, dryRun: true });
    assert.ok(preview.selected, 'the strong candidate should still be selected in preview mode');

    const stillUnprocessed = db.prepare('SELECT COUNT(*) c FROM marketing_events WHERE processed_at IS NULL').get().c;
    assert.equal(stillUnprocessed, 1, 'dryRun must not mark the event processed');

    // A real (non-dry) run afterwards must still see and select the same event.
    const real = selectBestCandidate(db, { facts: FACTS });
    assert.equal(real.selected.fingerprint, preview.selected.fingerprint);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('selectBestCandidate with dryRun:true does not prevent a later real run from re-scoring the same event', () => {
  const { dir, db } = tempDb();
  try {
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e1', payload: { rawLogLines: FULL_ARC_LINES, factIds: ['FACT-009'] } });
    selectBestCandidate(db, { facts: FACTS, dryRun: true });
    selectBestCandidate(db, { facts: FACTS, dryRun: true });
    selectBestCandidate(db, { facts: FACTS, dryRun: true });
    const stillUnprocessed = db.prepare('SELECT COUNT(*) c FROM marketing_events WHERE processed_at IS NULL').get().c;
    assert.equal(stillUnprocessed, 1, 'repeated dryRun previews must be idempotent no-ops, not slowly consuming events');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});
