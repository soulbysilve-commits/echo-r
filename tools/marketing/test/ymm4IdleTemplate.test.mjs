import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MARKETING_IDLE_TEMPLATE, countProjectItems, checkIdleTemplateClean, resolvePreferredIdleProjectPath,
  createBlankIdleTemplate, computeAutonomousRenderReadiness, isUnderMarketingRoot,
  checkEmptyMarketingSessionReady, HEALTHY_EMPTY_MARKETING_SESSION, HEALTHY_PROJECT_LOADED_STATE,
  deriveHealthState,
} from '../lib/ymm4IdleTemplate.mjs';
import { DEFAULT_MARKETING_IDLE_PROJECT } from '../lib/ymm4Startup.mjs';
import { DEFAULT_PROJECTS_DIR } from '../lib/videoAutomation.mjs';
import { HEALTH, recordYmm4ProcessState } from '../lib/ymm4Health.mjs';
import { openDb, closeDb } from '../lib/db.mjs';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'marketing-idletemplate-test-'));
  const db = openDb(join(dir, 'x.db'));
  return { dir, db };
}

const NOEMORA_PATH = 'C:\\Users\\Silver\\NoemoraYMM4\\NoemoraLive.ymmp';

// A minimal but real-shaped .ymmp payload (see lib/ymm4IdleTemplate.mjs's
// countProjectItems doc comment) — BOM + JSON, Timelines[].Items[].
function projectJson(itemsPerTimeline) {
  const bom = '\uFEFF';
  const timelines = itemsPerTimeline.map((n, i) => ({
    ID: `t${i}`,
    Items: Array.from({ length: n }, (_, j) => ({ $type: 'VoiceItem', text: `item ${j}` })),
  }));
  return bom + JSON.stringify({ FilePath: '', Timelines: timelines });
}

function fileSystemMock(files) {
  return {
    existsImpl: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileImpl: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
  };
}

// --- countProjectItems / checkIdleTemplateClean ---

test('countProjectItems: sums Items across every timeline', () => {
  const { existsImpl, readFileImpl } = fileSystemMock({
    '/mnt/c/Users/Silver/VeritasForgeMarketing/marketing_idle.ymmp': projectJson([3, 5, 8]),
  });
  const result = countProjectItems('C:\\Users\\Silver\\VeritasForgeMarketing\\marketing_idle.ymmp', { existsImpl, readFileImpl });
  assert.equal(result.ok, true);
  assert.equal(result.count, 16);
});

test('countProjectItems: missing file -> ok:false, never a guessed count', () => {
  const result = countProjectItems(DEFAULT_MARKETING_IDLE_TEMPLATE, { existsImpl: () => false });
  assert.equal(result.ok, false);
});

test('checkIdleTemplateClean: a contaminated idle project (real content) -> CLEAN=false', () => {
  const { existsImpl, readFileImpl } = fileSystemMock({
    '/mnt/c/Users/Silver/VeritasForgeMarketing/marketing_idle_blank.ymmp': projectJson([16]),
  });
  const result = checkIdleTemplateClean(DEFAULT_MARKETING_IDLE_TEMPLATE, { existsImpl, readFileImpl });
  assert.equal(result.clean, false);
  assert.equal(result.itemCount, 16);
});

test('checkIdleTemplateClean: a genuinely zero-item marketing project -> CLEAN=true', () => {
  const { existsImpl, readFileImpl } = fileSystemMock({
    '/mnt/c/Users/Silver/VeritasForgeMarketing/marketing_idle_blank.ymmp': projectJson([0, 0]),
  });
  const result = checkIdleTemplateClean(DEFAULT_MARKETING_IDLE_TEMPLATE, { existsImpl, readFileImpl });
  assert.equal(result.clean, true);
  assert.equal(result.itemCount, 0);
});

test('checkIdleTemplateClean: a Noemora path is hard-denied regardless of content', () => {
  const { existsImpl, readFileImpl } = fileSystemMock({
    'C:\\Users\\Silver\\NoemoraYMM4\\NoemoraLive.ymmp': projectJson([0]),
  });
  const result = checkIdleTemplateClean(NOEMORA_PATH, { existsImpl, readFileImpl });
  assert.equal(result.clean, false);
  assert.match(result.reason, /forbidden/i);
});

test('checkIdleTemplateClean: a marketing-owned path whose content nonetheless references Noemora is refused (content scan, independent of the path check)', () => {
  const bom = '\uFEFF';
  const content = bom + JSON.stringify({ FilePath: 'C:\\Users\\Silver\\NoemoraYMM4\\NoemoraLive.ymmp copied in', Timelines: [{ ID: 't0', Items: [] }] });
  const { existsImpl, readFileImpl } = fileSystemMock({
    '/mnt/c/Users/Silver/VeritasForgeMarketing/marketing_idle_blank.ymmp': content,
  });
  const result = checkIdleTemplateClean(DEFAULT_MARKETING_IDLE_TEMPLATE, { existsImpl, readFileImpl });
  assert.equal(result.clean, false);
  assert.match(result.reason, /Noemora/i);
});

test('countProjectItems: a genuinely blank project (no Noemora anywhere) reports noemoraReference:false', () => {
  const { existsImpl, readFileImpl } = fileSystemMock({
    '/mnt/c/Users/Silver/VeritasForgeMarketing/marketing_idle_blank.ymmp': projectJson([0]),
  });
  const result = countProjectItems(DEFAULT_MARKETING_IDLE_TEMPLATE, { existsImpl, readFileImpl });
  assert.equal(result.ok, true);
  assert.equal(result.noemoraReference, false);
});

test('checkIdleTemplateClean: a path outside the marketing project root is refused even if empty', () => {
  const { existsImpl, readFileImpl } = fileSystemMock({
    '/mnt/c/Users/Silver/SomewhereElse/blank.ymmp': projectJson([0]),
  });
  const result = checkIdleTemplateClean('C:\\Users\\Silver\\SomewhereElse\\blank.ymmp', { existsImpl, readFileImpl });
  assert.equal(result.clean, false);
});

test('checkIdleTemplateClean: ambiguous/unparseable project content fails closed, never CLEAN=true', () => {
  const existsImpl = () => true;
  const readFileImpl = () => 'not valid json at all';
  const result = checkIdleTemplateClean(DEFAULT_MARKETING_IDLE_TEMPLATE, { existsImpl, readFileImpl });
  assert.equal(result.clean, false);
});

test('checkIdleTemplateClean: no template configured at all -> CLEAN=false', () => {
  const result = checkIdleTemplateClean(null);
  assert.equal(result.clean, false);
});

// --- resolvePreferredIdleProjectPath (startup selection) ---

test('resolvePreferredIdleProjectPath: clean idle template is selected by startup over the fallback', () => {
  const { existsImpl, readFileImpl } = fileSystemMock({
    '/mnt/c/Users/Silver/VeritasForgeMarketing/marketing_idle_blank.ymmp': projectJson([0]),
  });
  const result = resolvePreferredIdleProjectPath({
    fallbackIdleProjectPath: DEFAULT_MARKETING_IDLE_PROJECT, existsImpl, readFileImpl,
  });
  assert.equal(result.usedTemplate, true);
  assert.equal(result.path, DEFAULT_MARKETING_IDLE_TEMPLATE);
});

test('resolvePreferredIdleProjectPath: old contaminated idle template is never selected once it has real content', () => {
  const { existsImpl, readFileImpl } = fileSystemMock({
    '/mnt/c/Users/Silver/VeritasForgeMarketing/marketing_idle_blank.ymmp': projectJson([16]),
  });
  const result = resolvePreferredIdleProjectPath({
    fallbackIdleProjectPath: DEFAULT_MARKETING_IDLE_PROJECT, existsImpl, readFileImpl,
  });
  assert.equal(result.usedTemplate, false);
  assert.equal(result.path, DEFAULT_MARKETING_IDLE_PROJECT, 'must fall back to the historical idle project, never adopt a contaminated template');
});

test('resolvePreferredIdleProjectPath: no template file at all -> falls back cleanly, no crash', () => {
  const result = resolvePreferredIdleProjectPath({ fallbackIdleProjectPath: DEFAULT_MARKETING_IDLE_PROJECT, existsImpl: () => false });
  assert.equal(result.usedTemplate, false);
  assert.equal(result.path, DEFAULT_MARKETING_IDLE_PROJECT);
});

// --- computeAutonomousRenderReadiness ---

test('computeAutonomousRenderReadiness: every condition true -> ready', () => {
  const result = computeAutonomousRenderReadiness({
    healthState: HEALTH.HEALTHY, liveProjectPath: DEFAULT_MARKETING_IDLE_PROJECT,
    demoAllowed: true, idleTemplateClean: true, renderLockAvailable: true,
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.reasons, []);
});

test('computeAutonomousRenderReadiness: a Noemora live project -> hard deny even if everything else is green', () => {
  const result = computeAutonomousRenderReadiness({
    healthState: HEALTH.HEALTHY, liveProjectPath: NOEMORA_PATH,
    demoAllowed: true, idleTemplateClean: true, renderLockAvailable: true,
  });
  assert.equal(result.ready, false);
  assert.ok(result.reasons.some((r) => /forbidden/i.test(r)));
});

test('computeAutonomousRenderReadiness: ambiguous live project identity (no path known) -> fail closed', () => {
  const result = computeAutonomousRenderReadiness({
    healthState: HEALTH.HEALTHY, liveProjectPath: null,
    demoAllowed: true, idleTemplateClean: true, renderLockAvailable: true,
  });
  assert.equal(result.ready, false);
  assert.ok(result.reasons.some((r) => /ProjectFilePath/.test(r)));
});

test('computeAutonomousRenderReadiness: a dirty idle template alone blocks readiness', () => {
  const result = computeAutonomousRenderReadiness({
    healthState: HEALTH.HEALTHY, liveProjectPath: DEFAULT_MARKETING_IDLE_PROJECT,
    demoAllowed: true, idleTemplateClean: false, renderLockAvailable: true,
  });
  assert.equal(result.ready, false);
  assert.ok(result.reasons.some((r) => /template/i.test(r)));
});

test('computeAutonomousRenderReadiness: health not HEALTHY alone blocks readiness (live project detection stays ProjectFilePath + IsEmptyProject based)', () => {
  const result = computeAutonomousRenderReadiness({
    healthState: HEALTH.READY_NO_PROJECT, liveProjectPath: null,
    demoAllowed: true, idleTemplateClean: true, renderLockAvailable: true,
  });
  assert.equal(result.ready, false);
});

// --- createBlankIdleTemplate (the one-time live bootstrap) ---

function bridgeMock({ createOk = true, saveOk = true, restoreOk = true, afterCreateEmpty = true } = {}) {
  const calls = [];
  let currentPath = 'C:\\Users\\Silver\\VeritasForgeMarketing\\marketing_idle.ymmp';
  let currentEmpty = false;
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (url.endsWith('/api/reflect/get')) {
      const body = JSON.parse(opts.body);
      if (body.path === 'IsEmptyProject') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.Boolean', value: currentEmpty }) };
      if (body.path === 'ProjectFilePath') return { ok: true, status: 200, json: async () => ({ success: true, type: 'System.String', value: currentPath ?? '' }) };
      throw new Error(`unexpected reflect/get path: ${body.path}`);
    }
    if (url.endsWith('/api/reflect/invoke')) {
      const body = JSON.parse(opts.body);
      if (body.method === 'CreateProject') {
        if (!createOk) return { ok: true, status: 200, json: async () => ({ success: false, error: 'CreateProject blew up' }) };
        currentEmpty = afterCreateEmpty;
        currentPath = null;
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (body.method === 'SaveProject') {
        if (!saveOk) return { ok: true, status: 200, json: async () => ({ success: false, error: 'SaveProject blew up' }) };
        currentPath = body.args[0];
        currentEmpty = false; // saved -> no longer the transient unsaved-new-project state
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (body.method === 'OpenProject') {
        if (!restoreOk) return { ok: true, status: 200, json: async () => ({ success: false, error: 'OpenProject blew up' }) };
        currentPath = body.args[0];
        currentEmpty = false;
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      throw new Error(`unexpected reflect/invoke method: ${body.method}`);
    }
    throw new Error(`unexpected url: ${url}`);
  };
  return { fetchImpl, calls, getCurrentPath: () => currentPath };
}

test('createBlankIdleTemplate: refuses a forbidden (Noemora) target path without calling anything', async () => {
  const { fetchImpl, calls } = bridgeMock();
  const result = await createBlankIdleTemplate(NOEMORA_PATH, { fetchImpl, existsImpl: () => false });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test('createBlankIdleTemplate: refuses a target path outside the marketing project root', async () => {
  const { fetchImpl, calls } = bridgeMock();
  const result = await createBlankIdleTemplate('C:\\Users\\Silver\\SomewhereElse\\blank.ymmp', { fetchImpl, existsImpl: () => false });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test('createBlankIdleTemplate: refuses to overwrite if the blank template already exists', async () => {
  const { fetchImpl, calls } = bridgeMock();
  const result = await createBlankIdleTemplate(DEFAULT_MARKETING_IDLE_TEMPLATE, { fetchImpl, existsImpl: () => true });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test('createBlankIdleTemplate: full success -> CreateProject, verify empty, SaveProject, restore original, verify restored', async () => {
  const { fetchImpl, calls } = bridgeMock();
  const result = await createBlankIdleTemplate(DEFAULT_MARKETING_IDLE_TEMPLATE, {
    fetchImpl, existsImpl: () => false, restoreProjectPath: DEFAULT_MARKETING_IDLE_PROJECT,
  });
  assert.equal(result.ok, true);
  assert.equal(result.restoredOk, true);
  const methods = calls.filter((u) => u.endsWith('/api/reflect/invoke')).length;
  assert.ok(methods >= 3, 'expected CreateProject, SaveProject, and OpenProject(restore) calls');
});

test('createBlankIdleTemplate: CreateProject failure -> never calls SaveProject, reports failure', async () => {
  const { fetchImpl } = bridgeMock({ createOk: false });
  const result = await createBlankIdleTemplate(DEFAULT_MARKETING_IDLE_TEMPLATE, {
    fetchImpl, existsImpl: () => false, restoreProjectPath: DEFAULT_MARKETING_IDLE_PROJECT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'create');
});

test('createBlankIdleTemplate: CreateProject succeeds but identity does not verify empty -> aborts, attempts restore, never saves', async () => {
  const { fetchImpl } = bridgeMock({ afterCreateEmpty: false });
  const result = await createBlankIdleTemplate(DEFAULT_MARKETING_IDLE_TEMPLATE, {
    fetchImpl, existsImpl: () => false, restoreProjectPath: DEFAULT_MARKETING_IDLE_PROJECT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'verify-empty');
  assert.equal(result.restoreAttempted, true);
});

test('createBlankIdleTemplate: SaveProject fails -> attempts restore, reports failure, blank file never adopted', async () => {
  const { fetchImpl } = bridgeMock({ saveOk: false });
  const result = await createBlankIdleTemplate(DEFAULT_MARKETING_IDLE_TEMPLATE, {
    fetchImpl, existsImpl: () => false, restoreProjectPath: DEFAULT_MARKETING_IDLE_PROJECT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'save');
  assert.equal(result.restoreAttempted, true);
});

test('createBlankIdleTemplate: save succeeds but restoring the original project fails -> reports human action required, does not silently claim success', async () => {
  const { fetchImpl } = bridgeMock({ restoreOk: false });
  const result = await createBlankIdleTemplate(DEFAULT_MARKETING_IDLE_TEMPLATE, {
    fetchImpl, existsImpl: () => false, restoreProjectPath: DEFAULT_MARKETING_IDLE_PROJECT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'restore');
  assert.equal(result.blankCreated, true);
});

test('createBlankIdleTemplate: with no restoreProjectPath given, still succeeds without attempting a restore', async () => {
  const { fetchImpl } = bridgeMock();
  const result = await createBlankIdleTemplate(DEFAULT_MARKETING_IDLE_TEMPLATE, { fetchImpl, existsImpl: () => false });
  assert.equal(result.ok, true);
  assert.equal(result.restoredOk, null);
});

test('isUnderMarketingRoot: sanity check for both the live and idle-template paths', () => {
  assert.equal(isUnderMarketingRoot(DEFAULT_MARKETING_IDLE_PROJECT), true);
  assert.equal(isUnderMarketingRoot(DEFAULT_MARKETING_IDLE_TEMPLATE), true);
  assert.equal(isUnderMarketingRoot(NOEMORA_PATH), false);
});

// --- checkEmptyMarketingSessionReady / HEALTHY_EMPTY_MARKETING_SESSION ---

function readyNoProjectHealth(pid) {
  return { status: HEALTH.READY_NO_PROJECT, processes: [{ pid, startTime: 'x' }], checkedAt: new Date().toISOString() };
}

function cleanTemplateFs() {
  return fileSystemMock({
    '/mnt/c/Users/Silver/VeritasForgeMarketing/marketing_idle_blank.ymmp': projectJson([0]),
  });
}

const REAL_COMMAND_LINE = `"C:\\Users\\Silver\\Apps\\YukkuriMovieMaker4\\YukkuriMovieMaker.exe" ${DEFAULT_MARKETING_IDLE_TEMPLATE}`;

test('checkEmptyMarketingSessionReady: clean template + marketing-owned process + exact argv + empty state -> ready', async () => {
  const { dir, db } = tempDb();
  try {
    recordYmm4ProcessState(db, { pid: 50188, owner: 'MARKETING', startedAt: null, project: null, bridgeStatus: HEALTH.READY_NO_PROJECT });
    const result = await checkEmptyMarketingSessionReady({
      db, health: readyNoProjectHealth(50188), ...cleanTemplateFs(),
      getProcessCommandLineImpl: async () => ({ ok: true, commandLine: REAL_COMMAND_LINE }),
      getItemsImpl: async () => ({ ok: true, items: [], count: 0 }),
      env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
    });
    assert.equal(result.ready, true, JSON.stringify(result.reasons));
    assert.equal(result.owner, 'MARKETING');
    assert.equal(result.commandLineVerified, true);
    assert.equal(result.liveItemCount, 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkEmptyMarketingSessionReady: unknown process owner -> fail closed', async () => {
  const { dir, db } = tempDb();
  try {
    // No durable record at all -> owner unknown, never assumed MARKETING.
    const result = await checkEmptyMarketingSessionReady({
      db, health: readyNoProjectHealth(50188), ...cleanTemplateFs(),
      getProcessCommandLineImpl: async () => ({ ok: true, commandLine: REAL_COMMAND_LINE }),
      getItemsImpl: async () => ({ ok: true, items: [], count: 0 }),
      env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
    });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.some((r) => /owner/i.test(r)));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkEmptyMarketingSessionReady: wrong/missing argv -> fail closed', async () => {
  const { dir, db } = tempDb();
  try {
    recordYmm4ProcessState(db, { pid: 50188, owner: 'MARKETING', startedAt: null, project: null, bridgeStatus: HEALTH.READY_NO_PROJECT });
    const result = await checkEmptyMarketingSessionReady({
      db, health: readyNoProjectHealth(50188), ...cleanTemplateFs(),
      getProcessCommandLineImpl: async () => ({ ok: true, commandLine: '"C:\\Users\\Silver\\Apps\\YukkuriMovieMaker4\\YukkuriMovieMaker.exe" C:\\Users\\Silver\\VeritasForgeMarketing\\marketing_canary.ymmp' }),
      getItemsImpl: async () => ({ ok: true, items: [], count: 0 }),
      env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
    });
    assert.equal(result.ready, false);
    assert.equal(result.commandLineVerified, false);
    assert.ok(result.reasons.some((r) => /command line/i.test(r)));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkEmptyMarketingSessionReady: empty state but the configured idle template is contaminated -> fail closed', async () => {
  const { dir, db } = tempDb();
  try {
    recordYmm4ProcessState(db, { pid: 50188, owner: 'MARKETING', startedAt: null, project: null, bridgeStatus: HEALTH.READY_NO_PROJECT });
    const contaminatedFs = fileSystemMock({
      '/mnt/c/Users/Silver/VeritasForgeMarketing/marketing_idle_blank.ymmp': projectJson([16]),
    });
    const result = await checkEmptyMarketingSessionReady({
      db, health: readyNoProjectHealth(50188), ...contaminatedFs,
      getProcessCommandLineImpl: async () => ({ ok: true, commandLine: REAL_COMMAND_LINE }),
      getItemsImpl: async () => ({ ok: true, items: [], count: 0 }),
      env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
    });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.some((r) => /template is not clean/i.test(r)));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkEmptyMarketingSessionReady: empty state but live item count > 0 -> fail closed', async () => {
  const { dir, db } = tempDb();
  try {
    recordYmm4ProcessState(db, { pid: 50188, owner: 'MARKETING', startedAt: null, project: null, bridgeStatus: HEALTH.READY_NO_PROJECT });
    const result = await checkEmptyMarketingSessionReady({
      db, health: readyNoProjectHealth(50188), ...cleanTemplateFs(),
      getProcessCommandLineImpl: async () => ({ ok: true, commandLine: REAL_COMMAND_LINE }),
      getItemsImpl: async () => ({ ok: true, items: [{ type: 'VoiceItem' }], count: 1 }),
      env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
    });
    assert.equal(result.ready, false);
    assert.equal(result.liveItemCount, 1);
    assert.ok(result.reasons.some((r) => /live item count/i.test(r)));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkEmptyMarketingSessionReady: a Noemora reference in the real launch argument is hard-denied, even with everything else clean', async () => {
  const { dir, db } = tempDb();
  try {
    recordYmm4ProcessState(db, { pid: 50188, owner: 'MARKETING', startedAt: null, project: null, bridgeStatus: HEALTH.READY_NO_PROJECT });
    const result = await checkEmptyMarketingSessionReady({
      db, health: readyNoProjectHealth(50188), ...cleanTemplateFs(),
      getProcessCommandLineImpl: async () => ({ ok: true, commandLine: '"C:\\Users\\Silver\\Apps\\YukkuriMovieMaker4\\YukkuriMovieMaker.exe" C:\\Users\\Silver\\NoemoraYMM4\\NoemoraLive.ymmp' }),
      getItemsImpl: async () => ({ ok: true, items: [], count: 0 }),
      env: { MARKETING_YMM4_DEMO_ALLOWED: 'true' },
    });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.some((r) => /forbidden/i.test(r)));
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test('checkEmptyMarketingSessionReady: health status is not READY_NO_PROJECT -> immediately not ready, no live calls made', async () => {
  const { dir, db } = tempDb();
  try {
    const result = await checkEmptyMarketingSessionReady({
      db, health: { status: HEALTH.HEALTHY, processes: [{ pid: 1 }] },
      getProcessCommandLineImpl: async () => { throw new Error('must not be called'); },
      getItemsImpl: async () => { throw new Error('must not be called'); },
    });
    assert.equal(result.ready, false);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// --- computeAutonomousRenderReadiness: HEALTHY_EMPTY_MARKETING_SESSION branch ---

test('computeAutonomousRenderReadiness: healthState=HEALTHY_EMPTY_MARKETING_SESSION -> ready (branch B)', () => {
  const result = computeAutonomousRenderReadiness({
    healthState: HEALTHY_EMPTY_MARKETING_SESSION, liveProjectPath: null,
    demoAllowed: true, idleTemplateClean: true, renderLockAvailable: true,
  });
  assert.equal(result.ready, true);
});

test('computeAutonomousRenderReadiness: raw transport READY_NO_PROJECT alone (never enriched to HEALTHY_EMPTY_MARKETING_SESSION) -> still blocked, no silent branch B', () => {
  const result = computeAutonomousRenderReadiness({
    healthState: HEALTH.READY_NO_PROJECT, liveProjectPath: null,
    demoAllowed: true, idleTemplateClean: true, renderLockAvailable: true,
  });
  assert.equal(result.ready, false);
});

test('computeAutonomousRenderReadiness: a normal marketing project with an authoritative ProjectFilePath -> ready via branch A (HEALTHY_PROJECT_LOADED)', () => {
  const result = computeAutonomousRenderReadiness({
    healthState: HEALTHY_PROJECT_LOADED_STATE, liveProjectPath: DEFAULT_MARKETING_IDLE_PROJECT,
    demoAllowed: true, idleTemplateClean: true, renderLockAvailable: true,
  });
  assert.equal(result.ready, true);
});

test('computeAutonomousRenderReadiness: unknown ProjectFilePath on an otherwise-HEALTHY (non-empty) project -> fail closed', () => {
  const result = computeAutonomousRenderReadiness({
    healthState: HEALTH.HEALTHY, liveProjectPath: null,
    demoAllowed: true, idleTemplateClean: true, renderLockAvailable: true,
  });
  assert.equal(result.ready, false);
  assert.ok(result.reasons.some((r) => /ProjectFilePath/.test(r)));
});

// --- dedicated video project generation never touches the blank template ---

test('dedicated per-run video project paths never collide with the idle blank template', () => {
  for (const demoRunId of ['abc123', 'marketing_idle_blank', 'x'.repeat(40)]) {
    const projectPath = `${DEFAULT_PROJECTS_DIR}\\${demoRunId}.ymmp`;
    assert.notEqual(projectPath.toLowerCase(), DEFAULT_MARKETING_IDLE_TEMPLATE.toLowerCase());
  }
  assert.ok(!DEFAULT_PROJECTS_DIR.toLowerCase().includes('marketing_idle_blank'));
});

// --- deriveHealthState ---

test('deriveHealthState: HEALTHY transport -> HEALTHY_PROJECT_LOADED, regardless of the emptySessionReady flag', () => {
  assert.equal(deriveHealthState(HEALTH.HEALTHY, false), HEALTHY_PROJECT_LOADED_STATE);
  assert.equal(deriveHealthState(HEALTH.HEALTHY, true), HEALTHY_PROJECT_LOADED_STATE);
});

test('deriveHealthState: READY_NO_PROJECT + verified empty session -> HEALTHY_EMPTY_MARKETING_SESSION', () => {
  assert.equal(deriveHealthState(HEALTH.READY_NO_PROJECT, true), HEALTHY_EMPTY_MARKETING_SESSION);
});

test('deriveHealthState: READY_NO_PROJECT without a verified empty session -> stays the raw transport state', () => {
  assert.equal(deriveHealthState(HEALTH.READY_NO_PROJECT, false), HEALTH.READY_NO_PROJECT);
});

test('deriveHealthState: any other transport state passes through unchanged', () => {
  assert.equal(deriveHealthState(HEALTH.BLOCKED_DIALOG, false), HEALTH.BLOCKED_DIALOG);
  assert.equal(deriveHealthState(HEALTH.WRONG_PROJECT, true), HEALTH.WRONG_PROJECT);
});
