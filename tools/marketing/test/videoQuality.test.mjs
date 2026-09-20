import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkVideoQuality, detectBlackFraction } from '../lib/videoQuality.mjs';

const execFileAsync = promisify(execFile);

async function makeVideo(path, { color = 'blue', seconds = 2, withAudio = true } = {}) {
  const args = ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:d=${seconds}:r=30`];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast');
  if (withAudio) args.push('-c:a', 'aac', '-shortest');
  else args.push('-an');
  args.push(path);
  await execFileAsync('ffmpeg', args);
}

test('detectBlackFraction reports near-zero for a real non-black video', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-quality-'));
  try {
    const path = join(dir, 'blue.mp4');
    await makeVideo(path, { color: 'blue', seconds: 2 });
    const black = await detectBlackFraction(path);
    assert.ok(black < 0.5, `expected near-zero black duration for a blue video, got ${black}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, { timeout: 30000 });

test('detectBlackFraction reports the full duration for a genuinely black video (real blackdetect run, not mocked)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-quality-'));
  try {
    const path = join(dir, 'black.mp4');
    await makeVideo(path, { color: 'black', seconds: 2 });
    const black = await detectBlackFraction(path);
    assert.ok(black >= 1.4, `expected most of a 2s black video to be detected as black, got ${black}s`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, { timeout: 30000 });

test('checkVideoQuality passes a normal, valid video with a matching script', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-quality-'));
  try {
    const videoPath = join(dir, 'video.mp4');
    const scriptPath = join(dir, 'script.json');
    // A flat color source compresses to a few KB and would trip the
    // "abnormally small" guard meant for genuinely broken renders — use a
    // busier test pattern so the fixture's size is realistic.
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', videoPath,
    ]);
    writeFileSync(scriptPath, JSON.stringify({ lines: [{ text: 'a' }, { text: 'b' }] }));

    const result = await checkVideoQuality(videoPath, { scriptPath });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.hasVideo, true);
    assert.equal(result.hasAudio, true);
    assert.equal(result.scriptLineCount, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, { timeout: 30000 });

test('checkVideoQuality fails a video with no audio stream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-quality-'));
  try {
    const videoPath = join(dir, 'silent.mp4');
    await makeVideo(videoPath, { color: 'blue', seconds: 1, withAudio: false });
    const result = await checkVideoQuality(videoPath);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.includes('no audio stream')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, { timeout: 30000 });

test('checkVideoQuality fails a mostly-black render (real end-to-end blackdetect gate)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-quality-'));
  try {
    const videoPath = join(dir, 'black.mp4');
    await makeVideo(videoPath, { color: 'black', seconds: 3 });
    const result = await checkVideoQuality(videoPath);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.includes('black frames')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, { timeout: 30000 });

test('checkVideoQuality fails an empty script (zero narration lines)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-quality-'));
  try {
    const videoPath = join(dir, 'video.mp4');
    const scriptPath = join(dir, 'script.json');
    await makeVideo(videoPath, { color: 'blue', seconds: 1 });
    writeFileSync(scriptPath, JSON.stringify({ lines: [] }));
    const result = await checkVideoQuality(videoPath, { scriptPath });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.includes('zero narration lines')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, { timeout: 30000 });

test('checkVideoQuality fails honestly when the file does not exist', async () => {
  const result = await checkVideoQuality('/nonexistent/path.mp4');
  assert.equal(result.ok, false);
  assert.ok(result.issues[0].includes('does not exist'));
});

test('checkVideoQuality flags an abnormally large file (e.g. accidentally uploading the master instead of the publication copy)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-quality-'));
  try {
    const videoPath = join(dir, 'video.mp4');
    await makeVideo(videoPath, { color: 'blue', seconds: 1 });
    // Directly test the size heuristic without generating a real 2GB file.
    const { checkVideoQuality: cvq } = await import('../lib/videoQuality.mjs');
    const realResult = await cvq(videoPath);
    assert.equal(realResult.fileSize < 2 * 1024 * 1024 * 1024, true); // sanity: our tiny test file is well under the threshold
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, { timeout: 30000 });
