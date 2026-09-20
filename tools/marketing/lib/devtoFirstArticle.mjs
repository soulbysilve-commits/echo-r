// First real, long-form DEV.to technical article candidate. Unlike
// draftDevToArticle() (a single-fact template), this is a hand-authored,
// multi-fact engineering writeup — but every substantive claim still
// traces to exactly one FACT-* id from docs/marketing/VERITAS_FORGE_PUBLIC_FACTS.md
// (CLAIM_SECTIONS below is the single source of truth both the public body
// and the private evidence manifest are built from, so the two can never
// drift apart). Building/validating/writing/approving the candidate never
// calls the DEV.to API and never touches the canary draft (article
// 4669152) — only the explicit publishApprovedDevToFirstArticle() at the
// bottom of this file ever makes a real network call, and only for a
// HUMAN_APPROVED row. This module never imports a connector directly; a
// real client is passed in by the caller (see cli.mjs's `publish-approved`
// command), so every function above that stays trivially connector-free.
// PENDING_HUMAN_APPROVAL is recorded via the same mechanism
// lib/humanApprovalPackage.mjs's Product Hunt/HN/note packages already use;
// approveDevToFirstArticle() below is the only thing that ever transitions
// it to HUMAN_APPROVED (DEVTO_FIRST_PUBLIC_APPROVED=true).
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factById } from './facts.mjs';
import { checkContent, checkPolicyGate } from './policy.mjs';
import { recordIntent, findExisting, markPublished } from './ledger.mjs';
import { CANARY_DEVTO_TITLE, CANARY_DEVTO_BODY } from './canary.mjs';
import { getChannelState } from './channelState.mjs';

export const DEVTO_FIRST_ARTICLE_ACTION_TYPE = 'devto_first_public_article';
export const DEVTO_FIRST_ARTICLE_IDEMPOTENCY_KEY = 'devto:first-public-article:v1';
export const DEVTO_FIRST_ARTICLE_TITLE = 'How We Separate Persistent AI Identity from the Underlying LLM';
export const DEVTO_FIRST_ARTICLE_TAGS = ['ai', 'machinelearning', 'architecture', 'llm'];
export const DEVTO_FIRST_ARTICLE_SLUG = 'how-we-separate-persistent-ai-identity-from-the-underlying-llm';

const INTRO = `A bare LLM inference call does not provide durable identity by itself: send context in, get output back. Any continuity across days, sessions, or model changes has to be maintained by system-controlled state outside the model itself.

If you want an AI system with a persistent identity — one that has continuity, memory, and a relationship that develops over time — those properties need their own storage, selection, and verification layer. This is a look at how we've actually built that separation in ECHO Agent and ECHO App, what's verified today, and what's still in progress.

Every claim below is labeled with its real status. We're not going to pretend something works end-to-end when our own tests say otherwise — a couple of the sections here are deliberately about things that are still broken.`;

const CLOSING = `## Why this needs its own infrastructure at all

None of the above is "prompt engineering." A bigger context window doesn't give you evidence-based continuity verification, and a longer system prompt doesn't give you a relationship state that persists and updates with its own rules. Identity, memory, and continuity are storage and verification problems that live in a layer above the model — which is also why that state can remain outside the model when the underlying model changes. That's the bet this architecture makes, and the sections above are an honest account of how much of it is actually built versus still ahead of us.

We'll follow up as the multi-provider continuity work and the long-horizon session tests move from "planned" to "verified."`;

const CLAIM_SECTIONS = [
  {
    factId: 'FACT-008',
    heading: 'The model is not the identity',
    statusLabel: 'Partial — verified only for a simulated planner swap, not a real provider swap',
    body: `ECHO Agent's persisted identity records — commitments, autobiography, continuity state — don't store any reference to which model or planner produced them. We proved this by loading the same on-disk identity state into a runtime instantiated with a different planner function and confirming it survives intact.

To be precise about what that does and doesn't show: the test swaps a planner *function* (e.g. one that returns response "A" vs. one that returns response "B"), not a live call to a different model provider. It demonstrates the storage layer is genuinely model-agnostic by construction, not that we've validated identity continuity across a real multi-provider swap in production — that's a separate, not-yet-demonstrated step (see "Toward real multi-provider continuity" below).`,
  },
  {
    factId: 'FACT-009',
    heading: 'Continuity is verified, never self-reported',
    statusLabel: 'Verified',
    body: `An LLM can be prompted into claiming almost anything, including that it "remembers" a relationship it has no actual continuity evidence for. So ECHO Agent doesn't trust the model's own claim of continuity at all. A dedicated continuity-permission gate recomputes an identity-continuity signal from on-disk evidence on every sensitive action, and that signal can independently escalate to WARN (require approval for actions the base permission gate would otherwise auto-allow) or FAIL (deny everything but read-only). We specifically test this against a spoofed-continuity claim — the model asserting continuity it can't back up — and confirm the gate still fails closed.`,
  },
  {
    factId: 'FACT-010',
    heading: 'Durable storage underneath',
    statusLabel: 'Verified',
    body: `Underneath the identity and continuity layers is a hash-verified write-ahead log, a classified write ledger, and hybrid lexical-plus-embedding memory search. This is the oldest and most heavily tested layer of the stack — fully committed, with broad existing test coverage — and it's what everything above it (continuity checks, identity records, relationship state) is ultimately built on top of.`,
  },
  {
    factId: 'FACT-011',
    heading: 'The same durable-memory approach on the app side',
    statusLabel: 'Verified (backend)',
    body: `ECHO App's backend saves and retrieves long-term memories the same way: a hybrid of lexical matching and embedding similarity, not a single retrieval strategy. This is backend logic only — device-side memory consolidation on the client is still partial, and we didn't have a way to execute the client-side test suite in the environment this was verified in, so we're not claiming it end-to-end yet.`,
  },
  {
    factId: 'FACT-012',
    heading: 'Relationship state as real persisted data',
    statusLabel: 'Verified (backend)',
    body: `ECHO App tracks a relationship as numeric state — trust, affection, guardedness, respect, stability — that persists and updates over time through write-ahead-logged load/save/apply-impacts logic, with clamped, inertia-based changes rather than values that can swing arbitrarily from a single interaction. This is backend-side and verified; there's currently no dedicated typed relationship model on the iOS client, where it's handled as a generic field instead.`,
  },
  {
    factId: 'FACT-013',
    heading: 'Conversation continuity across sessions',
    statusLabel: 'Partial — known gap, not solved',
    body: `Conversations can pick up context from prior sessions, and the core continuity-transfer tests pass. But we're not going to round this up: our own end-to-end test for canonical, long-horizon (multi-year) continuity — rebuilding context from canonically-selected evidence after a long gap — is currently failing. We're treating that as an open problem, not finished infrastructure, until it's green.`,
  },
  {
    factId: 'FACT-014',
    heading: 'Bounded context assembly, not a raw history dump',
    statusLabel: 'Partial — backend verified, client regressed',
    body: `Rather than stuffing raw conversation history into the prompt, model context (memories, beliefs, prior turns) goes through a dedicated, bounded, deterministically-ranked assembler. The backend concept is real and its own test suite passes. The client-side implementation, though, is currently regressed relative to its own contract tests — several bounded-context-selection and continuous-conversation-assembly checks are failing because the Swift source has drifted from what those contracts expect. We're not marketing this as working end-to-end until that regression is fixed and re-verified.`,
  },
  {
    factId: 'FACT-015',
    heading: 'Toward real multi-provider continuity',
    statusLabel: 'Partial — architecture in place, live continuity not yet demonstrated',
    body: `ECHO App's backend already talks to different LLM providers (a mock provider, or any OpenAI-compatible endpoint) behind one common interface, without the context-assembly logic above needing to know which provider is behind it. That's architecturally the right shape for "swap the model, keep the identity" — but we want to be precise about what's actually been shown so far: no test yet swaps providers mid-conversation and confirms that identity, memory, and relationship state all survive the swap intact in a live run. That's the next real validation step, not something we're claiming today.`,
  },
];

function buildBodyMarkdown() {
  const sections = CLAIM_SECTIONS.map(
    (s) => `## ${s.heading}\n\n**Status: ${s.statusLabel}.**\n\n${s.body}`
  ).join('\n\n');
  return [INTRO, sections, CLOSING].join('\n\n');
}

/**
 * Builds the candidate DEV.to article + a private review manifest mapping
 * every section's claim to the exact fact registry entry backing it (fact
 * id, product, status, source repository/path, source evidence, the
 * verification date). The manifest is for internal review only and is
 * never written into the public article body.
 */
export function buildDevToFirstArticleCandidate(facts) {
  const factIds = [...new Set(CLAIM_SECTIONS.map((s) => s.factId))];
  const missing = factIds.filter((id) => !factById(facts, id));
  if (missing.length > 0) {
    return { ok: false, reason: 'MISSING_FACTS', missing };
  }

  const bodyMarkdown = buildBodyMarkdown();
  const description = "What's actually implemented, verified, and still in progress in how ECHO keeps a persistent identity, memory, and relationship state separate from the underlying LLM.";

  const candidate = {
    channel: 'devto',
    title: DEVTO_FIRST_ARTICLE_TITLE,
    description,
    tags: DEVTO_FIRST_ARTICLE_TAGS,
    body_markdown: bodyMarkdown,
    canonical_content_id: DEVTO_FIRST_ARTICLE_IDEMPOTENCY_KEY,
    canonical_url: null,
    factIds,
    claimStrength: 'neutral',
    actionType: DEVTO_FIRST_ARTICLE_ACTION_TYPE,
    slug: DEVTO_FIRST_ARTICLE_SLUG,
  };

  const reviewManifest = {
    title: candidate.title,
    generatedAt: new Date().toISOString(),
    idempotencyKey: DEVTO_FIRST_ARTICLE_IDEMPOTENCY_KEY,
    claims: CLAIM_SECTIONS.map((s) => {
      const fact = factById(facts, s.factId);
      return {
        section: s.heading,
        statusLabelInArticle: s.statusLabel,
        factId: s.factId,
        factStatus: fact.STATUS,
        product: fact.PRODUCT,
        claim: fact.CLAIM,
        sourceRepository: fact.SOURCE_REPOSITORY,
        sourcePath: fact.SOURCE_PATH,
        sourceEvidence: fact.SOURCE_EVIDENCE,
        verifiedAt: fact.VERIFIED_AT,
        publicSafe: fact.PUBLIC_SAFE === 'true',
        notes: fact.NOTES ?? '',
      };
    }),
  };

  return { ok: true, candidate, reviewManifest };
}

const INTERNAL_PATH_PATTERNS = [
  /tools\/marketing/i,
  /~\/\.config/i,
  /~\/\.local\/share/i,
  /MARKETING_STATE_DIR/,
  /DEVTO_API_KEY/,
  /secrets\.env/i,
  /publication_ledger/i,
  /veritas-forge-marketing\/(logs|videos)/i,
];

const HYPE_WORDS = /\b(revolutionary|game-changing|cutting-edge|next-generation|unprecedented|paradigm shift|world-class|supercharge)\b/i;

/**
 * Everything a human reviewer needs before this could ever be approved:
 * policy-gate checks (reused from the same engine every other channel's
 * content goes through), fact-registry traceability for every cited claim,
 * a hard block on reusing/duplicating the canary draft's content, and a
 * scan for internal-only operational paths/secrets and hype language that
 * doesn't belong in an engineering writeup.
 */
export function validateDevToFirstArticleCandidate(candidate, facts) {
  const violations = [];

  if (candidate.title === CANARY_DEVTO_TITLE || candidate.body_markdown === CANARY_DEVTO_BODY) {
    violations.push('DUPLICATES_CANARY_CONTENT');
  }

  if (!candidate.tags || candidate.tags.length === 0 || candidate.tags.length > 4) {
    violations.push('INVALID_TAG_COUNT');
  }

  if (!candidate.body_markdown || candidate.body_markdown.length < 1500) {
    violations.push('INSUFFICIENT_TECHNICAL_SUBSTANCE');
  }

  if (!candidate.factIds || candidate.factIds.length < 5) {
    violations.push('INSUFFICIENT_EVIDENCE_BREADTH');
  }

  for (const id of candidate.factIds ?? []) {
    const fact = factById(facts, id);
    if (!fact) {
      violations.push(`UNKNOWN_FACT_ID:${id}`);
    } else if (fact.PUBLIC_SAFE !== 'true') {
      violations.push(`FACT_NOT_PUBLIC_SAFE:${id}`);
    }
  }

  const contentCheck = checkContent(
    { text: candidate.body_markdown ?? '', factIds: candidate.factIds, claimStrength: candidate.claimStrength },
    facts
  );
  if (!contentCheck.ok) violations.push(...contentCheck.violations);

  const policyCheck = checkPolicyGate({ text: candidate.body_markdown ?? '' });
  if (!policyCheck.ok) violations.push(...policyCheck.violations);

  for (const pattern of INTERNAL_PATH_PATTERNS) {
    if (pattern.test(candidate.body_markdown ?? '')) violations.push(`INTERNAL_PATH_LEAK:${pattern}`);
  }

  if (HYPE_WORDS.test(candidate.body_markdown ?? '')) violations.push('HYPE_LANGUAGE');

  return { ok: violations.length === 0, violations };
}

function frontmatterToYaml({ title, description, tags, canonicalContentId, canonicalUrl }) {
  const lines = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    `tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]`,
    `canonical_content_id: ${JSON.stringify(canonicalContentId)}`,
    `canonical_url: ${canonicalUrl ? JSON.stringify(canonicalUrl) : 'null'}`,
    'published: false',
    '---',
    '',
  ];
  return lines.join('\n');
}

/**
 * Writes the reviewable article candidate into a real, git-tracked content
 * directory (same "generate, never auto-post" pattern as lib/zenn.mjs) and
 * the private evidence manifest into a separate, non-public review
 * directory. Idempotent by slug: never overwrites an already-generated
 * candidate or manifest.
 */
export function writeDevToFirstArticleCandidate(candidate, reviewManifest, { contentDir, reviewDir }) {
  mkdirSync(contentDir, { recursive: true });
  mkdirSync(reviewDir, { recursive: true });

  const articlePath = join(contentDir, `${candidate.slug}.md`);
  const manifestPath = join(reviewDir, `${candidate.slug}.manifest.json`);

  let writtenArticle = false;
  let writtenManifest = false;

  if (!existsSync(articlePath)) {
    const frontmatter = frontmatterToYaml({
      title: candidate.title, description: candidate.description, tags: candidate.tags,
      canonicalContentId: candidate.canonical_content_id, canonicalUrl: candidate.canonical_url,
    });
    writeFileSync(articlePath, frontmatter + candidate.body_markdown);
    writtenArticle = true;
  }
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, JSON.stringify(reviewManifest, null, 2));
    writtenManifest = true;
  }

  return { articlePath, manifestPath, writtenArticle, writtenManifest };
}

/**
 * Records the candidate as PENDING_HUMAN_APPROVAL in the same durable
 * publication_ledger every other never-auto-submitted package (Product
 * Hunt/HN/note) already uses — idempotent via the ledger's own
 * UNIQUE(channel, content_hash) on the article body, so calling this again
 * for the same candidate text never creates a second pending row. This
 * (approval_state='PENDING_HUMAN_APPROVAL', published_at IS NULL) is the
 * durable DEVTO_FIRST_PUBLIC_APPROVED=false boundary. The only way it ever
 * changes is the explicit, separate approveDevToFirstArticle() call below —
 * never automatically, and never as a side effect of preparing/validating
 * the candidate.
 */
export function recordDevToFirstArticlePending(db, candidate) {
  const row = recordIntent(db, {
    channel: 'devto',
    text: candidate.body_markdown,
    contentType: candidate.actionType,
    sourceEvidence: candidate.factIds.join(','),
    riskClass: 'HUMAN_APPROVAL_REQUIRED',
    approvalState: 'PENDING_HUMAN_APPROVAL',
    canonicalContentId: candidate.canonical_content_id,
    canonicalUrl: candidate.canonical_url,
  });
  return { status: 'PENDING_APPROVAL', publicationId: row.publication_id };
}

export const HUMAN_APPROVED_STATE = 'HUMAN_APPROVED';

/**
 * The ONLY function in this codebase that transitions this specific
 * article's ledger row from PENDING_HUMAN_APPROVAL to HUMAN_APPROVED — this
 * is the durable DEVTO_FIRST_PUBLIC_APPROVED=true boundary. Requires a
 * PENDING row to already exist for this exact candidate content (via
 * recordDevToFirstArticlePending) — approval is never recorded for content
 * that never went through the pending-review step, and this never
 * auto-creates one. This approves ONLY the ledger row matching this exact
 * candidate's content hash; it has no effect on, and sets no state for, any
 * other article/channel.
 */
export function approveDevToFirstArticle(db, candidate) {
  const row = findExisting(db, 'devto', candidate.body_markdown);
  if (!row) return { ok: false, reason: 'NOT_PENDING', detail: 'no PENDING_HUMAN_APPROVAL row exists for this exact article content — run prepare devto-first first' };
  if (row.published_at) return { ok: true, alreadyApproved: true, alreadyPublished: true, publicationId: row.publication_id };
  if (row.approval_state === HUMAN_APPROVED_STATE) {
    return { ok: true, alreadyApproved: true, alreadyPublished: false, publicationId: row.publication_id };
  }
  if (row.approval_state !== 'PENDING_HUMAN_APPROVAL') {
    return { ok: false, reason: 'UNEXPECTED_APPROVAL_STATE', detail: row.approval_state };
  }
  db.prepare('UPDATE publication_ledger SET approval_state = ? WHERE publication_id = ?').run(HUMAN_APPROVED_STATE, row.publication_id);
  return { ok: true, alreadyApproved: false, alreadyPublished: false, publicationId: row.publication_id };
}

/**
 * Reads back the real durable state — never assumes, always re-derives from
 * the ledger row. `approved` (DEVTO_FIRST_PUBLIC_APPROVED) means a human
 * ran approveDevToFirstArticle() for this exact content — it says nothing
 * about whether it's actually live yet; `published` is the separate,
 * later fact that the real publish call succeeded.
 */
export function getDevToFirstArticleApprovalState(db, candidate) {
  const row = findExisting(db, 'devto', candidate.body_markdown);
  if (!row) return { exists: false, approved: false, pending: false, published: false, publicationId: null };
  return {
    exists: true,
    approved: row.approval_state === HUMAN_APPROVED_STATE || !!row.published_at,
    pending: row.approval_state === 'PENDING_HUMAN_APPROVAL' && !row.published_at,
    published: !!row.published_at,
    publicationId: row.publication_id,
  };
}

/** Reads a previously-written manifest back from disk — used by status reporting, never assumes. */
export function readDevToFirstArticleManifest(manifestPath, { readFileImpl = readFileSync, existsImpl = existsSync } = {}) {
  if (!existsImpl(manifestPath)) return { exists: false };
  return { exists: true, manifest: JSON.parse(readFileImpl(manifestPath, 'utf8')) };
}

/**
 * The one-time, explicitly-human-approved real publish for this specific
 * article. Deliberately bypasses MARKETING_DEVTO_ENABLED/PUBLIC_MARKETING_MODE
 * (this function is never called from the unattended operator loop — only
 * an explicit `publish-approved devto-first` CLI invocation reaches it,
 * same "explicit invocation, not a mode/flag check, is what makes this
 * safe" architecture as every canary function in lib/canary.mjs), but every
 * other safety property still applies in full:
 *  - requires a durable HUMAN_APPROVED row for this EXACT content hash
 *    (never publishes edited-since-approval content — a wording change
 *    after approval simply has no matching approved row, and this fails
 *    NOT_APPROVED rather than silently publishing the new text)
 *  - requires durably-recorded AUTH_VALID and CANARY_PASS
 *  - re-confirms identity live before ever attempting a create
 *  - checks the real remote account for a pre-existing matching article
 *    before creating anything (crash/duplicate prevention, same pattern as
 *    canaryDevto's adopt-before-create logic)
 *  - FAILS CLOSED unless the response (or, if ambiguous, live
 *    reconciliation against the real DEV.to API) explicitly confirms
 *    published=true
 *  - idempotent: an already-published row returns instantly, zero network
 *    calls, never creates a second article
 */
export async function publishApprovedDevToFirstArticle(db, candidate, { env = process.env, fetchImpl, devtoClient } = {}) {
  const row = findExisting(db, 'devto', candidate.body_markdown);
  if (row?.published_at) {
    return {
      ok: true, alreadyPublished: true, idempotent: true,
      externalId: row.external_id, externalUrl: row.external_url, published: true,
    };
  }
  if (!row || row.approval_state !== HUMAN_APPROVED_STATE) {
    return { ok: false, reason: 'NOT_APPROVED' };
  }

  const state = getChannelState(db, 'devto');
  if (!state.auth_valid) return { ok: false, reason: 'AUTH_NOT_VALID_LOCALLY' };
  if (!state.canary_passed) return { ok: false, reason: 'CANARY_NOT_PASSED' };

  const identity = await devtoClient.getIdentity({ env, fetchImpl });
  if (!identity.ok) return { ok: false, reason: 'AUTH_INVALID', detail: identity.message ?? identity.errorClass };

  // Duplicate-prevention: a real article with this exact title may already
  // exist remotely (crash after a prior successful create, before the
  // local ledger write landed) — never blindly create a second one.
  const remoteAll = await devtoClient.getAllArticles({ env, fetchImpl });
  if (remoteAll.ok) {
    const remoteMatch = remoteAll.articles.find((a) => a.title === candidate.title);
    if (remoteMatch) {
      if (remoteMatch.published) {
        const externalId = String(remoteMatch.id);
        markPublished(db, row.publication_id, { externalId, externalUrl: remoteMatch.url, result: 'PUBLISHED_OK_ADOPTED' });
        return { ok: true, alreadyPublished: true, idempotent: true, adopted: true, externalId, externalUrl: remoteMatch.url, published: true };
      }
      // A draft with this exact title already exists remotely but isn't
      // published — never guess at its provenance; fail closed rather than
      // create a second article or silently publish someone else's draft.
      return { ok: false, reason: 'REMOTE_DRAFT_EXISTS_NOT_PUBLISHED', externalId: String(remoteMatch.id) };
    }
  }

  const result = await devtoClient.createArticle({
    title: candidate.title, body_markdown: candidate.body_markdown, tags: candidate.tags,
    description: candidate.description, canonical_url: candidate.canonical_url ?? undefined, published: true,
  }, { env, fetchImpl });
  if (!result.ok) {
    return { ok: false, reason: result.message ?? result.errorClass ?? 'PUBLISH_FAILED' };
  }
  if (!result.id) {
    return { ok: false, reason: 'PUBLISH_NOT_VERIFIABLE_NO_ID' };
  }
  const externalId = String(result.id);

  if (result.published !== true) {
    // The create response didn't explicitly confirm published=true — never
    // trust HTTP success alone. Reconcile against the real API before
    // deciding anything.
    const reconcile = await devtoClient.reconcileArticleStatus(externalId, { env, fetchImpl });
    if (!reconcile.ok || reconcile.status !== 'PUBLISHED') {
      return {
        ok: false, reason: 'PUBLISHED_NOT_CONFIRMED_TRUE', externalId,
        reconcileStatus: reconcile.ok ? reconcile.status : reconcile.errorClass,
      };
    }
  }

  markPublished(db, row.publication_id, { externalId, externalUrl: result.url, result: 'PUBLISHED_OK' });
  return { ok: true, alreadyPublished: false, idempotent: false, externalId, externalUrl: result.url, published: true };
}
