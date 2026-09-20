// Canary publications (mandate: "safe first-live canary mode"). Each
// function performs at most ONE real publication, only when explicitly
// called — never from the scheduled operator loop. Idempotency is enforced
// by the same publication_ledger every other post goes through: calling a
// canary function twice with unchanged canary text does not post twice.
import { recordIntent, markPublished, markFailed, findExisting } from './ledger.mjs';
import { recordCanary } from './channelState.mjs';
import * as x from '../connectors/x.mjs';
import * as youtube from '../connectors/youtube.mjs';
import * as bluesky from '../connectors/bluesky.mjs';
import * as mastodon from '../connectors/mastodon.mjs';
import * as devto from '../connectors/devto.mjs';
import * as qiita from '../connectors/qiita.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

export const CANARY_TEXT_X = 'Veritas Forge marketing operator canary test — automated connectivity check, please ignore.';
export const CANARY_VIDEO_TITLE = 'Veritas Forge marketing operator canary test (private, please ignore)';
// Deterministic, minimal, truthful — no product claims, no users/revenue/
// performance, no private infrastructure/secrets (mandate). The exact text
// itself IS the durable idempotency key (same mechanism every other canary
// here already uses — publication_ledger's UNIQUE(channel, content_hash) —
// never a second, parallel idempotency system); the semantic key below is
// documentation/reporting only, not a second source of truth.
export const CANARY_TEXT_BLUESKY = 'Veritas Forge marketing automation canary.\nTesting the Bluesky publication path for @veritasforge.bsky.social.\nNo product claims are being made in this post.';
export const BLUESKY_CANARY_IDEMPOTENCY_KEY = 'bluesky:public-canary:v1';
// Same reasoning as Bluesky's canary text above, plus one more requirement:
// mastodon.social's own signup rules require disclosure when generative AI
// is used, so this text carries an explicit AI-assisted disclosure line.
export const CANARY_TEXT_MASTODON = 'Veritas Forge marketing automation canary.\nTesting the Mastodon publication path for @Veritas_Forge.\nNo product claims are being made in this post.\nAI-assisted post.';
export const MASTODON_CANARY_IDEMPOTENCY_KEY = 'mastodon:public-canary:v1';
// DEV.to draft canary (idempotent draft validation mandate): unlike the
// Bluesky/Mastodon canaries above, this one is deliberately NEVER made
// public — it validates the real article-creation endpoint by creating
// exactly one real, unpublished (published=false) draft, ever. No product
// claims, no users/revenue/performance, no private infrastructure/secrets.
// The title+body below (not a separate semantic key) IS the durable
// idempotency key, via the same publication_ledger UNIQUE(channel,
// content_hash) mechanism every other canary here uses — the constant below
// is documentation/reporting only, never a second source of truth.
export const CANARY_DEVTO_TITLE = 'Veritas Forge API Publication Canary';
export const CANARY_DEVTO_BODY = [
  '# Veritas Forge API Publication Canary',
  '',
  "This unpublished draft verifies the DEV.to publication integration used by Veritas Forge's marketing automation.",
  '',
  'No product claims or benchmark claims are made here.',
  '',
  'This draft is intentionally not public.',
].join('\n');
export const CANARY_DEVTO_TAGS = ['testing', 'ai'];
export const CANARY_TEXT_DEVTO = `${CANARY_DEVTO_TITLE}\n\n${CANARY_DEVTO_BODY}`;
export const DEVTO_CANARY_IDEMPOTENCY_KEY = 'devto:draft-canary:v1';
// Qiita PRIVATE canary: same architecture as the DEV.to draft canary above —
// unlike DEV.to (which has a real draft/unpublished state), Qiita items are
// either private or public with no separate "draft" concept, so this
// canary's permanence is `private: true` instead of `published: false`, and
// it is likewise never made public, ever. No product claims, no users/
// revenue/performance, no private infrastructure/secrets.
export const CANARY_QIITA_TITLE = 'Veritas Forge API Publication Canary';
export const CANARY_QIITA_BODY = [
  '# Veritas Forge API Publication Canary',
  '',
  "This private item verifies the Qiita publication integration used by Veritas Forge's marketing automation.",
  '',
  'No product claims or benchmark claims are made here.',
  '',
  'This item is intentionally private and not public.',
].join('\n');
export const CANARY_QIITA_TAGS = ['Test'];
export const CANARY_TEXT_QIITA = `${CANARY_QIITA_TITLE}\n\n${CANARY_QIITA_BODY}`;
export const QIITA_CANARY_IDEMPOTENCY_KEY = 'qiita:private-canary:v1';

export async function canaryX(db, { env = process.env, fetchImpl } = {}) {
  const me = await x.getMe({ env, fetchImpl });
  if (!me.ok) {
    return { ok: false, reason: 'AUTH_INVALID', detail: me.message ?? me.errorClass };
  }

  const existing = findExisting(db, 'x', CANARY_TEXT_X);
  if (existing?.published_at) {
    return { ok: true, alreadyPassed: true, idempotent: true, externalId: existing.external_id, externalUrl: existing.external_url };
  }

  const row = recordIntent(db, {
    channel: 'x', text: CANARY_TEXT_X, riskClass: 'AUTO', approvalState: 'CANARY', contentType: 'canary',
  });
  const result = await x.publish({ text: CANARY_TEXT_X }, { dryRun: false, env, fetchImpl });
  if (!result.ok) {
    markFailed(db, row.publication_id, result.error ?? 'unknown');
    recordCanary(db, 'x', { passed: false });
    return { ok: false, reason: result.error ?? 'PUBLISH_FAILED' };
  }
  markPublished(db, row.publication_id, { externalId: result.externalId, externalUrl: result.externalUrl, result: 'CANARY_OK' });
  recordCanary(db, 'x', { passed: true, externalId: result.externalId, externalUrl: result.externalUrl });
  return { ok: true, alreadyPassed: false, idempotent: false, externalId: result.externalId, externalUrl: result.externalUrl };
}

/**
 * Generates a tiny, genuinely-rendered (not fabricated) 2-second black test
 * video via ffmpeg if one doesn't already exist at `videoPath`. This is only
 * ever used for the YouTube canary upload — never presented as real content.
 */
export async function ensureCanaryVideo(videoPath, { execFileImpl = execFileAsync } = {}) {
  if (existsSync(videoPath)) return { ok: true, created: false, videoPath };
  try {
    await execFileImpl('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=2',
      '-vf', 'format=yuv420p', videoPath,
    ]);
    return { ok: true, created: true, videoPath };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

export async function canaryYoutube(db, { env = process.env, fetchImpl, videoPath, ensureVideoImpl = ensureCanaryVideo, readFileImpl } = {}) {
  // Pre-flight check is token validity, NOT channel identity: channels.list
  // requires broader scope than youtube.upload alone (confirmed empirically
  // — 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT — against this project's
  // deliberately minimum-scope credential). Requiring it here would make the
  // canary permanently unrunnable for the exact scope this project uses.
  const auth = await youtube.getAccessToken({ env, fetchImpl });
  if (!auth.ok) {
    return { ok: false, reason: 'AUTH_INVALID', detail: auth.message ?? auth.errorClass };
  }

  const existing = findExisting(db, 'youtube', CANARY_VIDEO_TITLE);
  if (existing?.published_at && existing.external_id) {
    // Best-effort re-verification: videos.list also requires broader scope,
    // so this may legitimately fail to confirm anything further under
    // upload-only scope — that is not treated as the canary having failed,
    // since it already durably recorded a real external id/url when it ran.
    const status = await youtube.getVideoStatus(existing.external_id, { env, fetchImpl });
    return {
      ok: true, alreadyPassed: true, idempotent: true,
      externalId: existing.external_id, externalUrl: existing.external_url,
      verifiedStillExists: status.ok, privacyStatus: status.ok ? status.privacyStatus : undefined,
    };
  }

  const videoResult = await ensureVideoImpl(videoPath);
  if (!videoResult.ok) {
    return { ok: false, reason: 'CANARY_VIDEO_GENERATION_FAILED', detail: videoResult.error };
  }

  const row = recordIntent(db, {
    channel: 'youtube', text: CANARY_VIDEO_TITLE, riskClass: 'AUTO', approvalState: 'CANARY', contentType: 'canary',
  });
  const draft = { filePath: videoResult.videoPath, title: CANARY_VIDEO_TITLE, description: 'Automated connectivity check for the Veritas Forge marketing operator. Not real content.', privacyStatus: 'private' };
  const result = await youtube.publish(draft, { dryRun: false, env, fetchImpl, readFileImpl });
  if (!result.ok) {
    markFailed(db, row.publication_id, result.error ?? 'unknown');
    recordCanary(db, 'youtube', { passed: false });
    return { ok: false, reason: result.error ?? 'PUBLISH_FAILED' };
  }

  // VERIFICATION: the insert response itself (part=snippet,status) already
  // carries privacyStatus/title — that IS the confirmation the upload
  // succeeded and landed as private, since a separate videos.list re-read is
  // not possible under this project's upload-only scope (confirmed above).
  if (!result.externalId || result.privacyStatus === undefined) {
    markFailed(db, row.publication_id, 'upload response missing id/status — cannot confirm success');
    recordCanary(db, 'youtube', { passed: false });
    return { ok: false, reason: 'UPLOAD_NOT_VERIFIABLE', externalId: result.externalId };
  }

  markPublished(db, row.publication_id, { externalId: result.externalId, externalUrl: result.externalUrl, result: 'CANARY_OK' });
  recordCanary(db, 'youtube', { passed: true, externalId: result.externalId, externalUrl: result.externalUrl });
  return {
    ok: true, alreadyPassed: false, idempotent: false,
    externalId: result.externalId, externalUrl: result.externalUrl, privacyStatus: result.privacyStatus,
  };
}

/**
 * Real, one-time, idempotent Bluesky public canary (multi-channel expansion
 * mandate). Exactly one real public post total, ever, no matter how many
 * times this is called — enforced by the same publication_ledger
 * UNIQUE(channel, content_hash) idempotency every other canary here already
 * uses (see CANARY_TEXT_BLUESKY's own doc comment). Never called from the
 * scheduled operator loop; only from an explicit `canary bluesky` CLI
 * invocation. Deliberately ignores MARKETING_BLUESKY_ENABLED and
 * PUBLIC_MARKETING_MODE entirely — this function's own explicit-invocation
 * requirement, not a mode/flag check, is what makes it safe (mandate
 * sections 5/6): passing `dryRun: false` directly to bluesky.publish() below
 * is what actually causes a real write, never a mode read.
 */
export async function canaryBluesky(db, { env = process.env, fetchImpl } = {}) {
  const identity = await bluesky.getIdentity({ env, fetchImpl });
  if (!identity.ok) {
    return { ok: false, reason: 'AUTH_INVALID', detail: identity.message ?? identity.errorClass };
  }

  const existing = findExisting(db, 'bluesky', CANARY_TEXT_BLUESKY);
  if (existing?.published_at) {
    return {
      ok: true, channel: 'bluesky', alreadyPassed: true, idempotent: true,
      uri: existing.external_id, cid: existing.external_cid ?? null, url: existing.external_url,
      publishedAt: existing.published_at, canaryPass: true,
    };
  }

  const row = recordIntent(db, {
    channel: 'bluesky', text: CANARY_TEXT_BLUESKY, riskClass: 'AUTO', approvalState: 'CANARY', contentType: 'canary',
  });
  const result = await bluesky.publish({ text: CANARY_TEXT_BLUESKY }, { dryRun: false, env, fetchImpl });
  if (!result.ok) {
    markFailed(db, row.publication_id, result.error ?? 'unknown');
    recordCanary(db, 'bluesky', { passed: false });
    return { ok: false, channel: 'bluesky', reason: result.error ?? 'PUBLISH_FAILED', canaryPass: false };
  }
  // Malformed-response protection: bluesky.mjs's createPost() already
  // refuses (ok:false) if the real AT Protocol response is missing `uri` —
  // this is an extra, independent guard so a canary is never marked passed
  // without a genuinely usable identifier, even if that upstream check ever
  // changed.
  if (!result.externalId) {
    markFailed(db, row.publication_id, 'publish reported ok but returned no externalId (uri)');
    recordCanary(db, 'bluesky', { passed: false });
    return { ok: false, channel: 'bluesky', reason: 'PUBLISH_NOT_VERIFIABLE', canaryPass: false };
  }
  markPublished(db, row.publication_id, {
    externalId: result.externalId, externalUrl: result.externalUrl, externalCid: result.cid, result: 'CANARY_OK',
  });
  recordCanary(db, 'bluesky', { passed: true, externalId: result.externalId, externalUrl: result.externalUrl });
  return {
    ok: true, channel: 'bluesky', alreadyPassed: false, idempotent: false,
    uri: result.externalId, cid: result.cid, url: result.externalUrl, canaryPass: true,
  };
}

/**
 * Real, one-time, idempotent Mastodon public canary — same architecture as
 * canaryBluesky() above: exactly one real public post total, ever, enforced
 * by the same publication_ledger UNIQUE(channel, content_hash) idempotency
 * (CANARY_TEXT_MASTODON's own doc comment). Never called from the scheduled
 * operator loop; only from an explicit `canary mastodon` CLI invocation.
 * Deliberately ignores MARKETING_MASTODON_ENABLED and PUBLIC_MARKETING_MODE
 * entirely — this function's own explicit-invocation requirement, not a
 * mode/flag check, is what makes it safe: passing `dryRun: false` directly
 * to mastodon.publish() below is what actually causes a real write, never a
 * mode read. Also passes MASTODON_CANARY_IDEMPOTENCY_KEY as the real
 * Mastodon API's own Idempotency-Key header (its documented mechanism) —
 * an extra, real-world safety net on top of, never a replacement for, the
 * ledger-based idempotency check below.
 */
export async function canaryMastodon(db, { env = process.env, fetchImpl } = {}) {
  const identity = await mastodon.getIdentity({ env, fetchImpl });
  if (!identity.ok) {
    return { ok: false, channel: 'mastodon', reason: 'AUTH_INVALID', detail: identity.message ?? identity.errorClass, canaryPass: false };
  }

  const existing = findExisting(db, 'mastodon', CANARY_TEXT_MASTODON);
  if (existing?.published_at) {
    return {
      ok: true, channel: 'mastodon', alreadyPassed: true, idempotent: true,
      externalId: existing.external_id, url: existing.external_url,
      publishedAt: existing.published_at, canaryPass: true,
    };
  }

  const row = recordIntent(db, {
    channel: 'mastodon', text: CANARY_TEXT_MASTODON, riskClass: 'AUTO', approvalState: 'CANARY', contentType: 'canary',
  });
  const result = await mastodon.publish({ text: CANARY_TEXT_MASTODON }, {
    dryRun: false, env, fetchImpl, idempotencyKey: MASTODON_CANARY_IDEMPOTENCY_KEY,
  });
  if (!result.ok) {
    markFailed(db, row.publication_id, result.error ?? 'unknown');
    recordCanary(db, 'mastodon', { passed: false });
    return { ok: false, channel: 'mastodon', reason: result.error ?? 'PUBLISH_FAILED', canaryPass: false };
  }
  // Malformed-response protection: mastodon.mjs's createStatus() already
  // refuses (ok:false) if the real API response is missing `id` — this is
  // an extra, independent guard so a canary is never marked passed without
  // a genuinely usable identifier, even if that upstream check ever changed.
  if (!result.externalId) {
    markFailed(db, row.publication_id, 'publish reported ok but returned no externalId (status id)');
    recordCanary(db, 'mastodon', { passed: false });
    return { ok: false, channel: 'mastodon', reason: 'PUBLISH_NOT_VERIFIABLE', canaryPass: false };
  }
  markPublished(db, row.publication_id, { externalId: result.externalId, externalUrl: result.externalUrl, result: 'CANARY_OK' });
  recordCanary(db, 'mastodon', { passed: true, externalId: result.externalId, externalUrl: result.externalUrl });
  return {
    ok: true, channel: 'mastodon', alreadyPassed: false, idempotent: false,
    externalId: result.externalId, url: result.externalUrl, canaryPass: true,
  };
}

/**
 * Real, one-time, idempotent DEV.to DRAFT canary — same architecture as
 * canaryBluesky()/canaryMastodon() above (identity check, ledger-based
 * idempotency, fail-closed verification, recordCanary persistence), with one
 * deliberate difference: this canary must never go public. It calls the real
 * DEV.to article-creation endpoint (connectors/devto.mjs's createArticle)
 * directly with published:false — never through devto.publish(), which
 * hardcodes published:true for real long-form publication and is therefore
 * the wrong call for a draft-only canary. Never called from the scheduled
 * operator loop; only from an explicit `canary devto` CLI invocation.
 * Deliberately ignores MARKETING_DEVTO_ENABLED and PUBLIC_MARKETING_MODE
 * entirely — this function's own explicit-invocation requirement, not a
 * mode/flag check, is what makes it safe (same reasoning as the other
 * canaries): passing published:false directly to devto.createArticle() is
 * what actually keeps this a draft, never a mode read.
 */
export async function canaryDevto(db, { env = process.env, fetchImpl } = {}) {
  const identity = await devto.getIdentity({ env, fetchImpl });
  if (!identity.ok) {
    return { ok: false, channel: 'devto', reason: 'AUTH_INVALID', detail: identity.message ?? identity.errorClass, canaryPass: false };
  }

  const existing = findExisting(db, 'devto', CANARY_TEXT_DEVTO);
  if (existing?.published_at) {
    return {
      ok: true, channel: 'devto', alreadyPassed: true, idempotent: true,
      externalId: existing.external_id, externalUrl: existing.external_url,
      publishedAt: existing.published_at, published: false, canaryPass: true,
    };
  }

  // Duplicate-prevention / crash recovery: local state can be lost or never
  // written even after a real remote draft was created (crash between a
  // successful POST and the ledger write, or an earlier run whose response
  // couldn't be confirmed). Before creating anything, check the real DEV.to
  // unpublished-drafts collection for the deterministic canary title and
  // adopt a match instead of creating a second draft.
  const remoteLookup = await devto.getUnpublishedArticles({ env, fetchImpl });
  if (remoteLookup.ok) {
    const remoteMatch = remoteLookup.articles.find((a) => a.title === CANARY_DEVTO_TITLE);
    if (remoteMatch) {
      const externalId = String(remoteMatch.id);
      const row = recordIntent(db, {
        channel: 'devto', text: CANARY_TEXT_DEVTO, riskClass: 'AUTO', approvalState: 'CANARY', contentType: 'canary',
      });
      markPublished(db, row.publication_id, { externalId, externalUrl: remoteMatch.url, result: 'CANARY_OK_ADOPTED' });
      recordCanary(db, 'devto', { passed: true, externalId, externalUrl: remoteMatch.url });
      return {
        ok: true, channel: 'devto', alreadyPassed: true, idempotent: true, adopted: true,
        externalId, externalUrl: remoteMatch.url, published: false, canaryPass: true,
      };
    }
  }

  const row = recordIntent(db, {
    channel: 'devto', text: CANARY_TEXT_DEVTO, riskClass: 'AUTO', approvalState: 'CANARY', contentType: 'canary',
  });
  const result = await devto.createArticle({
    title: CANARY_DEVTO_TITLE, body_markdown: CANARY_DEVTO_BODY, tags: CANARY_DEVTO_TAGS, published: false,
  }, { env, fetchImpl });
  if (!result.ok) {
    markFailed(db, row.publication_id, result.message ?? result.errorClass ?? 'unknown');
    recordCanary(db, 'devto', { passed: false });
    return { ok: false, channel: 'devto', reason: result.message ?? result.errorClass ?? 'PUBLISH_FAILED', canaryPass: false };
  }
  // Malformed-response protection: an id must exist, same as every other
  // canary's own connector-response check.
  if (!result.id) {
    markFailed(db, row.publication_id, 'create reported ok but returned no article id');
    recordCanary(db, 'devto', { passed: false });
    return { ok: false, channel: 'devto', reason: 'PUBLISH_NOT_VERIFIABLE', canaryPass: false };
  }
  const externalId = String(result.id);

  // FAIL CLOSED, unconditionally: the response explicitly says this went
  // public. Never weakened by the reconciliation path below.
  if (result.published === true) {
    markFailed(db, row.publication_id, 'article response explicitly confirmed published=true');
    recordCanary(db, 'devto', { passed: false });
    return { ok: false, channel: 'devto', reason: 'PUBLISHED_TRUE', canaryPass: false, externalId };
  }

  if (result.published !== false) {
    // The real DEV.to create response can omit `published` even when the
    // request used published:false — that ambiguity is never treated as
    // success on its own. Fall back to authenticated read-only
    // reconciliation against the real unpublished-drafts endpoint; only
    // pass if the same article id is confirmed there.
    const reconcile = await devto.reconcileArticleStatus(externalId, { env, fetchImpl });
    if (!reconcile.ok || reconcile.status !== 'UNPUBLISHED') {
      const reason = reconcile.ok && reconcile.status === 'PUBLISHED' ? 'RECONCILED_PUBLISHED' : 'PUBLISHED_NOT_CONFIRMED_FALSE';
      markFailed(db, row.publication_id, `publish state not confirmed via reconciliation (status=${reconcile.ok ? reconcile.status : reconcile.errorClass})`);
      recordCanary(db, 'devto', { passed: false });
      return { ok: false, channel: 'devto', reason, canaryPass: false, externalId };
    }
  }

  markPublished(db, row.publication_id, { externalId, externalUrl: result.url, result: 'CANARY_OK' });
  recordCanary(db, 'devto', { passed: true, externalId, externalUrl: result.url });
  return {
    ok: true, channel: 'devto', alreadyPassed: false, idempotent: false,
    externalId, externalUrl: result.url, published: false, canaryPass: true,
  };
}

/**
 * Real, one-time, idempotent Qiita PRIVATE canary — same architecture as
 * canaryDevto() above (identity check, remote-duplicate-prevention
 * adopt-before-create, ledger-based idempotency, fail-closed verification,
 * recordCanary persistence), with the same deliberate constraint: this
 * canary must never go public. It calls the real Qiita item-creation
 * endpoint (connectors/qiita.mjs's createItem) directly with
 * isPrivate:true — never through qiita.publish(), which defaults to
 * isPrivate:false for real public publication and is therefore the wrong
 * call for a private-only canary. Never called from the scheduled operator
 * loop; only from an explicit `canary qiita` CLI invocation. Deliberately
 * ignores MARKETING_QIITA_ENABLED and PUBLIC_MARKETING_MODE entirely — this
 * function's own explicit-invocation requirement, not a mode/flag check, is
 * what makes it safe (same reasoning as every other canary here): passing
 * isPrivate:true directly to qiita.createItem() is what actually keeps this
 * private, never a mode read.
 */
export async function canaryQiita(db, { env = process.env, fetchImpl } = {}) {
  const identity = await qiita.getIdentity({ env, fetchImpl });
  if (!identity.ok) {
    return { ok: false, channel: 'qiita', reason: 'AUTH_INVALID', detail: identity.message ?? identity.errorClass, canaryPass: false };
  }

  const existing = findExisting(db, 'qiita', CANARY_TEXT_QIITA);
  if (existing?.published_at) {
    return {
      ok: true, channel: 'qiita', alreadyPassed: true, idempotent: true,
      externalId: existing.external_id, externalUrl: existing.external_url,
      publishedAt: existing.published_at, private: true, canaryPass: true,
    };
  }

  // Duplicate-prevention / crash recovery: local state can be lost or never
  // written even after a real remote item was created. Before creating
  // anything, check the real Qiita "my items" collection (which, unlike
  // lookupExisting()'s public-profile endpoint, includes private items) for
  // the deterministic canary title and adopt a match instead of creating a
  // second item.
  const remoteLookup = await qiita.getMyItems({ env, fetchImpl });
  if (remoteLookup.ok) {
    const remoteMatch = remoteLookup.items.find((it) => it.title === CANARY_QIITA_TITLE);
    if (remoteMatch) {
      if (!remoteMatch.private) {
        // A PUBLIC item with this exact title already exists — never adopt
        // it as the private canary, and never create a second item that
        // could collide with it either. Fail closed.
        return { ok: false, channel: 'qiita', reason: 'REMOTE_MATCH_IS_PUBLIC', canaryPass: false, externalId: String(remoteMatch.id) };
      }
      const externalId = String(remoteMatch.id);
      const row = recordIntent(db, {
        channel: 'qiita', text: CANARY_TEXT_QIITA, riskClass: 'AUTO', approvalState: 'CANARY', contentType: 'canary',
      });
      markPublished(db, row.publication_id, { externalId, externalUrl: remoteMatch.url, result: 'CANARY_OK_ADOPTED' });
      recordCanary(db, 'qiita', { passed: true, externalId, externalUrl: remoteMatch.url });
      return {
        ok: true, channel: 'qiita', alreadyPassed: true, idempotent: true, adopted: true,
        externalId, externalUrl: remoteMatch.url, private: true, canaryPass: true,
      };
    }
  }

  const row = recordIntent(db, {
    channel: 'qiita', text: CANARY_TEXT_QIITA, riskClass: 'AUTO', approvalState: 'CANARY', contentType: 'canary',
  });
  const result = await qiita.createItem({
    title: CANARY_QIITA_TITLE, body: CANARY_QIITA_BODY, tags: CANARY_QIITA_TAGS, isPrivate: true,
  }, { env, fetchImpl });
  if (!result.ok) {
    markFailed(db, row.publication_id, result.message ?? result.errorClass ?? 'unknown');
    recordCanary(db, 'qiita', { passed: false });
    return { ok: false, channel: 'qiita', reason: result.message ?? result.errorClass ?? 'PUBLISH_FAILED', canaryPass: false };
  }
  // Malformed-response protection: an id must exist, same as every other
  // canary's own connector-response check.
  if (!result.id) {
    markFailed(db, row.publication_id, 'create reported ok but returned no item id');
    recordCanary(db, 'qiita', { passed: false });
    return { ok: false, channel: 'qiita', reason: 'PUBLISH_NOT_VERIFIABLE', canaryPass: false };
  }
  const externalId = String(result.id);

  // FAIL CLOSED, unconditionally: the response explicitly says this is
  // public. Never weakened by the reconciliation path below.
  if (result.private === false) {
    markFailed(db, row.publication_id, 'item response explicitly confirmed private=false');
    recordCanary(db, 'qiita', { passed: false });
    return { ok: false, channel: 'qiita', reason: 'PRIVATE_FALSE', canaryPass: false, externalId };
  }

  if (result.private !== true) {
    // The real Qiita create response can omit/mangle `private` even when
    // the request used private:true — that ambiguity is never treated as
    // success on its own. Fall back to authenticated read-only
    // reconciliation against the real "my items" endpoint; only pass if the
    // same item id is confirmed private there.
    const reconcile = await qiita.reconcileItemStatus(externalId, { env, fetchImpl });
    if (!reconcile.ok || reconcile.status !== 'PRIVATE') {
      const reason = reconcile.ok && reconcile.status === 'PUBLIC' ? 'RECONCILED_PUBLIC' : 'PRIVATE_NOT_CONFIRMED';
      markFailed(db, row.publication_id, `private state not confirmed via reconciliation (status=${reconcile.ok ? reconcile.status : reconcile.errorClass})`);
      recordCanary(db, 'qiita', { passed: false });
      return { ok: false, channel: 'qiita', reason, canaryPass: false, externalId };
    }
  }

  markPublished(db, row.publication_id, { externalId, externalUrl: result.url, result: 'CANARY_OK' });
  recordCanary(db, 'qiita', { passed: true, externalId, externalUrl: result.url });
  return {
    ok: true, channel: 'qiita', alreadyPassed: false, idempotent: false,
    externalId, externalUrl: result.url, private: true, canaryPass: true,
  };
}
