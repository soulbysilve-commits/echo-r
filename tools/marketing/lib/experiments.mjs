// Bounded content experiments (mandate section 12). Exactly two variants,
// one metric, a required minimum sample before a winner can be declared —
// no simultaneously-varying-everything, no optimizing for clickbait (the
// hypothesis and variants still pass through the same policy gate as any
// other content, enforced by the caller drafting variant_A/variant_B).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS experiments (
  experiment_id     TEXT PRIMARY KEY,
  hypothesis        TEXT NOT NULL,
  variant_a         TEXT NOT NULL,
  variant_b         TEXT NOT NULL,
  metric            TEXT NOT NULL,
  minimum_sample    INTEGER NOT NULL,
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  variant_a_content_id TEXT,
  variant_b_content_id TEXT,
  winner            TEXT,
  confidence        REAL,
  result            TEXT
);
`;

export function ensureExperimentsSchema(db) {
  db.exec(SCHEMA);
}

export function createExperiment(db, { experimentId, hypothesis, variantA, variantB, metric, minimumSample }) {
  ensureExperimentsSchema(db);
  db.prepare(
    `INSERT INTO experiments (experiment_id, hypothesis, variant_a, variant_b, metric, minimum_sample, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(experimentId, hypothesis, variantA, variantB, metric, minimumSample, new Date().toISOString());
  return db.prepare('SELECT * FROM experiments WHERE experiment_id = ?').get(experimentId);
}

export function attachVariantContent(db, experimentId, { variantAContentId, variantBContentId }) {
  db.prepare('UPDATE experiments SET variant_a_content_id = ?, variant_b_content_id = ? WHERE experiment_id = ?').run(
    variantAContentId ?? null, variantBContentId ?? null, experimentId
  );
}

function metricValue(memoryRow, metric) {
  if (metric === 'ctr') return memoryRow.ctr;
  if (metric === 'conversions') return memoryRow.conversions;
  if (metric === 'engagement') return memoryRow.engagement;
  return memoryRow[metric] ?? null;
}

/**
 * Evaluate an experiment against marketing_memory. Refuses to declare a
 * winner until both variants individually have at least `minimum_sample`
 * (here: impressions, as the sample-size proxy) — an experiment with one
 * lucky post is not a result.
 */
export function evaluateExperiment(db, experimentId) {
  const exp = db.prepare('SELECT * FROM experiments WHERE experiment_id = ?').get(experimentId);
  if (!exp) return { ok: false, error: 'unknown experiment' };
  if (!exp.variant_a_content_id || !exp.variant_b_content_id) {
    return { ok: false, error: 'experiment has no attached content yet' };
  }
  const a = db.prepare('SELECT * FROM marketing_memory WHERE content_id = ?').get(exp.variant_a_content_id);
  const b = db.prepare('SELECT * FROM marketing_memory WHERE content_id = ?').get(exp.variant_b_content_id);
  if (!a || !b) return { ok: false, error: 'variant content has no recorded performance yet' };

  const sampleA = a.impressions ?? 0;
  const sampleB = b.impressions ?? 0;
  if (sampleA < exp.minimum_sample || sampleB < exp.minimum_sample) {
    return { ok: true, decided: false, reason: 'below minimum_sample', sampleA, sampleB, minimumSample: exp.minimum_sample };
  }

  const valueA = metricValue(a, exp.metric);
  const valueB = metricValue(b, exp.metric);
  if (valueA === null || valueB === null) {
    return { ok: true, decided: false, reason: `no ${exp.metric} data for one or both variants` };
  }

  const winner = valueA === valueB ? null : valueA > valueB ? 'variant_A' : 'variant_B';
  const confidence = Math.min(1, Math.abs(valueA - valueB) / (Math.max(valueA, valueB) || 1));

  db.prepare('UPDATE experiments SET ended_at = ?, winner = ?, confidence = ?, result = ? WHERE experiment_id = ?').run(
    new Date().toISOString(), winner, confidence, JSON.stringify({ valueA, valueB }), experimentId
  );

  return { ok: true, decided: true, winner, confidence, valueA, valueB };
}

export function listExperiments(db) {
  ensureExperimentsSchema(db);
  return db.prepare('SELECT * FROM experiments ORDER BY started_at DESC').all();
}
