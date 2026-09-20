// Source health reporting (mandate section 17). Read-only: never scans,
// only reports what the last real scan (if any) recorded via
// lib/sourceCursors.mjs, plus a cumulative count of events actually
// ingested from that source_repository.
import { getCursor } from './sourceCursors.mjs';
import { ensureEventsSchema } from './events.mjs';

export function sourceHealth(db, adapter) {
  ensureEventsSchema(db);
  const cursor = getCursor(db, adapter.source);
  const eventsFound = db.prepare(
    'SELECT COUNT(*) c FROM marketing_events WHERE source_repo = ?'
  ).get(adapter.sourceRepository).c;

  let status;
  if (!cursor || !cursor.last_scan_at) status = 'NO_EVIDENCE';
  else if (eventsFound > 0) status = 'PASS';
  else status = 'NO_EVIDENCE';

  return {
    source: adapter.source,
    lastScanAt: cursor?.last_scan_at ?? null,
    eventsFound,
    status,
  };
}

export function allSourceHealth(db, adapters) {
  return adapters.map((a) => sourceHealth(db, a));
}
