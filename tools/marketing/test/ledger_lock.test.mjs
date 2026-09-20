import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { acquireLock, releaseLock } from '../lib/lock.mjs';
import { recordIntent, markPublished, markFailed, findExisting, todaysPublications, failedPublications } from '../lib/ledger.mjs';

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-test-'));
  return { dir, path: join(dir, 'test.db') };
}

test('same publication content is never recorded twice (idempotency)', () => {
  const { dir, path } = tempDbPath();
  try {
    const db = openDb(path);
    const first = recordIntent(db, { channel: 'x', text: 'hello world', riskClass: 'AUTO', approvalState: 'AUTO_APPROVED' });
    const second = recordIntent(db, { channel: 'x', text: 'hello world', riskClass: 'AUTO', approvalState: 'AUTO_APPROVED' });
    assert.equal(first.publication_id, second.publication_id);
    const count = db.prepare('SELECT COUNT(*) c FROM publication_ledger').get().c;
    assert.equal(count, 1);
    closeDb(db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publication ledger survives a simulated restart (reopening the same db file)', () => {
  const { dir, path } = tempDbPath();
  try {
    let db = openDb(path);
    const row = recordIntent(db, { channel: 'discord', text: 'release notes v1', riskClass: 'AUTO', approvalState: 'AUTO_APPROVED' });
    markPublished(db, row.publication_id, { externalId: 'abc123', result: 'OK' });
    closeDb(db);

    // Simulate process restart: fresh DatabaseSync handle on the same file.
    db = openDb(path);
    const reloaded = findExisting(db, 'discord', 'release notes v1');
    assert.ok(reloaded);
    assert.equal(reloaded.external_id, 'abc123');
    assert.equal(reloaded.published_at !== null, true);

    // Attempting to record the same content again must not duplicate or clear published state.
    const again = recordIntent(db, { channel: 'discord', text: 'release notes v1', riskClass: 'AUTO', approvalState: 'AUTO_APPROVED' });
    assert.equal(again.publication_id, row.publication_id);
    assert.equal(again.published_at !== null, true);
    closeDb(db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overlapping operator runs are blocked by the single-run lock', () => {
  const { dir, path } = tempDbPath();
  try {
    const db = openDb(path);
    const runA = acquireLock(db, 'run-A');
    assert.equal(runA.acquired, true);

    const runB = acquireLock(db, 'run-B');
    assert.equal(runB.acquired, false);
    assert.equal(runB.reason, 'SKIP_OVERLAP');

    releaseLock(db, 'run-A');
    const runC = acquireLock(db, 'run-C');
    assert.equal(runC.acquired, true);
    closeDb(db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale lock (dead pid, past staleness window) can be recovered', () => {
  const { dir, path } = tempDbPath();
  try {
    const db = openDb(path);
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO operator_lock (id, run_id, pid, host, started_at) VALUES (1, ?, ?, ?, ?)').run(
      'dead-run', 999999999, 'x', longAgo
    );
    const result = acquireLock(db, 'new-run');
    assert.equal(result.acquired, true);
    closeDb(db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('todaysPublications only returns rows published today', () => {
  const { dir, path } = tempDbPath();
  try {
    const db = openDb(path);
    const row = recordIntent(db, { channel: 'x', text: 'today post', riskClass: 'AUTO', approvalState: 'AUTO_APPROVED' });
    markPublished(db, row.publication_id, { result: 'OK' });
    const rows = todaysPublications(db);
    assert.equal(rows.length, 1);
    closeDb(db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed publication can be retried safely without creating a duplicate', () => {
  const { dir, path } = tempDbPath();
  try {
    const db = openDb(path);
    const row = recordIntent(db, { channel: 'x', text: 'flaky post', riskClass: 'AUTO', approvalState: 'AUTO_APPROVED' });
    markFailed(db, row.publication_id, 'network timeout');
    assert.equal(failedPublications(db).length, 1);

    // Retry: the operator would recordIntent again with identical content, then republish.
    const retryRow = recordIntent(db, { channel: 'x', text: 'flaky post', riskClass: 'AUTO', approvalState: 'AUTO_APPROVED' });
    assert.equal(retryRow.publication_id, row.publication_id);
    markPublished(db, retryRow.publication_id, { externalId: 'ok-1', result: 'OK' });

    const finalRow = db.prepare('SELECT * FROM publication_ledger WHERE publication_id = ?').get(row.publication_id);
    assert.equal(finalRow.result, 'OK');
    assert.ok(finalRow.published_at);
    const count = db.prepare('SELECT COUNT(*) c FROM publication_ledger').get().c;
    assert.equal(count, 1, 'retry must not create a duplicate ledger row');
    closeDb(db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
