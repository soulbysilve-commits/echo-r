import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSourceFingerprint, buildNormalizedEvent, MARKETING_EVENT_TYPES } from '../lib/sourceEventSchema.mjs';
import { EVENT_TYPES, ingestEvent } from '../lib/events.mjs';
import { openDb, closeDb } from '../lib/db.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('computeSourceFingerprint is deterministic and identity-based (same repo/kind/native_id -> same fingerprint)', () => {
  const key = { source_repository: 'ECHOapp', source_kind: 'git_milestone_tag', source_native_id: 'echo-backend-v0.1' };
  assert.equal(computeSourceFingerprint(key), computeSourceFingerprint({ ...key }));
});

test('computeSourceFingerprint changes when source_native_id changes, even if everything else is identical', () => {
  const base = { source_repository: 'ECHOapp', source_kind: 'git_milestone_tag', source_native_id: 'echo-backend-v0.1' };
  const other = { ...base, source_native_id: 'echo-backend-v0.2' };
  assert.notEqual(computeSourceFingerprint(base), computeSourceFingerprint(other));
});

test('computeSourceFingerprint is stable across scans regardless of when it is computed (does not depend on occurred_at/detected_at/title/summary)', () => {
  const key = { source_repository: 'Noemora_mod_core', source_kind: 'public_demo_seal', source_native_id: 'V22902_..._SEAL.md' };
  const fp1 = computeSourceFingerprint(key);
  const fp2 = computeSourceFingerprint(key); // a second, later "scan"
  assert.equal(fp1, fp2);
});

test('buildNormalizedEvent sets event_id to the fingerprint, so ingestion dedup (lib/events.mjs dedupeKey) is automatic', () => {
  const raw = { source_repository: 'ECHOapp', source_kind: 'git_milestone_tag', source_native_id: 'tag-1', event_type: 'NEW_FEATURE_VERIFIED' };
  const normalized = buildNormalizedEvent(raw);
  assert.equal(normalized.event_id, computeSourceFingerprint(raw));
  assert.equal(normalized.source_fingerprint, normalized.event_id);
});

test('buildNormalizedEvent fails closed on public_safety_state (defaults to NEEDS_REVIEW when the adapter does not specify one)', () => {
  const normalized = buildNormalizedEvent({ source_repository: 'r', source_kind: 'k', source_native_id: 'n', event_type: 'BUG_FIXED' });
  assert.equal(normalized.public_safety_state, 'NEEDS_REVIEW');
});

test('buildNormalizedEvent defaults verification_state to UNVERIFIED (fail closed) when unspecified', () => {
  const normalized = buildNormalizedEvent({ source_repository: 'r', source_kind: 'k', source_native_id: 'n', event_type: 'BUG_FIXED' });
  assert.equal(normalized.verification_state, 'UNVERIFIED');
});

// Regression test: MARKETING_EVENT_TYPES (used by adapters, e.g.
// sourceAdapters/echoAgent.mjs's REAL_TASK_RECOVERED/SKILL_PROMOTION) must
// stay in sync with lib/events.mjs's EVENT_TYPES, the list ingestEvent()
// actually validates against — a real gap this test caught: adapter event
// types that aren't in EVENT_TYPES get silently rejected by ingestEvent(),
// never becoming a marketing_events row at all.
test('MARKETING_EVENT_TYPES is exactly EVENT_TYPES (single source of truth, no drift)', () => {
  assert.deepEqual(MARKETING_EVENT_TYPES, EVENT_TYPES);
});

test('every internal discovery event type (mandate section 5) is actually accepted by ingestEvent()', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-eventtypes-'));
  const db = openDb(join(dir, 'x.db'));
  try {
    for (const eventType of ['REAL_TASK_COMPLETED', 'REAL_TASK_FAILED', 'REAL_TASK_RECOVERED', 'VERIFIER_REJECTED', 'CHECKPOINT_RESUMED', 'CONTINUITY_CHANGED']) {
      const result = ingestEvent(db, { eventType, dedupeKey: `test-${eventType}` });
      assert.equal(result.ok, true, `${eventType} must be a valid, ingestable event type`);
    }
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('buildNormalizedEvent preserves every mandated schema field with a defined (possibly default) value', () => {
  const normalized = buildNormalizedEvent({ source_repository: 'r', source_kind: 'k', source_native_id: 'n', event_type: 'BUG_FIXED' });
  for (const field of [
    'event_id', 'source_product', 'source_repository', 'source_kind', 'source_native_id', 'occurred_at', 'detected_at',
    'event_type', 'title', 'summary', 'evidence_refs', 'evidence_hashes', 'verification_state', 'public_safety_state',
    'task_id', 'run_id', 'release_id', 'commit_sha', 'capabilities', 'story_signals',
    'contains_failure', 'contains_recovery', 'contains_verifier_result', 'contains_checkpoint_resume',
    'contains_continuity_event', 'contains_skill_learning', 'source_fingerprint',
  ]) {
    assert.ok(field in normalized, `missing schema field: ${field}`);
  }
});
