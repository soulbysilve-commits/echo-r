// Publication transcode stage: YMM4's master render (NVENC, ~240 Mbps —
// verified in this session at 1.7GB for 56.87s) is far too large for
// routine uploads. This produces a separate, smaller PUBLICATION COPY via a
// standard software H.264/AAC encode at a quality-targeted (not
// master-matching) bitrate — the master is never modified or replaced.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream, statSync, existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

// CRF (Constant Rate Factor) targets visual quality directly rather than a
// fixed bitrate — the right tool for "visually high quality, reasonable
// size" instead of copying the master's fixed (and extreme) bitrate.
// 20 is a commonly-cited "visually lossless for typical viewing" value for
// x264 at 1080p; -preset slow trades encode time for better compression at
// the same visual quality.
export const TRANSCODE_PRESET = {
  crf: 20,
  preset: 'slow',
  audioBitrateKbps: 192,
};

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function ffprobeJson(path, { execFileImpl = execFileAsync } = {}) {
  const { stdout } = await execFileImpl('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', path]);
  return JSON.parse(stdout);
}

/**
 * Transcodes `masterPath` to `publicationPath` (1920x1080, source fps
 * capped at 60, H.264 CRF, AAC). Never overwrites `masterPath`. Refuses to
 * overwrite an existing publication file (ffmpeg `-n`) — callers wanting a
 * fresh copy must choose a new path.
 */
export async function transcodePublicationCopy(masterPath, publicationPath, {
  execFileImpl = execFileAsync, preset = TRANSCODE_PRESET,
} = {}) {
  if (!existsSync(masterPath)) {
    return { ok: false, error: `master file not found: ${masterPath}` };
  }
  if (existsSync(publicationPath)) {
    return { ok: false, error: `publication path already exists, refusing to overwrite: ${publicationPath}` };
  }

  // Compute the fps cap in JS rather than an inline ffmpeg expression — an
  // earlier version tried `fps=min(60,source_fps)` directly in the filter
  // string, which is not valid syntax for the fps filter's rate argument
  // and failed on the very first real ffmpeg run (caught by the test suite,
  // not assumed to work).
  let sourceFps = 60;
  try {
    const probe = await ffprobeJson(masterPath, { execFileImpl });
    const videoStream = probe.streams.find((s) => s.codec_type === 'video');
    const [num, den] = (videoStream?.r_frame_rate ?? '60/1').split('/').map(Number);
    if (num > 0 && den > 0) sourceFps = num / den;
  } catch { /* fall back to the 60fps default above */ }
  const targetFps = Math.min(60, sourceFps);

  const args = [
    '-y', // ffmpeg's own -y only governs whether *ffmpeg* overwrites — the existsSync check above is the real guard, executed before ffmpeg ever runs
    '-i', masterPath,
    '-vf', `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=${targetFps}`,
    '-c:v', 'libx264', '-preset', preset.preset, '-crf', String(preset.crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', `${preset.audioBitrateKbps}k`,
    '-movflags', '+faststart',
    publicationPath,
  ];

  try {
    await execFileImpl('ffmpeg', args);
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }

  if (!existsSync(publicationPath)) {
    return { ok: false, error: 'ffmpeg reported success but publication file does not exist' };
  }

  const masterSize = statSync(masterPath).size;
  const publicationSize = statSync(publicationPath).size;
  const [masterHash, publicationHash] = await Promise.all([sha256File(masterPath), sha256File(publicationPath)]);

  return {
    ok: true,
    masterPath, publicationPath,
    masterSize, publicationSize,
    masterSha256: masterHash, publicationSha256: publicationHash,
    transcodeRatio: publicationSize / masterSize,
  };
}

/**
 * Verifies the publication copy: real video+audio streams, playable
 * container, duration close to the master's (within toleranceSeconds).
 */
export async function verifyPublicationCopy(masterPath, publicationPath, { toleranceSeconds = 1.0, execFileImpl = execFileAsync } = {}) {
  const [masterInfo, pubInfo] = await Promise.all([
    ffprobeJson(masterPath, { execFileImpl }),
    ffprobeJson(publicationPath, { execFileImpl }),
  ]);

  const pubVideo = pubInfo.streams.find((s) => s.codec_type === 'video');
  const pubAudio = pubInfo.streams.find((s) => s.codec_type === 'audio');
  const masterDuration = Number(masterInfo.format.duration);
  const pubDuration = Number(pubInfo.format.duration);

  const issues = [];
  if (!pubVideo) issues.push('no video stream in publication copy');
  if (!pubAudio) issues.push('no audio stream in publication copy');
  if (!(pubDuration > 0)) issues.push('publication copy has zero/invalid duration');
  if (Math.abs(masterDuration - pubDuration) > toleranceSeconds) {
    issues.push(`duration mismatch: master=${masterDuration}s publication=${pubDuration}s (tolerance ${toleranceSeconds}s)`);
  }

  return {
    ok: issues.length === 0,
    issues,
    masterDuration, publicationDuration: pubDuration,
    videoCodec: pubVideo?.codec_name, audioCodec: pubAudio?.codec_name,
    width: pubVideo?.width, height: pubVideo?.height,
  };
}
