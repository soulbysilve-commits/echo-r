// Single-run operator lock, backed by the operator_lock table.
// Prevents overlapping marketing operator runs (mandate section 37/2).

const STALE_MS = 30 * 60 * 1000; // a lock older than this with a dead pid is recoverable

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to acquire the single operator lock.
 * Returns { acquired: true, runId } or { acquired: false, reason, holder }.
 */
export function acquireLock(db, runId) {
  const existing = db.prepare('SELECT * FROM operator_lock WHERE id = 1').get();
  const now = new Date().toISOString();

  if (existing) {
    const age = Date.now() - Date.parse(existing.started_at);
    const stale = age > STALE_MS && !pidAlive(existing.pid);
    if (!stale) {
      return { acquired: false, reason: 'SKIP_OVERLAP', holder: existing };
    }
    // Stale lock: recover it.
    db.prepare('DELETE FROM operator_lock WHERE id = 1').run();
  }

  db.prepare(
    'INSERT INTO operator_lock (id, run_id, pid, host, started_at) VALUES (1, ?, ?, ?, ?)'
  ).run(runId, process.pid, process.env.HOSTNAME ?? 'unknown', now);

  return { acquired: true, runId };
}

export function releaseLock(db, runId) {
  const existing = db.prepare('SELECT * FROM operator_lock WHERE id = 1').get();
  if (existing && existing.run_id === runId) {
    db.prepare('DELETE FROM operator_lock WHERE id = 1').run();
    return true;
  }
  return false;
}
