// Per-channel LIVE enable flags (pre-live hardening). MARKETING_MODE=LIVE
// alone must never activate every connected channel — each channel needs
// its own explicit flag, default false, fail closed.
const CHANNEL_ENV_FLAG = {
  x: 'MARKETING_X_ENABLED',
  discord: 'MARKETING_DISCORD_ENABLED',
  reddit: 'MARKETING_REDDIT_ENABLED',
  qiita: 'MARKETING_QIITA_ENABLED',
  youtube: 'MARKETING_YOUTUBE_ENABLED',
  // Multi-channel expansion (mandate section 1) — same fail-closed default
  // (false) as every existing channel; each needs its own explicit flag on
  // top of MARKETING_MODE=LIVE + the global kill switch.
  bluesky: 'MARKETING_BLUESKY_ENABLED',
  mastodon: 'MARKETING_MASTODON_ENABLED',
  devto: 'MARKETING_DEVTO_ENABLED',
  zenn: 'MARKETING_ZENN_ENABLED', // gates AUTO_DRAFT generation only — AUTO_PUBLISH is a separate, not-yet-built step (mandate section 7)
  hashnode: 'MARKETING_HASHNODE_ENABLED',
  linkedin: 'MARKETING_LINKEDIN_ENABLED',
  producthunt: 'MARKETING_PRODUCTHUNT_ENABLED', // gates AUTO_PREPARE_HUMAN_APPROVAL package generation only — never auto-submission
  hackernews: 'MARKETING_HACKERNEWS_ENABLED',
  note: 'MARKETING_NOTE_ENABLED',
};

export function channelEnvFlagName(channel) {
  return CHANNEL_ENV_FLAG[channel] ?? null;
}

export function channelEnabled(channel, env = process.env) {
  const varName = CHANNEL_ENV_FLAG[channel];
  if (!varName) return false; // unknown/non-API channel can never be LIVE-enabled
  return env[varName] === 'true';
}

export function allChannelFlags(env = process.env) {
  return Object.fromEntries(Object.entries(CHANNEL_ENV_FLAG).map(([ch, name]) => [ch, env[name] === 'true']));
}
