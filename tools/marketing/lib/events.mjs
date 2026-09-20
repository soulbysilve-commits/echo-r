// Event-ingestion interface (mandate section 10). An event only triggers
// evidence verification + story (re-)scoring — it never publishes anything
// by itself. Idempotent on event_id: replaying the same event (e.g. a CI
// webhook retry) is always safe.
import { randomUUID } from 'node:crypto';

export const EVENT_TYPES = [
  'TEST_SUITE_PASS',
  'RELEASE_READY',
  'NEW_FEATURE_VERIFIED',
  'BUG_FIXED',
  'DEMO_COMPLETED',
  'MODEL_MIGRATION_PASS',
  'SKILL_PROMOTION',
  'PAYMENT_E2E_PASS',
  'PUBLIC_RELEASE',
  // Narrowly justified internal discovery types (automatic-event-ingestion
  // mandate section 5) — added for sourceAdapters/echoAgent.mjs, whose
  // trajectory-run evidence doesn't map cleanly onto any type above.
  'REAL_TASK_COMPLETED',
  'REAL_TASK_FAILED',
  'REAL_TASK_RECOVERED',
  'VERIFIER_REJECTED',
  'CHECKPOINT_RESUMED',
  'CONTINUITY_CHANGED',
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS marketing_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  source_repo  TEXT,
  fact_id      TEXT,
  payload      TEXT,
  received_at  TEXT NOT NULL,
  processed_at TEXT,
  outcome      TEXT
);
`;

export function ensureEventsSchema(db) {
  db.exec(SCHEMA);
}

/**
 * Ingest an event. `dedupeKey` (defaults to a random id if omitted) is what
 * makes replays safe — the same dedupeKey is only ever recorded once.
 */
export function ingestEvent(db, { eventType, sourceRepo, factId, payload, dedupeKey }) {
  ensureEventsSchema(db);
  if (!EVENT_TYPES.includes(eventType)) {
    return { ok: false, error: `unknown event type: ${eventType}` };
  }
  const eventId = dedupeKey ?? randomUUID();
  const existing = db.prepare('SELECT * FROM marketing_events WHERE event_id = ?').get(eventId);
  if (existing) {
    return { ok: true, deduped: true, eventId };
  }
  db.prepare(
    'INSERT INTO marketing_events (event_id, event_type, source_repo, fact_id, payload, received_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(eventId, eventType, sourceRepo ?? null, factId ?? null, payload ? JSON.stringify(payload) : null, new Date().toISOString());
  return { ok: true, deduped: false, eventId };
}

export function markEventProcessed(db, eventId, outcome) {
  db.prepare('UPDATE marketing_events SET processed_at = ?, outcome = ? WHERE event_id = ?').run(
    new Date().toISOString(), outcome, eventId
  );
}

export function unprocessedEvents(db) {
  ensureEventsSchema(db);
  return db.prepare('SELECT * FROM marketing_events WHERE processed_at IS NULL ORDER BY received_at ASC').all();
}
