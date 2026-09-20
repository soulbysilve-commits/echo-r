// Clean idle/bootstrap template for YMM4 unattended startup (mandate
// sections 2-9 of the "CLEAN IDLE TEMPLATE" pass, 2026-09-16). Solves a real
// problem confirmed live: the existing `marketing_idle.ymmp` (see
// lib/ymm4Startup.mjs's ensureMarketingIdleProjectFile) was bootstrapped by
// saving whatever project was loaded at the time — which, for the one real
// instance running today (PID 31496), turned out to be the demo/canary
// project with 16 real VoiceItems already on its timeline, not a blank
// project. That file is never deleted or rewritten by anything here (kept
// as historical evidence); this module instead adds a SEPARATE, positively-
// verified-empty template (`marketing_idle_blank.ymmp`) and the machinery to
// detect whether a configured idle template is actually clean before
// anything is allowed to treat it as safe to seed autonomous runs from.
import { readFileSync, existsSync } from 'node:fs';
import { isForbiddenProjectPath, MARKETING_PROJECT_ROOT, ymm4DemoAllowed } from './videoPipeline.mjs';
import { toWslPath } from './winPath.mjs';
import { reflectInvoke, saveProject, getProjectIdentity, getItems } from './ymm4Bridge.mjs';
import { getProcessCommandLine, commandLineContainsPath } from './ymm4Process.mjs';
import { getYmm4ProcessState } from './ymm4Health.mjs';
import { psFetch } from './psHttpRelay.mjs';

export const DEFAULT_MARKETING_IDLE_TEMPLATE = `C:\\Users\\Silver\\${MARKETING_PROJECT_ROOT}\\marketing_idle_blank.ymmp`;

export function isUnderMarketingRoot(projectPath) {
  const normalized = String(projectPath ?? '').replace(/\\/g, '/');
  return normalized.includes(`/${MARKETING_PROJECT_ROOT}/`) || normalized.startsWith(`${MARKETING_PROJECT_ROOT}/`);
}

/**
 * Reads a .ymmp file directly off disk (never via the live bridge — this is
 * the cheap, non-invasive check meant to run repeatedly, e.g. on every
 * status call, without touching any running YMM4 instance) and counts real
 * timeline items. Confirmed real file shape (2026-09-16, read from the live
 * marketing_idle.ymmp): UTF-8-with-BOM JSON, `{ Timelines: [{ Items: [...] }
 * ...] }` — every item type (VoiceItem, TextItem, media, ...) lives in the
 * same per-timeline `Items` array, so summing its length across all
 * timelines is a complete "is anything on this timeline" check, not just a
 * VoiceItem-specific one.
 */
export function countProjectItems(projectPath, { readFileImpl = readFileSync, existsImpl = existsSync } = {}) {
  const wslPath = toWslPath(projectPath);
  if (!existsImpl(wslPath)) return { ok: false, error: 'project file does not exist' };
  let raw;
  try {
    raw = readFileImpl(wslPath, 'utf8');
  } catch (err) {
    return { ok: false, error: `could not read project file: ${String(err?.message ?? err)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    return { ok: false, error: `project file is not valid JSON: ${String(err?.message ?? err)}` };
  }
  const timelines = Array.isArray(parsed?.Timelines) ? parsed.Timelines : [];
  const count = timelines.reduce((sum, t) => sum + (Array.isArray(t?.Items) ? t.Items.length : 0), 0);
  // Defense-in-depth content scan (mandate section 7/9), independent of the
  // path-based isForbiddenProjectPath check above — catches the case of a
  // clean-looking path whose actual saved content somehow references a
  // forbidden project (e.g. copy-paste of real data). A genuinely
  // from-scratch blank project (see docs/marketing/YMM4_STARTUP_AUDIT.md's
  // "Clean idle template" section) never contains this string by
  // construction, so this is expected to always pass for a real blank file.
  const noemoraReference = /noemora/i.test(raw);
  return { ok: true, count, timelineCount: timelines.length, noemoraReference };
}

/**
 * The idle-cleanliness safety gate (mandate section 7): a configured idle
 * template is CLEAN only when every one of these independently holds —
 * marketing-owned path, not a forbidden (Noemora) reference, the file
 * actually exists, and it verifiably contains zero timeline items. Any
 * failure (missing file, unreadable/unparseable content, ambiguous path)
 * fails closed to `clean: false`, never to a guess.
 */
export function checkIdleTemplateClean(templatePath, opts = {}) {
  if (!templatePath) return { clean: false, reason: 'no idle template configured' };
  if (isForbiddenProjectPath(templatePath)) {
    return { clean: false, reason: 'forbidden (Noemora) path — never eligible as an idle template' };
  }
  if (!isUnderMarketingRoot(templatePath)) {
    return { clean: false, reason: `not under ${MARKETING_PROJECT_ROOT} — refusing to treat an out-of-scope path as a marketing idle template` };
  }
  const existsImpl = opts.existsImpl ?? existsSync;
  if (!existsImpl(toWslPath(templatePath))) {
    return { clean: false, reason: 'idle template file does not exist' };
  }
  const counted = countProjectItems(templatePath, opts);
  if (!counted.ok) {
    return { clean: false, reason: counted.error };
  }
  if (counted.noemoraReference) {
    return { clean: false, reason: 'idle template file content references "Noemora" — refusing despite a clean-looking path' };
  }
  if (counted.count !== 0) {
    return { clean: false, reason: `idle template contains ${counted.count} real item(s)`, itemCount: counted.count };
  }
  return { clean: true, itemCount: 0, timelineCount: counted.timelineCount };
}

/**
 * Which idle project path a startup attempt should actually use: the clean
 * blank template when (and only when) it's independently verified clean,
 * otherwise the existing (possibly contaminated) `marketing_idle.ymmp` —
 * never a hard failure just because the blank template doesn't exist yet.
 * The one, shared decision both JS-side startup paths (lib/ymm4Startup.mjs's
 * callers, via cli.mjs) route through, so "prefer the clean template" is
 * never re-derived ad hoc at each call site.
 */
export function resolvePreferredIdleProjectPath({
  fallbackIdleProjectPath, idleTemplatePath = DEFAULT_MARKETING_IDLE_TEMPLATE, ...opts
} = {}) {
  const clean = checkIdleTemplateClean(idleTemplatePath, opts);
  if (clean.clean) {
    return { path: idleTemplatePath, usedTemplate: true, clean };
  }
  return { path: fallbackIdleProjectPath, usedTemplate: false, clean };
}

/**
 * One-time, explicitly ops-triggered bootstrap (never called from any
 * automatic/unattended path — see cli.mjs's `ymm4 idle-template create`,
 * same "explicit human/ops-triggered command" split as `ymm4 ensure`) that
 * creates a genuinely empty project and saves it as a NEW file, using the
 * live application's own real `CreateProject()`/`SaveProject()` methods
 * (confirmed real signatures via /api/reflect/inspect against MainViewModel,
 * 2026-09-16 — `CreateProject(): Void`, `OpenProject(String file): Void`) —
 * never by hand-constructing a .ymmp file (this codebase's established rule,
 * see ymm4Startup.mjs's ensureMarketingIdleProjectFile).
 *
 * This necessarily uses the ONE live GUI instance (starting a second one is
 * against this whole pipeline's own hard rule) — so it always restores
 * whatever was loaded before (`restoreProjectPath`) once the blank file is
 * safely persisted, and attempts that same restore on every failure branch
 * too, so a failed attempt never leaves the live session parked on a
 * throwaway blank project. It never touches `restoreProjectPath`'s file on
 * disk (only ever reads it back via OpenProject) and never writes anything
 * at all if `blankProjectPath` already exists — this function only ever
 * creates the file once.
 */
export async function createBlankIdleTemplate(blankProjectPath, {
  env = process.env, fetchImpl = psFetch, existsImpl = existsSync,
  restoreProjectPath, getProjectIdentityImpl = getProjectIdentity,
} = {}) {
  if (isForbiddenProjectPath(blankProjectPath)) {
    return { ok: false, error: 'refusing to create a forbidden (Noemora) idle template path' };
  }
  if (!isUnderMarketingRoot(blankProjectPath)) {
    return { ok: false, error: `refusing: ${blankProjectPath} is not under ${MARKETING_PROJECT_ROOT}` };
  }
  if (existsImpl(toWslPath(blankProjectPath))) {
    return { ok: false, error: 'blank idle template already exists — refusing to overwrite it; this function only ever creates it once' };
  }

  const before = await getProjectIdentityImpl({ env, fetchImpl });
  if (!before.ok) {
    return { ok: false, error: `could not verify current project identity before attempting: ${before.message ?? before.errorClass}`, stage: 'pre-check' };
  }

  const created = await reflectInvoke('Main', 'CreateProject', [], { env, fetchImpl });
  if (!created.ok) {
    return { ok: false, error: `CreateProject failed: ${created.message ?? created.errorClass}`, stage: 'create' };
  }

  const afterCreate = await getProjectIdentityImpl({ env, fetchImpl });
  if (!afterCreate.ok || afterCreate.isEmpty !== true) {
    const restore = restoreProjectPath ? await reflectInvoke('Main', 'OpenProject', [restoreProjectPath], { env, fetchImpl }) : null;
    return {
      ok: false, stage: 'verify-empty',
      error: 'CreateProject did not produce a verified-empty project — refusing to save it as the idle template',
      restoreAttempted: !!restoreProjectPath, restoreOk: restore ? restore.ok : null,
    };
  }

  const saved = await saveProject(blankProjectPath, { env, fetchImpl });
  if (!saved.ok) {
    const restore = restoreProjectPath ? await reflectInvoke('Main', 'OpenProject', [restoreProjectPath], { env, fetchImpl }) : null;
    return {
      ok: false, stage: 'save',
      error: `SaveProject failed: ${saved.message ?? saved.errorClass}`,
      restoreAttempted: !!restoreProjectPath, restoreOk: restore ? restore.ok : null,
    };
  }

  let restoreOk = null;
  if (restoreProjectPath) {
    const restore = await reflectInvoke('Main', 'OpenProject', [restoreProjectPath], { env, fetchImpl });
    restoreOk = restore.ok;
    if (!restore.ok) {
      return {
        ok: false, stage: 'restore', blankCreated: true, blankProjectPath,
        error: `blank template saved to ${blankProjectPath}, but restoring ${restoreProjectPath} into the live session failed: ${restore.message ?? restore.errorClass} — a human must reopen it manually`,
      };
    }
    const afterRestore = await getProjectIdentityImpl({ env, fetchImpl });
    const restoredToRightPath = afterRestore.ok
      && String(afterRestore.projectPath ?? '').replace(/\\/g, '/').toLowerCase() === String(restoreProjectPath).replace(/\\/g, '/').toLowerCase();
    if (!restoredToRightPath) {
      return {
        ok: false, stage: 'restore-verify', blankCreated: true, blankProjectPath,
        error: `blank template saved to ${blankProjectPath}; OpenProject(${restoreProjectPath}) was called but the live session does not verifiably report it loaded — a human must check`,
      };
    }
  }

  return { ok: true, blankProjectPath, restoredOk: restoreOk };
}

// The two ENRICHED health-state labels computeAutonomousRenderReadiness()
// keys its branches on (distinct from the raw TRANSPORT status —
// HEALTH.HEALTHY/READY_NO_PROJECT/etc, see lib/ymm4Health.mjs — which never
// carries this extra verification by itself; see "status terminology" in
// docs/marketing/YMM4_STARTUP_AUDIT.md for why the two are kept separate,
// never overwriting one with the other).
//
// HEALTHY_PROJECT_LOADED: transport HEALTHY, i.e. a normal marketing
// project is actually loaded — the ordinary case.
export const HEALTHY_PROJECT_LOADED_STATE = 'HEALTHY_PROJECT_LOADED';
// HEALTHY_EMPTY_MARKETING_SESSION: transport READY_NO_PROJECT (bridge/app
// responsive, nothing loaded — by itself UNVERIFIED beyond that) PLUS every
// condition in checkEmptyMarketingSessionReady() below independently
// holding. Never set merely because IsEmptyProject=true; always computed,
// never inferred.
export const HEALTHY_EMPTY_MARKETING_SESSION = 'HEALTHY_EMPTY_MARKETING_SESSION';

/**
 * The one place transport status + (for READY_NO_PROJECT) an empty-session
 * verification result get combined into the single enriched health-state
 * label everything else (computeAutonomousRenderReadiness, `ymm4 status`'s
 * YMM4_HEALTH_STATE, and the durable record read back by the top-level
 * `status` command) keys off — so that combination is computed exactly
 * once, never re-derived ad hoc at each call site.
 */
export function deriveHealthState(healthStatus, emptySessionReady) {
  if (healthStatus === 'HEALTHY') return HEALTHY_PROJECT_LOADED_STATE;
  if (healthStatus === 'READY_NO_PROJECT' && emptySessionReady === true) return HEALTHY_EMPTY_MARKETING_SESSION;
  return healthStatus;
}

/**
 * The one function that may report HEALTHY_EMPTY_MARKETING_SESSION-eligible
 * (mandate: "the special empty-session exception is allowed ONLY because"
 * every one of these independently holds — never generalized to an
 * arbitrary unknown-path project). Fails closed on any missing/ambiguous
 * signal; never guesses. `health` must be a fresh `checkYmm4Health()` result
 * already showing `READY_NO_PROJECT` — this function does not itself
 * re-derive process/bridge/dialog state, only adds the extra verification
 * that state alone doesn't cover:
 *   - process ownership (durable record, cross-checked against the live pid
 *     already in `health`, same pattern every other caller uses)
 *   - the REAL OS command line (never the durable "what we think we
 *     launched with" record) contains the exact configured clean template
 *     path, and does not itself reference a forbidden (Noemora) path
 *   - the live bridge's own item count (via getItems(), not merely
 *     IsEmptyProject) is genuinely zero
 *   - the configured idle template is independently re-verified clean RIGHT
 *     NOW (never trusted from an earlier check — it could have been
 *     modified since)
 *   - the demo kill switch is on
 */
export async function checkEmptyMarketingSessionReady({
  db, health, idleTemplatePath = DEFAULT_MARKETING_IDLE_TEMPLATE,
  env = process.env, fetchImpl = psFetch, execFileImpl,
  existsImpl, readFileImpl,
  getProcessCommandLineImpl = getProcessCommandLine,
  getItemsImpl = getItems,
  getYmm4ProcessStateImpl = getYmm4ProcessState,
} = {}) {
  const reasons = [];
  if (health?.status !== 'READY_NO_PROJECT') {
    return { ready: false, reasons: [`health status is ${health?.status}, not READY_NO_PROJECT`] };
  }

  const pid = health.processes?.[0]?.pid ?? null;
  if (pid == null) reasons.push('no live process pid available');

  const state = getYmm4ProcessStateImpl(db);
  const owner = (state?.owner === 'MARKETING' && pid != null && String(state?.pid) === String(pid)) ? 'MARKETING' : (state?.owner ?? null);
  if (owner !== 'MARKETING') reasons.push(`process owner is ${owner ?? 'unknown'}, not MARKETING`);

  const templateClean = checkIdleTemplateClean(idleTemplatePath, { existsImpl, readFileImpl });
  if (!templateClean.clean) reasons.push(`configured idle template is not clean: ${templateClean.reason}`);

  let commandLine = null;
  let commandLineVerified = false;
  if (pid != null) {
    const cmdResult = await getProcessCommandLineImpl(pid, { execFileImpl });
    if (!cmdResult.ok) {
      reasons.push(`could not read the real process command line: ${cmdResult.error}`);
    } else {
      commandLine = cmdResult.commandLine;
      if (isForbiddenProjectPath(commandLine ?? '')) {
        reasons.push('process command line references a forbidden (Noemora) path');
      }
      commandLineVerified = commandLineContainsPath(commandLine, idleTemplatePath);
      if (!commandLineVerified) reasons.push('real process command line does not verifiably contain the configured clean idle template path');
    }
  }

  const itemsResult = await getItemsImpl({ env, fetchImpl });
  let liveItemCount = null;
  if (!itemsResult.ok) {
    reasons.push('could not verify the live item count via the bridge');
  } else {
    liveItemCount = itemsResult.count;
    if (liveItemCount !== 0) reasons.push(`live item count is ${liveItemCount}, not 0`);
  }

  const demoAllowed = ymm4DemoAllowed(env);
  if (!demoAllowed) reasons.push('MARKETING_YMM4_DEMO_ALLOWED is not true');

  return {
    ready: reasons.length === 0, reasons,
    pid, owner, templateClean, commandLine, commandLineVerified, liveItemCount, demoAllowed,
  };
}

/**
 * Full autonomous-render readiness (mandate section 8) — THE canonical
 * computation; every caller (the live `ymm4 status`/`ymm4 ensure` commands,
 * which compute `healthState` fresh via deriveHealthState() above, and the
 * top-level `status` command, which reads the same already-computed
 * `health_state` back from durable storage — see
 * lib/ymm4Health.mjs's recordYmm4ProcessState/getYmm4ProcessState — never a
 * separate, re-derived copy of this logic) must route through this one
 * function, keyed on the single enriched `healthState` label
 * (deriveHealthState()'s output), never on the raw transport status alone.
 * Two mutually-exclusive ways to be render-ready:
 *   A. HEALTHY_PROJECT_LOADED — the authoritative live ProjectFilePath is
 *      known and verified marketing-owned/non-forbidden.
 *   B. HEALTHY_EMPTY_MARKETING_SESSION — already the fully-verified result
 *      of checkEmptyMarketingSessionReady() (see deriveHealthState()) —
 *      nothing further to re-check about the empty session itself here.
 * Either way, the demo kill switch, a verified-clean idle/bootstrap
 * template, and an available render lock (never acquired here — pure read)
 * are always separately required.
 */
export function computeAutonomousRenderReadiness({
  healthState, liveProjectPath, demoAllowed, idleTemplateClean, renderLockAvailable,
}) {
  const reasons = [];
  const projectLoadedHealthy = healthState === HEALTHY_PROJECT_LOADED_STATE || healthState === 'HEALTHY';
  const emptySessionHealthy = healthState === HEALTHY_EMPTY_MARKETING_SESSION;

  if (!projectLoadedHealthy && !emptySessionHealthy) {
    reasons.push(`health state is ${healthState}, neither a loaded-project HEALTHY state nor a verified HEALTHY_EMPTY_MARKETING_SESSION`);
  }
  if (projectLoadedHealthy) {
    if (!liveProjectPath) reasons.push('authoritative live ProjectFilePath is not known');
    if (liveProjectPath && isForbiddenProjectPath(liveProjectPath)) reasons.push('live project is a forbidden (Noemora) reference');
    if (liveProjectPath && !isUnderMarketingRoot(liveProjectPath)) reasons.push(`live project is not under ${MARKETING_PROJECT_ROOT}`);
  }
  if (!demoAllowed) reasons.push('MARKETING_YMM4_DEMO_ALLOWED is not true');
  if (!idleTemplateClean) reasons.push('configured idle/bootstrap template is not verified clean');
  if (!renderLockAvailable) reasons.push('render lock is currently held');
  return { ready: reasons.length === 0, reasons };
}
