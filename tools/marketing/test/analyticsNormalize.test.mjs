import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMetrics, supportsMetric, NORMALIZED_METRIC_FIELDS } from '../lib/analyticsNormalize.mjs';

test('normalizeMetrics: maps a real X API response into the shared vocabulary', () => {
  const result = normalizeMetrics('x', { impression_count: 100, like_count: 5, retweet_count: 2, reply_count: 1, bookmark_count: 0, url_link_clicks: 3 });
  assert.equal(result.impressions, 100);
  assert.equal(result.likes, 5);
  assert.equal(result.article_views, null, 'X has no article_views metric');
});

test('normalizeMetrics: an unsupported channel returns all-null, never a fabricated zero', () => {
  const result = normalizeMetrics('unknown_channel', { likes: 5 });
  for (const field of NORMALIZED_METRIC_FIELDS) assert.equal(result[field], null);
});

test('normalizeMetrics: a metric genuinely absent from the raw response stays null, not 0', () => {
  const result = normalizeMetrics('x', {});
  assert.equal(result.likes, null);
});

test('supportsMetric: only reports true for metrics the real official API actually exposes', () => {
  assert.equal(supportsMetric('x', 'impressions'), true);
  assert.equal(supportsMetric('bluesky', 'impressions'), false);
  assert.equal(supportsMetric('devto', 'article_views'), true);
  assert.equal(supportsMetric('bluesky', 'article_views'), false);
});
