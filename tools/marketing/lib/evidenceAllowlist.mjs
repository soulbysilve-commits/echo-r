// Strong-evidence allowlist (mandate: "A new fact candidate may be
// generated automatically ONLY from strong evidence... Do not heuristically
// trust arbitrary files... Unknown schema: BLOCKED_UNVERIFIED").
//
// This is the ONLY place that decides whether an observed artifact
// (lib/devObserver.mjs's Stage A observations) is strong enough to even be
// CONSIDERED for auto-fact-generation (Stage B). Every entry here was
// chosen from a real, already-audited local evidence convention already
// trusted elsewhere in this codebase — never invented for this purpose:
//
//   - Noemora PUBLIC_DEMO seal: the EXACT filename/status convention
//     sourceAdapters/noemora.mjs already ingests for the canonical seal
//     source (imported from there, never duplicated).
//   - Official-site/ECHO Agent release manifest: the EXACT schema tag
//     sourceAdapters/officialSite.mjs already trusts
//     ('veritasforge.echo-agent.release-manifest.v1').
//   - The generic `veritas-forge-verified-evidence/v1` schema: a NEW,
//     narrow, strictly-validated JSON convention, not yet emitted by any
//     product repo today (confirmed by a real audit — see
//     docs/marketing/AUTOMATIC_EVENT_SOURCE_AUDIT.md-style survey done for
//     this task) — available for ECHO Agent/ECHO App to adopt later, but
//     no existing file in either repo currently satisfies it, and this
//     module creates none. Every other ad-hoc artifact found in these
//     repos (e.g. ECHODiscord版's many `*_SEAL_V1.json`/`*_REPORT*` files
//     from unrelated, in-progress engineering experiments) is DELIBERATELY
//     not allow-listed: their real meaning (pass vs. fail vs. denial vs.
//     abandoned attempt) cannot be safely inferred from filename/shape
//     alone, so they fall through to BLOCKED_UNVERIFIED, exactly as the
//     mandate requires ("fail closed").
import { createHash } from 'node:crypto';
import { SEAL_FILE_PATTERN, STRONG_STATUS_PATTERN } from '../sourceAdapters/noemora.mjs';

export const GENERIC_SCHEMA_ID = 'veritas-forge-verified-evidence/v1';
export const RELEASE_MANIFEST_SCHEMA_ID = 'veritasforge.echo-agent.release-manifest.v1';

// Controlled claim-topic vocabulary for the generic schema (mandate section
// 4: "The claim MUST be narrower than or equal to what the evidence
// proves... Never generalize"). Deliberately a FIXED, code-defined set of
// narrow sentence templates — an evidence file can select a topic and
// supply a bounded `description` substring, but can NEVER supply free-form
// claim text directly, so no evidence file (however it was produced,
// including by an LLM) can talk its way into a broader claim than the
// topic's own template allows.
export const CLAIM_TOPICS = {
  planner_function_swap: {
    requiredArtifactTypes: ['e2e_test_report', 'integration_test_report'],
    status: 'PARTIAL',
    template: ({ product, description }) => `${product}'s persisted state survives being loaded by a runtime instantiated with a different planner function${description ? ` (${description})` : ''}.`,
    limitations: 'Proves survival across a swapped planner FUNCTION only — this is not a real multi-provider/model migration and must never be phrased as one.',
  },
  backend_unit_coverage: {
    requiredArtifactTypes: ['unit_test_report', 'integration_test_report'],
    status: 'PARTIAL',
    template: ({ product, description }) => `${product} has passing automated test coverage for: ${description}`,
    limitations: 'Backend/unit-level evidence only — does not confirm end-to-end client-facing behavior.',
  },
  offline_evaluation_result: {
    requiredArtifactTypes: ['offline_evaluation'],
    status: 'PARTIAL',
    template: ({ product, description }) => `${product} passed an offline evaluation for: ${description}`,
    limitations: 'Offline evaluation only — does not confirm production/live runtime behavior.',
  },
  e2e_test_pass: {
    requiredArtifactTypes: ['e2e_test_report'],
    status: 'VERIFIED',
    template: ({ product, description }) => `${product}'s end-to-end test suite passed for: ${description}`,
    limitations: null,
  },

  // Added 2026-09-18 for the release-orchestrator integration (mandate:
  // "Add narrowly scoped claim topics ONLY if they can be safely defined
  // and validated"). Each of these four is scoped to exactly ONE product
  // via `allowedProduct` (enforced below, in tryGenericSchema) -- unlike
  // the four topics above, which were deliberately left product-agnostic.
  // Every template states ONLY that validated code/a validated build
  // reached its own Production/release-pipeline boundary; NONE of them may
  // ever be used to imply general sales, checkout, pricing, App Store
  // availability, or (for Noemora specifically) any autonomous governance
  // action -- each `limitations` string says so explicitly, and the tests
  // in evidenceAllowlist.test.mjs assert every one of these boundaries.
  echo_agent_production_release: {
    allowedProduct: 'ECHO Agent',
    requiredArtifactTypes: ['release_promotion_record'],
    status: 'VERIFIED',
    template: ({ product, description }) => `A verified ${product} build was promoted to the Production distribution path${description ? ` (${description})` : ''}.`,
    limitations: 'Does not imply general public availability, live sales, or that purchase/checkout is open -- see the product\'s own commercial-availability facts for that.',
  },
  echo_app_validated_release: {
    allowedProduct: 'ECHO App',
    requiredArtifactTypes: ['release_promotion_record'],
    status: 'VERIFIED',
    template: ({ product, description }) => `A new ${product} revision passed its validated release pipeline${description ? ` (${description})` : ''}.`,
    limitations: 'Does not imply App Store or TestFlight availability, or that any build was installed on a real device. Public App Store release remains a separate, manual decision.',
  },
  noemora_runtime_release: {
    allowedProduct: 'Noemora',
    requiredArtifactTypes: ['release_promotion_record'],
    status: 'VERIFIED',
    template: ({ product, description }) => `A validated ${product} runtime revision was deployed${description ? ` (${description})` : ''}.`,
    limitations: 'Code-deployment evidence only -- never implies any autonomous governance decision, world-tick action, vote, law enactment, or Discord/network action was taken by Noemora itself.',
  },
  official_site_deployment: {
    allowedProduct: 'ECHO-R',
    requiredArtifactTypes: ['release_promotion_record'],
    status: 'VERIFIED',
    template: ({ product, description }) => `A validated ${product} website revision was deployed${description ? ` (${description})` : ''}.`,
    limitations: 'Does not imply general sales are live, pricing changed, or any commercial/checkout flag was enabled.',
  },
};

// --- optional, additive `release_binding` (veritas-release-orchestrator) ---
// Identifies WHICH deployment a release_promotion_record refers to, so this
// module never needs Vercel access to know. Absent on every record written
// before it existed (still valid -- historical evidence must stay
// byte-for-byte acceptable and idempotent). When PRESENT it is validated
// strictly and independently of the orchestrator's own emit-side check:
// exactly the six known keys (plus, for an explicitly RECONCILED release
// only, the optional pair `reconciled` + `reconciliation_id`, given together
// or not at all), each a bounded identifier/boolean, and it can never carry
// anything secret-shaped. It is provenance only: it is NEVER slotted into the
// claim sentence or limitations, so it cannot widen a claim.
const RELEASE_BINDING_KEYS = ['deployment_id', 'deployment_url', 'production_alias', 'promoted_at', 'post_validation_result', 'live_revision_verified'];
const RECONCILIATION_KEYS = ['reconciled', 'reconciliation_id'];
const RECONCILIATION_ID_PATTERN = /^recon-[a-z0-9][a-z0-9-]{3,80}$/;
const DEPLOYMENT_ID_PATTERN = /^dpl_[A-Za-z0-9]{6,64}$/;
const DEPLOYMENT_URL_PATTERN = /^https:\/\/[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.vercel\.app$/;
const ALIAS_HOST_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// High-confidence credential signatures only (never a heuristic that could
// misfire on a hostname or hash). Checked against the WHOLE serialized
// binding before any other validation, so a secret-bearing value is rejected
// outright -- and no reason string ever echoes the offending value.
const SECRET_SIGNATURES = [
  /sk_(live|test)_[A-Za-z0-9]/i, /rk_(live|test)_[A-Za-z0-9]/i, /whsec_[A-Za-z0-9]/i, /pk_(live|test)_[A-Za-z0-9]/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i, /\bvc[a-z]_[A-Za-z0-9]{8,}/i, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /[?&](token|key|secret|password|auth)=/i, /\/\/[^/\s:@]+:[^/\s@]+@/,
];

/** Strict validation of an evidence record's `release_binding`. Returns
 * `{ ok: true, value }` (a fresh, minimal copy) or `{ ok: false, reason }`
 * with a reason that never echoes any value from the input. */
export function validateReleaseBinding(binding) {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    return { ok: false, reason: 'release_binding is not an object' };
  }
  let serialized;
  try {
    serialized = JSON.stringify(binding);
  } catch {
    return { ok: false, reason: 'release_binding is not serializable' };
  }
  if (SECRET_SIGNATURES.some((re) => re.test(serialized))) {
    return { ok: false, reason: 'release_binding contains secret-shaped content' };
  }
  const keys = Object.keys(binding);
  const unknown = keys.filter((k) => !RELEASE_BINDING_KEYS.includes(k) && !RECONCILIATION_KEYS.includes(k));
  if (unknown.length > 0) return { ok: false, reason: `release_binding has ${unknown.length} unknown key(s)` };
  const hasReconciled = keys.includes('reconciled');
  const hasReconciliationId = keys.includes('reconciliation_id');
  if (hasReconciled !== hasReconciliationId) return { ok: false, reason: 'release_binding reconciled and reconciliation_id must be given together' };
  if (hasReconciled && binding.reconciled !== true) return { ok: false, reason: 'release_binding.reconciled must be true when present' };
  if (hasReconciliationId && (typeof binding.reconciliation_id !== 'string' || !RECONCILIATION_ID_PATTERN.test(binding.reconciliation_id))) {
    return { ok: false, reason: 'release_binding.reconciliation_id is malformed' };
  }
  const missing = RELEASE_BINDING_KEYS.filter((k) => binding[k] === undefined || binding[k] === null || binding[k] === '');
  if (missing.length > 0) return { ok: false, reason: `release_binding missing required key(s): ${missing.join(', ')}` };
  if (typeof binding.deployment_id !== 'string' || !DEPLOYMENT_ID_PATTERN.test(binding.deployment_id)) return { ok: false, reason: 'release_binding.deployment_id is malformed' };
  if (typeof binding.deployment_url !== 'string' || !DEPLOYMENT_URL_PATTERN.test(binding.deployment_url)) return { ok: false, reason: 'release_binding.deployment_url is malformed' };
  if (typeof binding.production_alias !== 'string' || !ALIAS_HOST_PATTERN.test(binding.production_alias)) return { ok: false, reason: 'release_binding.production_alias is malformed' };
  if (typeof binding.promoted_at !== 'string' || !ISO_UTC_PATTERN.test(binding.promoted_at) || Number.isNaN(Date.parse(binding.promoted_at))) return { ok: false, reason: 'release_binding.promoted_at is malformed' };
  if (binding.post_validation_result !== 'PASS') return { ok: false, reason: 'release_binding.post_validation_result is not PASS' };
  if (binding.live_revision_verified !== true) return { ok: false, reason: 'release_binding.live_revision_verified is not true' };
  return {
    ok: true,
    value: {
      deploymentId: binding.deployment_id,
      deploymentUrl: binding.deployment_url,
      productionAlias: binding.production_alias,
      promotedAt: binding.promoted_at,
      // Only present for a reconciled release; absent keys keep every
      // non-reconciled binding's shape byte-identical to before.
      ...(hasReconciled ? { reconciled: true, reconciliationId: binding.reconciliation_id } : {}),
    },
  };
}

const ARTIFACT_TYPES = new Set(['unit_test_report', 'integration_test_report', 'e2e_test_report', 'offline_evaluation', 'release_promotion_record']);

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Standard shape for a "recognized this schema, but it failed validation"
 * result — always carries enough identity (product/sourceRepository/
 * artifactPath/a content hash) for lib/factPromotion.mjs to durably log it
 * for audit (mandate: "malformed artifact -> blocked", never silently
 * dropped), even though it can never be promoted. */
function blocked(reason, { product, sourceRepository, relPath, text }) {
  return { ok: false, reason, product, sourceRepository, artifactPath: relPath, artifactHash: sha256(text ?? relPath) };
}

/**
 * Noemora PUBLIC_DEMO seal — reuses the canonical adapter's own pattern.
 * `relPath` is relative to the repo root (mirrors devObserver's own
 * artifact identity convention).
 */
function tryNoemoraSeal({ product, sourceRepository, relPath, text }) {
  const fileName = relPath.split('/').pop();
  const match = SEAL_FILE_PATTERN.exec(fileName);
  if (!match) return null;
  if (!text || !STRONG_STATUS_PATTERN.test(text)) {
    return blocked('noemora seal filename matched but no strong Status: marker inside', { product, sourceRepository, relPath, text });
  }
  const statusLine = /^Status:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const titleLine = /^#\s*(.+)$/m.exec(text)?.[1]?.trim() ?? fileName;
  const sha256Matches = [...text.matchAll(/SHA256:\s*([a-f0-9]{64,})/gi)].map((m) => m[1]);
  // Same field the canonical adapter (sourceAdapters/noemora.mjs) already
  // extracts and relies on for its own cursor advancement — reused here,
  // never a second guess at "when." Genuinely absent (not just unparsed)
  // when the seal doesn't carry a Generated: line at all — left null, never
  // fabricated from file mtime or scan time.
  const generatedLine = /^Generated:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  return {
    ok: true,
    evidenceType: 'noemora_public_demo_seal',
    product, sourceRepository,
    artifactPath: relPath,
    artifactHash: sha256Matches[0] ?? sha256(text),
    sourceRevision: match[1], // the seal's own version number (V<nnnnn>) — Noemora's seals are versioned independently of git SHA
    verifiedAt: generatedLine,
    result: 'PASS',
    verifierIdentity: 'noemora-public-demo-seal-convention',
    title: titleLine,
    statusLine,
    claim: `Noemora's public demo build reached the sealed milestone: ${titleLine}.`,
    claimStatus: 'VERIFIED',
    limitations: 'Demo-build milestone only — does not itself confirm live/production Noemora service behavior.',
  };
}

/** Official-site/ECHO Agent release manifest — reuses the existing schema tag officialSite.mjs already trusts. */
function tryReleaseManifest({ product, sourceRepository, relPath, text }) {
  if (!relPath.endsWith('manifest.json')) return null;
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return blocked('manifest.json present but not valid JSON', { product, sourceRepository, relPath, text });
  }
  if (manifest?.schema !== RELEASE_MANIFEST_SCHEMA_ID) return null; // not this convention at all — let another matcher try
  if (!manifest.release_id || !manifest.artifact_sha256 || !manifest.created_at) {
    return blocked('release manifest missing required fields (release_id/artifact_sha256/created_at)', { product, sourceRepository, relPath, text });
  }
  return {
    ok: true,
    evidenceType: 'release_manifest',
    product, sourceRepository,
    artifactPath: relPath,
    artifactHash: manifest.artifact_sha256,
    sourceRevision: manifest.release_id,
    verifiedAt: manifest.created_at,
    result: 'PASS',
    verifierIdentity: 'echo-agent-release-packaging-v1',
    claim: `${product} release artifact ${manifest.release_id} was packaged and sha256-verified.`,
    claimStatus: 'VERIFIED',
    limitations: 'Packaging/verification only — does not confirm public availability or live deployment.',
  };
}

/**
 * The generic, narrow schema any product could adopt. EVERY required field
 * (mandate section 3) must be present and well-typed, `result` must be the
 * literal string 'PASS' or 'VERIFIED', and `claim_topic` must be one of the
 * fixed CLAIM_TOPICS above — the evidence supplies FACTS (what ran, what
 * revision, a short bounded description), never the claim sentence itself.
 */
function tryGenericSchema({ product, sourceRepository, relPath, text }) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return null; // not JSON at all — not this schema, let it fall through to BLOCKED_UNVERIFIED
  }
  if (record?.schema !== GENERIC_SCHEMA_ID) return null;

  const required = ['product', 'artifact_type', 'source_revision', 'verified_at', 'result', 'verifier', 'public_safe', 'claim_topic'];
  const missing = required.filter((k) => record[k] === undefined || record[k] === null || record[k] === '');
  if (missing.length > 0) {
    return blocked(`generic schema missing required field(s): ${missing.join(', ')}`, { product, sourceRepository, relPath, text });
  }
  if (record.result !== 'PASS' && record.result !== 'VERIFIED') {
    return blocked(`result is not an explicit PASS/VERIFIED (saw: ${JSON.stringify(record.result)})`, { product, sourceRepository, relPath, text });
  }
  if (record.public_safe !== true) {
    return blocked('public_safe is not explicitly true', { product, sourceRepository, relPath, text });
  }
  if (!ARTIFACT_TYPES.has(record.artifact_type)) {
    return blocked(`unknown artifact_type: ${record.artifact_type}`, { product, sourceRepository, relPath, text });
  }
  const topic = CLAIM_TOPICS[record.claim_topic];
  if (!topic) {
    return blocked(`unknown claim_topic: ${record.claim_topic}`, { product, sourceRepository, relPath, text });
  }
  if (topic.allowedProduct && record.product !== topic.allowedProduct) {
    return blocked(`claim_topic '${record.claim_topic}' is scoped to product '${topic.allowedProduct}', not '${record.product}'`, { product, sourceRepository, relPath, text });
  }
  if (!topic.requiredArtifactTypes.includes(record.artifact_type)) {
    return blocked(`claim_topic '${record.claim_topic}' does not accept artifact_type '${record.artifact_type}'`, { product, sourceRepository, relPath, text });
  }
  // Optional deployment binding: provenance only, strictly validated when
  // present, and only meaningful on a release promotion record.
  let releaseBinding = null;
  if (Object.prototype.hasOwnProperty.call(record, 'release_binding')) {
    if (record.artifact_type !== 'release_promotion_record') {
      return blocked('release_binding is only valid on release_promotion_record evidence', { product, sourceRepository, relPath, text });
    }
    const checked = validateReleaseBinding(record.release_binding);
    if (!checked.ok) return blocked(checked.reason, { product, sourceRepository, relPath, text });
    releaseBinding = checked.value;
  }
  // description is a BOUNDED, plain factual substring slotted into a fixed
  // template — never trusted as free-form claim text on its own.
  const description = typeof record.description === 'string' ? record.description.slice(0, 300) : '';
  return {
    ok: true,
    evidenceType: `generic:${record.artifact_type}`,
    product, sourceRepository,
    artifactPath: relPath,
    artifactHash: sha256(text),
    sourceRevision: record.source_revision,
    verifiedAt: record.verified_at,
    result: record.result,
    verifierIdentity: record.verifier,
    claim: topic.template({ product: record.product, description }),
    claimStatus: topic.status,
    limitations: [topic.limitations, record.limitations].filter(Boolean).join(' '),
    claimTopic: record.claim_topic,
    releaseBinding, // null for evidence with no binding (all historical records)
  };
}

const MATCHERS = [tryNoemoraSeal, tryReleaseManifest, tryGenericSchema];

/**
 * Validates one observed artifact against every known trusted schema.
 * Returns `{ ok: true, ...evidence }` for STRONG evidence, or
 * `{ ok: false, reason }` for anything that looked plausible but failed a
 * required check, or `null` when nothing recognized the file at all (the
 * "unknown schema" case — also BLOCKED_UNVERIFIED at the caller). Tries
 * every matcher rather than stopping at the first match attempt, since a
 * matcher returning `null` means "not mine," not "rejected."
 */
export function validateEvidence({ product, sourceRepository, relPath, text }) {
  for (const matcher of MATCHERS) {
    const result = matcher({ product, sourceRepository, relPath, text });
    if (result !== null) return result;
  }
  return null;
}
