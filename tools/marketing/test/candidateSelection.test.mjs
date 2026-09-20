import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { ensureActivationBoundary } from '../lib/activation.mjs';
import { isPermanentlyIneligibleForChannel, selectCandidateForChannel } from '../lib/candidateSelection.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-candidateselection-test-'));
  const db = openDb(join(dir, 'test.db'));
  return { dir, db };
}

function fact(overrides = {}) {
  return {
    id: 'FACT-TEST', PRODUCT: 'ECHO Agent', STATUS: 'VERIFIED',
    CLAIM: 'ECHO Agent\'s verifier rejects a claimed task success when there is no supporting evidence.',
    SOURCE_REPOSITORY: 'ECHODiscord版', SOURCE_PATH: 'echo_agent_verifier_v1.py',
    SOURCE_EVIDENCE: 'test passes', VERIFIED_AT: '2026-06-01T00:00:00.000Z', PUBLIC_SAFE: 'true', NOTES: '',
    ...overrides,
  };
}

const REAL_ECHO_AGENT_RELEASE_FACT = {
  id: 'MVF-17cbc9ef77e56440', PRODUCT: 'ECHO-R', STATUS: 'VERIFIED',
  CLAIM: 'A verified ECHO Agent build was promoted to the Production distribution path (release echoagent-win-20260916T154527Z-64d6d128 promoted to the Production distribution path).',
  SOURCE_REPOSITORY: 'echo-r', SOURCE_PATH: 'docs/release/ECHO_AGENT_PRODUCTION_RELEASE_VERIFICATION_RECORD.json',
  SOURCE_EVIDENCE: 'generic:release_promotion_record', VERIFIED_AT: '2026-09-18T05:41:00Z', PUBLIC_SAFE: 'true',
  NOTES: 'Does not imply general public availability, live sales, or that purchase/checkout is open.',
};

test('CASE A: rank1 permanently pre-activation, rank2 valid post-activation -> rank1 skipped, rank2 selected', () => {
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2026-01-01T00:00:00.000Z'); // global boundary
    const historical = fact({ id: 'FACT-OLD', VERIFIED_AT: '2025-01-01T00:00:00.000Z' });
    const valid = fact({ id: 'FACT-NEW', VERIFIED_AT: '2026-06-01T00:00:00.000Z' });
    const ranked = [{ fact: historical, score: 99 }, { fact: valid, score: 10 }];

    const candidate = selectCandidateForChannel(db, 'bluesky', ranked);
    assert.ok(candidate, 'must select a candidate, not give up');
    assert.equal(candidate.fact.id, 'FACT-NEW');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CASE B: every ranked fact is pre-activation -> no candidate, safe NOOP', () => {
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2026-01-01T00:00:00.000Z');
    const ranked = [
      { fact: fact({ id: 'FACT-OLD-1', VERIFIED_AT: '2025-01-01T00:00:00.000Z' }), score: 99 },
      { fact: fact({ id: 'FACT-OLD-2', VERIFIED_AT: '2025-02-01T00:00:00.000Z' }), score: 90 },
    ];

    const candidate = selectCandidateForChannel(db, 'bluesky', ranked);
    assert.equal(candidate, null);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CASE C: rank1 has an existing ledger row from a TEMPORARY block (not yet published) -> still selectable, never permanently discarded', () => {
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z'); // well before -- fact is post-activation
    const f = fact({ id: 'FACT-TEMP-BLOCKED', VERIFIED_AT: '2026-06-01T00:00:00.000Z' });
    const ranked = [{ fact: f, score: 50 }];

    // Simulate: a prior cycle attempted this fact and it was blocked for a
    // TEMPORARY reason (frequency cap / stagger / DRY_RUN) -- alreadyPublished
    // must report false for it, since no real publish happened.
    const alreadyPublished = () => false; // no publication_ledger row has published_at set for this fact yet
    const verdict = isPermanentlyIneligibleForChannel(db, 'bluesky', f, { alreadyPublished });
    assert.equal(verdict.blocked, false, 'a fact merely attempted-and-temporarily-blocked before must not be permanently ineligible');

    const candidate = selectCandidateForChannel(db, 'bluesky', ranked, { alreadyPublished });
    assert.ok(candidate);
    assert.equal(candidate.fact.id, 'FACT-TEMP-BLOCKED');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CASE D: rank1 already genuinely PUBLISHED on X, rank2 unpublished and eligible -> rank2 selected for X', () => {
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    const published = fact({ id: 'FACT-ALREADY-PUBLISHED', VERIFIED_AT: '2026-06-01T00:00:00.000Z' });
    const unpublished = fact({ id: 'FACT-NOT-YET-PUBLISHED', VERIFIED_AT: '2026-06-02T00:00:00.000Z' });
    const ranked = [{ fact: published, score: 99 }, { fact: unpublished, score: 10 }];

    const alreadyPublished = (factId) => factId === 'FACT-ALREADY-PUBLISHED';
    const candidate = selectCandidateForChannel(db, 'x', ranked, { alreadyPublished });
    assert.ok(candidate);
    assert.equal(candidate.fact.id, 'FACT-NOT-YET-PUBLISHED');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CASE E: a fact historical for Bluesky\'s own boundary but post-activation globally is evaluated PER-CHANNEL, not just globally', () => {
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z'); // global: well before
    ensureActivationBoundary(db, '2026-08-01T00:00:00.000Z', 'bluesky'); // bluesky: after the fact's own VERIFIED_AT
    const f = fact({ id: 'FACT-BLUESKY-HISTORICAL', VERIFIED_AT: '2026-06-01T00:00:00.000Z' });

    const blueskyVerdict = isPermanentlyIneligibleForChannel(db, 'bluesky', f);
    assert.equal(blueskyVerdict.blocked, true);
    assert.equal(blueskyVerdict.reason, 'PRE_ACTIVATION');

    // No per-channel boundary set for mastodon -- only the (older) global one applies, so the SAME fact is eligible there.
    const mastodonVerdict = isPermanentlyIneligibleForChannel(db, 'mastodon', f);
    assert.equal(mastodonVerdict.blocked, false);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CASE F: the real new ECHO Agent release fact (MVF-17cbc9ef77e56440) is selectable for X/Bluesky/Mastodon once normal channel gates allow', () => {
  const { dir, db } = tempDb();
  try {
    // Boundaries set well before the fact's real verified_at (2026-09-18T05:41:00Z), matching the real production state.
    ensureActivationBoundary(db, '2026-09-14T16:44:43.953Z');
    ensureActivationBoundary(db, '2026-09-15T22:53:39.584Z', 'bluesky');
    ensureActivationBoundary(db, '2026-09-15T23:59:55.703Z', 'mastodon');
    const ranked = [{ fact: REAL_ECHO_AGENT_RELEASE_FACT, score: 79 }];

    for (const channel of ['x', 'bluesky', 'mastodon']) {
      const candidate = selectCandidateForChannel(db, channel, ranked);
      assert.ok(candidate, `expected ${channel} to select the new ECHO Agent fact`);
      assert.equal(candidate.fact.id, 'MVF-17cbc9ef77e56440');
    }
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isPermanentlyIneligibleForChannel: NO_DRAFT/content-policy rejections are deliberately OUT of scope -- publishToChannel() still decides those fresh every cycle, since they never write a ledger row and so never caused the queue-jam bug this module fixes', () => {
  const { dir, db } = tempDb();
  try {
    ensureActivationBoundary(db, '2020-01-01T00:00:00.000Z');
    const f = fact({ id: 'FACT-WOULD-DECLINE-DRAFT', VERIFIED_AT: '2026-06-01T00:00:00.000Z' });
    const verdict = isPermanentlyIneligibleForChannel(db, 'devto', f);
    assert.equal(verdict.blocked, false, 'candidate selection itself never evaluates draft/content/policy -- only publishToChannel() does');
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
});
