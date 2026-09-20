// Resource/loop-safety bounds (mandate section 15). Every bound is an env
// var with a conservative default, so ops can tune without a code change,
// but the defaults alone are safe to run unattended.
// A function, not a frozen object: read fresh each call so an env var change
// (including one made mid-test-suite) takes effect without a module reload.
import { statfsSync } from 'node:fs';

export function getLimits(env = process.env) {
  return {
    MAX_RUN_DURATION_MS: Number(env.MARKETING_MAX_RUN_DURATION_MS ?? 10 * 60 * 1000),
    MAX_STORIES_PER_RUN: Number(env.MARKETING_MAX_STORIES_PER_RUN ?? 1),
    MAX_DRAFTS_PER_RUN: Number(env.MARKETING_MAX_DRAFTS_PER_RUN ?? 1),
    MAX_EXTERNAL_POSTS_PER_DAY: Number(env.MARKETING_MAX_EXTERNAL_POSTS_PER_DAY ?? 3),
    MAX_REPLIES_PER_DAY: Number(env.MARKETING_MAX_REPLIES_PER_DAY ?? 5),
    MAX_RESEARCH_ITEMS_PER_RUN: Number(env.MARKETING_MAX_RESEARCH_ITEMS_PER_RUN ?? 10),
    // Video pipeline resource guards (recurring-video mandate section 13).
    MAX_AUTO_VIDEOS_PER_DAY: Number(env.MARKETING_MAX_AUTO_VIDEOS_PER_DAY ?? 1),
    MAX_VIDEO_PIPELINE_RUNTIME_MS: Number(env.MARKETING_MAX_VIDEO_PIPELINE_RUNTIME_MS ?? 30 * 60 * 1000),
    MAX_RENDER_RUNTIME_MS: Number(env.MARKETING_MAX_RENDER_RUNTIME_MS ?? 20 * 60 * 1000),
    MAX_MASTER_DISK_USAGE_BYTES: Number(env.MARKETING_MAX_MASTER_DISK_USAGE_BYTES ?? 50 * 1024 * 1024 * 1024), // 50GB
    MIN_FREE_DISK_SPACE_BYTES: Number(env.MARKETING_MIN_FREE_DISK_SPACE_BYTES ?? 20 * 1024 * 1024 * 1024), // 20GB
    // YMM4 idle-resource policy (unattended-startup mandate section 11):
    // metadata/settings only this pass — no aggressive-shutdown behavior is
    // implemented yet, nothing currently reads YMM4_IDLE_TIMEOUT_MS to
    // actually close anything. Conservative defaults: an instance this
    // system started stays alive for later work by default, and even once
    // idle-shutdown is implemented, it must never close a user-owned
    // instance (YMM4_PROCESS_OWNER=USER) regardless of this setting.
    YMM4_KEEP_ALIVE_AFTER_RENDER: (env.MARKETING_YMM4_KEEP_ALIVE_AFTER_RENDER ?? 'true') === 'true',
    YMM4_IDLE_TIMEOUT_MS: Number(env.MARKETING_YMM4_IDLE_TIMEOUT_MS ?? 60 * 60 * 1000), // 1 hour
  };
}

/**
 * Disk-safety gate for the video pipeline (mandate section 13: "If free disk
 * space is too low: SKIP_VIDEO_LOW_DISK... Do not start encode when disk
 * safety threshold fails"). Checks free space at `path` via statfs — an
 * unreadable/nonexistent path fails CLOSED (never treated as "plenty of
 * space"), since a check that can't run is not evidence that it's safe.
 */
export function checkDiskGuard(path, env = process.env) {
  const limits = getLimits(env);
  let freeBytes;
  try {
    const stats = statfsSync(path);
    freeBytes = stats.bavail * stats.bsize;
  } catch (err) {
    return { ok: false, path, freeBytes: null, minRequired: limits.MIN_FREE_DISK_SPACE_BYTES, reason: `SKIP_VIDEO_LOW_DISK: disk check failed for ${path}: ${err.message ?? err}` };
  }
  const ok = freeBytes >= limits.MIN_FREE_DISK_SPACE_BYTES;
  return { ok, path, freeBytes, minRequired: limits.MIN_FREE_DISK_SPACE_BYTES, reason: ok ? null : `SKIP_VIDEO_LOW_DISK: ${freeBytes} bytes free at ${path}, below MIN_FREE_DISK_SPACE_BYTES (${limits.MIN_FREE_DISK_SPACE_BYTES})` };
}

// Convenience snapshot at import time (defaults, or whatever env was set
// before this module first loaded) — fine for one-off reads like status
// reporting; runOnce() always calls getLimits() fresh instead of using this.
export const LIMITS = getLimits();

// A bare `class X extends Error {}` does NOT get `.name` set to "X" — it
// stays "Error" (JS quirk: Error.prototype.name is only ever overridden by
// an explicit assignment) — so every `err?.name === 'RunDurationExceededError'`
// check downstream (this file's own callers, operator.mjs, videoAutomation.mjs)
// would otherwise silently never match. Confirmed by direct test in this
// environment before fixing it here.
export class RunDurationExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RunDurationExceededError';
  }
}

export async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RunDurationExceededError(`${label} exceeded MAX_RUN_DURATION_MS (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True if this process is already running nested inside another marketing
 * operator invocation. The wrapper script sets MARKETING_OPERATOR_RUNNING=1
 * before invoking `claude -p`; if that Claude Code session's own reasoning
 * ever tried to re-invoke the wrapper (directly or by calling `cli.mjs run`
 * again), this stops it before a second run — and therefore a second nested
 * `claude -p` — can start. This is a hard technical backstop, independent of
 * the prompt instruction in operator-prompt.md not to do this.
 */
export function isNestedInvocation(env = process.env) {
  return env.MARKETING_OPERATOR_RUNNING === '1';
}
