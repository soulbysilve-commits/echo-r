import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { recordIntent } from '../lib/ledger.mjs';
import { matchCandidateSubreddits, checkRedditEligibility, SUBREDDIT_REGISTRY } from '../lib/subredditPolicy.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-subreddit-test-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

const REDDIT_ENV = { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'secret', REDDIT_USERNAME: 'u', REDDIT_PASSWORD: 'p' };

const AGENT_FACT = { id: 'FACT-001', PRODUCT: 'ECHO Agent', CLAIM: 'a fully autonomous ai agent that never fabricates task success' };
const UNRELATED_FACT = { id: 'FACT-002', PRODUCT: 'Some Product', CLAIM: 'a completely unrelated claim about something else' };

test('matchCandidateSubreddits: only returns subreddits that both allow self-promo AND match the fact\'s topic', () => {
  const matches = matchCandidateSubreddits(AGENT_FACT);
  assert.ok(matches.includes('artificial'));
  assert.ok(matches.includes('SideProject'));
  assert.ok(!matches.includes('programming'), 'programming disallows self-promo entirely');
  assert.ok(!matches.includes('MachineLearning'), 'MachineLearning disallows top-level self-promo');
});

test('matchCandidateSubreddits: an unrelated fact matches nothing', () => {
  assert.deepEqual(matchCandidateSubreddits(UNRELATED_FACT), []);
});

test('checkRedditEligibility: an unregistered subreddit is refused outright (never an unreviewed target)', () => {
  const { dir, db } = tempDb();
  try {
    const result = checkRedditEligibility(db, 'somerandomsubreddit', AGENT_FACT, { env: REDDIT_ENV });
    assert.equal(result.eligible, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkRedditEligibility: a subreddit whose rules disallow self-promotion is refused even if relevant', () => {
  const { dir, db } = tempDb();
  try {
    const result = checkRedditEligibility(db, 'MachineLearning', AGENT_FACT, { env: REDDIT_ENV });
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => /self-promotion rule disallows/.test(r)));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkRedditEligibility: relevant + allowed + credentials present + no repeats -> eligible', () => {
  const { dir, db } = tempDb();
  try {
    const result = checkRedditEligibility(db, 'artificial', AGENT_FACT, { env: REDDIT_ENV });
    assert.equal(result.eligible, true, JSON.stringify(result.reasons));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkRedditEligibility: missing reddit credentials blocks eligibility', () => {
  const { dir, db } = tempDb();
  try {
    const result = checkRedditEligibility(db, 'artificial', AGENT_FACT, { env: {} });
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => /credentials not configured/.test(r)));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkRedditEligibility: a repeated promotion to the same subreddit within 7 days is refused', () => {
  const { dir, db } = tempDb();
  try {
    recordIntent(db, { channel: 'reddit', account: 'artificial', text: 'earlier promo', riskClass: 'HUMAN_APPROVAL_REQUIRED', approvalState: 'PENDING_HUMAN_APPROVAL', contentType: 'reddit_self_promotion' });
    const result = checkRedditEligibility(db, 'artificial', AGENT_FACT, { env: REDDIT_ENV });
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => /already received a promotion/.test(r)));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkRedditEligibility: no cross-subreddit burst — a second distinct subreddit on the same day is refused when maxSubredditsPerDay=1', () => {
  const { dir, db } = tempDb();
  try {
    recordIntent(db, { channel: 'reddit', account: 'SideProject', text: 'promo to SideProject', riskClass: 'HUMAN_APPROVAL_REQUIRED', approvalState: 'PENDING_HUMAN_APPROVAL', contentType: 'reddit_self_promotion' });
    const result = checkRedditEligibility(db, 'artificial', AGENT_FACT, { env: REDDIT_ENV, maxSubredditsPerDay: 1 });
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((r) => /cross-subreddit burst/.test(r)));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});
