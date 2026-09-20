import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { getCursor, recordScan, allCursors } from '../lib/sourceCursors.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-cursors-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

test('getCursor returns null for a source that has never been scanned', () => {
  const { dir, db } = tempDb();
  try {
    assert.equal(getCursor(db, 'echo-agent'), null);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('recordScan with advance persists last_native_id/last_timestamp, resumable via getCursor', () => {
  const { dir, db } = tempDb();
  try {
    recordScan(db, 'echo-app', { advance: { lastNativeId: 'tag-1', lastTimestamp: '2026-09-01T00:00:00Z' } });
    const cursor = getCursor(db, 'echo-app');
    assert.equal(cursor.last_native_id, 'tag-1');
    assert.equal(cursor.last_timestamp, '2026-09-01T00:00:00Z');
    assert.ok(cursor.last_scan_at);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('recordScan without advance still updates last_scan_at (a real scan that found nothing new)', () => {
  const { dir, db } = tempDb();
  try {
    recordScan(db, 'noemora', { advance: { lastNativeId: 'seal-1', lastTimestamp: '2026-09-01T00:00:00Z' } });
    const first = getCursor(db, 'noemora');
    recordScan(db, 'noemora', { advance: null }); // scanned again, nothing new found
    const second = getCursor(db, 'noemora');
    assert.equal(second.last_native_id, first.last_native_id, 'position must not regress when nothing new is found');
    assert.ok(second.last_scan_at >= first.last_scan_at, 'last_scan_at must still reflect the second scan');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('recordScan with dryRun:true is a complete no-op (mandate: "dry-run does not advance cursor")', () => {
  const { dir, db } = tempDb();
  try {
    const result = recordScan(db, 'official-site', { advance: { lastNativeId: 'r1', lastTimestamp: '2026-09-01T00:00:00Z' }, dryRun: true });
    assert.equal(result.persisted, false);
    assert.equal(getCursor(db, 'official-site'), null);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('a cursor is resumable: an interrupted scan that never called recordScan leaves the cursor exactly where it was (safe to rescan from the same point)', () => {
  const { dir, db } = tempDb();
  try {
    recordScan(db, 'echo-agent', { advance: { lastNativeId: 'run-1', lastTimestamp: '2026-09-01T00:00:00Z' } });
    // Simulate a crash mid-scan: nothing further is ever recorded for this cycle.
    const cursor = getCursor(db, 'echo-agent');
    assert.equal(cursor.last_native_id, 'run-1', 'cursor stays at the last successfully recorded position, ready to resume from there');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('allCursors lists every source that has ever been scanned', () => {
  const { dir, db } = tempDb();
  try {
    recordScan(db, 'echo-agent', { advance: { lastNativeId: 'a' } });
    recordScan(db, 'noemora', { advance: { lastNativeId: 'b' } });
    const all = allCursors(db);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((c) => c.source).sort(), ['echo-agent', 'noemora']);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});
