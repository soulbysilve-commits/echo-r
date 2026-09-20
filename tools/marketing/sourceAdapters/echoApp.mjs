// READ-ONLY adapter over ECHO App's real evidence: annotated git tags
// following the confirmed `echo-<component>-vX.Y` / "Freeze <Component>
// vX.Y" convention (94 real tags found; see
// docs/marketing/AUTOMATIC_EVENT_SOURCE_AUDIT.md). Never writes to the
// repo — only `git for-each-ref` (a read command).
//
// Real noise risk (confirmed by direct inspection): many tags are bare
// metadata bumps, e.g. "Freeze ECHO iOS Bundle Identifier Metadata v0.1".
// MILESTONE_PATTERN/NOISE_PATTERN below encode the exact filter verified
// against the real tag corpus (mandate section 7: "Do not turn every ...
// into a marketing event. Aggregate meaningful milestones.").
import { execFileSync } from 'node:child_process';
import { buildNormalizedEvent } from '../lib/sourceEventSchema.mjs';

export const source = 'echo-app';
export const sourceRepository = 'ECHOapp';

export function defaultRepoRoot(env = process.env) {
  return env.ECHO_APP_REPO_ROOT || process.env.ECHO_APP_REPO_ROOT || '/home/silver/ECHOapp';
}

const NOISE_PATTERN = /\bMetadata\s+v[\d.]+\s*$/i;
const MILESTONE_KEYWORDS = /\b(E2E|Production|Backend|Validation|Compile Gate|Endpoint|Privacy|Recovery|Security|Release|Launch|Sync|Provider|Retention|Compliance|Payment|Purchase)\b/i;

export function isMilestoneWorthy(subject) {
  if (typeof subject !== 'string' || !subject.trim()) return false;
  if (NOISE_PATTERN.test(subject)) return false;
  return MILESTONE_KEYWORDS.test(subject);
}

export async function scanSince(cursor, { repoRoot = defaultRepoRoot() } = {}) {
  let out;
  try {
    out = execFileSync(
      'git', ['for-each-ref', "--sort=-creatordate", "--format=%(refname:short)|%(creatordate:iso-strict)|%(subject)|%(objectname)", 'refs/tags'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return []; // repo unreadable/not a git repo — no evidence, not a crash
  }

  const raw = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [tagName, createdAt, subject, commitSha] = line.split('|');
    if (!tagName || !createdAt) continue;
    if (cursor?.last_timestamp && createdAt <= cursor.last_timestamp) continue;
    if (!isMilestoneWorthy(subject)) continue;
    raw.push({ tagName, createdAt, subject, commitSha });
  }
  return raw;
}

export function normalize(raw) {
  return buildNormalizedEvent({
    source_product: 'ECHO App',
    source_repository: sourceRepository,
    source_kind: 'git_milestone_tag',
    source_native_id: raw.tagName,
    occurred_at: raw.createdAt,
    event_type: 'NEW_FEATURE_VERIFIED',
    title: raw.subject,
    summary: `ECHO App milestone tag ${raw.tagName}: ${raw.subject}.`,
    evidence_refs: [`tag:${raw.tagName}`],
    evidence_hashes: raw.commitSha ? [raw.commitSha] : [],
    // A human-created, deliberate milestone tag — not machine-verified
    // (no attached CI-run proof was found), so PARTIAL not VERIFIED
    // (mandate: "Git commits may be supporting metadata only").
    verification_state: 'PARTIAL',
    public_safety_state: 'PUBLIC_SAFE',
    commit_sha: raw.commitSha ?? null,
  });
}
