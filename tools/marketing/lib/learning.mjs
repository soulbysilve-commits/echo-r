// Growth learning loop (mandate section 11). Derives performance groupings
// from marketing_memory and only proposes a strategy change when there is
// enough evidence — a single anomalous post must never rewrite strategy.
const MIN_SAMPLE = 5; // minimum observations in a group before it's trusted
const MIN_LIFT = 0.2; // relative CTR difference required to call one group a winner

const SCHEMA = `
CREATE TABLE IF NOT EXISTS strategy_log (
  version      TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  reason       TEXT NOT NULL,
  evidence     TEXT NOT NULL,
  sample_size  INTEGER NOT NULL
);
`;

export function ensureLearningSchema(db) {
  db.exec(SCHEMA);
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key === null || key === undefined) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function summarize(rows) {
  const n = rows.length;
  const impressions = rows.reduce((s, r) => s + (r.impressions ?? 0), 0);
  const clicks = rows.reduce((s, r) => s + (r.clicks ?? 0), 0);
  const conversions = rows.reduce((s, r) => s + (r.conversions ?? 0), 0);
  const ctr = impressions > 0 ? clicks / impressions : null;
  return { n, impressions, clicks, conversions, ctr };
}

/**
 * Returns performance groupings for each requested dimension, each entry
 * marked `trusted: n >= MIN_SAMPLE` — untrusted groupings are still returned
 * (for visibility) but must never be used to justify a strategy change.
 */
export function analyzePerformance(db, dimensions = ['channel', 'campaign', 'topic', 'angle', 'audience']) {
  const rows = db.prepare('SELECT * FROM marketing_memory WHERE impressions IS NOT NULL').all();
  const result = {};
  for (const dim of dimensions) {
    const groups = groupBy(rows, (r) => r[dim]);
    result[dim] = Object.fromEntries(
      [...groups.entries()].map(([key, groupRows]) => {
        const summary = summarize(groupRows);
        return [key, { ...summary, trusted: summary.n >= MIN_SAMPLE }];
      })
    );
  }
  return result;
}

/**
 * Compares two named groups within one dimension's analysis and proposes a
 * strategy change only if both groups are trusted (>= MIN_SAMPLE) and the
 * CTR lift exceeds MIN_LIFT. Returns null (no change proposed) otherwise.
 */
export function proposeStrategyChange(db, dimension, groupA, groupB) {
  const analysis = analyzePerformance(db, [dimension])[dimension];
  const a = analysis[groupA];
  const b = analysis[groupB];
  if (!a || !b || !a.trusted || !b.trusted) {
    return { proposed: false, reason: 'insufficient sample size', minSample: MIN_SAMPLE };
  }
  if (a.ctr === null || b.ctr === null) {
    return { proposed: false, reason: 'no CTR data for one or both groups' };
  }
  const lift = b.ctr === 0 ? Infinity : (a.ctr - b.ctr) / b.ctr;
  if (Math.abs(lift) < MIN_LIFT) {
    return { proposed: false, reason: `lift ${lift.toFixed(2)} below MIN_LIFT ${MIN_LIFT}` };
  }
  const winner = lift > 0 ? groupA : groupB;
  return {
    proposed: true,
    winner,
    dimension,
    evidence: { [groupA]: a, [groupB]: b, lift },
  };
}

export function recordStrategyDecision(db, { version, reason, evidence, sampleSize }) {
  ensureLearningSchema(db);
  db.prepare(
    'INSERT OR REPLACE INTO strategy_log (version, created_at, reason, evidence, sample_size) VALUES (?, ?, ?, ?, ?)'
  ).run(version, new Date().toISOString(), reason, JSON.stringify(evidence), sampleSize);
}

export function strategyHistory(db) {
  ensureLearningSchema(db);
  return db.prepare('SELECT * FROM strategy_log ORDER BY created_at ASC').all();
}

export function nextStrategyVersion(db) {
  const history = strategyHistory(db);
  return `strategy_v${history.length + 1}`;
}
