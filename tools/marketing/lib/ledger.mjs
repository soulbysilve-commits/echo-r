import { createHash, randomUUID } from 'node:crypto';

export function contentHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Multi-channel expansion (mandate section 15): canonical-content tracking
// for cross-posted long-form articles (DEV.to/Qiita/Zenn/Hashnode) — same
// ALTER-TABLE migration pattern as videoPipeline.mjs's V2_COLUMNS, never a
// DROP/CREATE (existing ledger rows are real publication history).
// external_cid added for the Bluesky canary (AT Protocol responses carry a
// separate content-addressed `cid` alongside `uri`/external_id — never
// re-derivable without a live call, so it must be persisted to survive a
// process restart / be returned on an idempotent "already passed" re-run).
const V2_COLUMNS = { event_id: 'TEXT', canonical_content_id: 'TEXT', canonical_url: 'TEXT', external_cid: 'TEXT' };

export function ensureLedgerV2Schema(db) {
  const existingCols = new Set(db.prepare('PRAGMA table_info(publication_ledger)').all().map((c) => c.name));
  for (const [name, type] of Object.entries(V2_COLUMNS)) {
    if (!existingCols.has(name)) {
      db.exec(`ALTER TABLE publication_ledger ADD COLUMN ${name} ${type}`);
    }
  }
}

/**
 * Returns the existing ledger row for this (channel, content) pair, if any.
 * Used to enforce idempotency: the same content must never be published
 * twice to the same channel, even across process restarts.
 */
export function findExisting(db, channel, text) {
  const hash = contentHash(text);
  return db
    .prepare('SELECT * FROM publication_ledger WHERE channel = ? AND content_hash = ?')
    .get(channel, hash);
}

/**
 * Record an intended publication (DRY_RUN or pending approval). Does not
 * mark it published — call markPublished() once a connector actually
 * sends it, so a crash between recording and sending is always retryable.
 */
export function recordIntent(db, {
  channel, account, text, contentType, sourceEvidence, riskClass, approvalState, campaign, utm,
  eventId, canonicalContentId, canonicalUrl,
}) {
  ensureLedgerV2Schema(db);
  const existing = findExisting(db, channel, text);
  if (existing) return existing;

  const publicationId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO publication_ledger
      (publication_id, channel, account, content_hash, content_type, source_evidence,
       risk_class, approval_state, scheduled_at, published_at, external_id, external_url,
       campaign, utm, result, created_at, event_id, canonical_content_id, canonical_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?)`
  ).run(
    publicationId, channel, account ?? null, contentHash(text), contentType ?? null,
    sourceEvidence ?? null, riskClass, approvalState, campaign ?? null, utm ?? null, now,
    eventId ?? null, canonicalContentId ?? null, canonicalUrl ?? null
  );
  return db.prepare('SELECT * FROM publication_ledger WHERE publication_id = ?').get(publicationId);
}

export function markPublished(db, publicationId, { externalId, externalUrl, externalCid, result }) {
  ensureLedgerV2Schema(db);
  db.prepare(
    `UPDATE publication_ledger
     SET published_at = ?, external_id = ?, external_url = ?, external_cid = ?, result = ?
     WHERE publication_id = ?`
  ).run(new Date().toISOString(), externalId ?? null, externalUrl ?? null, externalCid ?? null, result ?? 'OK', publicationId);
}

export function markFailed(db, publicationId, reason) {
  db.prepare('UPDATE publication_ledger SET result = ? WHERE publication_id = ?').run(
    `FAILED: ${reason}`,
    publicationId
  );
}

export function todaysPublications(db) {
  const today = new Date().toISOString().slice(0, 10);
  return db
    .prepare("SELECT * FROM publication_ledger WHERE published_at LIKE ? || '%'")
    .all(today);
}

export function pendingPublications(db) {
  return db
    .prepare('SELECT * FROM publication_ledger WHERE published_at IS NULL AND result IS NULL')
    .all();
}

export function failedPublications(db) {
  return db.prepare("SELECT * FROM publication_ledger WHERE result LIKE 'FAILED%'").all();
}
