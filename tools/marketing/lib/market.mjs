// Market/competitor research pipeline (mandate sections 7-8). External
// research is stored under a DIFFERENT evidence classification than the
// internal FACT-* registry (tools/marketing/lib/facts.mjs) — it is never
// auto-trusted or auto-published. A human (or a human-reviewed operator run)
// promotes a market_watch/competitor_fact row into public-facing content,
// never the reverse.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS market_watch (
  entry_id           TEXT PRIMARY KEY,
  retrieved_at       TEXT NOT NULL,
  published_at       TEXT,
  source             TEXT NOT NULL,
  url                TEXT,
  claim              TEXT NOT NULL,
  confidence         TEXT NOT NULL,
  product_impact     TEXT,
  marketing_opportunity TEXT,
  evidence_class     TEXT NOT NULL DEFAULT 'UNVERIFIED_EXTERNAL'
);

CREATE TABLE IF NOT EXISTS competitor_facts (
  entry_id       TEXT PRIMARY KEY,
  competitor     TEXT NOT NULL,
  dimension      TEXT NOT NULL,
  value          TEXT NOT NULL,
  source         TEXT NOT NULL,
  date           TEXT NOT NULL,
  evidence       TEXT NOT NULL,
  confidence     TEXT NOT NULL,
  evidence_class TEXT NOT NULL DEFAULT 'UNVERIFIED_EXTERNAL'
);
`;

export const EVIDENCE_CLASS = {
  UNVERIFIED_EXTERNAL: 'UNVERIFIED_EXTERNAL', // a single external source, not cross-checked
  CORROBORATED_EXTERNAL: 'CORROBORATED_EXTERNAL', // 2+ independent external sources agree
};

export const CONFIDENCE = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' };

export function ensureMarketSchema(db) {
  db.exec(SCHEMA);
}

export function recordMarketEntry(db, { entryId, source, url, claim, confidence, productImpact, marketingOpportunity, publishedAt, evidenceClass }) {
  ensureMarketSchema(db);
  db.prepare(
    `INSERT OR REPLACE INTO market_watch
      (entry_id, retrieved_at, published_at, source, url, claim, confidence, product_impact, marketing_opportunity, evidence_class)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entryId, new Date().toISOString(), publishedAt ?? null, source, url ?? null, claim,
    confidence, productImpact ?? null, marketingOpportunity ?? null, evidenceClass ?? EVIDENCE_CLASS.UNVERIFIED_EXTERNAL
  );
}

export function recordCompetitorFact(db, { entryId, competitor, dimension, value, source, date, evidence, confidence, evidenceClass }) {
  ensureMarketSchema(db);
  db.prepare(
    `INSERT OR REPLACE INTO competitor_facts
      (entry_id, competitor, dimension, value, source, date, evidence, confidence, evidence_class)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(entryId, competitor, dimension, value, source, date, evidence, confidence, evidenceClass ?? EVIDENCE_CLASS.UNVERIFIED_EXTERNAL);
}

export function listMarketEntries(db) {
  ensureMarketSchema(db);
  return db.prepare('SELECT * FROM market_watch ORDER BY retrieved_at DESC').all();
}

export function listCompetitorFacts(db, competitor) {
  ensureMarketSchema(db);
  if (competitor) {
    return db.prepare('SELECT * FROM competitor_facts WHERE competitor = ? ORDER BY date DESC').all(competitor);
  }
  return db.prepare('SELECT * FROM competitor_facts ORDER BY competitor, dimension').all();
}

/**
 * A market/competitor entry may back a public marketing claim only once it
 * has been explicitly reviewed — this function exists so that gate is a
 * single, named, testable choke point rather than an implicit assumption
 * scattered across draft templates.
 */
export function canBackPublicClaim(entry) {
  return entry.evidence_class === EVIDENCE_CLASS.CORROBORATED_EXTERNAL && entry.confidence !== CONFIDENCE.LOW;
}
