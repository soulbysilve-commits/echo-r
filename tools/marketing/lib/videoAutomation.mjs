// Top-level automatic video pipeline orchestration (mandate: "AUTOMATIC
// REAL-TASK SELECTION -> AUTOMATIC EVIDENCE BUNDLE -> AUTOMATIC YMM4 VIDEO ->
// AUTOMATIC TRANSCODE -> AUTOMATIC QUALITY CHECK -> AUTOMATIC YOUTUBE PRIVATE
// UPLOAD -> HUMAN REVIEW -> PUBLICATION"). Every existing stage
// (selectBestCandidate, createVideo, assembleProjectViaLiveBridge,
// autoEncodeProject, transcodePublicationCopy, checkVideoQuality,
// uploadPrivateVideo) is reused UNCHANGED — this module only sequences them
// and stops safely, recording the reason, the first time any gate fails.
// It never throws on an expected failure mode and never retries a stage
// indefinitely (mandate section 8: "bounded retries only for clearly
// transient failures" — encode failures here are reported, not retried,
// since autoEncodeProject already ran the one real encode attempt).
//
// Now wired into the daily scheduler (operator.mjs runOnceInner) as of the
// recurring-video mandate's section 12, which supersedes the earlier
// deferral (the instruction had arrived cut off mid-sentence at the time
// this module was first written) — see runDailyVideoStage() below, the
// entry point the daily cycle actually calls.
import { selectBestCandidate, minVideoScore } from './videoCandidates.mjs';
import {
  createVideo, getDemoRun, upsertDemoRun, populateReviewMetadata,
  assembleProjectViaLiveBridge, autoEncodeProject, uploadPrivateVideo,
  generateThumbnail, ensureVideoPipelineSchema, MARKETING_PROJECT_ROOT,
} from './videoPipeline.mjs';
import { transcodePublicationCopy, verifyPublicationCopy } from './transcode.mjs';
import { checkVideoQuality } from './videoQuality.mjs';
import { toWslPath } from './winPath.mjs';
import { writeReviewNotification } from './videoNotify.mjs';
import { getLimits, checkDiskGuard, withTimeout } from './limits.mjs';
import { statePath } from './paths.mjs';

// Windows path — this pipeline only ever runs against the real Windows-side
// YMM4 bridge (see docs/marketing/YMM4_AUTOMATION_AUDIT.md), so a literal
// Windows path here (not a WSL /mnt/c path) is intentional, matching every
// other Windows-side path already used by autoEncodeProject(). Everything
// downstream of the render (ffmpeg/ffprobe/Node fs/YouTube upload) needs
// the WSL-translated equivalent instead — see lib/winPath.mjs.
export const DEFAULT_PROJECTS_DIR = `C:\\Users\\Silver\\${MARKETING_PROJECT_ROOT}\\projects`;
export const DEFAULT_RENDER_OUTPUT_DIR = `C:\\Users\\Silver\\${MARKETING_PROJECT_ROOT}\\render`;

function generateDemoRunId(fingerprint) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  return `auto-${ts}-${fingerprint.slice(0, 8)}`;
}

/**
 * How many automatic video runs have actually reached a real private
 * upload today (UTC date) — the basis for MAX_AUTO_VIDEOS_PER_DAY (mandate
 * section 12: "Never generate multiple large renders in one scheduled
 * run"). Deliberately counts completed uploads, not merely attempted runs,
 * so a run that stopped early (NO_VIDEO, YMM4_BRIDGE_UNREACHABLE, a gated
 * failure) never consumes the day's cap.
 */
export function autoVideosToday(db, { now = new Date() } = {}) {
  ensureVideoPipelineSchema(db);
  const today = now.toISOString().slice(0, 10);
  const row = db.prepare(
    "SELECT COUNT(*) c FROM demo_runs WHERE youtube_video_id IS NOT NULL AND privacy_status = 'private' AND created_at LIKE ? || '%'"
  ).get(today);
  return row.c;
}

/**
 * Entry point the daily scheduler actually calls (mandate section 12, step
 * 6-14). Enforces MAX_AUTO_VIDEOS_PER_DAY BEFORE selection runs, so a day
 * that's already at its cap never consumes/marks-processed any candidate
 * event — those stay available for tomorrow's run instead of being wasted.
 */
export async function runDailyVideoStage(db, { facts = [], env = process.env, ...opts } = {}) {
  const limits = getLimits(env);
  const todayCount = autoVideosToday(db);
  if (todayCount >= limits.MAX_AUTO_VIDEOS_PER_DAY) {
    return { ok: true, status: 'DAILY_VIDEO_CAP_REACHED', autoVideosToday: todayCount, cap: limits.MAX_AUTO_VIDEOS_PER_DAY };
  }
  return runAutomaticVideoPipeline(db, { facts, env, ...opts });
}

/**
 * Runs the automatic pipeline exactly as far as it can safely go, stopping
 * at PRIVATE_VIDEO_READY_FOR_REVIEW on full success. Returns a structured
 * result with a `status` field describing exactly where it stopped and
 * `ok: true` whenever stopping there is the CORRECT outcome — including
 * NO_VIDEO, which the mandate is explicit is not a failure ("If nothing
 * qualifies: NO_VIDEO is correct").
 *
 * Bounded by MAX_VIDEO_PIPELINE_RUNTIME_MS end-to-end (mandate section 13) —
 * a timeout here is reported as TIMEOUT, never silently swallowed, and never
 * retried (bounded retries are for transient failures, not a whole-pipeline
 * runaway).
 */
export async function runAutomaticVideoPipeline(db, opts = {}) {
  const env = opts.env ?? process.env;
  const limits = getLimits(env);
  try {
    return await withTimeout(runAutomaticVideoPipelineInner(db, opts), limits.MAX_VIDEO_PIPELINE_RUNTIME_MS, 'runAutomaticVideoPipeline');
  } catch (err) {
    if (err?.name === 'RunDurationExceededError') {
      return { ok: false, status: 'TIMEOUT', message: err.message };
    }
    throw err;
  }
}

async function runAutomaticVideoPipelineInner(db, {
  facts = [], env = process.env, fetchImpl = fetch, execFileImpl, readFileImpl, youtubeImpl, ymm4ReadyImpl,
  projectsDir = DEFAULT_PROJECTS_DIR, outputDir = DEFAULT_RENDER_OUTPUT_DIR,
} = {}) {
  const limits = getLimits(env);
  const selection = selectBestCandidate(db, { facts, minScore: minVideoScore(env) });
  if (!selection.selected) {
    return { ok: true, status: 'NO_VIDEO', minScore: selection.minScore, candidatesConsidered: selection.allScored.length };
  }
  const { candidate, fingerprint, total: score } = selection.selected;
  const demoRunId = generateDemoRunId(fingerprint);

  upsertDemoRun(db, demoRunId, {
    story_fingerprint: fingerprint,
    source_event_ids: JSON.stringify([candidate.sourceEventId]),
    source_fact_ids: JSON.stringify(candidate.factIds),
  });
  populateReviewMetadata(db, demoRunId, {
    title: candidate.title ?? `Veritas Forge demo — ${candidate.eventType}`,
    factIds: candidate.factIds,
    facts,
  });

  // Stage 1: evidence + script (+ YMM4 ready check, mandate section 7/10 —
  // ensureYmm4ForVideoJob() only ever runs here, AFTER selection already
  // found a qualifying candidate above, never merely to scan). Reuses
  // createVideo() exactly as the manual `video create` command does.
  const created = await createVideo(db, demoRunId, {
    factIds: candidate.factIds, rawLogLines: candidate.rawLogLines, facts, env, fetchImpl, execFileImpl, ymm4ReadyImpl,
  });
  if (!created.ok) {
    return { ok: false, status: 'EVIDENCE_OR_SCRIPT_FAILED', demoRunId, score, stage: created.stage, detail: created };
  }
  if (created.status !== 'BRIDGE_REACHABLE_READY_FOR_ASSEMBLY') {
    // Correct, honest stop — never fake a render. A human/the startup task
    // must get YMM4 ready before this run can proceed further.
    return { ok: true, status: created.status ?? 'YMM4_UNAVAILABLE', demoRunId, score, message: created.message, packagePath: created.packagePath };
  }

  // Stage 2: assemble a NEW dedicated per-run project (never the canary
  // project, never any Noemora project — mandate section 7).
  const projectPath = `${projectsDir}\\${demoRunId}.ymmp`;
  const assembled = await assembleProjectViaLiveBridge(created.script, projectPath, { env, fetchImpl });
  if (!assembled.ok) {
    upsertDemoRun(db, demoRunId, { render_status: `ASSEMBLY_FAILED: ${assembled.stage ?? ''} ${assembled.error ?? ''}`.trim() });
    return { ok: false, status: 'ASSEMBLY_FAILED', demoRunId, score, detail: assembled };
  }

  // Disk-safety gate (mandate section 13) — checked right before the encode
  // that's actually about to write a multi-GB master file, against the
  // real Windows drive the render/transcode output lands on (outputDir,
  // translated to its WSL-visible mount — see lib/winPath.mjs). Fails
  // closed: an unreadable path is treated as unsafe, not as "plenty of
  // room".
  const diskGuard = checkDiskGuard(toWslPath(outputDir), env);
  if (!diskGuard.ok) {
    upsertDemoRun(db, demoRunId, { render_status: diskGuard.reason });
    return { ok: true, status: 'SKIP_VIDEO_LOW_DISK', demoRunId, score, diskGuard };
  }

  // Stage 3: automatic headless encode — gated end-to-end by
  // canAutoEncode()/MARKETING_YMM4_DEMO_ALLOWED inside autoEncodeProject().
  // Not retried here: autoEncodeProject already performs exactly one
  // encode attempt per call, matching "never launch more than one encode
  // process" from every prior authorization this session has honored.
  // Bounded by MAX_RENDER_RUNTIME_MS independently of the whole-pipeline
  // timeout above, so a hung encode is reported specifically as a render
  // timeout rather than a generic pipeline timeout.
  let encoded;
  try {
    encoded = await withTimeout(
      autoEncodeProject(db, demoRunId, { projectPath, outputDir, env, execFileImpl }),
      limits.MAX_RENDER_RUNTIME_MS, 'autoEncodeProject',
    );
  } catch (err) {
    if (err?.name === 'RunDurationExceededError') {
      upsertDemoRun(db, demoRunId, { render_status: `RENDER_TIMEOUT: ${err.message}` });
      return { ok: false, status: 'RENDER_TIMEOUT', demoRunId, score, message: err.message };
    }
    throw err;
  }
  if (!encoded.ok) {
    return { ok: false, status: 'ENCODE_FAILED', demoRunId, score, stage: encoded.stage, detail: encoded };
  }

  // Stage 4: master -> publication transcode (never touches/uploads the
  // master). encoded.outputFile is Windows-style (the real path YMM4/
  // powershell.exe wrote to) — translated to the WSL POSIX path for every
  // Linux-side tool below (ffmpeg/ffprobe/Node fs), while the Windows-style
  // form is still what gets recorded to the DB for human/Windows reference.
  const publicationPathWin = encoded.outputFile.replace(/\.mp4$/i, '_pub.mp4');
  const masterPosix = toWslPath(encoded.outputFile);
  const publicationPosix = toWslPath(publicationPathWin);
  const transcoded = await transcodePublicationCopy(masterPosix, publicationPosix, { execFileImpl });
  if (!transcoded.ok) {
    // Deliberately does NOT touch render_status here — it already records
    // the real AUTO_ENCODE_PASS outcome from the stage above, and a
    // downstream transcode failure must not overwrite/lose that record.
    return { ok: false, status: 'TRANSCODE_FAILED', demoRunId, score, detail: transcoded };
  }
  const verified = await verifyPublicationCopy(masterPosix, publicationPosix, { execFileImpl });
  upsertDemoRun(db, demoRunId, {
    master_path: encoded.outputFile, master_sha256: transcoded.masterSha256, master_size: transcoded.masterSize,
    publication_path: publicationPathWin, publication_sha256: transcoded.publicationSha256,
    publication_size: transcoded.publicationSize, transcode_ratio: transcoded.transcodeRatio,
    publication_duration: verified.publicationDuration ?? null,
  });
  if (!verified.ok) {
    return { ok: false, status: 'TRANSCODE_VERIFY_FAILED', demoRunId, score, detail: verified };
  }

  // Stage 5: pre-upload quality gate against the publication copy.
  const row = getDemoRun(db, demoRunId);
  const quality = await checkVideoQuality(publicationPosix, { scriptPath: row.script_path, execFileImpl });
  upsertDemoRun(db, demoRunId, {
    quality_check_status: quality.ok ? `PASS (blackFraction=${quality.blackFraction?.toFixed(3)})` : `FAIL: ${quality.issues.join('; ')}`,
  });
  if (!quality.ok) {
    return { ok: false, status: 'QUALITY_CHECK_FAILED', demoRunId, score, detail: quality };
  }

  // Real ffmpeg frame grab for the review-queue thumbnail (mandate section
  // 15). Best-effort: a thumbnail failure is metadata-only and must not
  // block a video that otherwise passed every real gate.
  const thumbPath = statePath('videos', demoRunId, 'thumbnail.jpg');
  const thumb = await generateThumbnail(publicationPosix, thumbPath, { execFileImpl });
  if (thumb.ok) upsertDemoRun(db, demoRunId, { thumbnail_path: thumb.outPath });

  // Stage 6: automatic PRIVATE upload only (mandate section 10) — never
  // unlisted/public. Human review (review_status) remains PENDING.
  const uploaded = await uploadPrivateVideo(db, demoRunId, { env, fetchImpl, readFileImpl, ...(youtubeImpl ? { youtubeImpl } : {}) });
  if (!uploaded.ok) {
    return { ok: false, status: 'UPLOAD_FAILED', demoRunId, score, detail: uploaded };
  }

  // Review notification (mandate section 15) — built from the final,
  // fully-populated demo_runs row, never from raw evidence.
  const finalRow = getDemoRun(db, demoRunId);
  const notification = writeReviewNotification(finalRow);

  return {
    ok: true, status: 'PRIVATE_VIDEO_READY_FOR_REVIEW', demoRunId, score,
    youtubeVideoId: uploaded.externalId, youtubeUrl: uploaded.externalUrl,
    reviewStatus: 'PENDING', notification,
  };
}
