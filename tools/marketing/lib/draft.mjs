// Turns a scored fact into a channel-specific draft. Deliberately template-based
// (not free-generation) so every claim traces directly to the fact's own CLAIM
// text — no room for the drafter to embellish beyond what was verified.

// Exported so lib/crossChannelDraft.mjs's additional per-channel generators
// reuse the exact same status-label vocabulary rather than a second,
// possibly-drifting copy.
export const STATUS_LABEL_JA = {
  VERIFIED: '',
  PARTIAL: '（一部実装 / 開発中）',
  EXPERIMENTAL: '（実験段階）',
  PLANNED: '（開発予定）',
};

export const STATUS_LABEL_EN = {
  VERIFIED: '',
  PARTIAL: '(partially implemented / in progress)',
  EXPERIMENTAL: '(experimental)',
  PLANNED: '(planned)',
};

export function draftXPostEn(fact) {
  const label = STATUS_LABEL_EN[fact.STATUS] ?? '';
  const text = `${fact.CLAIM}${label ? ' ' + label : ''}\n\n#ECHOAgent #PersistentAI`.trim();
  return {
    channel: 'x',
    text,
    factIds: [fact.id],
    claimStrength: fact.STATUS === 'VERIFIED' ? 'shipped' : 'planned',
    actionType: 'x_post',
  };
}

export function draftXPostJa(fact) {
  const label = STATUS_LABEL_JA[fact.STATUS] ?? '';
  const text = `${fact.CLAIM}${label}\n\n#ECHOAgent #永続人格AI`.trim();
  return {
    channel: 'x',
    text,
    factIds: [fact.id],
    claimStrength: fact.STATUS === 'VERIFIED' ? 'shipped' : 'planned',
    actionType: 'x_post',
  };
}

export function draftChangelogEntry(fact) {
  const date = new Date().toISOString().slice(0, 10);
  const text = `## ${date} — ${fact.PRODUCT}\n\nStatus: ${fact.STATUS}\n\n${fact.CLAIM}\n\nEvidence: ${fact.SOURCE_REPOSITORY} — ${fact.SOURCE_PATH}\n`;
  return {
    channel: 'changelog',
    text,
    factIds: [fact.id],
    claimStrength: fact.STATUS === 'VERIFIED' ? 'shipped' : 'planned',
    actionType: 'changelog',
  };
}
