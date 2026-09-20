// Marketing performance memory (mandate section 21). Distinct from ECHO's own
// canonical Identity Memory — this only tracks content performance.

const NUMERIC_FIELDS = [
  'impressions', 'clicks', 'ctr', 'engagement', 'video_completion',
  'landing_visits', 'checkout_starts', 'conversions',
];

/**
 * Validate an incoming analytics payload before it touches the database.
 * Malformed analytics (wrong types, NaN, negative counts, out-of-range CTR)
 * must never corrupt stored rows — they're rejected with a reason instead.
 */
export function validateAnalytics(payload) {
  const errors = [];
  for (const field of NUMERIC_FIELDS) {
    if (payload[field] === undefined || payload[field] === null) continue;
    const value = payload[field];
    if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
      errors.push(`${field}: not a finite number`);
      continue;
    }
    if (value < 0) errors.push(`${field}: negative value`);
    if (field === 'ctr' && value > 1) errors.push('ctr: out of range (expected 0-1)');
  }
  if (!payload.content_id) errors.push('content_id: required');
  return errors;
}

export function upsertMemory(db, payload) {
  const errors = validateAnalytics(payload);
  if (errors.length) {
    return { ok: false, errors };
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO marketing_memory
      (content_id, channel, campaign, topic, angle, audience, content_hash, published_at, url, utm,
       impressions, clicks, ctr, engagement, video_completion, landing_visits, checkout_starts, conversions, lesson, updated_at)
     VALUES (@content_id, @channel, @campaign, @topic, @angle, @audience, @content_hash, @published_at, @url, @utm,
       @impressions, @clicks, @ctr, @engagement, @video_completion, @landing_visits, @checkout_starts, @conversions, @lesson, @updated_at)
     ON CONFLICT(content_id) DO UPDATE SET
       impressions=excluded.impressions, clicks=excluded.clicks, ctr=excluded.ctr,
       engagement=excluded.engagement, video_completion=excluded.video_completion,
       landing_visits=excluded.landing_visits, checkout_starts=excluded.checkout_starts,
       conversions=excluded.conversions, lesson=excluded.lesson, updated_at=excluded.updated_at`
  ).run({
    content_id: payload.content_id,
    channel: payload.channel ?? null,
    campaign: payload.campaign ?? null,
    topic: payload.topic ?? null,
    angle: payload.angle ?? null,
    audience: payload.audience ?? null,
    content_hash: payload.content_hash ?? null,
    published_at: payload.published_at ?? null,
    url: payload.url ?? null,
    utm: payload.utm ?? null,
    impressions: payload.impressions ?? null,
    clicks: payload.clicks ?? null,
    ctr: payload.ctr ?? null,
    engagement: payload.engagement ?? null,
    video_completion: payload.video_completion ?? null,
    landing_visits: payload.landing_visits ?? null,
    checkout_starts: payload.checkout_starts ?? null,
    conversions: payload.conversions ?? null,
    lesson: payload.lesson ?? null,
    updated_at: now,
  });
  return { ok: true };
}
