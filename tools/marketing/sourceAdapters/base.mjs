// Shared adapter interface + helpers (mandate section 3). Every adapter is
// READ-ONLY over its product repository — no adapter in this directory may
// write, edit, or exec anything that mutates the target repo's git state or
// runtime state. Each adapter module exports:
//
//   source: string                        — stable id, e.g. 'echo-agent'
//   repoRoot(env): string                 — absolute path to scan (injectable for tests)
//   async scanSince(cursor, opts): raw[]   — read-only scan; opts = { dryRun, repoRoot }
//   normalize(raw): normalizedEvent        — pure, uses lib/sourceEventSchema.mjs
//
// `scanSince` returns adapter-internal "raw" objects — never coupled to the
// canonical schema directly (mandate: "Do not couple the existing scoring
// engine directly to repo-specific formats"). `normalize()` is the only
// place that translates a raw record into the shared schema.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Never throws — a missing/unreadable file is just "no evidence here". */
export function readTextSafely(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Parses a JSONL file, skipping any line that fails to parse rather than
 * aborting the whole scan on one malformed row. */
export function readJsonlSafely(path) {
  const text = readTextSafely(path);
  if (!text) return [];
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // Malformed line — skip it, never crash the scan over one bad record.
    }
  }
  return rows;
}

/** Real last-commit date for a git-tracked file — more accurate than mtime
 * for "when was this evidence actually recorded", and read-only (git log).
 * Returns null (never throws) if the path isn't tracked or git isn't available. */
export function gitLastCommitDate(repoRoot, relativePath) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%aI', '--', relativePath], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Extracts `KEY=VALUE` pairs (uppercase-snake keys) from free-form text —
 * used for the official-site docs/release/*.md convention. Never reads
 * surrounding prose into a returned value. */
export function extractKeyValuePairs(text) {
  const pairs = {};
  const re = /\b([A-Z][A-Z0-9_]*)=([A-Za-z0-9._/-]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    pairs[m[1]] = m[2];
  }
  return pairs;
}
