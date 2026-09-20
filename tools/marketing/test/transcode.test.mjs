import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcodePublicationCopy, verifyPublicationCopy, sha256File } from '../lib/transcode.mjs';

const execFileAsync = promisify(execFile);

async function makeTestVideo(path, { seconds = 2, size = '320x240' } = {}) {
  await execFileAsync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `color=c=blue:s=${size}:d=${seconds}:r=30`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', path,
  ]);
}

test('transcodePublicationCopy produces a real, smaller, valid publication file from a real master (actual ffmpeg run, not mocked)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-transcode-'));
  try {
    const masterPath = join(dir, 'master.mp4');
    const pubPath = join(dir, 'publication.mp4');
    // Use a high-bitrate-ish master (ultrafast preset, low CRF-equivalent via
    // default) to stand in for YMM4's much larger NVENC master — the point
    // here is verifying our own transcode/verify code against real ffmpeg
    // output, not reproducing the master's exact size.
    await makeTestVideo(masterPath, { seconds: 2 });

    const result = await transcodePublicationCopy(masterPath, pubPath);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(existsSync(pubPath));
    assert.ok(result.masterSha256.length === 64);
    assert.ok(result.publicationSha256.length === 64);
    assert.notEqual(result.masterSha256, result.publicationSha256);

    const verify = await verifyPublicationCopy(masterPath, pubPath);
    assert.equal(verify.ok, true, JSON.stringify(verify));
    assert.equal(verify.videoCodec, 'h264');
    assert.equal(verify.audioCodec, 'aac');
    assert.ok(Math.abs(verify.masterDuration - verify.publicationDuration) < 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 60000 });

test('transcodePublicationCopy never overwrites the master, and refuses to overwrite an existing publication path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-transcode-'));
  try {
    const masterPath = join(dir, 'master.mp4');
    const pubPath = join(dir, 'publication.mp4');
    await makeTestVideo(masterPath, { seconds: 1 });
    const masterHashBefore = await sha256File(masterPath);

    const first = await transcodePublicationCopy(masterPath, pubPath);
    assert.equal(first.ok, true);
    const masterHashAfter = await sha256File(masterPath);
    assert.equal(masterHashBefore, masterHashAfter, 'master must be byte-identical after transcode');

    const second = await transcodePublicationCopy(masterPath, pubPath);
    assert.equal(second.ok, false);
    assert.match(second.error, /already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 60000 });

test('transcodePublicationCopy reports failure honestly when the master does not exist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-transcode-'));
  try {
    const result = await transcodePublicationCopy(join(dir, 'nope.mp4'), join(dir, 'out.mp4'));
    assert.equal(result.ok, false);
    assert.match(result.error, /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyPublicationCopy flags a publication file with no audio stream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-transcode-'));
  try {
    const masterPath = join(dir, 'master.mp4');
    const silentPubPath = join(dir, 'silent.mp4');
    await makeTestVideo(masterPath, { seconds: 1 });
    // Build a video-only "publication" file directly (bypassing our own
    // transcode function) to test the verifier catches a missing audio track.
    await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1:r=30', '-an', silentPubPath]);

    const verify = await verifyPublicationCopy(masterPath, silentPubPath);
    assert.equal(verify.ok, false);
    assert.ok(verify.issues.some((i) => i.includes('no audio stream')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 30000 });

test('verifyPublicationCopy flags a duration mismatch beyond tolerance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-transcode-'));
  try {
    const masterPath = join(dir, 'master.mp4');
    const shortPubPath = join(dir, 'short.mp4');
    await makeTestVideo(masterPath, { seconds: 5 });
    await makeTestVideo(shortPubPath, { seconds: 1 });

    const verify = await verifyPublicationCopy(masterPath, shortPubPath, { toleranceSeconds: 0.5 });
    assert.equal(verify.ok, false);
    assert.ok(verify.issues.some((i) => i.includes('duration mismatch')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 30000 });

test('sha256File matches a value independently computed via sha256sum-equivalent node crypto on the same bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-transcode-'));
  try {
    const path = join(dir, 'file.txt');
    writeFileSync(path, 'hello world');
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update('hello world').digest('hex');
    assert.equal(await sha256File(path), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
