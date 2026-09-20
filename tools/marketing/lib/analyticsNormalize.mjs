// Engagement-metric normalization (multi-channel expansion mandate section
// 19). Feeds into the existing marketing_memory learning loop
// (lib/memory.mjs's validateAnalytics/upsertMemory — unchanged, reused as-is)
// — this module only defines the shared normalized shape and per-channel
// mapping from each platform's own real API response fields, never scrapes
// or invents a metric the official API doesn't actually expose.
export const NORMALIZED_METRIC_FIELDS = [
  'impressions', 'clicks', 'likes', 'reposts', 'comments', 'bookmarks',
  'article_views', 'followers_delta',
];

/**
 * Per-channel field mapping from that platform's own real API response
 * shape to the normalized vocabulary above. `null` for a metric a channel's
 * official API genuinely does not expose — never guessed, never defaulted
 * to 0 (0 means "measured and zero"; null means "not available").
 */
const CHANNEL_METRIC_MAP = {
  x: (raw) => ({
    impressions: raw.impression_count ?? null,
    clicks: raw.url_link_clicks ?? null,
    likes: raw.like_count ?? null,
    reposts: raw.retweet_count ?? null,
    comments: raw.reply_count ?? null,
    bookmarks: raw.bookmark_count ?? null,
    article_views: null,
    followers_delta: null,
  }),
  bluesky: (raw) => ({
    impressions: null, // Bluesky's public API does not expose impression counts
    clicks: null,
    likes: raw.likeCount ?? null,
    reposts: raw.repostCount ?? null,
    comments: raw.replyCount ?? null,
    bookmarks: null,
    article_views: null,
    followers_delta: null,
  }),
  mastodon: (raw) => ({
    impressions: null,
    clicks: null,
    likes: raw.favourites_count ?? null,
    reposts: raw.reblogs_count ?? null,
    comments: raw.replies_count ?? null,
    bookmarks: null,
    article_views: null,
    followers_delta: null,
  }),
  devto: (raw) => ({
    impressions: null,
    clicks: null,
    likes: raw.public_reactions_count ?? null,
    reposts: null,
    comments: raw.comments_count ?? null,
    bookmarks: null,
    article_views: raw.page_views_count ?? null,
    followers_delta: null,
  }),
  qiita: (raw) => ({
    impressions: null,
    clicks: null,
    likes: raw.likes_count ?? null,
    reposts: raw.reactions_count ?? null,
    comments: raw.comments_count ?? null,
    bookmarks: raw.stocks_count ?? null,
    article_views: raw.page_views_count ?? null,
    followers_delta: null,
  }),
};

// Which normalized metrics each channel's real, official API can ever
// expose — declared explicitly (not inferred from a sample call) so
// supportsMetric() never depends on whatever happens to be present in one
// particular raw response.
const CHANNEL_SUPPORTED_METRICS = {
  x: ['impressions', 'clicks', 'likes', 'reposts', 'comments', 'bookmarks'],
  bluesky: ['likes', 'reposts', 'comments'],
  mastodon: ['likes', 'reposts', 'comments'],
  devto: ['likes', 'comments', 'article_views'],
  qiita: ['likes', 'reposts', 'comments', 'bookmarks', 'article_views'],
};

/**
 * Normalizes one raw API response into the shared metric vocabulary. Fails
 * closed (all-null, not zero) for a channel with no mapping defined —
 * "unsupported" is never silently reported as "measured zero engagement".
 */
export function normalizeMetrics(channel, raw) {
  const mapper = CHANNEL_METRIC_MAP[channel];
  if (!mapper || !raw) {
    return Object.fromEntries(NORMALIZED_METRIC_FIELDS.map((f) => [f, null]));
  }
  return mapper(raw);
}

/** True only if this channel's real, official API can ever expose `metric` — never scraped/private-endpoint metrics. */
export function supportsMetric(channel, metric) {
  return (CHANNEL_SUPPORTED_METRICS[channel] ?? []).includes(metric);
}
