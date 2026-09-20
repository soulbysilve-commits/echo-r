// Local review-ready notification artifact (recurring-video mandate section
// 15: "When a private video is ready, create a concise review notification
// artifact... Do not expose raw private evidence."). Every field here is
// already reviewer-facing (title, private URL, duration, claim TEXT, the
// demo run id) — never the raw evidence bundle or full script. If Discord
// ever becomes connected this can become a real notification; for now it's
// written to durable local state and returned for the caller to print.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { statePath } from './paths.mjs';

export function buildReviewNotification(row) {
  const claims = row.claims_json ? JSON.parse(row.claims_json) : [];
  const topClaim = claims[0]?.claim ?? '(no fact-backed claim recorded on this run)';
  const duration = typeof row.publication_duration === 'number' ? `${row.publication_duration.toFixed(1)}s` : 'unknown';

  return [
    'VIDEO_READY_FOR_REVIEW',
    '',
    `Title: ${row.title ?? '(untitled)'}`,
    `Private URL: ${row.youtube_url ?? '(none)'}`,
    `Duration: ${duration}`,
    `Story: ${row.demo_run_id}`,
    `Top verified claim: ${topClaim}`,
    `Demo Run ID: ${row.demo_run_id}`,
  ].join('\n') + '\n';
}

/**
 * Persists the notification under durable local state (mandate: "For now
 * persist locally/status output"), keyed by demo run id so re-running never
 * collides across runs. Returns the text alongside the path so a caller
 * (CLI, daily scheduler) can also print it directly without a re-read.
 */
export function writeReviewNotification(row) {
  const text = buildReviewNotification(row);
  const path = statePath('videos', row.demo_run_id, 'REVIEW_NOTIFICATION.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return { path, text };
}
