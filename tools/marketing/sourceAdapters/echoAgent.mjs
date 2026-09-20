// READ-ONLY adapter over ECHO Agent's real, source-verified evidence
// formats. Verified by reading echo_agent_trajectory_v1.py and
// echo_agent_skill_promotion_v1.py directly on 2026-09-15 — not guessed.
// See docs/marketing/AUTOMATIC_EVENT_SOURCE_AUDIT.md for the full survey.
//
// Two real ledger conventions exist:
//   <memory_root>/trajectories/trajectory_events_v1.jsonl
//   <memory_root>/skills/promotion_packets_v1.jsonl
// but at audit time neither has a real caller wired into the live runtime
// and neither has a real file on disk anywhere in the repo — this adapter
// is built against the verified real schema so it starts working the
// moment the product wires either recorder in; today it correctly finds
// nothing (NO_VIDEO is the honest, correct result, not a bug in this
// adapter).
//
// There is no single "memory_root" in this repo — personas each have their
// own (the already-populated `_wal/` ledgers already follow exactly this
// convention: `_ysas/memory_<name>/`, `echo_memory/<name>/`,
// `memory_instances/<name>/`) — so this adapter globs those known root
// prefixes (one level deep, cheap) rather than assuming one path.
//
// Privacy (mandate section 6, "Never ingest: credentials, private user
// conversation, private customer task contents"): trajectory `payload`
// values are key-based redacted at write time by the product's own code,
// but that does NOT certify they are free of private task content — this
// adapter therefore NEVER reads a payload value into any field. Every
// title/summary it produces is built ONLY from top-level structural facts
// (event_type presence/counts) that this file's own source code guarantees
// exist — never from `payload`.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildNormalizedEvent } from '../lib/sourceEventSchema.mjs';
import { readJsonlSafely } from './base.mjs';

export const source = 'echo-agent';
export const sourceRepository = 'ECHODiscord版';
const MEMORY_ROOT_GLOBS = [
  ['_ysas', 'memory_'],
  ['echo_memory', ''],
  ['memory_instances', ''],
];

export function defaultRepoRoot(env = process.env) {
  return env.ECHO_AGENT_REPO_ROOT || process.env.ECHO_AGENT_REPO_ROOT || '/home/silver/ECHODiscord版';
}

function candidateMemoryRoots(repoRoot) {
  const roots = [];
  for (const [dir, prefix] of MEMORY_ROOT_GLOBS) {
    const base = join(repoRoot, dir);
    if (!existsSync(base)) continue;
    let entries;
    try { entries = readdirSync(base); } catch { continue; }
    for (const entry of entries) {
      if (prefix && !entry.startsWith(prefix)) continue;
      const full = join(base, entry);
      try { if (statSync(full).isDirectory()) roots.push(full); } catch { /* skip unreadable entry */ }
    }
  }
  return roots;
}

/** Groups trajectory rows by task_run_id; only a run that reached an
 * `outcome` row (mandate: "completed real ECHO Agent tasks", not a
 * mid-flight/abandoned run) becomes a candidate. */
function groupCompletedTaskRuns(rows) {
  const byRun = new Map();
  for (const row of rows) {
    if (typeof row?.task_run_id !== 'string' || typeof row?.event_type !== 'string') continue;
    if (!byRun.has(row.task_run_id)) byRun.set(row.task_run_id, []);
    byRun.get(row.task_run_id).push(row);
  }
  const completed = [];
  for (const [taskRunId, events] of byRun) {
    if (!events.some((e) => e.event_type === 'outcome')) continue; // still in flight — not a candidate
    completed.push({ taskRunId, events });
  }
  return completed;
}

export async function scanSince(cursor, { repoRoot = defaultRepoRoot() } = {}) {
  const raw = [];
  for (const memoryRoot of candidateMemoryRoots(repoRoot)) {
    const trajectoryRows = readJsonlSafely(join(memoryRoot, 'trajectories', 'trajectory_events_v1.jsonl'));
    for (const { taskRunId, events } of groupCompletedTaskRuns(trajectoryRows)) {
      const recordedAts = events.map((e) => e.recorded_at).filter(Boolean).sort();
      const occurredAt = recordedAts[recordedAts.length - 1] ?? null;
      if (cursor?.last_timestamp && occurredAt && occurredAt <= cursor.last_timestamp) continue;
      raw.push({ kind: 'trajectory_task_run', memoryRoot, taskRunId, events, occurredAt });
    }

    const promotionRows = readJsonlSafely(join(memoryRoot, 'skills', 'promotion_packets_v1.jsonl'));
    for (const row of promotionRows) {
      if (row?.decision !== 'ACCEPT') continue; // only a real promotion is a candidate story
      if (typeof row?.candidate_hash !== 'string') continue;
      if (cursor?.last_timestamp && row.timestamp && row.timestamp <= cursor.last_timestamp) continue;
      raw.push({ kind: 'skill_promotion', memoryRoot, row });
    }
  }
  return raw;
}

export function normalize(raw) {
  if (raw.kind === 'trajectory_task_run') {
    const types = new Set(raw.events.map((e) => e.event_type));
    const containsFailure = types.has('failure');
    const containsRecovery = types.has('retry');
    const containsVerifier = types.has('verifier_result');
    const containsCheckpoint = types.has('checkpoint');
    const eventType = containsFailure && containsRecovery ? 'REAL_TASK_RECOVERED'
      : containsFailure ? 'REAL_TASK_FAILED'
      : 'REAL_TASK_COMPLETED';
    return buildNormalizedEvent({
      source_product: 'ECHO Agent',
      source_repository: sourceRepository,
      source_kind: 'trajectory_task_run',
      source_native_id: raw.taskRunId,
      occurred_at: raw.occurredAt,
      event_type: eventType,
      // Structural-only text — never a payload value (see module header).
      title: containsFailure && containsRecovery
        ? 'ECHO Agent recovered a real task after a failure'
        : containsFailure ? 'ECHO Agent task run ended after a failure'
        : 'ECHO Agent completed a real task run',
      summary: `Task run with ${raw.events.length} trajectory event(s) (${[...types].sort().join(', ')}); `
        + `verifier_result=${containsVerifier}, checkpoint=${containsCheckpoint}, retry=${containsRecovery}, failure=${containsFailure}.`,
      evidence_refs: [`${raw.memoryRoot}/trajectories/trajectory_events_v1.jsonl#${raw.taskRunId}`],
      verification_state: containsVerifier ? 'VERIFIED' : 'PARTIAL',
      public_safety_state: 'PUBLIC_SAFE', // structural-only text; independently re-scanned by the quality gate anyway
      run_id: raw.taskRunId,
      contains_failure: containsFailure,
      contains_recovery: containsRecovery,
      contains_verifier_result: containsVerifier,
      contains_checkpoint_resume: containsCheckpoint,
    });
  }

  if (raw.kind === 'skill_promotion') {
    const { row } = raw;
    const passedStages = (row.stage_results ?? []).filter((s) => s?.status === 'PASSED').map((s) => s.stage);
    return buildNormalizedEvent({
      source_product: 'ECHO Agent',
      source_repository: sourceRepository,
      source_kind: 'skill_promotion_packet',
      source_native_id: row.candidate_hash,
      occurred_at: row.timestamp ?? null,
      event_type: 'SKILL_PROMOTION',
      title: 'ECHO Agent promoted a new Skill to production',
      summary: `Deterministic promotion gate ACCEPTED a candidate Skill (${passedStages.length} stage(s) passed: ${passedStages.join(', ')}).`,
      evidence_refs: [`${raw.memoryRoot}/skills/promotion_packets_v1.jsonl#${row.candidate_hash}`],
      evidence_hashes: [row.candidate_hash],
      verification_state: 'VERIFIED', // deterministic, evidence-first gate — never an LLM-opinion-only ACCEPT
      public_safety_state: 'PUBLIC_SAFE',
      capabilities: ['skill_learning'],
      contains_skill_learning: true,
    });
  }

  throw new Error(`echoAgent adapter: unknown raw record kind: ${raw?.kind}`);
}
