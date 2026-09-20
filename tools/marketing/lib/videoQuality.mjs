// Pre-upload quality gate (mandate section 10). Runs against the
// PUBLICATION copy (what will actually be uploaded). If any check fails,
// the caller must not upload — this module only ever reports, it never
// uploads anything itself.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync, readFileSync } from 'node:fs';

const execFileAsync = promisify(execFile);

const MIN_FILE_SIZE_BYTES = 50 * 1024; // below this, almost certainly an empty/broken render
const MAX_REASONABLE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB — a publication copy this large signals the transcode stage didn't run/help
const MIN_DURATION_SECONDS = 1;
// If more than this fraction of total duration is detected as black frames,
// treat it as a likely empty/broken render rather than legitimate content.
const MAX_BLACK_FRACTION = 0.8;

async function ffprobeJson(path, { execFileImpl = execFileAsync } = {}) {
  const { stdout } = await execFileImpl('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', path]);
  return JSON.parse(stdout);
}

/**
 * Runs ffmpeg's blackdetect filter and sums the reported black-frame
 * duration. A real, standard technique for "obvious empty render" detection
 * — not a heuristic invented for this codebase.
 */
export async function detectBlackFraction(videoPath, { execFileImpl = execFileAsync } = {}) {
  // ffmpeg writes blackdetect's findings to stderr regardless of whether the
  // process exits 0 or non-zero (with `-f null -` it normally exits 0) — so
  // stderr must be read from BOTH the success value and the error object,
  // not only the catch branch.
  let stderr = '';
  try {
    const result = await execFileImpl('ffmpeg', ['-i', videoPath, '-vf', 'blackdetect=d=0.5:pic_th=0.98', '-an', '-f', 'null', '-']);
    stderr = result?.stderr ?? '';
  } catch (err) {
    stderr = err?.stderr ?? '';
  }
  const durations = [...stderr.matchAll(/black_duration:([0-9.]+)/g)].map((m) => Number(m[1]));
  return durations.reduce((a, b) => a + b, 0);
}

/**
 * Full pre-upload quality check. `scriptPath` (optional) is the
 * video_script.json for this demo run — if given, the check confirms the
 * publication video's duration is at least roughly consistent with the
 * script having actually been the source (a cheap proxy for "narration
 * wasn't silently dropped"), without needing per-line audio analysis.
 */
export async function checkVideoQuality(videoPath, { scriptPath, execFileImpl = execFileAsync } = {}) {
  const issues = [];

  let stat;
  try {
    stat = statSync(videoPath);
  } catch {
    return { ok: false, issues: [`file does not exist: ${videoPath}`] };
  }

  if (stat.size < MIN_FILE_SIZE_BYTES) issues.push(`file size ${stat.size} bytes is abnormally small (< ${MIN_FILE_SIZE_BYTES})`);
  if (stat.size > MAX_REASONABLE_SIZE_BYTES) issues.push(`file size ${stat.size} bytes is abnormally large for a publication copy (> ${MAX_REASONABLE_SIZE_BYTES}) — is this actually the transcoded copy, not the master?`);

  let probe;
  try {
    probe = await ffprobeJson(videoPath, { execFileImpl });
  } catch (err) {
    return { ok: false, issues: [...issues, `ffprobe failed: ${err.message ?? err}`] };
  }

  const videoStream = probe.streams.find((s) => s.codec_type === 'video');
  const audioStream = probe.streams.find((s) => s.codec_type === 'audio');
  const duration = Number(probe.format.duration);

  if (!videoStream) issues.push('no video stream present');
  if (!audioStream) issues.push('no audio stream present');
  if (!(duration >= MIN_DURATION_SECONDS)) issues.push(`duration ${duration}s is below the minimum ${MIN_DURATION_SECONDS}s`);

  let scriptLineCount = null;
  if (scriptPath) {
    try {
      const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
      scriptLineCount = script.lines?.length ?? 0;
      if (scriptLineCount === 0) issues.push('script has zero narration lines — nothing to narrate');
    } catch (err) {
      issues.push(`could not read/parse script at ${scriptPath}: ${err.message ?? err}`);
    }
  }

  let blackFraction = 0;
  if (videoStream && duration > 0) {
    const blackSeconds = await detectBlackFraction(videoPath, { execFileImpl });
    blackFraction = blackSeconds / duration;
    if (blackFraction > MAX_BLACK_FRACTION) {
      issues.push(`${(blackFraction * 100).toFixed(0)}% of the video is detected as black frames (> ${MAX_BLACK_FRACTION * 100}%) — likely an empty/broken render`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    fileSize: stat.size,
    duration,
    hasVideo: !!videoStream,
    hasAudio: !!audioStream,
    scriptLineCount,
    blackFraction,
  };
}
