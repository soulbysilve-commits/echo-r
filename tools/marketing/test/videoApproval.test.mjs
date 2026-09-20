import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../lib/db.mjs';
import { upsertDemoRun, approveVideo, rejectVideo, canPublishPublic, reviewQueue, getDemoRun } from '../lib/videoPipeline.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-approval-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

function seedPrivateVideo(db, id = 'demo1') {
  upsertDemoRun(db, id, {
    title: 'Test Video', youtube_video_id: 'vid1', youtube_url: 'https://youtu.be/vid1',
    privacy_status: 'private', claims_json: JSON.stringify([{ factId: 'FACT-001', claim: 'x' }]),
    evidence_refs_json: JSON.stringify(['FACT-001']),
  });
}

// --- approveVideo ---

test('approveVideo without confirm returns a preview only, no state change', () => {
  const { dir, db } = tempDb();
  try {
    seedPrivateVideo(db);
    const result = approveVideo(db, 'demo1');
    assert.equal(result.ok, true);
    assert.equal(result.approved, false);
    assert.equal(result.preview.title, 'Test Video');
    assert.equal(result.preview.privateUrl, 'https://youtu.be/vid1');
    assert.equal(result.preview.claims.length, 1);
    const row = getDemoRun(db, 'demo1');
    assert.equal(row.review_status, 'PENDING', 'must not change state without confirm');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('approveVideo with confirm:true transitions to APPROVED', () => {
  const { dir, db } = tempDb();
  try {
    seedPrivateVideo(db);
    const result = approveVideo(db, 'demo1', { confirm: true });
    assert.equal(result.ok, true);
    assert.equal(result.approved, true);
    const row = getDemoRun(db, 'demo1');
    assert.equal(row.review_status, 'APPROVED');
    assert.ok(row.reviewed_at);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('approveVideo refuses when the recorded privacy status is not private (approval only makes sense pre-publish)', () => {
  const { dir, db } = tempDb();
  try {
    seedPrivateVideo(db);
    upsertDemoRun(db, 'demo1', { privacy_status: 'public' });
    const result = approveVideo(db, 'demo1', { confirm: true });
    assert.equal(result.ok, false);
    const row = getDemoRun(db, 'demo1');
    assert.equal(row.review_status, 'PENDING', 'must not approve a non-private video');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('approveVideo reports an error for an unknown demo run rather than throwing', () => {
  const { dir, db } = tempDb();
  try {
    const result = approveVideo(db, 'nonexistent', { confirm: true });
    assert.equal(result.ok, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- rejectVideo ---

test('rejectVideo transitions to REJECTED or NEEDS_EDIT', () => {
  const { dir, db } = tempDb();
  try {
    seedPrivateVideo(db);
    const r1 = rejectVideo(db, 'demo1', { status: 'NEEDS_EDIT' });
    assert.equal(r1.ok, true);
    assert.equal(getDemoRun(db, 'demo1').review_status, 'NEEDS_EDIT');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('rejectVideo refuses an invalid status value', () => {
  const { dir, db } = tempDb();
  try {
    seedPrivateVideo(db);
    const result = rejectVideo(db, 'demo1', { status: 'MAYBE' });
    assert.equal(result.ok, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- canPublishPublic: the core "no accidental public" gate ---

test('canPublishPublic blocks a PENDING (not yet reviewed) video', () => {
  const { dir, db } = tempDb();
  try {
    seedPrivateVideo(db);
    const result = canPublishPublic(db, 'demo1');
    assert.equal(result.allowed, false);
    assert.match(result.reason, /PENDING/);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canPublishPublic blocks a REJECTED video even after having been reviewed', () => {
  const { dir, db } = tempDb();
  try {
    seedPrivateVideo(db);
    rejectVideo(db, 'demo1', { status: 'REJECTED' });
    const result = canPublishPublic(db, 'demo1');
    assert.equal(result.allowed, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canPublishPublic allows only after explicit APPROVED state', () => {
  const { dir, db } = tempDb();
  try {
    seedPrivateVideo(db);
    approveVideo(db, 'demo1', { confirm: true });
    const result = canPublishPublic(db, 'demo1');
    assert.equal(result.allowed, true);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canPublishPublic refuses to re-publish a video already public', () => {
  const { dir, db } = tempDb();
  try {
    seedPrivateVideo(db);
    approveVideo(db, 'demo1', { confirm: true });
    upsertDemoRun(db, 'demo1', { privacy_status: 'public' });
    const result = canPublishPublic(db, 'demo1');
    assert.equal(result.allowed, false);
    assert.match(result.reason, /already public/);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('canPublishPublic refuses a video with no uploaded id even if somehow APPROVED', () => {
  const { dir, db } = tempDb();
  try {
    upsertDemoRun(db, 'demo1', { privacy_status: 'private', review_status: 'APPROVED' });
    const result = canPublishPublic(db, 'demo1');
    assert.equal(result.allowed, false);
    assert.match(result.reason, /no uploaded video/);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- reviewQueue ---

test('reviewQueue lists only demo runs that actually have an uploaded video', () => {
  const { dir, db } = tempDb();
  try {
    seedPrivateVideo(db, 'demo1');
    upsertDemoRun(db, 'demo2', { evidence_status: 'PUBLIC_SAFE' }); // no youtube_video_id yet
    const queue = reviewQueue(db);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].demo_run_id, 'demo1');
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});
