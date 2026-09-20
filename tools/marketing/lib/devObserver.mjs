// Local development observer (mandate: "detect meaningful development
// progress directly from the user's local PC repositories/worktrees,
// WITHOUT weakening the existing public-safety/evidence gates").
//
// This is Stage A of the full three-stage evidence pipeline (see
// lib/factPromotion.mjs for Stages B/C):
//   Stage A — LOCAL_DEVELOPMENT_OBSERVATION: "something meaningful changed
//     on the user's PC" (commit / dirty tree / artifact-shaped file).
//     Recorded in dev_observations below. NEVER publishable by itself.
//   Stage B — VERIFIED_FACT_CANDIDATE: a Stage A artifact that also passed
//     lib/evidenceAllowlist.mjs's strong-evidence check gets a structured
//     fact candidate generated and recorded in lib/factPromotion.mjs's own
//     machine_verified_facts table — still not automatically public.
//   Stage C — PUBLIC_SAFE_VERIFIED_FACT: only once EVERY gate in
//     lib/factPromotion.mjs's evaluatePublicSafeGate() passes. See that
//     module's loadMergedFacts() doc comment for why Stage C facts are
//     NOT wired into the live/automatic publication path in this pass.
// This module's own dev_observations 'PROMOTED' status is a SEPARATE,
// narrower thing — it only means "a human already independently curated
// matching evidence into the hand-authored fact registry," detected by
// cross-reference; it has nothing to do with Stages B/C.
//
// Strictly read-only against every product repository: the only git
// subcommands ever invoked are rev-parse/log/status (never add/commit/
// checkout/reset/clean), and file reads never write anything back. Zero
// network calls. Distinct from, and never merged with, the existing
// canonical Noemora PUBLIC_DEMO seal source (sourceAdapters/noemora.mjs) —
// that module, its table (marketing_events), and its ingestion pipeline
// are untouched by this one.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { getCursor, recordScan } from './sourceCursors.mjs';
import { readTextSafely } from '../sourceAdapters/base.mjs';
import { loadFacts } from './facts.mjs';
import { validateEvidence } from './evidenceAllowlist.mjs';
import { recordFactPromotion } from './factPromotion.mjs';
import { getActivationBoundary } from './activation.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_FACTS_PATH = new URL('../../../docs/marketing/VERITAS_FORGE_PUBLIC_FACTS.md', import.meta.url).pathname;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dev_observations (
  identity_hash    TEXT PRIMARY KEY,
  repo_key         TEXT NOT NULL,
  kind             TEXT NOT NULL,   -- 'commit' | 'artifact' | 'dirty'
  identity         TEXT NOT NULL,   -- commit SHA, artifact relative path, or dirty-set hash
  summary          TEXT,
  detected_at      TEXT NOT NULL,
  status           TEXT NOT NULL,   -- 'CANDIDATE' | 'BLOCKED_UNVERIFIED' | 'PROMOTED'
  matched_fact_id  TEXT
);
`;

export function ensureDevObserverSchema(db) {
  db.exec(SCHEMA);
}

function cursorKey(repoKey) {
  return `dev-observer:${repoKey}`;
}

function identityHash(repoKey, kind, identity) {
  return createHash('sha256').update(`${repoKey}:${kind}:${identity}`, 'utf8').digest('hex');
}

/**
 * The four repositories this observer watches (mandate section 2/4).
 * Every path is independently env-overridable, all defaulting to the real
 * paths named in the mandate. Deliberately a DIFFERENT set of env vars from
 * the existing canonical adapters' *_REPO_ROOT (lib/sourceAdapters/*.mjs) —
 * for Noemora specifically these must never collide, since the canonical
 * adapter's NOEMORA_REPO_ROOT points at the sealed public-demo source
 * (/home/silver/Noemora_mod_core) while this one points at the active
 * development worktree (/home/silver/Noemora_mod_core_work); reusing the
 * same var for both would silently make one of them wrong.
 */
export function devRepoConfigs(env = process.env) {
  return [
    { repoKey: 'echo-agent-dev', repoPath: env.ECHO_AGENT_DEV_ROOT || '/home/silver/ECHODiscord版', sourceRepository: 'ECHODiscord版', product: 'ECHO Agent' },
    { repoKey: 'echo-app-dev', repoPath: env.ECHO_APP_DEV_ROOT || '/home/silver/ECHOapp', sourceRepository: 'ECHOapp', product: 'ECHO App' },
    { repoKey: 'noemora-work-dev', repoPath: env.NOEMORA_DEV_ROOT || '/home/silver/Noemora_mod_core_work', sourceRepository: 'Noemora_mod_core_work', product: 'Noemora' },
    { repoKey: 'official-site-dev', repoPath: env.OFFICIAL_SITE_DEV_ROOT || '/home/silver/echo-r', sourceRepository: 'echo-r', product: 'ECHO-R' },
    // veritas-release-orchestrator's own durable public-evidence outbox
    // (added 2026-09-18 for the release -> verified evidence -> marketing
    // handoff): read-only, same walk/validate/promote path as every other
    // repo above -- this observer never calls into the orchestrator itself,
    // it only reads files the orchestrator's adapters already wrote via
    // emitPublicEvidence() (schema veritas-forge-verified-evidence/v1).
    // TWO separate entries, not one shared directory: each watched
    // directory here maps to exactly ONE `product`, the same convention
    // every entry above already follows -- Official Site and ECHO App
    // evidence live in their own dedicated subdirectories specifically so
    // neither's facts are ever labeled with the other's product.
    { repoKey: 'release-orchestrator-official-site', repoPath: env.RELEASE_ORCHESTRATOR_OFFICIAL_SITE_EVIDENCE_ROOT || '/home/silver/veritas-release-orchestrator/state/public-evidence/official-site', sourceRepository: 'veritas-release-orchestrator/official-site', product: 'ECHO-R' },
    { repoKey: 'release-orchestrator-echo-app', repoPath: env.RELEASE_ORCHESTRATOR_ECHO_APP_EVIDENCE_ROOT || '/home/silver/veritas-release-orchestrator/state/public-evidence/echo-app', sourceRepository: 'veritas-release-orchestrator/echo-app', product: 'ECHO App' },
  ];
}

// --- read-only git helpers (rev-parse / log / status ONLY — never a
// mutating subcommand) ---

async function gitHead(repoPath, execFileImpl) {
  try {
    const { stdout } = await execFileImpl('git', ['rev-parse', 'HEAD'], { cwd: repoPath, timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null; // not a git repo, or git unavailable — never throws
  }
}

async function gitNewCommits(repoPath, fromSha, toSha, execFileImpl) {
  if (!fromSha || !toSha || fromSha === toSha) return [];
  try {
    const { stdout } = await execFileImpl('git', ['log', `${fromSha}..${toSha}`, '--format=%H%x1f%s', '--max-count=50'], { cwd: repoPath, timeout: 5000 });
    return stdout.split('\n').filter(Boolean).map((line) => {
      const [sha, subject] = line.split('\x1f');
      return { sha, subject: subject ?? '' };
    });
  } catch {
    return [];
  }
}

async function gitDirtyPaths(repoPath, execFileImpl) {
  try {
    const { stdout } = await execFileImpl('git', ['status', '--porcelain'], { cwd: repoPath, timeout: 5000 });
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.slice(3)).sort();
  } catch {
    return [];
  }
}

// --- artifact detection: a generic "strong verified artifact" convention
// (filename shape + an explicit in-file status marker), the SAME family of
// signal the existing canonical Noemora seal adapter already looks for
// (sourceAdapters/noemora.mjs's SEAL_FILE_PATTERN/STRONG_STATUS_PATTERN),
// generalized across repos rather than duplicated per-repo. A file that
// merely matches the filename shape but has no real marker inside is
// exactly the "malformed artifact" case — reported BLOCKED_UNVERIFIED,
// never a candidate. ---

const ARTIFACT_FILENAME_PATTERN = /(SEAL|VALIDATION|VERIFIED|VERIFICATION|REPORT|HARDENING)/i;
const STRONG_MARKER_PATTERN = /\b(STATUS|RESULT)\s*:\s*.*(PASS|PASSED|VERIFIED|SEALED|FINAL|COMPLETE|SUCCESS)\b/i;
// The exact summary the legacy text-marker heuristic below wrote for an
// artifact it could not parse -- kept as a constant so the one-time
// reconciliation of rows it mislabeled can recognize precisely those rows.
const LEGACY_NO_MARKER_SUMMARY = 'no parseable status marker';
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'target', '__pycache__', '.venv', 'venv', 'coverage']);

/** Bounded-depth, read-only directory walk — never follows into heavy/
 * irrelevant trees, never touches anything outside `root`. */
function findArtifactCandidates(root, { readdirImpl = readdirSync, statImpl = statSync, maxDepth = 3 } = {}) {
  const found = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirImpl(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statImpl(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else if (ARTIFACT_FILENAME_PATTERN.test(name)) {
        found.push(full);
      }
    }
  }
  walk(root, 0);
  return found;
}

/**
 * True only when `factId`'s fact in the registry already traces to this
 * exact (sourceRepository, relativePath) — the ONLY promotion mechanism
 * this module has: detecting that a human already curated this evidence
 * into a real fact, never asserting one itself.
 */
function findMatchingFact(facts, sourceRepository, relativePath) {
  return facts.find((f) => f.SOURCE_REPOSITORY === sourceRepository && f.SOURCE_PATH && relativePath.endsWith(f.SOURCE_PATH))
    ?? null;
}

/**
 * One repo's observation pass. First-ever call for a repo BASELINES
 * (records current HEAD, emits zero observations — mandate section 6:
 * "Baseline the current repository state on first activation. Existing
 * history before baseline must not suddenly become publishable.") Every
 * subsequent call compares against the persisted cursor and emits only
 * genuinely new candidates since then. Fully idempotent: re-running with
 * an unchanged HEAD and unchanged artifact set emits nothing new (every
 * write here is INSERT OR IGNORE keyed on a stable identity_hash).
 */
export async function observeRepo(db, repoConfig, {
  execFileImpl = execFileAsync, readdirImpl = readdirSync, statImpl = statSync, facts,
} = {}) {
  ensureDevObserverSchema(db);
  const { repoKey, repoPath, sourceRepository } = repoConfig;
  const cursor = getCursor(db, cursorKey(repoKey));
  const head = await gitHead(repoPath, execFileImpl);
  const now = new Date().toISOString();

  if (!cursor || !cursor.last_scan_at) {
    // First activation for this repo: baseline only, never a backlog burst.
    recordScan(db, cursorKey(repoKey), { advance: head ? { lastNativeId: head } : null });
    return { repoKey, repoPath, baselined: true, lastHead: head, lastScan: now, newCandidates: 0, promoted: 0, blocked: 0 };
  }

  const observations = [];

  for (const { sha, subject } of await gitNewCommits(repoPath, cursor.last_native_id, head, execFileImpl)) {
    observations.push({ kind: 'commit', identity: sha, summary: subject.slice(0, 200), status: 'CANDIDATE', matchedFactId: null });
  }

  const dirtyPaths = await gitDirtyPaths(repoPath, execFileImpl);
  if (dirtyPaths.length > 0) {
    const dirtyIdentity = createHash('sha256').update(dirtyPaths.join('\n'), 'utf8').digest('hex').slice(0, 16);
    // Dirty working-tree state is, by design, NEVER eligible for promotion
    // (mandate section 3: "Do not allow: dirty source change alone... to
    // become AUTO_PUBLIC") — always BLOCKED_UNVERIFIED, regardless of
    // whether a matching fact might otherwise exist, since uncommitted
    // content has no stable, re-derivable identity to trace evidence to.
    observations.push({
      kind: 'dirty', identity: dirtyIdentity,
      summary: `${dirtyPaths.length} uncommitted path(s)`, status: 'BLOCKED_UNVERIFIED', matchedFactId: null,
    });
  }

  // Stage B/C: every artifact-shaped candidate ALSO runs through the
  // strong-evidence allowlist + auto-promotion gate (lib/evidenceAllowlist.mjs
  // / lib/factPromotion.mjs) — independent of, and stricter than, the loose
  // Stage A "looks artifact-shaped" check below (which only ever feeds this
  // module's own dev_observations audit trail, never a public claim).
  const activationBoundary = getActivationBoundary(db);
  const product = repoConfig.product ?? sourceRepository;

  for (const absPath of findArtifactCandidates(repoPath, { readdirImpl, statImpl })) {
    const relPath = relative(repoPath, absPath);
    const text = readTextSafely(absPath);

    const evidence = text ? validateEvidence({ product, sourceRepository, relPath, text }) : null;
    let promotion = null;
    if (evidence) {
      // Recorded regardless of outcome (mandate: never silently dropped) —
      // this call never publishes anything; see factPromotion.mjs's own
      // doc comments for exactly what each outcome means.
      promotion = recordFactPromotion(db, evidence, { activationBoundary, knownCurrentRevision: head });
    }

    if (evidence) {
      // ONE authoritative interpretation. A file whose schema
      // lib/evidenceAllowlist.mjs RECOGNIZES is judged by that module alone
      // (structured JSON schemas have no free-text `Status:` line, so the
      // legacy text-marker heuristic below can never match them and used to
      // stamp an allowlist-VERIFIED artifact 'BLOCKED_UNVERIFIED: no
      // parseable status marker' -- two contradictory audit verdicts for
      // one file). The text-marker heuristic remains the fallback for files
      // NO schema recognizes, exactly as before.
      const registryMatch = evidence.ok && facts ? findMatchingFact(facts, sourceRepository, relPath) : null;
      if (evidence.ok) {
        const bound = evidence.releaseBinding ? `; deployment ${evidence.releaseBinding.deploymentId}${evidence.releaseBinding.reconciled ? ' (reconciled)' : ''}` : '';
        observations.push({
          kind: 'artifact', identity: relPath, contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
          summary: `allowlist-verified ${evidence.evidenceType}${evidence.claimTopic ? ` (${evidence.claimTopic})` : ''}; stage ${promotion?.stage ?? 'UNKNOWN'}${bound}`.slice(0, 200),
          status: registryMatch ? 'PROMOTED' : 'CANDIDATE',
          matchedFactId: registryMatch?.id ?? promotion?.factId ?? null,
          reconcileLegacyBlocked: true,
        });
      } else {
        // Recognized as an attempt at a known schema but rejected: blocked,
        // with the allowlist's own reason (never the misleading generic one).
        observations.push({ kind: 'artifact', identity: relPath, summary: `allowlist rejected: ${evidence.reason}`.slice(0, 200), status: 'BLOCKED_UNVERIFIED', matchedFactId: null });
      }
      continue;
    }

    if (!text || !STRONG_MARKER_PATTERN.test(text)) {
      // Filename looked like an artifact, but no real, parseable
      // verification marker inside — the "malformed artifact" case.
      observations.push({ kind: 'artifact', identity: relPath, summary: LEGACY_NO_MARKER_SUMMARY, status: 'BLOCKED_UNVERIFIED', matchedFactId: null });
      continue;
    }
    const contentHash = createHash('sha256').update(text, 'utf8').digest('hex');
    const match = facts ? findMatchingFact(facts, sourceRepository, relPath) : null;
    observations.push({
      kind: 'artifact', identity: relPath, contentHash,
      summary: text.split('\n').find((l) => /^(Status|Result)\s*:/i.test(l))?.trim()?.slice(0, 200) ?? relPath,
      status: match ? 'PROMOTED' : 'CANDIDATE',
      matchedFactId: match?.id ?? null,
    });
  }

  let newCandidates = 0; let promoted = 0; let blocked = 0;
  for (const obs of observations) {
    // Artifacts dedup GLOBALLY on their own CONTENT hash when available —
    // deliberately NOT scoped by repoKey (mandate section 5: "the same
    // development event may later appear in [dev observer / canonical repo
    // / PUBLIC_DEMO seal / manual fact registry]... use stable source
    // identity... so promotion/re-observation is idempotent"): the exact
    // same sealed report found under two different repo paths (e.g. the
    // active worktree and, once committed, the canonical repo) is real
    // content-identical evidence and must collapse to the SAME
    // identity_hash, never be recorded twice just because the path
    // differed. Commit/dirty observations stay scoped by repoKey — a
    // commit SHA or a dirty-path-set is genuinely repo-specific, never
    // meaningfully "the same event" across two unrelated repositories.
    const hash = obs.kind === 'artifact' && obs.contentHash
      ? identityHash('artifact-content', 'artifact', obs.contentHash)
      : identityHash(repoKey, obs.kind, obs.identity);
    const existing = db.prepare('SELECT 1 FROM dev_observations WHERE identity_hash = ?').get(hash);
    if (existing) continue; // already recorded — idempotent, not a new candidate
    if (obs.reconcileLegacyBlocked) {
      // An artifact the allowlist now verifies may already have a row from
      // BEFORE this reconciliation, keyed by path (no content hash) and
      // stamped BLOCKED_UNVERIFIED / 'no parseable status marker' by the
      // legacy heuristic. Correct that ONE audit row in place, forward-only
      // and only for that exact contradictory state -- never a second row
      // for the same file, never touching any other status, and never
      // touching machine_verified_facts (the fact is upserted by its
      // deterministic id, so it is never duplicated either).
      const legacy = db.prepare('SELECT status, summary FROM dev_observations WHERE identity_hash = ?')
        .get(identityHash(repoKey, obs.kind, obs.identity));
      if (legacy) {
        if (legacy.status === 'BLOCKED_UNVERIFIED' && legacy.summary === LEGACY_NO_MARKER_SUMMARY) {
          db.prepare(
            `UPDATE dev_observations SET status = ?, summary = ?, matched_fact_id = ?
             WHERE identity_hash = ? AND status = 'BLOCKED_UNVERIFIED' AND summary = ?`
          ).run(obs.status, obs.summary ?? null, obs.matchedFactId ?? null, identityHash(repoKey, obs.kind, obs.identity), LEGACY_NO_MARKER_SUMMARY);
          if (obs.status === 'PROMOTED') promoted += 1; else newCandidates += 1;
        }
        continue;
      }
    }
    db.prepare(
      `INSERT INTO dev_observations (identity_hash, repo_key, kind, identity, summary, detected_at, status, matched_fact_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(hash, repoKey, obs.kind, obs.identity, obs.summary ?? null, now, obs.status, obs.matchedFactId ?? null);
    if (obs.status === 'PROMOTED') promoted += 1;
    else if (obs.status === 'BLOCKED_UNVERIFIED') blocked += 1;
    else newCandidates += 1;
  }

  recordScan(db, cursorKey(repoKey), { advance: head ? { lastNativeId: head } : null });
  return { repoKey, repoPath, baselined: false, lastHead: head, lastScan: now, newCandidates, promoted, blocked };
}

export async function observeAllDevRepos(db, repoConfigs, opts = {}) {
  let facts = opts.facts;
  if (!facts) {
    try {
      facts = loadFacts(opts.factsPath ?? DEFAULT_FACTS_PATH);
    } catch {
      facts = [];
    }
  }
  const results = [];
  for (const repoConfig of repoConfigs) {
    results.push(await observeRepo(db, repoConfig, { ...opts, facts }));
  }
  return results;
}

/** Read-only status summary per repo — never scans, only reports what the
 * last real observeRepo() call recorded (same "status never makes a live
 * call" convention as lib/sourceHealth.mjs / lib/channelState.mjs). */
export function devObserverStatus(db, repoConfigs) {
  ensureDevObserverSchema(db);
  return repoConfigs.map(({ repoKey, repoPath }) => {
    const cursor = getCursor(db, cursorKey(repoKey));
    const rows = db.prepare('SELECT status, COUNT(*) c FROM dev_observations WHERE repo_key = ? GROUP BY status').all(repoKey);
    const countFor = (status) => rows.find((r) => r.status === status)?.c ?? 0;
    return {
      repoKey, repoPath,
      LAST_HEAD: cursor?.last_native_id ?? null,
      LAST_SCAN: cursor?.last_scan_at ?? null,
      NEW_CANDIDATES: countFor('CANDIDATE'),
      PROMOTED_PUBLIC_FACTS: countFor('PROMOTED'),
      BLOCKED_UNVERIFIED: countFor('BLOCKED_UNVERIFIED'),
    };
  });
}
