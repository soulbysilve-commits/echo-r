import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { ingestEvent, markEventProcessed, unprocessedEvents, EVENT_TYPES } from '../lib/events.mjs';
import { analyzePerformance, proposeStrategyChange, recordStrategyDecision, strategyHistory, nextStrategyVersion } from '../lib/learning.mjs';
import { upsertMemory } from '../lib/memory.mjs';
import { createExperiment, attachVariantContent, evaluateExperiment } from '../lib/experiments.mjs';
import { recordMarketEntry, recordCompetitorFact, canBackPublicClaim, EVIDENCE_CLASS, CONFIDENCE } from '../lib/market.mjs';
import { writeWeeklyReport } from '../lib/weekly.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-growth-test-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

// --- Events ---

test('ingestEvent rejects unknown event types', () => {
  const { dir, db } = tempDb();
  try {
    const result = ingestEvent(db, { eventType: 'MADE_UP_EVENT' });
    assert.equal(result.ok, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('ingestEvent is idempotent on dedupeKey (event id)', () => {
  const { dir, db } = tempDb();
  try {
    const first = ingestEvent(db, { eventType: 'TEST_SUITE_PASS', dedupeKey: 'ci-run-42' });
    const second = ingestEvent(db, { eventType: 'TEST_SUITE_PASS', dedupeKey: 'ci-run-42' });
    assert.equal(first.deduped, false);
    assert.equal(second.deduped, true);
    const count = db.prepare('SELECT COUNT(*) c FROM marketing_events').get().c;
    assert.equal(count, 1);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('unprocessedEvents only returns events not yet marked processed', () => {
  const { dir, db } = tempDb();
  try {
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e1' });
    ingestEvent(db, { eventType: 'BUG_FIXED', dedupeKey: 'e2' });
    markEventProcessed(db, 'e1', 'story scored, NO_POST');
    const remaining = unprocessedEvents(db);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].event_id, 'e2');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('all EVENT_TYPES from the mandate are supported', () => {
  for (const t of ['TEST_SUITE_PASS', 'RELEASE_READY', 'NEW_FEATURE_VERIFIED', 'BUG_FIXED', 'DEMO_COMPLETED', 'MODEL_MIGRATION_PASS', 'SKILL_PROMOTION', 'PAYMENT_E2E_PASS', 'PUBLIC_RELEASE']) {
    assert.ok(EVENT_TYPES.includes(t));
  }
});

// --- Learning / growth loop ---

test('a single anomalous post does not count as trusted evidence for a strategy change', () => {
  const { dir, db } = tempDb();
  try {
    upsertMemory(db, { content_id: 'c1', channel: 'x', ctr: 0.5, clicks: 50, impressions: 100 });
    const decision = proposeStrategyChange(db, 'channel', 'x', 'discord');
    assert.equal(decision.proposed, false);
    assert.match(decision.reason, /insufficient sample/);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('a strategy change is proposed only once both groups reach minimum sample and lift is decisive', () => {
  const { dir, db } = tempDb();
  try {
    for (let i = 0; i < 6; i++) {
      upsertMemory(db, { content_id: `x-${i}`, channel: 'x', ctr: 0.10, clicks: 10, impressions: 100 });
      upsertMemory(db, { content_id: `d-${i}`, channel: 'discord', ctr: 0.02, clicks: 2, impressions: 100 });
    }
    const decision = proposeStrategyChange(db, 'channel', 'x', 'discord');
    assert.equal(decision.proposed, true);
    assert.equal(decision.winner, 'x');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('recorded strategy decisions are versioned and never overwrite prior versions', () => {
  const { dir, db } = tempDb();
  try {
    recordStrategyDecision(db, { version: nextStrategyVersion(db), reason: 'first', evidence: {}, sampleSize: 10 });
    recordStrategyDecision(db, { version: nextStrategyVersion(db), reason: 'second', evidence: {}, sampleSize: 12 });
    const history = strategyHistory(db);
    assert.equal(history.length, 2);
    assert.equal(history[0].version, 'strategy_v1');
    assert.equal(history[1].version, 'strategy_v2');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- Experiments ---

test('an experiment refuses to declare a winner below minimum_sample', () => {
  const { dir, db } = tempDb();
  try {
    createExperiment(db, { experimentId: 'exp1', hypothesis: 'video beats text', variantA: 'video', variantB: 'text', metric: 'ctr', minimumSample: 100 });
    upsertMemory(db, { content_id: 'va', ctr: 0.3, impressions: 10 });
    upsertMemory(db, { content_id: 'vb', ctr: 0.1, impressions: 10 });
    attachVariantContent(db, 'exp1', { variantAContentId: 'va', variantBContentId: 'vb' });
    const result = evaluateExperiment(db, 'exp1');
    assert.equal(result.decided, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('an experiment declares a winner once minimum_sample is reached', () => {
  const { dir, db } = tempDb();
  try {
    createExperiment(db, { experimentId: 'exp2', hypothesis: 'video beats text', variantA: 'video', variantB: 'text', metric: 'ctr', minimumSample: 50 });
    upsertMemory(db, { content_id: 'va2', ctr: 0.3, impressions: 100 });
    upsertMemory(db, { content_id: 'vb2', ctr: 0.1, impressions: 100 });
    attachVariantContent(db, 'exp2', { variantAContentId: 'va2', variantBContentId: 'vb2' });
    const result = evaluateExperiment(db, 'exp2');
    assert.equal(result.decided, true);
    assert.equal(result.winner, 'variant_A');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- Market / competitor evidence classification ---

test('external market evidence defaults to UNVERIFIED_EXTERNAL and cannot back a public claim until corroborated', () => {
  const { dir, db } = tempDb();
  try {
    recordMarketEntry(db, { entryId: 'm1', source: 'some blog', claim: 'competitor X launched a memory feature', confidence: CONFIDENCE.MEDIUM });
    const entry = db.prepare('SELECT * FROM market_watch WHERE entry_id = ?').get('m1');
    assert.equal(entry.evidence_class, 'UNVERIFIED_EXTERNAL');
    assert.equal(canBackPublicClaim(entry), false);

    recordMarketEntry(db, { entryId: 'm2', source: 'official docs + independent review', claim: 'competitor X launched a memory feature', confidence: CONFIDENCE.HIGH, evidenceClass: EVIDENCE_CLASS.CORROBORATED_EXTERNAL });
    const entry2 = db.prepare('SELECT * FROM market_watch WHERE entry_id = ?').get('m2');
    assert.equal(canBackPublicClaim(entry2), true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('competitor facts require a source, date, and evidence string — never bare assumption', () => {
  const { dir, db } = tempDb();
  try {
    recordCompetitorFact(db, {
      entryId: 'cf1', competitor: 'Replika', dimension: 'Memory', value: 'UNKNOWN',
      source: 'n/a', date: '2026-09-13', evidence: 'no public source found', confidence: CONFIDENCE.LOW,
    });
    const row = db.prepare('SELECT * FROM competitor_facts WHERE entry_id = ?').get('cf1');
    assert.equal(row.value, 'UNKNOWN');
    assert.ok(row.evidence.length > 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- Weekly report ---

test('writeWeeklyReport creates a dated file and never overwrites an existing one for the same date', () => {
  const { dir, db } = tempDb();
  const reportsDir = join(dir, 'reports');
  try {
    const now = new Date('2026-09-13T00:00:00Z');
    const first = writeWeeklyReport(db, reportsDir, { now });
    assert.equal(first.written, true);
    assert.ok(existsSync(first.path));
    const content = readFileSync(first.path, 'utf8');
    assert.ok(content.includes('Weekly Marketing Report'));

    const second = writeWeeklyReport(db, reportsDir, { now });
    assert.equal(second.written, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('analyzePerformance marks groups below MIN_SAMPLE as untrusted', () => {
  const { dir, db } = tempDb();
  try {
    upsertMemory(db, { content_id: 'only-one', channel: 'x', ctr: 0.9, impressions: 1000 });
    const analysis = analyzePerformance(db, ['channel']);
    assert.equal(analysis.channel.x.trusted, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});
