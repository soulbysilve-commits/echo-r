#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { runOnce, status, DB_PATH, FACTS_PATH } from './operator.mjs';
import { runWeeklyLongFormOnce } from './weeklyOperator.mjs';
import { loadFacts, validateFacts, factById } from './lib/facts.mjs';
import { checkContent } from './lib/policy.mjs';
import { recordIntent, contentHash } from './lib/ledger.mjs';
import { publishToChannel } from './lib/multiChannelPublish.mjs';
import {
  draftBlueskyPost, draftMastodonPost, draftDevToArticle, draftQiitaArticle,
  draftHashnodePost, draftLinkedInPost, draftRedditPost, draftHackerNewsPost, draftNoteArticle,
} from './lib/crossChannelDraft.mjs';
import { buildProductHuntPackage } from './lib/humanApprovalPackage.mjs';
import {
  buildDevToFirstArticleCandidate, validateDevToFirstArticleCandidate, writeDevToFirstArticleCandidate,
  recordDevToFirstArticlePending, getDevToFirstArticleApprovalState,
  approveDevToFirstArticle, publishApprovedDevToFirstArticle,
} from './lib/devtoFirstArticle.mjs';
import {
  buildQiitaFirstArticleCandidate, validateQiitaFirstArticleCandidate, writeQiitaFirstArticleCandidate,
  recordQiitaFirstArticlePending, getQiitaFirstArticleApprovalState,
  approveQiitaFirstArticle, publishApprovedQiitaFirstArticle,
} from './lib/qiitaFirstArticle.mjs';
import { writeZennArticle } from './lib/zenn.mjs';

const CHANNEL_DRAFT_FN = {
  bluesky: draftBlueskyPost,
  mastodon: draftMastodonPost,
  devto: draftDevToArticle,
  qiita: draftQiitaArticle,
  hashnode: draftHashnodePost,
  linkedin: draftLinkedInPost,
  reddit: draftRedditPost,
  hackernews: draftHackerNewsPost,
  note: draftNoteArticle,
};
const ZENN_CONTENT_DIR = new URL('../../content/zenn', import.meta.url).pathname;
const DEVTO_CONTENT_DIR = new URL('../../content/devto', import.meta.url).pathname;
const QIITA_CONTENT_DIR = new URL('../../content/qiita', import.meta.url).pathname;
import { rankFacts } from './lib/scoring.mjs';
import { classify, capabilityOnlyModule, connectorModule } from './connectors/registry.mjs';
import { openDb, closeDb } from './lib/db.mjs';
import { ingestEvent, EVENT_TYPES, unprocessedEvents, markEventProcessed } from './lib/events.mjs';
import { pendingPublications } from './lib/ledger.mjs';
import { writeWeeklyReport } from './lib/weekly.mjs';
import { createExperiment, attachVariantContent, evaluateExperiment, listExperiments } from './lib/experiments.mjs';
import { proposeStrategyChange, recordStrategyDecision, nextStrategyVersion, strategyHistory } from './lib/learning.mjs';
import { listMarketEntries, listCompetitorFacts } from './lib/market.mjs';
import { writeNewsArticle } from './lib/site.mjs';
import { authCheckX, authCheckYoutube, writePermissionStatus, authCheckGeneric, GENERIC_AUTH_CHECK_CHANNELS } from './lib/authCheck.mjs';
import { canaryX, canaryYoutube, canaryBluesky, canaryMastodon, canaryDevto, canaryQiita } from './lib/canary.mjs';
import { recordAuthCheck, getChannelState } from './lib/channelState.mjs';
import { channelReadiness } from './lib/channelReadiness.mjs';
import { statePath } from './lib/paths.mjs';
import {
  createVideo, latestDemoRun, getDemoRun, reviewQueue, allDemoRuns, approveVideo, rejectVideo, canPublishPublic,
  craftYoutubeCrossPost, upsertDemoRun, ymm4DemoAllowed, isRenderLockAvailable,
} from './lib/videoPipeline.mjs';
import { transcodePublicationCopy, verifyPublicationCopy } from './lib/transcode.mjs';
import { checkVideoQuality } from './lib/videoQuality.mjs';
import { runAutomaticVideoPipeline } from './lib/videoAutomation.mjs';
import * as youtube from './connectors/youtube.mjs';
import * as devto from './connectors/devto.mjs';
import * as qiita from './connectors/qiita.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { win32 as pathWin32 } from 'node:path';
import { adapters as sourceAdapterList, findAdapter } from './sourceAdapters/index.mjs';
import { scanSource, scanAllSources } from './lib/sourceIngestion.mjs';
import { allSourceHealth } from './lib/sourceHealth.mjs';
import { classifyActivationBaseline, ensureActivationBoundary } from './lib/activation.mjs';
import { checkYmm4Health, getYmm4ProcessState, recordYmm4ProcessState, HEALTH } from './lib/ymm4Health.mjs';
import { getProjectIdentity } from './lib/ymm4Bridge.mjs';
import { ensureYmm4Ready, DEFAULT_MARKETING_IDLE_PROJECT } from './lib/ymm4Startup.mjs';
import {
  DEFAULT_MARKETING_IDLE_TEMPLATE, checkIdleTemplateClean, resolvePreferredIdleProjectPath,
  createBlankIdleTemplate, computeAutonomousRenderReadiness, checkEmptyMarketingSessionReady,
  deriveHealthState,
} from './lib/ymm4IdleTemplate.mjs';
import { candidateFromEvent, computeStoryFingerprint, isDuplicateStory } from './lib/videoCandidates.mjs';

const REPORTS_DIR = new URL('../../docs/marketing/reports', import.meta.url).pathname;
const CONTENT_DIR_EN = new URL('../../content/news', import.meta.url).pathname;
const CONTENT_DIR_JA = new URL('../../content/ja/news', import.meta.url).pathname;
const CANARY_VIDEO_PATH = statePath('videos', 'canary.mp4');

const [, , command, ...args] = process.argv;

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  switch (command) {
    case 'run': {
      printJson(await runOnce());
      break;
    }
    case 'weekly-longform': {
      printJson(await runWeeklyLongFormOnce());
      break;
    }
    case 'status': {
      printJson(status());
      break;
    }
    case 'plan': {
      const facts = loadFacts(FACTS_PATH);
      const ranked = rankFacts(facts);
      printJson(ranked.map(({ fact, score }) => ({ id: fact.id, product: fact.PRODUCT, status: fact.STATUS, score, claim: fact.CLAIM })));
      break;
    }
    case 'verify': {
      const facts = loadFacts(FACTS_PATH);
      const errors = validateFacts(facts);
      if (errors.length) {
        console.error(`FACT REGISTRY INVALID (${errors.length} error(s)):`);
        for (const e of errors) console.error(' - ' + e);
        process.exitCode = 1;
      } else {
        console.log(`OK: ${facts.length} facts, all valid.`);
      }
      break;
    }

    case 'connector': {
      const [sub, name] = args;
      if (sub === 'status' && name) {
        printJson(classify(name));
      } else if (sub === 'capability' && name) {
        // Multi-channel expansion (mandate sections 8/9): the one live,
        // explicit, human-triggered check for a capability-detection-only
        // channel — same "status never makes a live call, a dedicated
        // command does" split as auth-check/canary.
        const mod = capabilityOnlyModule(name);
        if (!mod) {
          console.log(`connector capability is only implemented for capability-detection-only channels (hashnode, linkedin). ${name} is not one of those.`);
          process.exitCode = 1;
          break;
        }
        const result = await mod.detectCapability({ env: process.env });
        printJson({ CHANNEL: name.toUpperCase(), ...result });
        if (result.state !== 'READY') process.exitCode = 1;
      } else {
        console.log('Usage: node tools/marketing/cli.mjs connector <status|capability> <name>');
        process.exitCode = 1;
      }
      break;
    }

    case 'event': {
      const [eventType, factId, sourceRepo] = args;
      if (!eventType) {
        console.log(`Usage: node tools/marketing/cli.mjs event <${EVENT_TYPES.join('|')}> [factId] [sourceRepo]`);
        process.exitCode = 1;
        break;
      }
      const db = openDb(DB_PATH);
      try {
        const result = ingestEvent(db, { eventType, factId, sourceRepo, dedupeKey: `${eventType}:${factId ?? 'none'}:${sourceRepo ?? 'none'}:${new Date().toISOString().slice(0, 10)}` });
        if (!result.ok) {
          console.error(result.error);
          process.exitCode = 1;
          break;
        }
        printJson(result);
        if (!result.deduped) {
          // An event only triggers (re-)scoring — never publication by itself.
          const facts = loadFacts(FACTS_PATH);
          const ranked = rankFacts(facts);
          markEventProcessed(db, result.eventId, `scored ${ranked.length} candidate(s); top: ${ranked[0]?.fact.id ?? 'none'}`);
        }
      } finally {
        closeDb(db);
      }
      break;
    }

    case 'events': {
      const db = openDb(DB_PATH);
      try {
        printJson(unprocessedEvents(db));
      } finally {
        closeDb(db);
      }
      break;
    }

    case 'weekly': {
      const db = openDb(DB_PATH);
      try {
        printJson(writeWeeklyReport(db, REPORTS_DIR));
      } finally {
        closeDb(db);
      }
      break;
    }

    case 'learn': {
      const [dimension, groupA, groupB] = args;
      if (!dimension || !groupA || !groupB) {
        console.log('Usage: node tools/marketing/cli.mjs learn <dimension> <groupA> <groupB>');
        process.exitCode = 1;
        break;
      }
      const db = openDb(DB_PATH);
      try {
        const decision = proposeStrategyChange(db, dimension, groupA, groupB);
        if (decision.proposed) {
          const version = nextStrategyVersion(db);
          recordStrategyDecision(db, {
            version, reason: `${decision.winner} outperforms on ${dimension} (lift ${decision.evidence.lift.toFixed(2)})`,
            evidence: decision.evidence, sampleSize: decision.evidence[groupA].n + decision.evidence[groupB].n,
          });
          printJson({ ...decision, version });
        } else {
          printJson(decision);
        }
      } finally {
        closeDb(db);
      }
      break;
    }

    case 'strategy-history': {
      const db = openDb(DB_PATH);
      try {
        printJson(strategyHistory(db));
      } finally {
        closeDb(db);
      }
      break;
    }

    case 'experiment': {
      const [sub] = args;
      const db = openDb(DB_PATH);
      try {
        if (sub === 'create') {
          const [, hypothesis, variantA, variantB, metric, minimumSample] = args;
          const experimentId = randomUUID();
          printJson(createExperiment(db, { experimentId, hypothesis, variantA, variantB, metric, minimumSample: Number(minimumSample) }));
        } else if (sub === 'attach') {
          const [, experimentId, variantAContentId, variantBContentId] = args;
          attachVariantContent(db, experimentId, { variantAContentId, variantBContentId });
          console.log('attached');
        } else if (sub === 'evaluate') {
          const [, experimentId] = args;
          printJson(evaluateExperiment(db, experimentId));
        } else if (sub === 'list') {
          printJson(listExperiments(db));
        } else {
          console.log('Usage: node tools/marketing/cli.mjs experiment <create|attach|evaluate|list> ...');
          process.exitCode = 1;
        }
      } finally {
        closeDb(db);
      }
      break;
    }

    case 'market': {
      const [sub, competitor] = args;
      const db = openDb(DB_PATH);
      try {
        if (sub === 'list') printJson(listMarketEntries(db));
        else if (sub === 'competitors') printJson(listCompetitorFacts(db, competitor));
        else {
          console.log('Usage: node tools/marketing/cli.mjs market <list|competitors> [competitorName]');
          process.exitCode = 1;
        }
      } finally {
        closeDb(db);
      }
      break;
    }

    case 'auth-check': {
      const [name] = args;
      if (!name) {
        console.log(`Usage: node tools/marketing/cli.mjs auth-check <x|youtube|${GENERIC_AUTH_CHECK_CHANNELS.join('|')}>`);
        process.exitCode = 1;
        break;
      }
      if (GENERIC_AUTH_CHECK_CHANNELS.includes(name)) {
        // Multi-channel expansion: read-only auth validation only — never a
        // post/draft/publish call. MARKETING_<CHANNEL>_ENABLED is
        // deliberately NEVER consulted here (that flag governs publication
        // eligibility, not whether credentials can be tested — see
        // lib/authCheck.mjs's authCheckGeneric doc comment).
        const mod = connectorModule(name);
        const db = openDb(DB_PATH);
        try {
          const result = await authCheckGeneric(name, mod, { env: process.env });
          // Only a genuinely durable fact (AUTH_VALID / AUTH_INVALID) is
          // ever persisted — a transient API_ERROR must never overwrite a
          // previously-recorded state with a guess.
          if (result.state === 'AUTH_VALID' || result.state === 'AUTH_INVALID') {
            recordAuthCheck(db, name, { authValid: result.state === 'AUTH_VALID', accountIdentifier: result.accountName, permissionsSufficient: result.state === 'AUTH_VALID' });
          }
          const state = getChannelState(db, name);
          printJson({
            SERVICE: name,
            AUTH_CONFIGURED: connectorModule(name).isAuthConfigured(process.env),
            AUTH_VALID: result.state === 'AUTH_VALID',
            STATE: result.state,
            ACCOUNT_ID: result.accountId,
            ACCOUNT_NAME: result.accountName,
            CANARY_PASS: !!state.canary_passed,
            BLOCKER: result.state === 'AUTH_VALID' ? null : `${result.state}${result.error ? `: ${result.error}` : ''}`,
          });
          if (result.state !== 'AUTH_VALID') process.exitCode = 1;
        } finally {
          closeDb(db);
        }
        break;
      }
      if (name !== 'x' && name !== 'youtube') {
        console.log(`auth-check is implemented for x, youtube, and ${GENERIC_AUTH_CHECK_CHANNELS.join('/')} in this pass. ${name} has a real client (see connector status ${name}) but no dedicated auth-check output yet.`);
        process.exitCode = 1;
        break;
      }
      const db = openDb(DB_PATH);
      try {
        const result = name === 'x' ? await authCheckX() : await authCheckYoutube();
        recordAuthCheck(db, name, result);
        const readiness = channelReadiness(db, name, { factsPath: FACTS_PATH });
        if (name === 'x') {
          printJson({
            X_CLIENT: result.clientImplemented,
            X_CREDENTIALS_PRESENT: result.credentialsPresent,
            X_AUTH_VALID: result.authValid,
            X_ACCOUNT_ID: result.accountId,
            X_ACCOUNT_HANDLE: result.accountHandle,
            X_WRITE_PERMISSION: writePermissionStatus({ permissionsSufficient: result.permissionsSufficient, canaryPass: readiness.canaryPass }),
            X_CANARY_PASS: readiness.canaryPass,
            X_ENABLED: readiness.enabled,
            X_RECURRING_LIVE_READY: readiness.recurringLiveReady,
          });
        } else {
          printJson({
            YOUTUBE_CLIENT: result.clientImplemented,
            YOUTUBE_CREDENTIALS_PRESENT: result.credentialsPresent,
            YOUTUBE_AUTH_VALID: result.authValid,
            YOUTUBE_CHANNEL_ID: result.channelId,
            YOUTUBE_CHANNEL_TITLE: result.channelTitle,
            YOUTUBE_UPLOAD_PERMISSION: writePermissionStatus({ permissionsSufficient: result.permissionsSufficient, canaryPass: readiness.canaryPass }),
            YOUTUBE_CANARY_PASS: readiness.canaryPass,
            YOUTUBE_ENABLED: readiness.enabled,
            YOUTUBE_RECURRING_LIVE_READY: readiness.recurringLiveReady,
          });
        }
        if (!result.credentialsPresent) {
          console.error(`\nMissing credentials. Required env vars are documented in docs/marketing/CONNECTION_SETUP.md. Check presence (never values) with: scripts/marketing-auth-status.sh ${name}`);
        } else if (name === 'youtube' && result.authValid && !result.channelId) {
          console.error(`\n${result.error}`);
        }
      } finally {
        closeDb(db);
      }
      break;
    }

    case 'canary': {
      const [name] = args;
      if (name !== 'x' && name !== 'youtube' && name !== 'bluesky' && name !== 'mastodon' && name !== 'devto' && name !== 'qiita') {
        console.log('Usage: node tools/marketing/cli.mjs canary <x|youtube|bluesky|mastodon|devto|qiita>  (other channels not prioritized this pass)');
        process.exitCode = 1;
        break;
      }
      const db = openDb(DB_PATH);
      try {
        const result = name === 'x' ? await canaryX(db)
          : name === 'youtube' ? await canaryYoutube(db, { videoPath: CANARY_VIDEO_PATH })
          : name === 'bluesky' ? await canaryBluesky(db)
          : name === 'mastodon' ? await canaryMastodon(db)
          : name === 'devto' ? await canaryDevto(db)
          : await canaryQiita(db);
        printJson(result);
        if (result.ok) {
          console.error(`\nCanary ${result.alreadyPassed ? 'already passed (idempotent, not re-posted)' : 'PASSED'}. ` +
            `MARKETING_${name.toUpperCase()}_ENABLED is still false until you explicitly set it — canary passing does not enable recurring LIVE publication.`);
        }
      } finally {
        closeDb(db);
      }
      break;
    }

    case 'video': {
      const [sub, demoRunId, evidenceFile] = args;
      if (sub === 'create' && demoRunId) {
        let evidenceInput = { factIds: [], rawLogLines: [], screenshotPaths: [] };
        if (evidenceFile) {
          if (!existsSync(evidenceFile)) {
            console.error(`Evidence file not found: ${evidenceFile}`);
            process.exitCode = 1;
            break;
          }
          evidenceInput = JSON.parse(readFileSync(evidenceFile, 'utf8'));
        }
        const facts = loadFacts(FACTS_PATH);
        const db = openDb(DB_PATH);
        try {
          const result = await createVideo(db, demoRunId, { ...evidenceInput, facts });
          printJson(result);
        } finally {
          closeDb(db);
        }
      } else if (sub === 'latest') {
        const db = openDb(DB_PATH);
        try {
          printJson(latestDemoRun(db) ?? { message: 'no demo runs yet' });
        } finally {
          closeDb(db);
        }
      } else if (sub === 'transcode' && demoRunId) {
        const db = openDb(DB_PATH);
        try {
          const row = getDemoRun(db, demoRunId);
          if (!row?.master_path) {
            console.error(`No master_path recorded for ${demoRunId} — run "video create" and render first.`);
            process.exitCode = 1;
            break;
          }
          const pubPath = row.master_path.replace(/(\.mp4)$/i, '_pub$1').replace('/render/', '/publication/');
          const result = await transcodePublicationCopy(row.master_path, pubPath);
          if (!result.ok) { printJson(result); process.exitCode = 1; break; }
          const verify = await verifyPublicationCopy(row.master_path, pubPath);
          upsertDemoRun(db, demoRunId, {
            publication_path: result.publicationPath, publication_sha256: result.publicationSha256,
            publication_size: result.publicationSize, transcode_ratio: result.transcodeRatio,
          });
          printJson({ ...result, verify });
        } finally {
          closeDb(db);
        }
      } else if (sub === 'quality-check' && demoRunId) {
        const db = openDb(DB_PATH);
        try {
          const row = getDemoRun(db, demoRunId);
          if (!row?.publication_path) {
            console.error(`No publication_path recorded for ${demoRunId} — run "video transcode" first.`);
            process.exitCode = 1;
            break;
          }
          const result = await checkVideoQuality(row.publication_path, { scriptPath: row.script_path });
          upsertDemoRun(db, demoRunId, { quality_check_status: result.ok ? `PASS (blackFraction=${result.blackFraction?.toFixed(3)})` : `FAIL: ${result.issues.join('; ')}` });
          printJson(result);
          if (!result.ok) process.exitCode = 1;
        } finally {
          closeDb(db);
        }
      } else if (sub === 'storage-report') {
        const db = openDb(DB_PATH);
        try {
          const rows = allDemoRuns(db);
          const totalMaster = rows.reduce((s, r) => s + (r.master_size ?? 0), 0);
          const totalPublication = rows.reduce((s, r) => s + (r.publication_size ?? 0), 0);
          printJson({
            demoRuns: rows.length,
            totalMasterBytes: totalMaster,
            totalPublicationBytes: totalPublication,
            perRun: rows.map((r) => ({
              demoRunId: r.demo_run_id, masterSize: r.master_size, publicationSize: r.publication_size,
              transcodeRatio: r.transcode_ratio, masterPath: r.master_path, publicationPath: r.publication_path,
            })),
            note: 'Read-only report. See docs/marketing/VIDEO_RETENTION.md — no deletion is implemented.',
          });
        } finally {
          closeDb(db);
        }
      } else if (sub === 'queue') {
        const db = openDb(DB_PATH);
        try {
          printJson(reviewQueue(db).map((r) => ({
            demoRunId: r.demo_run_id, title: r.title, reviewStatus: r.review_status,
            privateUrl: r.youtube_url, privacyStatus: r.privacy_status, createdAt: r.created_at,
          })));
        } finally {
          closeDb(db);
        }
      } else if (sub === 'approve' && demoRunId) {
        const confirm = args.includes('--confirm');
        const db = openDb(DB_PATH);
        try {
          // Best-effort live re-check that the video is still private — this
          // specific read (videos.list) is known to require broader scope
          // than youtube.upload alone (see docs/marketing/CONNECTION_SETUP.md);
          // when it can't be confirmed live, we fall back to the last
          // recorded status rather than blocking approval on an API
          // limitation that has nothing to do with the video's real state.
          const row = getDemoRun(db, demoRunId);
          if (row?.youtube_video_id) {
            const liveStatus = await youtube.getVideoStatus(row.youtube_video_id);
            if (liveStatus.ok) console.error(`Live check: privacyStatus=${liveStatus.privacyStatus} (verified via videos.list)`);
            else console.error(`Live re-check unavailable (${liveStatus.errorClass ?? 'scope-limited'}) — using last recorded privacy_status=${row.privacy_status}`);
          }
          const result = approveVideo(db, demoRunId, { confirm });
          printJson(result);
        } finally {
          closeDb(db);
        }
      } else if (sub === 'reject' && demoRunId) {
        const status = args.includes('--needs-edit') ? 'NEEDS_EDIT' : 'REJECTED';
        const db = openDb(DB_PATH);
        try {
          printJson(rejectVideo(db, demoRunId, { status }));
        } finally {
          closeDb(db);
        }
      } else if (sub === 'publish' && demoRunId) {
        const confirm = args.includes('--confirm');
        const db = openDb(DB_PATH);
        try {
          const gate = canPublishPublic(db, demoRunId);
          if (!gate.allowed) {
            printJson({ ok: false, reason: gate.reason });
            process.exitCode = 1;
            break;
          }
          if (!confirm) {
            printJson({ ok: true, wouldPublish: true, message: 'Preview only. Re-run with --confirm to actually make this video public.', row: { demoRunId, youtubeUrl: gate.row.youtube_url, title: gate.row.title } });
            break;
          }
          const result = await youtube.setPrivacyStatus(gate.row.youtube_video_id, 'public', { confirmPublic: true });
          if (!result.ok) { printJson(result); process.exitCode = 1; break; }
          upsertDemoRun(db, demoRunId, { privacy_status: 'public', public_url: gate.row.youtube_url });
          const updatedRow = getDemoRun(db, demoRunId);
          const crossPost = craftYoutubeCrossPost(updatedRow, { siteUrl: 'https://echo-r.veritasforge.net/echo-agent' });
          printJson({ ok: true, published: true, publicUrl: updatedRow.public_url, xFollowUpDraft: crossPost });
        } finally {
          closeDb(db);
        }
      } else if (sub === 'auto-run') {
        // Manually-invokable entry point for the full automatic pipeline
        // (mandate: candidate selection -> YMM4 assembly -> encode ->
        // transcode -> quality check -> private upload -> stop for human
        // review). NOT wired into the systemd daily timer — the mandate's
        // scheduler-integration instructions were cut off mid-sentence, so
        // that wiring is deliberately not done until the rest is given.
        const facts = loadFacts(FACTS_PATH);
        const db = openDb(DB_PATH);
        try {
          const result = await runAutomaticVideoPipeline(db, { facts });
          printJson(result);
          if (!result.ok) process.exitCode = 1;
        } finally {
          closeDb(db);
        }
      } else {
        console.log('Usage: node tools/marketing/cli.mjs video <create|latest|transcode|quality-check|queue|approve|reject|publish|auto-run> ...');
        console.log('  create <demoRunId> [evidenceFile.json]');
        console.log('  transcode <demoRunId>          — build the publication copy from the recorded master');
        console.log('  quality-check <demoRunId>      — run pre-upload checks against the publication copy');
        console.log('  queue                          — list the review queue');
        console.log('  approve <demoRunId> [--confirm]');
        console.log('  reject <demoRunId> [--needs-edit]');
        console.log('  publish <demoRunId> [--confirm] — make the (APPROVED) private video public');
        console.log('  auto-run                       — run the full automatic pipeline once (candidate select -> ... -> private upload); NOT scheduled automatically');
        process.exitCode = 1;
      }
      break;
    }

    case 'sources': {
      const db = openDb(DB_PATH);
      try {
        printJson(allSourceHealth(db, sourceAdapterList));
      } finally {
        closeDb(db);
      }
      break;
    }

    case 'scan': {
      const dryRun = args.includes('--dry-run');
      const [nameArg] = args.filter((a) => a !== '--dry-run');
      const db = openDb(DB_PATH);
      try {
        if (!nameArg) {
          printJson(await scanAllSources(db, sourceAdapterList, { dryRun }));
        } else {
          const adapter = findAdapter(nameArg);
          if (!adapter) {
            console.log(`Usage: node tools/marketing/cli.mjs scan [echo-agent|echo-app|noemora|site] [--dry-run]`);
            process.exitCode = 1;
            break;
          }
          printJson(await scanSource(db, adapter, { dryRun }));
        }
      } finally {
        closeDb(db);
      }
      break;
    }

    // Safe public-live activation (mandate sections 1-3). Idempotent: safe
    // to run more than once — ensureActivationBoundary() never moves an
    // already-set boundary, and every classification is an upsert keyed on
    // (kind, item_id). Never publishes anything; only sets the durable
    // PUBLIC_LIVE_NOT_BEFORE boundary and classifies pre-existing backlog
    // so the normal scheduler stops treating it as newly publishable.
    case 'activate': {
      const [channelArg] = args;
      const db = openDb(DB_PATH);
      try {
        if (channelArg) {
          // Multi-channel expansion (section 1): a channel's OWN durable
          // activation boundary — same table/mechanism as the global
          // PUBLIC_LIVE_NOT_BEFORE (lib/activation.mjs's per-channel key),
          // never a parallel system, and never copied from the global
          // boundary, an old event timestamp, or an old canary timestamp —
          // ensureActivationBoundary()'s own default (`new Date()`,
          // evaluated fresh right here) is the only source. Idempotent:
          // re-running this never moves an already-set boundary.
          const { boundary, created } = ensureActivationBoundary(db, undefined, channelArg);
          printJson({ CHANNEL: channelArg, LIVE_NOT_BEFORE: boundary, ACTIVATION_JUST_CREATED: created });
          break;
        }
        const facts = (() => { try { return loadFacts(FACTS_PATH); } catch { return []; } })();
        const result = classifyActivationBaseline(db, {
          facts, unprocessedEvents, markEventProcessed, pendingPublications,
          candidateFromEvent, computeStoryFingerprint, isDuplicateStory,
        });
        printJson({
          PUBLIC_LIVE_NOT_BEFORE: result.boundary,
          ACTIVATION_JUST_CREATED: result.created,
          EVENTS_CLASSIFIED: result.events.length,
          EVENTS: result.events,
          PENDING_PUBLICATIONS_CLASSIFIED: result.pendingPublications.length,
          PENDING_PUBLICATIONS: result.pendingPublications,
        });
      } finally {
        closeDb(db);
      }
      break;
    }

    // YMM4 unattended-startup mandate section 6/12/13: explicit, human/ops-
    // triggered commands — same "status never makes a live check on its
    // own, a dedicated command does" split as auth-check/canary. `ensure`
    // is the one command that may actually launch YMM4 (bounded, safe,
    // never a second instance, never touches Noemora) — used by the
    // Windows-login startup task and available for manual testing.
    case 'ymm4': {
      const [sub] = args;
      const db = openDb(DB_PATH);
      try {
        if (sub === 'status') {
          const health = await checkYmm4Health({ env: process.env });
          const prior = getYmm4ProcessState(db);
          const pid = health.processes?.[0]?.pid ?? null;
          const owner = (prior?.owner === 'MARKETING' && String(prior?.pid) === String(pid)) ? 'MARKETING' : (pid ? 'USER' : (prior?.owner ?? null));
          const liveProject = health.currentProject ?? null;
          // Idle/bootstrap TEMPLATE cleanliness (mandate section 7) is a
          // completely separate concept from the currently LOADED project
          // above — never conflate them. This is a cheap, non-invasive,
          // file-only check (never touches the live bridge).
          const idleTemplateCheck = checkIdleTemplateClean(DEFAULT_MARKETING_IDLE_TEMPLATE);
          // Only attempted when health is genuinely READY_NO_PROJECT — never
          // spends a live command-line/item-count round trip otherwise.
          const emptySessionCheck = health.status === HEALTH.READY_NO_PROJECT
            ? await checkEmptyMarketingSessionReady({ db, health, env: process.env })
            : null;
          // The one place transport status + empty-session verification are
          // combined into the enriched label — see
          // lib/ymm4IdleTemplate.mjs's deriveHealthState(). Persisted below
          // (health.currentProject is only ever set from the live bridge's
          // own response — never from a configured/intended path — so it is
          // always safe to report as the live project, never a persisted
          // plan mistaken for reality) so the top-level `status` command can
          // read the SAME enriched state back without making its own live
          // call — never a second, re-derived copy of this logic.
          const healthState = deriveHealthState(health.status, emptySessionCheck?.ready ?? false);
          recordYmm4ProcessState(db, {
            pid, owner, startedAt: prior?.started_at ?? null, project: health.currentProject ?? null,
            bridgeStatus: health.status, healthState,
          });
          const readiness = computeAutonomousRenderReadiness({
            healthState,
            liveProjectPath: liveProject,
            demoAllowed: ymm4DemoAllowed(process.env),
            idleTemplateClean: idleTemplateCheck.clean,
            renderLockAvailable: isRenderLockAvailable(db),
          });
          // health.currentProject is only ever populated from the
          // AUTHORITATIVE signal (getProjectIdentity()'s IsEmptyProject +
          // ProjectFilePath via /api/reflect/get) — never from the broken
          // /api/project projectPath field (confirmed always empty on this
          // build even with a real project loaded; see ymm4Bridge.mjs).
          printJson({
            YMM4_HEALTH: health.status,
            // Explicit terminology split (never overwrite one with the
            // other): TRANSPORT_STATE is the raw process/bridge/project-
            // identity signal (HEALTHY/READY_NO_PROJECT/...); HEALTH_STATE
            // is the further-verified, higher-level concept that actually
            // gates autonomous-render eligibility.
            YMM4_TRANSPORT_STATE: health.status,
            YMM4_HEALTH_STATE: healthState,
            YMM4_PROCESSES: health.processes ?? [],
            // Deprecated alias, kept for existing consumers — always the
            // LIVE project only, identical to YMM4_LIVE_PROJECT, never a
            // planned/idle path that isn't actually loaded.
            YMM4_CURRENT_PROJECT: liveProject,
            YMM4_LIVE_PROJECT: liveProject,
            // Windows path (backslash-separated) even when this process runs
            // on Linux/WSL — path.basename() alone would treat the whole
            // string as one segment; path.win32.basename() splits correctly.
            YMM4_LIVE_PROJECT_NAME: liveProject ? pathWin32.basename(liveProject, '.ymmp') : null,
            YMM4_PROJECT_LOADED: liveProject !== null,
            YMM4_IS_EMPTY_PROJECT: health.status === HEALTH.READY_NO_PROJECT,
            YMM4_IDLE_PROJECT: DEFAULT_MARKETING_IDLE_PROJECT,
            YMM4_PROJECT: liveProject,
            YMM4_OWNER: owner,
            YMM4_REASON: health.reason ?? null,
            // The configured bootstrap/idle TEMPLATE (never the currently
            // loaded project — see above) and whether it is machine-verified
            // clean right now.
            YMM4_IDLE_TEMPLATE: DEFAULT_MARKETING_IDLE_TEMPLATE,
            YMM4_IDLE_TEMPLATE_CLEAN: idleTemplateCheck.clean,
            YMM4_IDLE_TEMPLATE_REASON: idleTemplateCheck.reason ?? null,
            // Only meaningful when YMM4_HEALTH_STATE could be
            // HEALTHY_EMPTY_MARKETING_SESSION — i.e. health.status is
            // READY_NO_PROJECT. Null in every other state, never a stale
            // leftover from a previous check.
            YMM4_BOOTSTRAP_TEMPLATE: emptySessionCheck ? DEFAULT_MARKETING_IDLE_TEMPLATE : null,
            YMM4_BOOTSTRAP_TEMPLATE_ARG_VERIFIED: emptySessionCheck?.commandLineVerified ?? null,
            YMM4_EMPTY_SESSION_REASONS: emptySessionCheck?.reasons ?? null,
            YMM4_READY_FOR_AUTONOMOUS_RENDER: readiness.ready,
            YMM4_READY_FOR_AUTONOMOUS_RENDER_REASONS: readiness.reasons,
          });
        } else if (sub === 'ensure') {
          // Prefer the verified-clean idle TEMPLATE over the historical
          // (possibly contaminated) marketing_idle.ymmp — mandate section 6
          // — but only ever as a preference; a missing/not-yet-clean
          // template never blocks the existing, already-safe fallback.
          const preferred = resolvePreferredIdleProjectPath({ fallbackIdleProjectPath: DEFAULT_MARKETING_IDLE_PROJECT });
          const result = await ensureYmm4Ready(db, { env: process.env, idleProjectPath: preferred.path });
          printJson({
            YMM4_READY: result.ready, YMM4_STATUS: result.status, YMM4_OWNER: result.owner ?? null,
            YMM4_PID: result.pid ?? null, YMM4_JUST_STARTED: !!result.justStarted,
            YMM4_IDLE_PROJECT_USED: preferred.path, YMM4_IDLE_TEMPLATE_USED: preferred.usedTemplate,
            DETAIL: result,
          });
          if (!result.ready) process.exitCode = 1;
        } else if (sub === 'idle-template' && args[1] === 'status') {
          const check = checkIdleTemplateClean(DEFAULT_MARKETING_IDLE_TEMPLATE);
          printJson({ YMM4_IDLE_TEMPLATE: DEFAULT_MARKETING_IDLE_TEMPLATE, YMM4_IDLE_TEMPLATE_CLEAN: check.clean, ...check });
        } else if (sub === 'idle-template' && args[1] === 'create') {
          // Explicit, human/ops-triggered ONLY (same split as `ensure`) —
          // never called from any automatic/unattended path. Uses the one
          // live GUI instance's real CreateProject()/SaveProject() methods,
          // then restores whatever was loaded before. See
          // lib/ymm4IdleTemplate.mjs's createBlankIdleTemplate doc comment.
          const identity = await getProjectIdentity();
          if (!identity.ok) {
            printJson({ ok: false, error: `could not read current live project identity: ${identity.message ?? identity.errorClass}` });
            process.exitCode = 1;
          } else {
            const result = await createBlankIdleTemplate(DEFAULT_MARKETING_IDLE_TEMPLATE, {
              env: process.env, restoreProjectPath: identity.projectPath ?? undefined,
            });
            printJson(result);
            if (!result.ok) process.exitCode = 1;
          }
        } else {
          console.log('Usage: node tools/marketing/cli.mjs ymm4 <status|ensure|idle-template status|idle-template create>');
          process.exitCode = 1;
        }
      } finally {
        closeDb(db);
      }
      break;
    }

    case 'channel-run': {
      // Multi-channel expansion (mandate: "Build clients, tests, status,
      // auth checks, canary infrastructure first... Do not activate
      // publishing" — this IS the explicit, human/ops-triggered publish
      // path, same "explicit command, never the unattended scheduler"
      // split as `canary`. Routes through lib/multiChannelPublish.mjs's
      // publishToChannel(), which enforces every existing safety gate
      // (evidence, policy, kill switch, per-channel enable, activation
      // boundary, frequency guard, stagger) plus records
      // PENDING_HUMAN_APPROVAL for any HUMAN_APPROVAL_REQUIRED channel
      // rather than ever publishing it.
      const [channelName, factId, extra] = args;
      const draftFn = CHANNEL_DRAFT_FN[channelName];
      if (!channelName || !factId || !draftFn) {
        console.log(`Usage: node tools/marketing/cli.mjs channel-run <${Object.keys(CHANNEL_DRAFT_FN).join('|')}> <factId> [subreddit — reddit only]`);
        process.exitCode = 1;
        break;
      }
      const facts = loadFacts(FACTS_PATH);
      const fact = factById(facts, factId);
      if (!fact) {
        console.log(`Unknown fact id: ${factId}`);
        process.exitCode = 1;
        break;
      }
      const db = openDb(DB_PATH);
      try {
        const result = await publishToChannel(db, channelName, fact, draftFn, {
          env: process.env, draftArgs: channelName === 'reddit' ? [extra] : [],
        });
        printJson(result);
        if (result.status === 'BLOCKED' || result.status === 'PUBLISH_FAILED' || result.status === 'NO_DRAFT') process.exitCode = 1;
      } finally {
        closeDb(db);
      }
      break;
    }

    case 'prepare': {
      const [channelName, factId] = args;

      if (channelName === 'devto-first') {
        // First real long-form DEV.to technical article (multi-fact,
        // hand-authored) — a local review candidate + private evidence
        // manifest only. Never calls the DEV.to API, never touches the
        // canary draft. Recorded PENDING_HUMAN_APPROVAL, same ledger
        // mechanism as every other never-auto-submitted package below.
        const facts = loadFacts(FACTS_PATH);
        const built = buildDevToFirstArticleCandidate(facts);
        if (!built.ok) {
          printJson({ ok: false, reason: built.reason, missing: built.missing });
          process.exitCode = 1;
          break;
        }
        const check = validateDevToFirstArticleCandidate(built.candidate, facts);
        if (!check.ok) {
          printJson({ ok: false, violations: check.violations });
          process.exitCode = 1;
          break;
        }
        const written = writeDevToFirstArticleCandidate(built.candidate, built.reviewManifest, {
          contentDir: DEVTO_CONTENT_DIR, reviewDir: statePath('review', 'devto-first-article'),
        });
        const db = openDb(DB_PATH);
        try {
          const pending = recordDevToFirstArticlePending(db, built.candidate);
          const approval = getDevToFirstArticleApprovalState(db, built.candidate);
          printJson({
            status: pending.status, publicationId: pending.publicationId,
            title: built.candidate.title, articlePath: written.articlePath, manifestPath: written.manifestPath,
            claimsTotal: built.candidate.factIds.length, devtoFirstPublicApproved: approval.approved,
          });
        } finally {
          closeDb(db);
        }
        break;
      }

      if (channelName === 'qiita-first') {
        // First real long-form Qiita technical article (multi-fact,
        // hand-authored, Japanese) — a local review candidate + private
        // evidence manifest only. Never calls the Qiita API, never touches
        // the private canary item. Recorded PENDING_HUMAN_APPROVAL; no
        // approve/publish path exists for this channel yet (deliberately
        // out of scope — preparation only).
        const facts = loadFacts(FACTS_PATH);
        const built = buildQiitaFirstArticleCandidate(facts);
        if (!built.ok) {
          printJson({ ok: false, reason: built.reason, missing: built.missing });
          process.exitCode = 1;
          break;
        }
        const check = validateQiitaFirstArticleCandidate(built.candidate, facts);
        if (!check.ok) {
          printJson({ ok: false, violations: check.violations });
          process.exitCode = 1;
          break;
        }
        const written = writeQiitaFirstArticleCandidate(built.candidate, built.reviewManifest, {
          contentDir: QIITA_CONTENT_DIR, reviewDir: statePath('review', 'qiita-first-article'),
        });
        const db = openDb(DB_PATH);
        try {
          const pending = recordQiitaFirstArticlePending(db, built.candidate);
          const approval = getQiitaFirstArticleApprovalState(db, built.candidate);
          printJson({
            status: pending.status, publicationId: pending.publicationId,
            title: built.candidate.title, articlePath: written.articlePath, manifestPath: written.manifestPath,
            claimsTotal: built.candidate.factIds.length, qiitaFirstPublicApproved: approval.approved,
          });
        } finally {
          closeDb(db);
        }
        break;
      }

      // Product Hunt specifically (mandate section 11): a richer, structured
      // package (not a plain text draft) — recorded PENDING_HUMAN_APPROVAL
      // directly, same ledger mechanism, never submitted anywhere.
      if (channelName !== 'producthunt' || !factId) {
        console.log('Usage: node tools/marketing/cli.mjs prepare producthunt <factId>  |  prepare devto-first  |  prepare qiita-first  (other channels: use `channel-run`)');
        process.exitCode = 1;
        break;
      }
      const facts = loadFacts(FACTS_PATH);
      const fact = factById(facts, factId);
      if (!fact) {
        console.log(`Unknown fact id: ${factId}`);
        process.exitCode = 1;
        break;
      }
      const pkg = buildProductHuntPackage(fact);
      const check = checkContent({ text: pkg.description, factIds: pkg.factIds, claimStrength: pkg.claimStrength }, facts);
      if (!check.ok) {
        printJson({ ok: false, violations: check.violations });
        process.exitCode = 1;
        break;
      }
      const db = openDb(DB_PATH);
      try {
        const row = recordIntent(db, {
          channel: 'producthunt', text: JSON.stringify(pkg), contentType: pkg.actionType,
          sourceEvidence: pkg.factIds.join(','), riskClass: 'HUMAN_APPROVAL_REQUIRED', approvalState: 'PENDING_HUMAN_APPROVAL',
        });
        printJson({ status: 'PENDING_APPROVAL', publicationId: row.publication_id, package: pkg });
      } finally {
        closeDb(db);
      }
      break;
    }

    case 'approve': {
      // Durable human-approval boundary. Supported targets: devto-first,
      // qiita-first (mandate: "Do not globally approve future
      // DEV.to/Qiita articles") — each narrowly transitions ONE specific,
      // already-validated article's ledger row from PENDING_HUMAN_APPROVAL
      // to HUMAN_APPROVED and nothing else.
      const [target] = args;
      if (target !== 'devto-first' && target !== 'qiita-first') {
        console.log('Usage: node tools/marketing/cli.mjs approve <devto-first|qiita-first>');
        process.exitCode = 1;
        break;
      }
      const facts = loadFacts(FACTS_PATH);
      const built = target === 'devto-first' ? buildDevToFirstArticleCandidate(facts) : buildQiitaFirstArticleCandidate(facts);
      if (!built.ok) {
        printJson({ ok: false, reason: built.reason, missing: built.missing });
        process.exitCode = 1;
        break;
      }
      const check = target === 'devto-first'
        ? validateDevToFirstArticleCandidate(built.candidate, facts)
        : validateQiitaFirstArticleCandidate(built.candidate, facts);
      if (!check.ok) {
        printJson({ ok: false, violations: check.violations });
        process.exitCode = 1;
        break;
      }
      const db = openDb(DB_PATH);
      try {
        const result = target === 'devto-first'
          ? approveDevToFirstArticle(db, built.candidate)
          : approveQiitaFirstArticle(db, built.candidate);
        const approval = target === 'devto-first'
          ? getDevToFirstArticleApprovalState(db, built.candidate)
          : getQiitaFirstArticleApprovalState(db, built.candidate);
        const approvedKey = target === 'devto-first' ? 'devtoFirstPublicApproved' : 'qiitaFirstPublicApproved';
        printJson({ ...result, [approvedKey]: approval.approved, contentHash: contentHash(built.candidate.body_markdown) });
        if (!result.ok) process.exitCode = 1;
      } finally {
        closeDb(db);
      }
      break;
    }

    case 'publish-approved': {
      // The narrowest possible one-time, explicitly-human-approved real
      // publish command — see lib/devtoFirstArticle.mjs's
      // publishApprovedDevToFirstArticle() / lib/qiitaFirstArticle.mjs's
      // publishApprovedQiitaFirstArticle() for the full safety contract
      // (requires HUMAN_APPROVED + durable AUTH_VALID + CANARY_PASS,
      // re-confirms identity live, checks for a pre-existing remote
      // article before creating, fails closed unless the response
      // explicitly confirms public visibility, idempotent). Deliberately
      // bypasses MARKETING_<CHANNEL>_ENABLED/PUBLIC_MARKETING_MODE — this
      // command is never reachable from the unattended operator loop, only
      // from this explicit invocation, same architecture as every `canary`
      // command.
      const [target] = args;
      if (target !== 'devto-first' && target !== 'qiita-first') {
        console.log('Usage: node tools/marketing/cli.mjs publish-approved <devto-first|qiita-first>');
        process.exitCode = 1;
        break;
      }
      const facts = loadFacts(FACTS_PATH);
      const built = target === 'devto-first' ? buildDevToFirstArticleCandidate(facts) : buildQiitaFirstArticleCandidate(facts);
      if (!built.ok) {
        printJson({ ok: false, reason: built.reason, missing: built.missing });
        process.exitCode = 1;
        break;
      }
      const db = openDb(DB_PATH);
      try {
        const result = target === 'devto-first'
          ? await publishApprovedDevToFirstArticle(db, built.candidate, { devtoClient: devto })
          : await publishApprovedQiitaFirstArticle(db, built.candidate, { qiitaClient: qiita });
        printJson({ ...result, contentHash: contentHash(built.candidate.body_markdown) });
        if (!result.ok) process.exitCode = 1;
      } finally {
        closeDb(db);
      }
      break;
    }

    case 'zenn': {
      const [sub, factId] = args;
      if (sub === 'generate' && factId) {
        const facts = loadFacts(FACTS_PATH);
        const fact = factById(facts, factId);
        if (!fact) {
          console.log(`Unknown fact id: ${factId}`);
          process.exitCode = 1;
          break;
        }
        const result = writeZennArticle(fact, facts, { contentDir: ZENN_CONTENT_DIR });
        printJson(result);
        if (!result.written && result.reason !== 'already generated') process.exitCode = 1;
      } else {
        console.log('Usage: node tools/marketing/cli.mjs zenn generate <factId>');
        process.exitCode = 1;
      }
      break;
    }

    case 'site': {
      const [sub] = args;
      if (sub === 'generate-news') {
        const facts = loadFacts(FACTS_PATH);
        const ranked = rankFacts(facts);
        const results = [];
        for (const { fact } of ranked) {
          results.push({ fact: fact.id, en: writeNewsArticle(fact, facts, { locale: 'en', contentDir: CONTENT_DIR_EN }) });
          results.push({ fact: fact.id, ja: writeNewsArticle(fact, facts, { locale: 'ja', contentDir: CONTENT_DIR_JA }) });
        }
        printJson(results.filter((r) => r.en?.written || r.ja?.written));
      } else {
        console.log('Usage: node tools/marketing/cli.mjs site generate-news');
        process.exitCode = 1;
      }
      break;
    }

    default:
      console.log('Usage: node tools/marketing/cli.mjs <run|status|plan|verify|connector|auth-check|canary|event|events|weekly|weekly-longform|learn|strategy-history|experiment|market|site|video|sources|scan|activate|ymm4>');
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
