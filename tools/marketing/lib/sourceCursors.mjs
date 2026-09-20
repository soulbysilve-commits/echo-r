// Durable per-source scan cursors (mandate section 10: "The scanner must
// not rescan all history every day... Persist per-source cursors outside
// disposable worktrees"). Stored as a table in the SAME marketing.db this
// codebase already keeps in the durable state dir (see lib/paths.mjs) —
// that db already lives outside any disposable git worktree, so a new
// table here satisfies the durability requirement without inventing a
// second persistence mechanism (loose JSON files) alongside the one this
// project already uses everywhere else.
//
// Crash-safety contract (mandate section 10): a cursor is only advanced
// AFTER the corresponding event has been normalized and successfully
// ingested into marketing_events — see lib/sourceIngestion.mjs, which calls
// advanceCursor() per-record only once ingestEvent() for that record has
// returned ok:true. A crash before that point means the record is simply
// rescanned next time (safe — ingestEvent()/dedup make a rescan a no-op if
// it was already ingested); a crash after is impossible to observe as a
// duplicate because the cursor and the event write happen in the same
// per-record step, in order.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS source_cursors (
  source          TEXT PRIMARY KEY,
  last_native_id  TEXT,
  last_timestamp  TEXT,
  last_hash       TEXT,
  last_scan_at    TEXT
);
`;

export function ensureSourceCursorsSchema(db) {
  db.exec(SCHEMA);
}

export function getCursor(db, source) {
  ensureSourceCursorsSchema(db);
  return db.prepare('SELECT * FROM source_cursors WHERE source = ?').get(source) ?? null;
}

/**
 * Records that a scan of `source` happened (updates last_scan_at always —
 * this is what source-health reporting's *_LAST_SCAN fields read). If
 * `advance` is given (the newest record actually processed this scan), also
 * moves last_native_id/last_timestamp/last_hash forward. `dryRun: true`
 * (mandate section 18/22: "dry-run does not advance cursor") makes this a
 * complete no-op — the caller must check dryRun before calling this at all,
 * but this function refuses defensively too, so a caller mistake fails
 * safe rather than silently persisting during a dry run.
 */
export function recordScan(db, source, { advance = null, dryRun = false } = {}) {
  if (dryRun) return { persisted: false, reason: 'dryRun' };
  ensureSourceCursorsSchema(db);
  const now = new Date().toISOString();
  const existing = getCursor(db, source);
  const next = {
    last_native_id: advance?.lastNativeId ?? existing?.last_native_id ?? null,
    last_timestamp: advance?.lastTimestamp ?? existing?.last_timestamp ?? null,
    last_hash: advance?.lastHash ?? existing?.last_hash ?? null,
  };
  if (existing) {
    db.prepare(
      'UPDATE source_cursors SET last_native_id = ?, last_timestamp = ?, last_hash = ?, last_scan_at = ? WHERE source = ?'
    ).run(next.last_native_id, next.last_timestamp, next.last_hash, now, source);
  } else {
    db.prepare(
      'INSERT INTO source_cursors (source, last_native_id, last_timestamp, last_hash, last_scan_at) VALUES (?, ?, ?, ?, ?)'
    ).run(source, next.last_native_id, next.last_timestamp, next.last_hash, now);
  }
  return { persisted: true };
}

export function allCursors(db) {
  ensureSourceCursorsSchema(db);
  return db.prepare('SELECT * FROM source_cursors').all();
}
