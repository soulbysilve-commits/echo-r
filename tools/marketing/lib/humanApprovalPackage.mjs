// Prepared-package builders for channels that never auto-publish (mandate
// sections 11, 12, 13: Product Hunt / Hacker News / note — mode
// AUTO_PREPARE_HUMAN_APPROVAL). Every package is a real, structured object a
// human reviews and manually submits; nothing here ever calls a connector or
// touches publication_ledger's `published_at` — recording it via
// lib/multiChannelPublish.mjs's PENDING_APPROVAL path is what makes it
// visible to a human, same mechanism every other HUMAN_APPROVAL_REQUIRED
// action already uses.
import { draftHackerNewsPost, draftNoteArticle, isTechnicalSubstance } from './crossChannelDraft.mjs';

/**
 * Product Hunt has no create-launch API at all (see connectors/registry.mjs)
 * — this always stays a package for a human to submit through the website,
 * never an automated call. mandate section 11's exact field list.
 */
export function buildProductHuntPackage(fact, { launchUrl, galleryAssets = [], videoUrl } = {}) {
  const taglineSource = fact.CLAIM.split(/[.。]/)[0];
  return {
    channel: 'producthunt',
    productName: fact.PRODUCT,
    tagline: taglineSource.length > 60 ? `${taglineSource.slice(0, 57)}...` : taglineSource,
    description: fact.CLAIM,
    makerComment: `Hi Product Hunt! ${fact.CLAIM} Happy to answer any questions about the implementation — source: ${fact.SOURCE_REPOSITORY}/${fact.SOURCE_PATH}.`,
    galleryAssets,
    video: videoUrl ?? null,
    topics: ['Artificial Intelligence', 'Developer Tools'],
    launchUrl: launchUrl ?? null,
    firstComment: `We built this because: ${fact.CLAIM}`,
    launchChecklist: [
      'Confirm launch date/time (Product Hunt day starts 12:01am PT)',
      'Verify gallery images/screenshots are final and accurate',
      'Verify the maker comment posts immediately at launch',
      'Have the team ready to reply to comments for the first few hours',
      'Confirm this is release-event-only (mandate: no generic launches)',
    ],
    factIds: [fact.id],
    claimStrength: fact.STATUS === 'VERIFIED' ? 'shipped' : 'planned',
    actionType: 'producthunt_launch',
  };
}

/**
 * Hacker News has no publish API by design — always a package for a human
 * to submit manually. Only ever built for a genuinely major event (mandate
 * section 12) — the caller decides that (this function doesn't gate it,
 * since "major event" isn't a property of the fact alone; it's an editorial
 * decision the human approval step itself makes).
 */
export function buildHackerNewsPackage(fact) {
  const draft = draftHackerNewsPost(fact);
  return {
    ...draft,
    checklist: [
      'Confirm this is genuinely major-event-worthy (major release, substantial writeup, research result, OSS release, or unusual engineering implementation) — never a generic promotional announcement',
      'Post during US morning hours (roughly 8am-noon ET) for visibility',
      'Be ready to answer technical questions in the comments promptly',
    ],
  };
}

/**
 * note.com has no publishing API at all (read or write) and this project
 * never uses undocumented/private browser APIs — always a package for a
 * human to paste into the web editor. Only built for genuinely technical
 * substance (mandate section 13), same gate as Zenn/DEV.to/Qiita.
 */
export function buildNotePackage(fact, facts) {
  const draft = draftNoteArticle(fact);
  if (!draft) return null;
  return {
    ...draft,
    assets: [],
    checklist: [
      'Paste the generated article into note.com\'s own web editor (no API/browser automation)',
      'Add a cover image before publishing',
      'Verify every claim still traces to a current VERIFIED/PARTIAL fact before submitting',
    ],
  };
}

export { isTechnicalSubstance };
