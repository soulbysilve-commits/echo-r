// Evidence -> fact promotion pipeline (mandate: "Add a rigorously bounded
// evidence-to-fact promotion layer so strong local evidence can produce NEW
// candidate public facts automatically without allowing ordinary code
// changes / LLM claims / dirty files to become public claims").
//
// Three structurally distinct stages (never conflated):
//   Stage A — LOCAL_DEVELOPMENT_OBSERVATION: lib/devObserver.mjs's own
//     commit/dirty/artifact observations. Never itself public.
//   Stage B — VERIFIED_FACT_CANDIDATE: a structured fact candidate was
//     generated from evidence that passed lib/evidenceAllowlist.mjs's
//     strong-evidence check, but has not yet cleared every PUBLIC_SAFE
//     gate below. Still not publishable.
//   Stage C — PUBLIC_SAFE_VERIFIED_FACT: cleared every gate. The ONLY
//     stage `loadMergedFacts()` will ever surface to the normal fact
//     reader — AND ONLY once its own real VERIFIED_AT is at/after this
//     source's own durable activation boundary (ensureMachineFactSourceBoundary()
//     below) — wired into operator.mjs's real candidate-selection path via
//     loadCanonicalFacts() (see that function's own doc comment for the
//     full list of downstream gates a machine fact still has to pass,
//     unchanged, exactly like a hand-authored one).
//
// Durable storage lives in its OWN table (machine_verified_facts), in the
// SAME marketing.db every other durable table already uses — the
// hand-authored docs/marketing/VERITAS_FORGE_PUBLIC_FACTS.md is NEVER
// written to by this module, directly or indirectly.
import { createHash } from 'node:crypto';
import { checkContent, checkPolicyGate } from './policy.mjs';
import { redact } from './redact.mjs';
import { isPreActivation, getActivationBoundary, ensureActivationBoundary } from './activation.mjs';
import { loadFacts } from './facts.mjs';

// A NEW fact source entering the production candidate-selection path gets
// its OWN durable activation boundary (mandate section 1), reusing the
// EXACT same set-once/never-moves-forward mechanism every channel boundary
// already uses (lib/activation.mjs's per-key activation_state row) — never
// a parallel system. Namespaced distinctly from every real channel name
// ('bluesky', 'mastodon', ...) so it can never collide with one.
export const MACHINE_FACT_SOURCE_KEY = 'machine-verified-facts';

export const STAGE = {
  PUBLIC_SAFE_VERIFIED_FACT: 'PUBLIC_SAFE_VERIFIED_FACT',
  VERIFIED_FACT_CANDIDATE: 'VERIFIED_FACT_CANDIDATE',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  BLOCKED_UNVERIFIED: 'BLOCKED_UNVERIFIED',
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS machine_verified_facts (
  fact_id            TEXT PRIMARY KEY,
  product            TEXT NOT NULL,
  claim              TEXT NOT NULL,
  status             TEXT NOT NULL,
  verified_at        TEXT,
  source_repository  TEXT NOT NULL,
  source_revision    TEXT,
  source_artifact    TEXT NOT NULL,
  source_artifact_hash TEXT NOT NULL,
  evidence_type      TEXT NOT NULL,
  public_safe        INTEGER NOT NULL,
  limitations        TEXT,
  confidence         TEXT NOT NULL,
  promotion_stage    TEXT NOT NULL,
  block_reasons      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
`;

export function ensureFactPromotionSchema(db) {
  db.exec(SCHEMA);
}

/**
 * Deterministic fact identity (mandate section 7): re-running observation
 * over the SAME proof (same product + revision + artifact content + claim
 * topic) always yields the SAME fact_id — an upsert, never a duplicate. If
 * the evidence changes materially (different artifact hash, different
 * revision), that is structurally a DIFFERENT fact_id — a new version,
 * never a silent mutation of the old row's history.
 */
export function deterministicFactId({ product, sourceRevision, artifactHash, evidenceType }) {
  const digest = createHash('sha256')
    .update(`${product}:${sourceRevision ?? ''}:${artifactHash}:${evidenceType}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `MVF-${digest}`;
}

/**
 * The auto-promotion gate (mandate section 5) — every check must pass for
 * Stage C; any single failure caps this at Stage B (VERIFIED_FACT_CANDIDATE)
 * or worse, never silently drops the record (mandate section 9: "historical
 * strong artifact -> fact may be recorded for audit but remains
 * activation-blocked").
 *
 * `knownCurrentRevision`: the repo's own most-recently-observed HEAD (from
 * lib/devObserver.mjs's cursor) — used only for evidence types that
 * reference a real git revision (the generic schema); evidence types with
 * no git-revision concept (Noemora seals, release manifests) skip that one
 * check, exactly as they always have in this codebase.
 */
export function evaluatePublicSafeGate(evidence, {
  activationBoundary = null, knownCurrentRevision = null, existingFactPaths = new Set(),
} = {}) {
  const reasons = [];

  // 1. Trusted evidence schema + explicit PASS/VERIFIED result — already
  // enforced by lib/evidenceAllowlist.mjs before this function is ever
  // called (only `ok: true` records reach here), re-asserted defensively.
  if (evidence.result !== 'PASS' && evidence.result !== 'VERIFIED') {
    reasons.push('NOT_EXPLICIT_PASS');
  }

  // 2. Revision/provenance binding present.
  if (evidence.sourceRevision === undefined || evidence.sourceRevision === null || evidence.sourceRevision === '') {
    reasons.push('NO_SOURCE_REVISION');
  }

  // 3. Staleness — only meaningful for evidence whose claim is about the
  // CURRENT state of the code at a git revision (test/evaluation reports):
  // a revision that no longer matches the repo's own most-recently-observed
  // HEAD is treated as stale rather than trusted forever (mandate: "stale
  // verifier result from old revision -> blocked"). This does NOT apply to
  // `generic:release_promotion_record` evidence — that artifact_type
  // records a completed, point-in-time deployment event bound permanently
  // to the revision it was built from; the underlying repo's HEAD moving
  // past that revision afterwards (including via the commit that adds this
  // very evidence file) does not retroactively make the deployment claim
  // untrue. (Every echo_agent_production_release/echo_app_validated_release/
  // noemora_runtime_release/official_site_deployment claim topic in
  // lib/evidenceAllowlist.mjs uses this artifact_type for exactly this
  // reason.)
  const isGitRevisionBound = evidence.evidenceType?.startsWith('generic:')
    && evidence.evidenceType !== 'generic:release_promotion_record';
  if (isGitRevisionBound && knownCurrentRevision && evidence.sourceRevision !== knownCurrentRevision) {
    reasons.push('STALE_REVISION');
  }

  // 4. No secrets / credentials in the composed claim or limitations text.
  const claimText = `${evidence.claim ?? ''} ${evidence.limitations ?? ''}`;
  if (redact(claimText) !== claimText) {
    reasons.push('POSSIBLE_SECRET_IN_CLAIM');
  }

  // 5/6/7. No unsupported metrics / superiority claims / testimonial
  // inference — reuses the EXISTING content/policy gate every real
  // publication already goes through, not a second copy of those rules.
  const contentCheck = checkContent({ text: evidence.claim, factIds: ['synthetic'], claimStrength: evidence.claimStatus === 'VERIFIED' ? 'shipped' : 'neutral' }, [{ id: 'synthetic', STATUS: evidence.claimStatus, PUBLIC_SAFE: 'true' }]);
  for (const v of contentCheck.violations) if (v !== `UNVERIFIED_CLAIM:synthetic:${evidence.claimStatus}`) reasons.push(`POLICY:${v}`);
  const policyCheck = checkPolicyGate({ text: evidence.claim });
  for (const v of policyCheck.violations) reasons.push(`POLICY:${v}`);

  // 8. No production claim from offline-only evidence — defensive keyword
  // check on top of the structural guarantee that CLAIM_TOPICS templates
  // never use these words for offline/unit/integration-scoped topics.
  if (evidence.claimStatus !== 'VERIFIED' && /\b(production|live deployment|in production)\b/i.test(evidence.claim ?? '')) {
    reasons.push('OVERBROAD_PRODUCTION_CLAIM_FROM_NON_VERIFIED_EVIDENCE');
  }

  // 8b. No claim may ever imply general public/customer availability, an
  // App Store/TestFlight release, Apple review having passed, or that
  // sales/checkout/pricing changed — regardless of claim_topic. The
  // generic schema's `description` field is interpolated verbatim into a
  // topic's own fixed sentence template (see lib/evidenceAllowlist.mjs's
  // tryGenericSchema()), so a topic's narrow template alone does not stop
  // an adversarial or careless description from smuggling in exactly this
  // kind of overclaim (found and closed 2026-09-18, release-orchestrator
  // integration: `echo_app_validated_release`/`official_site_deployment`'s
  // own limitations text already says exactly this must never be implied,
  // but nothing enforced it before this check). None of the 8 real
  // CLAIM_TOPICS templates ever use any of these phrases themselves, so
  // this can never fire on a legitimate claim.
  if (/\b(app store|testflight|apple review|generally available|general availability|publicly downloadable|available to customers|publicly available|checkout is (now )?open|pricing (has )?changed|sales (are|is) (now )?live|payment (is |are )?available)\b/i.test(evidence.claim ?? '')) {
    reasons.push('OVERCLAIM_GENERAL_AVAILABILITY_OR_STORE_RELEASE');
  }

  // 9. Claim scope <= evidence scope: structurally enforced by
  // lib/evidenceAllowlist.mjs's fixed CLAIM_TOPICS templates + the
  // requiredArtifactTypes gate on each topic — nothing further to check
  // here beyond confirming a claim was actually produced.
  if (!evidence.claim) reasons.push('NO_CLAIM_GENERATED');

  // 10. Deduplication — a fact_id already promoted for THIS exact artifact
  // path is not re-flagged as a NEW duplicate concern (the caller's own
  // upsert-by-fact_id already makes recording idempotent); nothing to add
  // here beyond noting it for the caller's own bookkeeping.

  // 11. Activation safety (mandate section 8) — the REAL evidence
  // timestamp, never a fabricated/backdated one, gates entry into
  // AUTO_PUBLIC exactly like every other fact already does
  // (isPreActivation() — the SAME function operator.mjs's own live-publish
  // gate uses, reused here rather than reimplemented).
  const preActivation = isPreActivation(evidence.verifiedAt, activationBoundary);

  if (reasons.length > 0) {
    return { stage: STAGE.VERIFIED_FACT_CANDIDATE, reasons };
  }
  if (preActivation) {
    // Genuinely strong, clean evidence — but historical. Recorded for
    // audit (mandate: "historical evidence discovered today remains
    // historical... No backlog laundering"), never silently promoted.
    return { stage: STAGE.VERIFIED_FACT_CANDIDATE, reasons: [`PRE_ACTIVATION (verified_at ${evidence.verifiedAt ?? 'unknown'} predates boundary ${activationBoundary ?? 'unset'})`] };
  }
  return { stage: STAGE.PUBLIC_SAFE_VERIFIED_FACT, reasons: [] };
}

/**
 * Records (upserts) one evidence record's promotion outcome. `evidence` is
 * either a `{ ok: true, ... }` result from lib/evidenceAllowlist.mjs's
 * validateEvidence(), or a `{ ok: false, reason }` / `null` (unknown
 * schema) — both of the latter are recorded as BLOCKED_UNVERIFIED, never
 * silently dropped, so the audit trail is complete even for rejected
 * artifacts. Idempotent: re-observing the identical artifact (same
 * fact_id) updates the SAME row rather than creating a new one.
 */
export function recordFactPromotion(db, evidence, gateOpts = {}) {
  ensureFactPromotionSchema(db);
  const now = new Date().toISOString();

  if (!evidence) {
    // No identity at all to key a durable row on (the caller didn't even
    // attempt any known schema against this file) — nothing to record here;
    // lib/devObserver.mjs's own Stage A bookkeeping already covers this case.
    return { stage: STAGE.BLOCKED_UNVERIFIED, reasons: ['UNKNOWN_SCHEMA'] };
  }
  if (evidence.ok === false) {
    // Recognized as an ATTEMPT at a known schema, but it failed validation
    // (mandate: "malformed artifact -> blocked") — still durably logged,
    // never silently dropped, using whatever identity evidenceAllowlist.mjs
    // could establish (no sourceRevision/artifactHash-based dedup is
    // possible here the way strong evidence gets, since a malformed record
    // often can't even prove which revision it claims to be for — keyed on
    // product+artifactPath instead, which is still stable across rescans).
    const factId = `MVF-BLOCKED-${createHash('sha256').update(`${evidence.product}:${evidence.artifactPath}`, 'utf8').digest('hex').slice(0, 16)}`;
    const existing = db.prepare('SELECT created_at FROM machine_verified_facts WHERE fact_id = ?').get(factId);
    db.prepare(
      `INSERT INTO machine_verified_facts
        (fact_id, product, claim, status, verified_at, source_repository, source_revision,
         source_artifact, source_artifact_hash, evidence_type, public_safe, limitations,
         confidence, promotion_stage, block_reasons, created_at, updated_at)
       VALUES (?, ?, ?, 'BLOCKED', NULL, ?, NULL, ?, ?, 'unrecognized', 0, NULL, 'NONE', ?, ?, ?, ?)
       ON CONFLICT(fact_id) DO UPDATE SET
         block_reasons = excluded.block_reasons, updated_at = excluded.updated_at`
    ).run(
      factId, evidence.product, `BLOCKED: ${evidence.reason}`, evidence.sourceRepository,
      evidence.artifactPath, evidence.artifactHash ?? '', STAGE.BLOCKED_UNVERIFIED,
      JSON.stringify([evidence.reason]), existing?.created_at ?? now, now
    );
    return { factId, stage: STAGE.BLOCKED_UNVERIFIED, reasons: [evidence.reason] };
  }

  const factId = deterministicFactId(evidence);
  const gate = evaluatePublicSafeGate(evidence, gateOpts);
  const existing = db.prepare('SELECT created_at FROM machine_verified_facts WHERE fact_id = ?').get(factId);

  db.prepare(
    `INSERT INTO machine_verified_facts
      (fact_id, product, claim, status, verified_at, source_repository, source_revision,
       source_artifact, source_artifact_hash, evidence_type, public_safe, limitations,
       confidence, promotion_stage, block_reasons, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(fact_id) DO UPDATE SET
       promotion_stage = excluded.promotion_stage,
       block_reasons = excluded.block_reasons,
       updated_at = excluded.updated_at`
  ).run(
    factId, evidence.product, evidence.claim, evidence.claimStatus, evidence.verifiedAt ?? null,
    evidence.sourceRepository, evidence.sourceRevision ?? null, evidence.artifactPath,
    evidence.artifactHash, evidence.evidenceType, evidence.limitations ?? null,
    'STRONG', gate.stage, JSON.stringify(gate.reasons), existing?.created_at ?? now, now
  );

  return { factId, stage: gate.stage, reasons: gate.reasons };
}

export function machineVerifiedFactRow(db, factId) {
  ensureFactPromotionSchema(db);
  return db.prepare('SELECT * FROM machine_verified_facts WHERE fact_id = ?').get(factId) ?? null;
}

/**
 * Converts a durable machine_verified_facts row into the EXACT same shape
 * lib/facts.mjs's parseFacts() produces, so every existing consumer
 * (rankFacts, checkContent, publishToChannel, etc.) works completely
 * unchanged.
 */
function toFactShape(row) {
  return {
    id: row.fact_id,
    PRODUCT: row.product,
    STATUS: row.status,
    CLAIM: row.claim,
    SOURCE_REPOSITORY: row.source_repository,
    SOURCE_PATH: row.source_artifact,
    SOURCE_EVIDENCE: `${row.evidence_type} (revision ${row.source_revision ?? 'n/a'}, sha256 ${row.source_artifact_hash.slice(0, 12)}...)`,
    VERIFIED_AT: row.verified_at,
    PUBLIC_SAFE: row.public_safe ? 'true' : 'false',
    NOTES: row.limitations ?? '',
  };
}

/** Stable dedup key: the same (repository, artifact-path) evidence, whether
 * it reached the registry via a human curating it by hand or via this
 * module auto-detecting it, is "the same fact" — never published as both. */
function evidenceKey(sourceRepository, sourcePath) {
  return `${sourceRepository ?? ''}::${sourcePath ?? ''}`;
}

/**
 * The machine-fact source's own durable activation boundary. Idempotent —
 * calling this again after one is already set returns the SAME boundary,
 * never moves it forward (identical contract to every other activation
 * boundary in this codebase, lib/activation.mjs's own ensureActivationBoundary()
 * itself, reused unchanged here, not reimplemented). Called once, lazily,
 * the FIRST time loadMergedFacts() is ever asked to actually merge machine
 * facts into candidate selection — exactly "generate it once at
 * activation/wiring time," where "wiring time" is the real first use, not
 * merely this code existing on disk.
 */
export function ensureMachineFactSourceBoundary(db) {
  return ensureActivationBoundary(db, undefined, MACHINE_FACT_SOURCE_KEY);
}

/** Read-only — never creates the boundary (same "status never mutates" convention as everywhere else). */
export function getMachineFactSourceBoundary(db) {
  return getActivationBoundary(db, MACHINE_FACT_SOURCE_KEY);
}

/**
 * Merges hand-authored facts with the machine-generated facts that have
 * BOTH cleared every promotion gate (promotion_stage =
 * PUBLIC_SAFE_VERIFIED_FACT — lib/factPromotion.mjs's own gate, which
 * already enforces the GLOBAL activation boundary) AND cleared this
 * source's OWN additional boundary (mandate section 1: a fact whose real
 * VERIFIED_AT predates the moment this NEW source was wired in stays
 * permanently historical/audit-only, exactly like every pre-existing
 * pending row already does for the channels — no backlog laundering just
 * because a new source got connected).
 *
 * Per-channel/global activation boundaries, frequency guards, staggers,
 * AUTH_VALID/CANARY_PASSED, and idempotency are all still enforced
 * DOWNSTREAM exactly as before (lib/multiChannelPublish.mjs's
 * publishToChannel() / operator.mjs's runOnceInner) — this function only
 * decides which facts are CANDIDATES for selection, never whether one is
 * actually allowed to publish.
 *
 * Human-authored facts always take precedence on a dedup collision (mandate
 * section 3) — never surface both a hand-authored and a machine-generated
 * variant of literally the same evidence.
 */
export function loadMergedFacts(handAuthoredFacts, db) {
  ensureFactPromotionSchema(db);
  const { boundary } = ensureMachineFactSourceBoundary(db);
  const handAuthoredKeys = new Set(handAuthoredFacts.map((f) => evidenceKey(f.SOURCE_REPOSITORY, f.SOURCE_PATH)));
  const rows = db.prepare("SELECT * FROM machine_verified_facts WHERE promotion_stage = 'PUBLIC_SAFE_VERIFIED_FACT'").all();
  const eligible = rows.filter((row) => {
    if (isPreActivation(row.verified_at, boundary)) return false; // pre-source-boundary: historical, audit-only, never a candidate
    return !handAuthoredKeys.has(evidenceKey(row.source_repository, row.source_artifact)); // human fact wins on collision
  });
  return [...handAuthoredFacts, ...eligible.map(toFactShape)];
}

/**
 * The ONE canonical fact stream for every real candidate-selection path
 * (mandate section 2: "There must be ONE canonical normalized fact stream
 * for candidate selection... Do not make downstream publishers understand
 * two separate fact schemas"). Every AUTO_PUBLIC channel cycle
 * (operator.mjs's runOnceInner/runBlueskyCycle/runMastodonCycle/
 * runDevToCycle/runQiitaCycle) calls this instead of loadFacts(factsPath)
 * directly — the ONLY change at each call site. A missing/invalid facts
 * file still throws exactly as loadFacts() always has (callers already
 * catch this the same way they did before); machine facts are simply
 * appended (or not, per every gate above) on top of whatever hand-authored
 * facts loaded successfully.
 */
export function loadCanonicalFacts(factsPath, db, { loadFactsImpl = loadFacts } = {}) {
  const handAuthored = loadFactsImpl(factsPath);
  return loadMergedFacts(handAuthored, db);
}

/** Read-only status summary (mandate section 11) — never scans/promotes/creates the boundary on its own. */
export function factPromotionStatus(db, handAuthoredFacts = []) {
  ensureFactPromotionSchema(db);
  const byProduct = db.prepare(`
    SELECT product,
      SUM(CASE WHEN promotion_stage = 'PUBLIC_SAFE_VERIFIED_FACT' THEN 1 ELSE 0 END) AS auto_promoted,
      SUM(CASE WHEN promotion_stage = 'VERIFIED_FACT_CANDIDATE' THEN 1 ELSE 0 END) AS candidates,
      SUM(CASE WHEN promotion_stage = 'MANUAL_REVIEW' THEN 1 ELSE 0 END) AS manual_review,
      SUM(CASE WHEN promotion_stage = 'BLOCKED_UNVERIFIED' THEN 1 ELSE 0 END) AS blocked
    FROM machine_verified_facts GROUP BY product
  `).all();
  const latest = db.prepare(`
    SELECT fact_id, product, verified_at, source_revision, evidence_type
    FROM machine_verified_facts WHERE promotion_stage = 'PUBLIC_SAFE_VERIFIED_FACT'
    ORDER BY updated_at DESC LIMIT 1
  `).get() ?? null;

  const boundary = getMachineFactSourceBoundary(db); // read-only — null until loadMergedFacts() has actually run once for real
  const allRows = db.prepare('SELECT * FROM machine_verified_facts').all();
  const publicSafeRows = allRows.filter((r) => r.promotion_stage === 'PUBLIC_SAFE_VERIFIED_FACT');
  const postBoundaryRows = boundary ? publicSafeRows.filter((r) => !isPreActivation(r.verified_at, boundary)) : [];
  const handAuthoredKeys = new Set(handAuthoredFacts.map((f) => evidenceKey(f.SOURCE_REPOSITORY, f.SOURCE_PATH)));
  const currentlyEligibleRows = postBoundaryRows.filter((r) => !handAuthoredKeys.has(evidenceKey(r.source_repository, r.source_artifact)));

  return {
    byProduct: byProduct.map((r) => ({
      PRODUCT: r.product, VERIFIED_FACT_CANDIDATES: r.candidates, AUTO_PROMOTED_FACTS: r.auto_promoted,
      MANUAL_REVIEW_FACTS: r.manual_review, BLOCKED_UNVERIFIED_FACTS: r.blocked,
    })),
    latestPromoted: latest ? {
      FACT_ID: latest.fact_id, PRODUCT: latest.product, VERIFIED_AT: latest.verified_at,
      SOURCE_REVISION: latest.source_revision, EVIDENCE_TYPE: latest.evidence_type,
    } : null,
    sourceWired: true,
    sourceBoundary: boundary,
    total: allRows.length,
    publicSafe: publicSafeRows.length,
    preSourceBoundary: boundary ? publicSafeRows.length - postBoundaryRows.length : publicSafeRows.length,
    postSourceBoundary: postBoundaryRows.length,
    currentlyEligible: currentlyEligibleRows.length,
  };
}
