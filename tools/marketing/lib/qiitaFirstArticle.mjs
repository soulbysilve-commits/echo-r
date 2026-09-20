// First real, long-form Qiita technical article candidate. Same
// architecture as lib/devtoFirstArticle.mjs (hand-authored, multi-fact
// writeup; CLAIM_SECTIONS is the single source of truth the public body AND
// the private evidence manifest are both built from). Building/validating/
// writing/approving the candidate never calls the Qiita API and never
// touches the private canary item (24d097823c81f2914e9b) — only the
// explicit publishApprovedQiitaFirstArticle() at the bottom of this file
// ever makes a real network call, and only for a HUMAN_APPROVED row. This
// module never imports a connector directly; a real client is passed in by
// the caller (see cli.mjs's `publish-approved` command), so every function
// above that stays trivially connector-free. PENDING_HUMAN_APPROVAL is
// recorded via the same mechanism lib/humanApprovalPackage.mjs's Product
// Hunt/HN/note packages already use; approveQiitaFirstArticle() below is
// the only thing that ever transitions it to HUMAN_APPROVED
// (QIITA_FIRST_PUBLIC_APPROVED=true).
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factById } from './facts.mjs';
import { checkContent, checkPolicyGate } from './policy.mjs';
import { recordIntent, findExisting, markPublished } from './ledger.mjs';
import { CANARY_QIITA_TITLE, CANARY_QIITA_BODY } from './canary.mjs';
import { buildDevToFirstArticleCandidate } from './devtoFirstArticle.mjs';
import { getChannelState } from './channelState.mjs';

export const QIITA_FIRST_ARTICLE_ACTION_TYPE = 'qiita_first_public_article';
export const QIITA_FIRST_ARTICLE_IDEMPOTENCY_KEY = 'qiita:identity-continuity-gate:v1';
export const QIITA_FIRST_ARTICLE_TITLE = 'LLMの「覚えている」を信用しない — ECHO AgentのIdentity Continuity Gate設計';
export const QIITA_FIRST_ARTICLE_TAGS = ['AI', 'LLM', 'Python', '設計'];
export const QIITA_FIRST_ARTICLE_SLUG = 'llm-continuity-permission-gate';

const INTRO = `LLMは呼び出しのたびに新しく推論を行うだけで、それ自体は「以前の自分」を証明する手段を持たない。にもかかわらず、モデルは対話の中で自然に「覚えています」「継続性は保たれています」と発話できてしまう。この発話は、実際に継続性が保たれているという証拠には一切ならない。もしシステムがこの自己申告をそのまま信用して機微な操作を許可すれば、継続性を偽装するだけで権限を騙し取れることになる。

この記事では、ECHO Agentがこの問題に対してどう設計しているか——モデルの発言と継続性の証拠を分離し、常に証拠側から独立に継続性を再計算し、その結果を権限判定に使う仕組み——を、実装とテストの範囲で検証済みのことだけに絞って説明する。`;

const CLOSING = `## まとめ

LLMの「覚えている」という発言は、それ自体では継続性の証拠にならない。ECHO Agentは、モデルの発言と永続化された証拠を明確に分離し、権限判定を常に証拠側から独立に再計算することで、継続性の詐称に対して構造的にfail closedする設計を取っている。この設計の中核部分（continuity-permission gateとその永続化レイヤー）はVERIFIEDとして検証されている一方、モデルプロバイダーをまたいだ継続性についてはまだ実証されていない。`;

const CLAIM_SECTIONS = [
  {
    factId: 'FACT-009',
    heading: '問題',
    statusLabel: 'VERIFIED',
    body: `LLMをそのまま信用すると、「継続性がある」という自己申告だけで機微な操作の許可が通ってしまう。ECHO Agentはこれを避けるため、continuity-permission gateという独立したコンポーネントを持っている。このゲートは、モデルの発言を一切信用せず、常にディスク上の永続化された証拠から継続性シグナルを再計算し、その結果だけを権限判定に使う。`,
  },
  {
    factId: 'FACT-009',
    heading: 'モデルの発言と継続性の証拠を分離する',
    statusLabel: 'VERIFIED',
    body: `ここで区別すべき概念は3つある。

1. モデルが生成した発言（model-generated statement）— 会話の中でモデルが「覚えている」と主張するテキスト。これは推論結果であり、証拠ではない。
2. 永続化された証拠（persisted evidence）— ディスク上に書き込まれ、モデルの発話とは独立して存在する記録。
3. 独立に再計算された継続性状態（independently recomputed continuity state）— 永続化された証拠から、判定のたびに改めて計算される継続性の結果。モデルの自己申告を継続性の根拠としてそのまま採用しない。

ECHO Agentのcontinuity-permission gateは、常に3番目だけを権限判定の入力として使う。モデルが「継続性がある」と言っているかどうかは、判定に一切影響しない。`,
  },
  {
    factId: 'FACT-009',
    heading: 'Continuity Permission Gate',
    statusLabel: 'VERIFIED',
    body: `継続性の判定は、機微な操作を実行する直前に、オンディスクの証拠から都度再計算される。判定はモデルの発言をそのまま信じるのではなく、実際に記録されている継続性の証拠と照合して行われる。判定結果はcontinuity signalとして表現され、その結果は権限ゲート（permission gate）の判断に直接反映される。`,
  },
  {
    factId: 'FACT-009',
    heading: 'WARN / FAIL',
    statusLabel: 'VERIFIED',
    body: `この記事で扱う制約側のcontinuity signalには、WARNとFAILがある。

- **WARN**: 通常であればbase permission gateが自動的に許可する操作について、追加の承認を要求する状態。
- **FAIL**: read-only以外のすべての操作を拒否する状態。

これらの状態は、ディスク上の証拠から再計算されたcontinuity signalとして権限制約に反映される。重要なのは、この状態がモデル自身の申告からではなく、常にディスク上の証拠から独立に再計算される点である。`,
  },
  {
    factId: 'FACT-009',
    heading: '「覚えている」と嘘をつくモデルをどう扱うか',
    statusLabel: 'VERIFIED',
    body: `この設計を検証するテストの一つに、いわゆる継続性の詐称（spoofed continuity claim）テストがある。内容はシンプルで、モデルが継続性を主張しても、永続化された証拠がそれを裏付けていない場合に、ゲートが実際にfail closedするかどうかを確認するというものである。このテストは実際にパスしており、モデルの自己申告だけでは権限が通らないことを確認している。`,
  },
  {
    factId: 'FACT-010',
    heading: '永続化レイヤー',
    statusLabel: 'VERIFIED',
    body: `この継続性の判定を成立させているのは、その下にある永続化レイヤーである。ECHO Agentは、ハッシュ検証付きのwrite-ahead-log（WAL）、分類されたwrite ledger、そして語彙検索と埋め込み検索を組み合わせたhybrid memory searchを持つ。これはECHO Agentのスタックの中でもっとも古くからコミットされ、テストカバレッジも広い、成熟したレイヤーである。continuity-permission gateが参照する「証拠」は、最終的にこの永続化レイヤーに支えられている。`,
  },
  {
    factId: 'FACT-008',
    heading: '補足: identityレコードとモデルの独立性について',
    statusLabel: 'PARTIAL（planner関数の入れ替えシミュレーションのみ、実プロバイダー切り替えは未実証）',
    body: `identityレコード（commitments, autobiography, continuity state）自体は、それを生成したモデルやplannerへの参照を一切持たない。これはplanner関数を入れ替えたシミュレーションで検証されている。ただし、この検証はplanner関数の入れ替えに限定されたものであり、実際に別のモデルプロバイダーへ切り替える形でのテストではない。したがって「実運用で別のAIモデル/プロバイダーに切り替えても継続性が保たれる」という主張は、この記事の時点ではまだ実証されていない。`,
  },
];

function buildBodyMarkdown() {
  const sections = CLAIM_SECTIONS.map(
    (s) => `## ${s.heading}\n\n**検証状況: ${s.statusLabel}**\n\n${s.body}`
  ).join('\n\n');
  const verified = '## 何が検証済みで、何がまだ未検証か\n\n**検証済み:**\n\n- continuity-permission gateがWARN/FAILを、モデルの自己申告ではなくディスク上の証拠から独立に再計算すること\n- 継続性の詐称テストに対してゲートがfail closedすること\n- ハッシュ検証付きWAL・write ledger・hybrid memory searchによる永続化レイヤーが実装されテストされていること\n\n**未検証・限定的:**\n\n- identityレコードがplanner関数の入れ替えに対して残ることは確認されているが、これは実際のモデルプロバイダー切り替えを意味しない';
  return [`# ${QIITA_FIRST_ARTICLE_TITLE}`, INTRO, sections, verified, CLOSING].join('\n\n');
}

/**
 * Builds the candidate Qiita article + a private review manifest mapping
 * every section's claim to the exact fact registry entry backing it. The
 * manifest is for internal review only and is never written into the
 * public article body (no SOURCE_PATH/SOURCE_REPOSITORY appears in the
 * Japanese prose above).
 */
export function buildQiitaFirstArticleCandidate(facts) {
  const factIds = [...new Set(CLAIM_SECTIONS.map((s) => s.factId))];
  const missing = factIds.filter((id) => !factById(facts, id));
  if (missing.length > 0) {
    return { ok: false, reason: 'MISSING_FACTS', missing };
  }

  const bodyMarkdown = buildBodyMarkdown();

  const candidate = {
    channel: 'qiita',
    title: QIITA_FIRST_ARTICLE_TITLE,
    tags: QIITA_FIRST_ARTICLE_TAGS,
    body_markdown: bodyMarkdown,
    canonical_content_id: QIITA_FIRST_ARTICLE_IDEMPOTENCY_KEY,
    canonical_url: null,
    factIds,
    claimStrength: 'neutral',
    actionType: QIITA_FIRST_ARTICLE_ACTION_TYPE,
    slug: QIITA_FIRST_ARTICLE_SLUG,
  };

  const reviewManifest = {
    title: candidate.title,
    generatedAt: new Date().toISOString(),
    idempotencyKey: QIITA_FIRST_ARTICLE_IDEMPOTENCY_KEY,
    claims: CLAIM_SECTIONS.map((s) => {
      const fact = factById(facts, s.factId);
      return {
        claim: fact.CLAIM,
        factId: s.factId,
        factStatus: fact.STATUS,
        sourceRepository: fact.SOURCE_REPOSITORY,
        sourcePath: fact.SOURCE_PATH,
        sourceEvidence: fact.SOURCE_EVIDENCE,
        publicSafe: fact.PUBLIC_SAFE === 'true',
        articleSection: s.heading,
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
  /QIITA_ACCESS_TOKEN/,
  /DEVTO_API_KEY/,
  /secrets\.env/i,
  /publication_ledger/i,
  /veritas-forge-marketing\/(logs|videos)/i,
  // Real repo/file paths this article's own evidence traces to — belong in
  // the private manifest only, never in the public article body.
  /echo_agent_continuity_permission_v1\.py/i,
  /identity_continuity_evolution_v1\.py/i,
  /state_wal\.py/i,
  /write_ledger\.py/i,
  /memory_manager\.py/i,
  /echo_agent_model_migration_proof_v1\.py/i,
  /ECHODiscord版/,
];

const HYPE_WORDS = /\b(revolutionary|game-changing|cutting-edge|next-generation|unprecedented|paradigm shift|world-class|supercharge)\b/i;
const HYPE_WORDS_JA = /(革新的|画期的|業界初|世界初|圧倒的|最先端|次世代)/;

/**
 * Real paragraph-level duplication check against the DEV.to first article
 * (mandate section 7: "No paragraph-level duplication"). Compares every
 * non-trivial paragraph (split on blank lines) of each body for exact
 * substring overlap — genuinely checks the two real bodies against each
 * other, not just a documentation claim that they differ.
 */
export function checkNoDevtoDuplication(qiitaBody, facts) {
  const devto = buildDevToFirstArticleCandidate(facts);
  if (!devto.ok) return { ok: true, checked: false }; // nothing to compare against
  const devtoParagraphs = devto.candidate.body_markdown.split(/\n\n+/).map((p) => p.trim()).filter((p) => p.length >= 40);
  const qiitaParagraphs = qiitaBody.split(/\n\n+/).map((p) => p.trim()).filter((p) => p.length >= 40);
  for (const qp of qiitaParagraphs) {
    for (const dp of devtoParagraphs) {
      if (qp === dp || qp.includes(dp) || dp.includes(qp)) {
        return { ok: false, checked: true, duplicateParagraph: qp.slice(0, 80) };
      }
    }
  }
  return { ok: true, checked: true };
}

/**
 * Everything a human reviewer needs before this could ever be approved:
 * policy-gate checks (reused from the same engine every other channel's
 * content goes through), fact-registry traceability for every cited claim,
 * a hard block on reusing/duplicating the private canary item's content, a
 * hard block on paragraph-level duplication with the DEV.to first article,
 * and a scan for internal-only operational paths/secrets/repo file paths
 * and hype language (English and Japanese) that don't belong in a public
 * engineering writeup.
 */
export function validateQiitaFirstArticleCandidate(candidate, facts) {
  const violations = [];

  if (candidate.title === CANARY_QIITA_TITLE || candidate.body_markdown === CANARY_QIITA_BODY) {
    violations.push('DUPLICATES_CANARY_CONTENT');
  }

  if (!candidate.tags || candidate.tags.length === 0 || candidate.tags.length > 5) {
    violations.push('INVALID_TAG_COUNT');
  }

  if (!candidate.body_markdown || candidate.body_markdown.length < 800) {
    violations.push('INSUFFICIENT_TECHNICAL_SUBSTANCE');
  }

  if (!candidate.factIds || candidate.factIds.length === 0) {
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

  if (HYPE_WORDS.test(candidate.body_markdown ?? '') || HYPE_WORDS_JA.test(candidate.body_markdown ?? '')) {
    violations.push('HYPE_LANGUAGE');
  }

  const dup = checkNoDevtoDuplication(candidate.body_markdown ?? '', facts);
  if (!dup.ok) violations.push('DUPLICATE_DEVTO_CONTENT');

  return { ok: violations.length === 0, violations };
}

function frontmatterToYaml({ title, tags, canonicalContentId, canonicalUrl }) {
  const lines = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]`,
    `canonical_content_id: ${JSON.stringify(canonicalContentId)}`,
    `canonical_url: ${canonicalUrl ? JSON.stringify(canonicalUrl) : 'null'}`,
    'reviewed_and_submitted: false',
    '---',
    '',
  ];
  return lines.join('\n');
}

/**
 * Writes the reviewable article candidate into a real, git-tracked content
 * directory (content/qiita/, same "generate, never auto-post" pattern as
 * content/devto/ and content/zenn/) and the private evidence manifest into
 * a separate, non-public review directory. Idempotent by slug: never
 * overwrites an already-generated candidate or manifest.
 */
export function writeQiitaFirstArticleCandidate(candidate, reviewManifest, { contentDir, reviewDir }) {
  mkdirSync(contentDir, { recursive: true });
  mkdirSync(reviewDir, { recursive: true });

  const articlePath = join(contentDir, `${candidate.slug}.md`);
  const manifestPath = join(reviewDir, `${candidate.slug}.manifest.json`);

  let writtenArticle = false;
  let writtenManifest = false;

  if (!existsSync(articlePath)) {
    const frontmatter = frontmatterToYaml({
      title: candidate.title, tags: candidate.tags,
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
 * Hunt/HN/note, and lib/devtoFirstArticle.mjs's own first article) already
 * uses — idempotent via the ledger's own UNIQUE(channel, content_hash) on
 * the article body. This (approval_state='PENDING_HUMAN_APPROVAL',
 * published_at IS NULL) is the durable QIITA_FIRST_PUBLIC_APPROVED=false
 * boundary. The only way it ever changes is the explicit, separate
 * approveQiitaFirstArticle() call below — never automatically, and never as
 * a side effect of preparing/validating the candidate.
 */
export function recordQiitaFirstArticlePending(db, candidate) {
  const row = recordIntent(db, {
    channel: 'qiita',
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
 * is the durable QIITA_FIRST_PUBLIC_APPROVED=true boundary, and it binds to
 * the EXACT content hash: findExisting() looks the row up by
 * candidate.body_markdown's own content_hash, so if the article is edited
 * after this call, the edited text has no matching HUMAN_APPROVED row at
 * all — approval is never inherited by different content. Requires a
 * PENDING row to already exist (via recordQiitaFirstArticlePending) —
 * approval is never recorded for content that never went through the
 * pending-review step, and this never auto-creates one. This approves ONLY
 * the ledger row matching this exact candidate's content hash; it has no
 * effect on, and sets no state for, any other article/channel (mandate:
 * "Do NOT globalize approval").
 */
export function approveQiitaFirstArticle(db, candidate) {
  const row = findExisting(db, 'qiita', candidate.body_markdown);
  if (!row) return { ok: false, reason: 'NOT_PENDING', detail: 'no PENDING_HUMAN_APPROVAL row exists for this exact article content — run prepare qiita-first first' };
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
 * the ledger row. `approved` (QIITA_FIRST_PUBLIC_APPROVED) means a human
 * ran approveQiitaFirstArticle() for this exact content — it says nothing
 * about whether it's actually live yet; `published` is the separate, later
 * fact that the real publish call succeeded.
 */
export function getQiitaFirstArticleApprovalState(db, candidate) {
  const row = findExisting(db, 'qiita', candidate.body_markdown);
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
export function readQiitaFirstArticleManifest(manifestPath, { readFileImpl = readFileSync, existsImpl = existsSync } = {}) {
  if (!existsImpl(manifestPath)) return { exists: false };
  return { exists: true, manifest: JSON.parse(readFileImpl(manifestPath, 'utf8')) };
}

/**
 * The one-time, explicitly-human-approved real publish for this specific
 * article. Deliberately bypasses MARKETING_QIITA_ENABLED/PUBLIC_MARKETING_MODE
 * (this function is never called from the unattended operator loop — only
 * an explicit `publish-approved qiita-first` CLI invocation reaches it,
 * same "explicit invocation, not a mode/flag check, is what makes this
 * safe" architecture as every canary function in lib/canary.mjs), but every
 * other safety property still applies in full:
 *  - requires a durable HUMAN_APPROVED row for this EXACT content hash
 *    (never publishes edited-since-approval content)
 *  - requires durably-recorded AUTH_VALID and CANARY_PASS
 *  - re-confirms identity live before ever attempting a create
 *  - checks the real remote account for a pre-existing matching item
 *    before creating anything: an existing PUBLIC item with this exact
 *    title is adopted (crash/duplicate prevention); an existing PRIVATE
 *    item with this exact title is never adopted and never silently
 *    reused — its content identity can't be safely confirmed as this
 *    approved article, so this fails closed instead
 *  - FAILS CLOSED unless the response (or, if ambiguous, live
 *    reconciliation against the real Qiita API) explicitly confirms
 *    private=false
 *  - idempotent: an already-published row returns instantly, zero network
 *    calls, never creates a second item
 */
export async function publishApprovedQiitaFirstArticle(db, candidate, { env = process.env, fetchImpl, qiitaClient } = {}) {
  const row = findExisting(db, 'qiita', candidate.body_markdown);
  if (row?.published_at) {
    return {
      ok: true, alreadyPublished: true, idempotent: true,
      externalId: row.external_id, externalUrl: row.external_url, private: false,
    };
  }
  if (!row || row.approval_state !== HUMAN_APPROVED_STATE) {
    return { ok: false, reason: 'NOT_APPROVED' };
  }

  const state = getChannelState(db, 'qiita');
  if (!state.auth_valid) return { ok: false, reason: 'AUTH_NOT_VALID_LOCALLY' };
  if (!state.canary_passed) return { ok: false, reason: 'CANARY_NOT_PASSED' };

  const identity = await qiitaClient.getIdentity({ env, fetchImpl });
  if (!identity.ok) return { ok: false, reason: 'AUTH_INVALID', detail: identity.message ?? identity.errorClass };

  // Duplicate-prevention: a real item with this exact title may already
  // exist remotely (crash after a prior successful create, before the
  // local ledger write landed) — never blindly create a second one.
  const mine = await qiitaClient.getMyItems({ env, fetchImpl });
  if (mine.ok) {
    const match = mine.items.find((it) => it.title === candidate.title);
    if (match) {
      if (!match.private) {
        const externalId = String(match.id);
        markPublished(db, row.publication_id, { externalId, externalUrl: match.url, result: 'PUBLISHED_OK_ADOPTED' });
        return { ok: true, alreadyPublished: true, idempotent: true, adopted: true, externalId, externalUrl: match.url, private: false };
      }
      // A PRIVATE item with this exact title already exists remotely (e.g.
      // the private canary uses a different, deterministic title, but some
      // other private item could still collide) — its content identity
      // can't be safely confirmed as this approved public article. Never
      // adopt it, never create a second item that could collide with it.
      // Fail closed.
      return { ok: false, reason: 'REMOTE_ITEM_EXISTS_PRIVATE', externalId: String(match.id) };
    }
  }

  const result = await qiitaClient.createItem({
    title: candidate.title, body: candidate.body_markdown, tags: candidate.tags, isPrivate: false,
  }, { env, fetchImpl });
  if (!result.ok) {
    return { ok: false, reason: result.message ?? result.errorClass ?? 'PUBLISH_FAILED' };
  }
  if (!result.id) {
    return { ok: false, reason: 'PUBLISH_NOT_VERIFIABLE_NO_ID' };
  }
  const externalId = String(result.id);

  if (result.private === true) {
    return { ok: false, reason: 'PRIVATE_TRUE', externalId };
  }

  if (result.private !== false) {
    // The create response didn't explicitly confirm private=false — never
    // trust HTTP success alone. Reconcile against the real API before
    // deciding anything.
    const reconcile = await qiitaClient.reconcileItemStatus(externalId, { env, fetchImpl });
    if (!reconcile.ok || reconcile.status !== 'PUBLIC') {
      return {
        ok: false, reason: 'VISIBILITY_NOT_CONFIRMED_PUBLIC', externalId,
        reconcileStatus: reconcile.ok ? reconcile.status : reconcile.errorClass,
      };
    }
  }

  markPublished(db, row.publication_id, { externalId, externalUrl: result.url, result: 'PUBLISHED_OK' });
  return { ok: true, alreadyPublished: false, idempotent: false, externalId, externalUrl: result.url, private: false };
}
