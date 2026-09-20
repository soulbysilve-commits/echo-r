// Channel policy classes and workflow modes (multi-channel expansion
// mandate sections 1 & 20). These are POLICY decisions, independent of
// connectors/registry.mjs's classify() (which only reports the technical
// fact of whether a real API client exists for a channel) — a channel can
// be CHANNEL_CLASS.AUTO_PUBLIC_ELIGIBLE in policy while still reporting
// MODE.DISABLED in practice because no credentials are configured yet; the
// two facts are combined, never conflated, in status reporting.
export const CHANNEL_CLASS = {
  AUTO_PUBLIC_ELIGIBLE: 'AUTO_PUBLIC_ELIGIBLE',
  CONDITIONAL_AUTO: 'CONDITIONAL_AUTO',
  HUMAN_APPROVAL_REQUIRED: 'HUMAN_APPROVAL_REQUIRED',
  NEVER_AUTO: 'NEVER_AUTO',
};

export const MODE = {
  AUTO_PUBLIC: 'AUTO_PUBLIC',
  AUTO_DRAFT: 'AUTO_DRAFT',
  AUTO_PREPARE_HUMAN_APPROVAL: 'AUTO_PREPARE_HUMAN_APPROVAL',
  MANUAL_ONLY: 'MANUAL_ONLY',
  DISABLED: 'DISABLED',
};

// The static policy baseline (mandate section 1). `mode` is the workflow
// this channel runs under RIGHT NOW, independent of whether credentials
// happen to be configured — status reporting combines this with the real
// authConfigured fact to decide the effective BLOCKER.
const CHANNEL_POLICY = {
  x: { class: CHANNEL_CLASS.AUTO_PUBLIC_ELIGIBLE, mode: MODE.AUTO_PUBLIC },
  bluesky: { class: CHANNEL_CLASS.AUTO_PUBLIC_ELIGIBLE, mode: MODE.AUTO_PUBLIC },
  mastodon: { class: CHANNEL_CLASS.AUTO_PUBLIC_ELIGIBLE, mode: MODE.AUTO_PUBLIC },
  devto: { class: CHANNEL_CLASS.AUTO_PUBLIC_ELIGIBLE, mode: MODE.AUTO_PUBLIC },
  qiita: { class: CHANNEL_CLASS.AUTO_PUBLIC_ELIGIBLE, mode: MODE.AUTO_PUBLIC },
  // Zenn has no write API at all (git-sync only, see registry.mjs) — content
  // generation is real (lib/zenn.mjs), but AUTO_PUBLISH stays false until a
  // successful canary + human review, per mandate section 7.
  zenn: { class: CHANNEL_CLASS.AUTO_PUBLIC_ELIGIBLE, mode: MODE.AUTO_DRAFT },
  // CONDITIONAL_AUTO: capability-detection only this pass (mandate sections
  // 8/9) — never auto-eligible until a dedicated capability check reports
  // READY (see cli.mjs's `connector capability <name>`).
  hashnode: { class: CHANNEL_CLASS.CONDITIONAL_AUTO, mode: MODE.DISABLED },
  linkedin: { class: CHANNEL_CLASS.CONDITIONAL_AUTO, mode: MODE.DISABLED },
  reddit: { class: CHANNEL_CLASS.HUMAN_APPROVAL_REQUIRED, mode: MODE.AUTO_PREPARE_HUMAN_APPROVAL },
  producthunt: { class: CHANNEL_CLASS.HUMAN_APPROVAL_REQUIRED, mode: MODE.AUTO_PREPARE_HUMAN_APPROVAL },
  hackernews: { class: CHANNEL_CLASS.HUMAN_APPROVAL_REQUIRED, mode: MODE.AUTO_PREPARE_HUMAN_APPROVAL },
  note: { class: CHANNEL_CLASS.HUMAN_APPROVAL_REQUIRED, mode: MODE.AUTO_PREPARE_HUMAN_APPROVAL },
};

/** Never guesses a channel into an auto-eligible class — anything not explicitly listed is NEVER_AUTO/DISABLED, fails closed. */
export function channelPolicy(channel) {
  return CHANNEL_POLICY[channel] ?? { class: CHANNEL_CLASS.NEVER_AUTO, mode: MODE.DISABLED };
}

export function allPolicyChannelNames() {
  return Object.keys(CHANNEL_POLICY);
}
