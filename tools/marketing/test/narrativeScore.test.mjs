import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreNarrative, classifyNarrative } from '../lib/narrativeScore.mjs';

const FULL_ARC = [
  '[00:02] GOAL ACCEPTED',
  '[00:06] PLAN CREATED — 5 STEPS',
  '[00:31] STEP 3 FAILED',
  '[00:32] VERIFIER — REJECT',
  '[00:34] CHECKPOINT AVAILABLE',
  '[00:55] RETRY',
  '[01:20] STEP 3 PASS',
  '[01:22] VERIFIER — PASS',
];

const ROUTINE_SUCCESS = [
  '[00:02] GOAL ACCEPTED',
  '[00:06] PLAN CREATED — 3 STEPS',
  '[00:20] STEP 1 PASS',
  '[00:30] STEP 2 PASS',
  '[00:40] STEP 3 PASS',
  '[00:41] RESULT SUCCESS',
];

test('scoreNarrative detects all beats in a real full-arc log', () => {
  const result = scoreNarrative(FULL_ARC);
  assert.equal(result.beats.task, true);
  assert.equal(result.beats.failure, true);
  assert.equal(result.beats.verifierRejection, true);
  assert.equal(result.beats.retry, true);
  assert.equal(result.beats.checkpoint, true);
  assert.equal(result.beats.finalResult, true);
  assert.equal(result.score, 6);
});

test('classifyNarrative labels a full arc as FLAGSHIP_CANDIDATE', () => {
  const result = classifyNarrative(FULL_ARC);
  assert.equal(result.label, 'FLAGSHIP_CANDIDATE');
});

test('classifyNarrative labels a boring real success as ROUTINE, not manufactured drama', () => {
  const result = classifyNarrative(ROUTINE_SUCCESS);
  assert.equal(result.label, 'ROUTINE');
  assert.equal(result.beats.failure, false);
  assert.equal(result.beats.verifierRejection, false);
});

test('classifyNarrative never fabricates a beat that is not textually present', () => {
  const result = classifyNarrative(['[00:01] hello', '[00:02] world']);
  assert.equal(Object.values(result.beats).every((v) => v === false), true);
  assert.equal(result.label, 'ROUTINE');
});

test('classifyNarrative labels a partial arc (failure without full retry/result) as PARTIAL_ARC', () => {
  const partial = ['[00:02] GOAL ACCEPTED', '[00:10] STEP 1 FAILED', '[00:11] VERIFIER — REJECT'];
  const result = classifyNarrative(partial);
  assert.equal(result.label, 'PARTIAL_ARC');
});
