import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSince, normalize, source } from '../sourceAdapters/echoAgent.mjs';

function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-echoagent-fixture-'));
  mkdirSync(join(dir, '_ysas', 'memory_reimu', 'trajectories'), { recursive: true });
  mkdirSync(join(dir, '_ysas', 'memory_reimu', 'skills'), { recursive: true });
  return dir;
}

function writeTrajectoryJsonl(repoRoot, rows) {
  const path = join(repoRoot, '_ysas', 'memory_reimu', 'trajectories', 'trajectory_events_v1.jsonl');
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const FULL_ARC = [
  { schema_version: 'echo-agent-trajectory-v1', task_run_id: 'run-1', event_type: 'goal_set', payload: { goal: 'SECRET GOAL TEXT should never appear in output' }, recorded_at: '2026-09-10T00:00:01Z' },
  { schema_version: 'echo-agent-trajectory-v1', task_run_id: 'run-1', event_type: 'plan_created', payload: {}, recorded_at: '2026-09-10T00:00:02Z' },
  { schema_version: 'echo-agent-trajectory-v1', task_run_id: 'run-1', event_type: 'tool_call', payload: { args: 'private task content' }, recorded_at: '2026-09-10T00:00:03Z' },
  { schema_version: 'echo-agent-trajectory-v1', task_run_id: 'run-1', event_type: 'failure', payload: {}, recorded_at: '2026-09-10T00:00:04Z' },
  { schema_version: 'echo-agent-trajectory-v1', task_run_id: 'run-1', event_type: 'retry', payload: {}, recorded_at: '2026-09-10T00:00:05Z' },
  { schema_version: 'echo-agent-trajectory-v1', task_run_id: 'run-1', event_type: 'verifier_result', payload: {}, recorded_at: '2026-09-10T00:00:06Z' },
  { schema_version: 'echo-agent-trajectory-v1', task_run_id: 'run-1', event_type: 'outcome', payload: { result: 'private result content' }, recorded_at: '2026-09-10T00:00:07Z' },
];

test('scanSince aggregates every trajectory row for one task_run_id into a SINGLE raw candidate — 7 log lines != 7 marketing events', async () => {
  const dir = makeFixtureRepo();
  try {
    writeTrajectoryJsonl(dir, FULL_ARC);
    const raw = await scanSince(null, { repoRoot: dir });
    assert.equal(raw.length, 1);
    assert.equal(raw[0].kind, 'trajectory_task_run');
    assert.equal(raw[0].events.length, 7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an in-flight task run (no outcome event yet) is not a candidate', async () => {
  const dir = makeFixtureRepo();
  try {
    writeTrajectoryJsonl(dir, FULL_ARC.filter((r) => r.event_type !== 'outcome'));
    const raw = await scanSince(null, { repoRoot: dir });
    assert.equal(raw.length, 0, 'an unfinished run must never surface as "completed"');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('normalize() classifies the run REAL_TASK_RECOVERED when it contains both failure and retry', async () => {
  const dir = makeFixtureRepo();
  try {
    writeTrajectoryJsonl(dir, FULL_ARC);
    const [raw] = await scanSince(null, { repoRoot: dir });
    const normalized = normalize(raw);
    assert.equal(normalized.event_type, 'REAL_TASK_RECOVERED');
    assert.equal(normalized.contains_failure, true);
    assert.equal(normalized.contains_recovery, true);
    assert.equal(normalized.verification_state, 'VERIFIED'); // verifier_result present
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('normalize() never includes any payload value in title/summary — private task content is never surfaced, even though it exists in the raw rows', async () => {
  const dir = makeFixtureRepo();
  try {
    writeTrajectoryJsonl(dir, FULL_ARC);
    const [raw] = await scanSince(null, { repoRoot: dir });
    const normalized = normalize(raw);
    const text = `${normalized.title} ${normalized.summary} ${JSON.stringify(normalized.evidence_refs)}`;
    assert.ok(!text.includes('SECRET GOAL TEXT'));
    assert.ok(!text.includes('private task content'));
    assert.ok(!text.includes('private result content'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanSince against a repo with no _ysas/echo_memory/memory_instances directories returns [] rather than throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-echoagent-empty-'));
  try {
    const raw = await scanSince(null, { repoRoot: dir });
    assert.deepEqual(raw, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a promotion packet with decision REJECT never becomes a candidate (only a real ACCEPT is a story)', async () => {
  const dir = makeFixtureRepo();
  try {
    const path = join(dir, '_ysas', 'memory_reimu', 'skills', 'promotion_packets_v1.jsonl');
    writeFileSync(path, JSON.stringify({ schema_version: 'echo-agent-skill-promotion-v1', candidate_hash: 'h1', decision: 'REJECT', timestamp: '2026-09-10T00:00:00Z' }) + '\n');
    const raw = await scanSince(null, { repoRoot: dir });
    assert.equal(raw.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a promotion packet with decision ACCEPT becomes a SKILL_PROMOTION candidate', async () => {
  const dir = makeFixtureRepo();
  try {
    const path = join(dir, '_ysas', 'memory_reimu', 'skills', 'promotion_packets_v1.jsonl');
    writeFileSync(path, JSON.stringify({
      schema_version: 'echo-agent-skill-promotion-v1', candidate_hash: 'h1', decision: 'ACCEPT', timestamp: '2026-09-10T00:00:00Z',
      stage_results: [{ stage: 'schema_validation', status: 'PASSED' }, { stage: 'safety_evaluation', status: 'PASSED' }],
    }) + '\n');
    const [raw] = await scanSince(null, { repoRoot: dir });
    const normalized = normalize(raw);
    assert.equal(normalized.event_type, 'SKILL_PROMOTION');
    assert.equal(normalized.verification_state, 'VERIFIED');
    assert.equal(normalized.contains_skill_learning, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a malformed JSONL line is skipped, never crashes the scan', async () => {
  const dir = makeFixtureRepo();
  try {
    const path = join(dir, '_ysas', 'memory_reimu', 'trajectories', 'trajectory_events_v1.jsonl');
    writeFileSync(path, 'not valid json\n' + JSON.stringify(FULL_ARC[0]) + '\n');
    const raw = await scanSince(null, { repoRoot: dir });
    assert.equal(raw.length, 0, 'run-1 alone (one goal_set row, no outcome) is not yet complete, but the scan must not throw');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('adapter identity', () => {
  assert.equal(source, 'echo-agent');
});
