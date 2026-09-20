import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import {
  ensureActivationBoundary, getActivationBoundary, isPreActivation,
  recordClassification, getClassifications, classifyActivationBaseline,
} from '../lib/activation.mjs';
import { ingestEvent, unprocessedEvents, markEventProcessed } from '../lib/events.mjs';
import { recordIntent, pendingPublications } from '../lib/ledger.mjs';
import { candidateFromEvent, computeStoryFingerprint, isDuplicateStory } from '../lib/videoCandidates.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-activation-test-'));
  const db = openDb(join(dir, 'test.db'));
  return { dir, db };
}

test('getActivationBoundary is null before any activation', () => {
  const { dir, db } = tempDb();
  try {
    assert.equal(getActivationBoundary(db), null);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureActivationBoundary sets the boundary once and never moves it on a later call', () => {
  const { dir, db } = tempDb();
  try {
    const first = ensureActivationBoundary(db, '2026-09-15T00:00:00.000Z');
    assert.equal(first.created, true);
    assert.equal(first.boundary, '2026-09-15T00:00:00.000Z');

    const second = ensureActivationBoundary(db, '2099-01-01T00:00:00.000Z');
    assert.equal(second.created, false);
    assert.equal(second.boundary, '2026-09-15T00:00:00.000Z');
    assert.equal(getActivationBoundary(db), '2026-09-15T00:00:00.000Z');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isPreActivation: no boundary set => nothing is gated', () => {
  assert.equal(isPreActivation('2020-01-01', null), false);
});

test('isPreActivation: missing candidate timestamp fails closed (treated as pre-activation)', () => {
  assert.equal(isPreActivation(null, '2026-09-15T00:00:00.000Z'), true);
  assert.equal(isPreActivation(undefined, '2026-09-15T00:00:00.000Z'), true);
});

test('isPreActivation: correctly compares date-only and full-datetime ISO strings', () => {
  assert.equal(isPreActivation('2026-09-14', '2026-09-15T00:00:00.000Z'), true);
  assert.equal(isPreActivation('2026-09-20', '2026-09-15T00:00:00.000Z'), false);
});

test('isPreActivation: a candidate timestamp EXACTLY equal to the boundary (same precision) is NOT pre-activation', () => {
  assert.equal(isPreActivation('2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z'), false);
  assert.equal(isPreActivation('2026-09-15', '2026-09-15'), false);
});

test('isPreActivation: a candidate timestamp after the boundary is NOT pre-activation', () => {
  assert.equal(isPreActivation('2026-09-16T00:00:00.000Z', '2026-09-15T00:00:00.000Z'), false);
});

test('recordClassification upserts on (kind, item_id) — a second call updates rather than duplicates', () => {
  const { dir, db } = tempDb();
  try {
    recordClassification(db, { kind: 'marketing_event', itemId: 'ev1', bucket: 'MANUAL_REVIEW', reason: 'first pass' });
    recordClassification(db, { kind: 'marketing_event', itemId: 'ev1', bucket: 'BASELINE_BEFORE_LIVE', reason: 'reclassified' });
    const rows = getClassifications(db, 'marketing_event');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].bucket, 'BASELINE_BEFORE_LIVE');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- classifyActivationBaseline: the real end-to-end pass ---

test('classifyActivationBaseline: a plain unlinked event with usable evidence and no dup is BASELINE_BEFORE_LIVE and gets marked processed', () => {
  const { dir, db } = tempDb();
  try {
    // rawLogLines is required for candidateFromEvent() to build a real
    // candidate at all — matches how sourceIngestion.mjs's real adapters
    // always populate it (toLegacyPayload's synthesizeRawLogLines()).
    ingestEvent(db, { eventType: 'NEW_FEATURE_VERIFIED', sourceRepo: 'ECHOapp', dedupeKey: 'ev-a', payload: { rawLogLines: ['real evidence line'] } });
    const result = classifyActivationBaseline(db, {
      facts: [], unprocessedEvents, markEventProcessed, pendingPublications,
      candidateFromEvent, computeStoryFingerprint, isDuplicateStory,
    });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].bucket, 'BASELINE_BEFORE_LIVE');
    assert.equal(unprocessedEvents(db).length, 0, 'must be marked processed so the video scheduler never reconsiders it');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyActivationBaseline: an event already linked to a fact_id is ALREADY_CONSUMED', () => {
  const { dir, db } = tempDb();
  try {
    ingestEvent(db, { eventType: 'RELEASE_READY', sourceRepo: 'echo-r', factId: 'FACT-001', dedupeKey: 'ev-b' });
    const result = classifyActivationBaseline(db, {
      facts: [], unprocessedEvents, markEventProcessed, pendingPublications,
      candidateFromEvent, computeStoryFingerprint, isDuplicateStory,
    });
    assert.equal(result.events[0].bucket, 'ALREADY_CONSUMED');
    assert.equal(unprocessedEvents(db).length, 0);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyActivationBaseline: an event detected AT OR AFTER the boundary is POST_BOUNDARY_NOT_HISTORICAL and stays UNPROCESSED (regression test for the audit-found bug)', () => {
  const { dir, db } = tempDb();
  try {
    // Boundary set explicitly in the far past — any event ingested "now"
    // (ingestEvent() always stamps received_at = new Date().toISOString(),
    // no injectable override) is genuinely AFTER it.
    ensureActivationBoundary(db, '2000-01-01T00:00:00.000Z');
    ingestEvent(db, { eventType: 'NEW_FEATURE_VERIFIED', sourceRepo: 'ECHOapp', dedupeKey: 'ev-post-boundary', payload: { rawLogLines: ['real evidence line'] } });
    const result = classifyActivationBaseline(db, {
      facts: [], unprocessedEvents, markEventProcessed, pendingPublications,
      candidateFromEvent, computeStoryFingerprint, isDuplicateStory,
    });
    assert.equal(result.events[0].bucket, 'POST_BOUNDARY_NOT_HISTORICAL');
    assert.notEqual(result.events[0].bucket, 'BASELINE_BEFORE_LIVE');
    assert.equal(unprocessedEvents(db).length, 1, 'a genuinely post-boundary event must NEVER be marked processed — it must stay available for the video pipeline to actually consider, exactly as it would with no activation pass having run at all');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyActivationBaseline: an event with a missing/malformed received_at fails closed to MANUAL_REVIEW, never silently marked processed', () => {
  const { dir, db } = tempDb();
  try {
    ingestEvent(db, { eventType: 'NEW_FEATURE_VERIFIED', sourceRepo: 'ECHOapp', dedupeKey: 'ev-malformed', payload: { rawLogLines: ['real evidence line'] } });
    // Directly corrupt the stored timestamp to simulate a malformed/garbage
    // value reaching this point — ingestEvent() itself always stamps a real
    // ISO timestamp, so this is the only way to exercise this path.
    db.prepare('UPDATE marketing_events SET received_at = ? WHERE event_id = ?').run('not-a-real-timestamp', 'ev-malformed');
    const result = classifyActivationBaseline(db, {
      facts: [], unprocessedEvents, markEventProcessed, pendingPublications,
      candidateFromEvent, computeStoryFingerprint, isDuplicateStory,
    });
    assert.equal(result.events[0].bucket, 'MANUAL_REVIEW');
    assert.equal(unprocessedEvents(db).length, 1, 'a malformed timestamp must never be silently resolved as historical/processed');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyActivationBaseline: never mutates a publication_ledger row\'s approval_state, and never makes a network call', () => {
  const { dir, db } = tempDb();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('UNEXPECTED_NETWORK_CALL: classifyActivationBaseline must never touch the network'); };
  try {
    ingestEvent(db, { eventType: 'NEW_FEATURE_VERIFIED', sourceRepo: 'ECHOapp', dedupeKey: 'ev-net', payload: { rawLogLines: ['real evidence line'] } });
    const before = recordIntent(db, {
      channel: 'x', text: 'a draft', contentType: 'x_post', sourceEvidence: 'FACT-002',
      riskClass: 'AUTO', approvalState: 'AUTO_APPROVED',
    });
    classifyActivationBaseline(db, {
      facts: [{ id: 'FACT-002', VERIFIED_AT: '2020-01-01' }], unprocessedEvents, markEventProcessed, pendingPublications,
      candidateFromEvent, computeStoryFingerprint, isDuplicateStory,
    });
    const after = db.prepare('SELECT approval_state, published_at, result FROM publication_ledger WHERE publication_id = ?').get(before.publication_id);
    assert.equal(after.approval_state, 'AUTO_APPROVED', 'approval_state must be untouched by classification');
    assert.equal(after.published_at, null, 'classification must never publish anything');
    assert.equal(after.result, null);
  } finally {
    globalThis.fetch = realFetch;
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyActivationBaseline: MANUAL_REVIEW events are classified but left unprocessed (not silently excluded)', () => {
  const { dir, db } = tempDb();
  try {
    ingestEvent(db, { eventType: 'BUG_FIXED', sourceRepo: 'echo-r', dedupeKey: 'ev-c' }); // no payload => candidateFromEvent likely returns null
    const result = classifyActivationBaseline(db, {
      facts: [], unprocessedEvents, markEventProcessed, pendingPublications,
      candidateFromEvent: () => null, // force the no-usable-evidence path deterministically
      computeStoryFingerprint, isDuplicateStory,
    });
    assert.equal(result.events[0].bucket, 'MANUAL_REVIEW');
    assert.equal(unprocessedEvents(db).length, 1, 'MANUAL_REVIEW must stay unprocessed for a human/future pass to still see it');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyActivationBaseline: a HUMAN_APPROVAL_REQUIRED pending publication is SAFE_TO_KEEP_PENDING', () => {
  const { dir, db } = tempDb();
  try {
    recordIntent(db, {
      channel: 'x', text: 'a human-gated post', contentType: 'x_post', sourceEvidence: 'FACT-001',
      riskClass: 'HUMAN_APPROVAL_REQUIRED', approvalState: 'PENDING_HUMAN_APPROVAL',
    });
    const result = classifyActivationBaseline(db, {
      facts: [{ id: 'FACT-001' }], unprocessedEvents, markEventProcessed, pendingPublications,
      candidateFromEvent, computeStoryFingerprint, isDuplicateStory,
    });
    assert.equal(result.pendingPublications[0].bucket, 'SAFE_TO_KEEP_PENDING');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyActivationBaseline: an AUTO-approved pending publication whose backing fact VERIFIED_AT predates the boundary is HISTORICAL_PENDING', () => {
  const { dir, db } = tempDb();
  try {
    recordIntent(db, {
      channel: 'x', text: 'an auto-approved draft', contentType: 'x_post', sourceEvidence: 'FACT-002',
      riskClass: 'AUTO', approvalState: 'AUTO_APPROVED',
    });
    const result = classifyActivationBaseline(db, {
      facts: [{ id: 'FACT-002', VERIFIED_AT: '2020-01-01' }], unprocessedEvents, markEventProcessed, pendingPublications,
      candidateFromEvent, computeStoryFingerprint, isDuplicateStory,
    });
    assert.equal(result.pendingPublications[0].bucket, 'HISTORICAL_PENDING');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyActivationBaseline: an AUTO-approved pending publication whose backing fact VERIFIED_AT is AT OR AFTER the boundary is POST_BOUNDARY_PENDING, never HISTORICAL_PENDING', () => {
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2026-09-01T00:00:00.000Z');
    recordIntent(db, {
      channel: 'x', text: 'a fresh auto-approved draft', contentType: 'x_post', sourceEvidence: 'FACT-002',
      riskClass: 'AUTO', approvalState: 'AUTO_APPROVED',
    });
    const result = classifyActivationBaseline(db, {
      facts: [{ id: 'FACT-002', VERIFIED_AT: '2026-09-02' }], unprocessedEvents, markEventProcessed, pendingPublications,
      candidateFromEvent, computeStoryFingerprint, isDuplicateStory,
    });
    assert.equal(result.pendingPublications[0].bucket, 'POST_BOUNDARY_PENDING');
    assert.notEqual(result.pendingPublications[0].bucket, 'HISTORICAL_PENDING');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyActivationBaseline: an AUTO-approved pending publication whose backing fact has no usable VERIFIED_AT fails closed to MANUAL_REVIEW, never HISTORICAL_PENDING', () => {
  const { dir, db } = tempDb();
  try {
    recordIntent(db, {
      channel: 'x', text: 'a draft with an unparseable backing fact date', contentType: 'x_post', sourceEvidence: 'FACT-002',
      riskClass: 'AUTO', approvalState: 'AUTO_APPROVED',
    });
    const result = classifyActivationBaseline(db, {
      facts: [{ id: 'FACT-002', VERIFIED_AT: 'not-a-real-date' }], unprocessedEvents, markEventProcessed, pendingPublications,
      candidateFromEvent, computeStoryFingerprint, isDuplicateStory,
    });
    assert.equal(result.pendingPublications[0].bucket, 'MANUAL_REVIEW');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyActivationBaseline: an AUTO-approved pending publication whose fact no longer exists is DISCARD_AS_OBSOLETE', () => {
  const { dir, db } = tempDb();
  try {
    recordIntent(db, {
      channel: 'x', text: 'a stale draft', contentType: 'x_post', sourceEvidence: 'FACT-999-REMOVED',
      riskClass: 'AUTO', approvalState: 'AUTO_APPROVED',
    });
    const result = classifyActivationBaseline(db, {
      facts: [{ id: 'FACT-002' }], unprocessedEvents, markEventProcessed, pendingPublications,
      candidateFromEvent, computeStoryFingerprint, isDuplicateStory,
    });
    assert.equal(result.pendingPublications[0].bucket, 'DISCARD_AS_OBSOLETE');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyActivationBaseline: a pending YouTube item is PRIVATE_VIDEO_REVIEW', () => {
  const { dir, db } = tempDb();
  try {
    recordIntent(db, {
      channel: 'youtube', text: 'n/a', contentType: 'youtube_public_announce', sourceEvidence: 'FACT-003',
      riskClass: 'HUMAN_APPROVAL_REQUIRED', approvalState: 'PENDING_HUMAN_APPROVAL',
    });
    const result = classifyActivationBaseline(db, {
      facts: [{ id: 'FACT-003' }], unprocessedEvents, markEventProcessed, pendingPublications,
      candidateFromEvent, computeStoryFingerprint, isDuplicateStory,
    });
    assert.equal(result.pendingPublications[0].bucket, 'PRIVATE_VIDEO_REVIEW');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyActivationBaseline is idempotent: re-running after a full pass classifies nothing new (all already resolved)', () => {
  const { dir, db } = tempDb();
  try {
    ingestEvent(db, { eventType: 'NEW_FEATURE_VERIFIED', sourceRepo: 'ECHOapp', dedupeKey: 'ev-d', payload: { rawLogLines: ['real evidence line'] } });
    recordIntent(db, {
      channel: 'x', text: 'a draft', contentType: 'x_post', sourceEvidence: 'FACT-002',
      riskClass: 'AUTO', approvalState: 'AUTO_APPROVED',
    });
    const deps = { facts: [{ id: 'FACT-002', VERIFIED_AT: '2020-01-01' }], unprocessedEvents, markEventProcessed, pendingPublications, candidateFromEvent, computeStoryFingerprint, isDuplicateStory };
    const first = classifyActivationBaseline(db, deps);
    assert.equal(first.events.length, 1);

    const second = classifyActivationBaseline(db, deps);
    // The event was marked processed by the first pass, so it's no longer
    // "unprocessed" and the second pass sees zero new events to classify.
    assert.equal(second.events.length, 0);
    // Pending publications have no "processed" concept, so the same pending
    // row is reclassified (idempotently, to the same bucket) every pass.
    assert.equal(second.pendingPublications.length, 1);
    assert.equal(second.pendingPublications[0].bucket, 'HISTORICAL_PENDING');
    assert.equal(second.boundary, first.boundary, 'boundary must never move on a re-run');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});
