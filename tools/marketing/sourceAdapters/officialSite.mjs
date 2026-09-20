// READ-ONLY adapter over the official site/sales repo's real evidence:
// `release-output/<release_id>/manifest.json` (automatic, structured —
// produced by scripts/package-echo-agent-release.mjs) and
// `docs/release/*.md`'s KEY=VALUE convention for payment E2E evidence. See
// docs/marketing/AUTOMATIC_EVENT_SOURCE_AUDIT.md for the full survey.
//
// Never reads a secret VALUE: manifest.json's own `wrapped_dek`/`auth_tag`/
// `iv` fields are never surfaced even though they aren't secret keys
// themselves; only `release_id`/`artifact_sha256`/`created_at`/
// `byte_size` are used. docs/release/*.md prose is never quoted (it names
// real Stripe TEST-mode account/price IDs) — only KEY=VALUE tokens.
//
// This repo currently has NO live payment capability (STRIPE_LIVE_SECRET=
// MISSING, LEGAL_GATE=BLOCKED — confirmed in docs/release/*.md at audit
// time) — every PAYMENT_E2E_PASS candidate this adapter produces is
// therefore unconditionally labeled sandbox/TEST-mode in its title, never
// "live sales" (mandate section 9: "Do not announce unfinished checkout
// work as released").
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildNormalizedEvent } from '../lib/sourceEventSchema.mjs';
import { readTextSafely, gitLastCommitDate, extractKeyValuePairs } from './base.mjs';

export const source = 'official-site';
export const sourceRepository = 'echo-r';

export function defaultRepoRoot(env = process.env) {
  return env.OFFICIAL_SITE_REPO_ROOT || process.env.OFFICIAL_SITE_REPO_ROOT || '/home/silver/echo-r';
}

function scanReleaseManifests(repoRoot, cursor) {
  const dir = join(repoRoot, 'release-output');
  if (!existsSync(dir)) return [];
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }

  const raw = [];
  for (const releaseDir of entries) {
    const manifestPath = join(dir, releaseDir, 'manifest.json');
    const text = readTextSafely(manifestPath);
    if (!text) continue;
    let manifest;
    try { manifest = JSON.parse(text); } catch { continue; }
    if (manifest?.schema !== 'veritasforge.echo-agent.release-manifest.v1') continue;
    if (cursor?.last_timestamp && manifest.created_at && manifest.created_at <= cursor.last_timestamp) continue;
    raw.push({
      kind: 'release_manifest', releaseId: manifest.release_id, artifactSha256: manifest.artifact_sha256,
      createdAt: manifest.created_at, byteSize: manifest.byte_size,
    });
  }
  return raw;
}

const E2E_PASS_KEY_PATTERN = /_E2E$/;

function scanPaymentE2eDocs(repoRoot, cursor) {
  const dir = join(repoRoot, 'docs', 'release');
  if (!existsSync(dir)) return [];
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }

  const raw = [];
  for (const fileName of entries) {
    if (!fileName.endsWith('.md')) continue;
    const relPath = join('docs', 'release', fileName);
    const text = readTextSafely(join(repoRoot, relPath));
    if (!text) continue;
    const pairs = extractKeyValuePairs(text);
    const passingE2eKeys = Object.entries(pairs).filter(([k, v]) => E2E_PASS_KEY_PATTERN.test(k) && v === 'PASS').map(([k]) => k);
    if (passingE2eKeys.length === 0) continue;

    const commitDate = gitLastCommitDate(repoRoot, relPath);
    if (cursor?.last_timestamp && commitDate && commitDate <= cursor.last_timestamp) continue;

    raw.push({ kind: 'payment_e2e_doc', fileName, passingE2eKeys, commitDate });
  }
  return raw;
}

export async function scanSince(cursor, { repoRoot = defaultRepoRoot() } = {}) {
  return [...scanReleaseManifests(repoRoot, cursor), ...scanPaymentE2eDocs(repoRoot, cursor)];
}

export function normalize(raw) {
  if (raw.kind === 'release_manifest') {
    return buildNormalizedEvent({
      source_product: 'ECHO Agent (official site release)',
      source_repository: sourceRepository,
      source_kind: 'release_manifest',
      source_native_id: raw.releaseId,
      occurred_at: raw.createdAt,
      // A manifest proves a packaged, hashed release artifact exists — not
      // that it is publicly available yet, so RELEASE_READY, not
      // PUBLIC_RELEASE (conservative, matches mandate section 9).
      event_type: 'RELEASE_READY',
      title: 'ECHO Agent release artifact packaged and verified',
      summary: `Release ${raw.releaseId}: ${raw.byteSize} byte artifact, sha256-verified.`,
      evidence_refs: [`release-output/${raw.releaseId}/manifest.json`],
      evidence_hashes: [raw.artifactSha256],
      verification_state: 'VERIFIED', // machine-generated, sha256-backed
      public_safety_state: 'PUBLIC_SAFE',
      release_id: raw.releaseId,
    });
  }

  if (raw.kind === 'payment_e2e_doc') {
    return buildNormalizedEvent({
      source_product: 'ECHO Agent (official site checkout)',
      source_repository: sourceRepository,
      source_kind: 'payment_e2e_doc',
      source_native_id: raw.fileName,
      occurred_at: raw.commitDate,
      event_type: 'PAYMENT_E2E_PASS',
      title: 'ECHO Agent checkout E2E passed (Stripe sandbox/TEST mode)',
      summary: `${raw.passingE2eKeys.join(', ')} recorded PASS in docs/release/${raw.fileName}. Sandbox/TEST-mode only — this repo has no live payment capability configured at present.`,
      evidence_refs: [`docs/release/${raw.fileName}`],
      // Human-curated doc, not a machine-persisted test-run artifact (the
      // underlying E2E scripts don't write a JSON result file today — see
      // audit doc) — PARTIAL, not VERIFIED.
      verification_state: 'PARTIAL',
      public_safety_state: 'PUBLIC_SAFE',
    });
  }

  throw new Error(`officialSite adapter: unknown raw record kind: ${raw?.kind}`);
}
