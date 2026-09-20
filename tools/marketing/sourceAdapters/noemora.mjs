// READ-ONLY adapter over Noemora's real, self-declared PUBLIC-SAFE
// evidence: the `V<nnnnn>_PUBLIC_DEMO_*_SEAL.md` convention (14 real files
// found at repo root, versions v21000-v22902, sha256-verified archives —
// see docs/marketing/AUTOMATIC_EVENT_SOURCE_AUDIT.md). Only ever reads
// files — never touches runtime/world state, never runs anything that
// could mutate Noemora's simulation or save data.
//
// Default posture is exclusion, not inclusion: every OTHER real evidence
// category found in this repo (tick/action receipts, WAL, private ledger,
// NOEMORA_CAMPFIRE_*.md drafts explicitly marked "Actual publication:
// FALSE") is deliberately NOT adapted here — see the audit doc for why
// each was excluded. Only the sealed public-demo package convention is
// scanned.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildNormalizedEvent } from '../lib/sourceEventSchema.mjs';
import { readTextSafely } from './base.mjs';

export const source = 'noemora';
export const sourceRepository = 'Noemora_mod_core';

export function defaultRepoRoot(env = process.env) {
  return env.NOEMORA_REPO_ROOT || process.env.NOEMORA_REPO_ROOT || '/home/silver/Noemora_mod_core';
}

// Exported (not just module-local) so lib/evidenceAllowlist.mjs can reuse
// the EXACT same convention for the strong-evidence promotion pipeline
// (mandate: "Do not invent new product-side files") instead of maintaining
// a second, potentially-drifting copy of this pattern.
export const SEAL_FILE_PATTERN = /^V(\d+)_PUBLIC_DEMO_.*_SEAL\.md$/;
// A seal's own Status line is the only signal used to decide whether it
// represents real completion — verified against all 14 real Status
// strings found in this repo (see audit doc): most contain SEALED/FINAL/
// COMPLETE; the two weaker ones ("HANDOFF PREPARED", "... REFRESHED") are
// still real but not treated as VERIFIED completion.
export const STRONG_STATUS_PATTERN = /SEALED|FINAL|COMPLETE/i;

export async function scanSince(cursor, { repoRoot = defaultRepoRoot() } = {}) {
  let entries;
  try {
    entries = readdirSync(repoRoot);
  } catch {
    return [];
  }

  const raw = [];
  for (const name of entries) {
    const match = SEAL_FILE_PATTERN.exec(name);
    if (!match) continue;
    const fullPath = join(repoRoot, name);
    const text = readTextSafely(fullPath);
    if (!text) continue;

    const statusLine = /^Status:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
    const generatedLine = /^Generated:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
    const titleLine = /^#\s*(.+)$/m.exec(text)?.[1]?.trim() ?? name;
    const sha256Matches = [...text.matchAll(/SHA256:\s*([a-f0-9]{64,})/gi)].map((m) => m[1]);

    if (cursor?.last_timestamp && generatedLine && generatedLine <= cursor.last_timestamp) continue;

    raw.push({ sealFile: name, versionNumber: match[1], statusLine, generatedLine, titleLine, sha256Matches });
  }
  return raw;
}

export function normalize(raw) {
  const strong = raw.statusLine ? STRONG_STATUS_PATTERN.test(raw.statusLine) : false;
  return buildNormalizedEvent({
    source_product: 'Noemora',
    source_repository: sourceRepository,
    source_kind: 'public_demo_seal',
    source_native_id: raw.sealFile,
    occurred_at: raw.generatedLine,
    event_type: 'DEMO_COMPLETED',
    title: raw.titleLine,
    // Structural only (status/version/hash) — never any narrative/world
    // content, which this file family does not contain in the first place
    // (a seal is a package-integrity record, not simulation output).
    summary: `Noemora public demo package seal v${raw.versionNumber}: status "${raw.statusLine ?? 'unknown'}".`,
    evidence_refs: [`${raw.sealFile}`],
    evidence_hashes: raw.sha256Matches,
    verification_state: strong ? 'VERIFIED' : 'PARTIAL',
    public_safety_state: 'PUBLIC_SAFE', // self-declared public-safe by the sealing process itself; re-scanned independently by the quality gate
    release_id: `noemora-public-demo-v${raw.versionNumber}`,
  });
}
