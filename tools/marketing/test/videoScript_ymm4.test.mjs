import test from 'node:test';
import assert from 'node:assert/strict';
import { generateVideoScript, validateScript } from '../lib/videoScript.mjs';
import { checkReachable, addVoiceLine, saveProject, bridgeBaseUrl, CHARACTER_NAME, getProjectInfo, deleteItemsOnLayers } from '../lib/ymm4Bridge.mjs';
import { buildPublicSafeBundle } from '../lib/evidence.mjs';

const FACTS = [
  { id: 'FACT-001', CLAIM: "ECHO Agent's verifier rejects a claimed success with no evidence." },
  { id: 'FACT-002', CLAIM: 'ECHO Agent can checkpoint an in-progress task and resume it after a restart.' },
];

function sampleBundle() {
  const result = buildPublicSafeBundle({
    demoRunId: 'demo1',
    factIds: ['FACT-001', 'FACT-002'],
    rawLogLines: ['[00:02] GOAL ACCEPTED', '[00:31] STEP 3 FAILED', '[00:32] VERIFIER — REJECT'],
  });
  assert.equal(result.ok, true);
  return result.bundle;
}

// --- video script generation ---

test('generateVideoScript never emits a technical/evidence line without an evidence_ref', () => {
  const bundle = sampleBundle();
  const script = generateVideoScript(bundle, FACTS);
  const check = validateScript(script, bundle);
  assert.equal(check.ok, true, JSON.stringify(check.violations));
});

test('generateVideoScript only narrates facts actually present in the bundle (no evidence, no claim)', () => {
  const bundle = sampleBundle();
  const script = generateVideoScript(bundle, FACTS);
  const technicalLines = script.lines.filter((l) => l.importance === 'technical');
  assert.equal(technicalLines.length, 2); // exactly the 2 facts in bundle.factIds
  for (const line of technicalLines) {
    assert.ok(bundle.factIds.includes(line.evidence_ref));
  }
});

test('generateVideoScript includes every public-safe log line with a resolvable evidence_ref', () => {
  const bundle = sampleBundle();
  const script = generateVideoScript(bundle, FACTS);
  const evidenceLines = script.lines.filter((l) => l.importance === 'evidence');
  assert.equal(evidenceLines.length, bundle.publicSafeLogLines.length);
});

test('validateScript catches a hand-built line with a fabricated evidence_ref', () => {
  const bundle = sampleBundle();
  const badScript = {
    demoRunId: 'demo1',
    lines: [{ speaker: 'marisa', text: 'ECHO Agent can do something not in the bundle', evidence_ref: 'FACT-999', importance: 'technical' }],
  };
  const check = validateScript(badScript, bundle);
  assert.equal(check.ok, false);
  assert.ok(check.violations[0].includes('FACT-999'));
});

test('validateScript catches a technical line missing evidence_ref entirely', () => {
  const bundle = sampleBundle();
  const badScript = { demoRunId: 'demo1', lines: [{ speaker: 'marisa', text: 'no evidence here', importance: 'technical' }] };
  const check = validateScript(badScript, bundle);
  assert.equal(check.ok, false);
});

test('intro/outro lines are exempt from the evidence requirement', () => {
  const bundle = sampleBundle();
  const script = { demoRunId: 'demo1', lines: [{ speaker: 'reimu', text: 'hello', importance: 'intro' }] };
  const check = validateScript(script, bundle);
  assert.equal(check.ok, true);
});

// --- YMM4 bridge (mocked HTTP; never touches a real bridge in tests) ---

test('checkReachable reports reachable=false without throwing when the bridge is down (connection refused)', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const result = await checkReachable({ fetchImpl, timeoutMs: 100 });
  assert.equal(result.reachable, false);
  assert.equal(result.ok, false);
});

test('checkReachable reports reachable=true on a real 200 response', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ version: '1.0' }) });
  const result = await checkReachable({ fetchImpl });
  assert.equal(result.reachable, true);
  assert.deepEqual(result.status, { version: '1.0' });
});

test('CHARACTER_NAME maps to the real registered character names (confirmed via GET /api/debug/voicecmd against the live project), not English codes', () => {
  assert.equal(CHARACTER_NAME.reimu, 'ゆっくり霊夢');
  assert.equal(CHARACTER_NAME.marisa, 'ゆっくり魔理沙');
});

test('addVoiceLine posts to /api/items/voice and parses the real {success, frame, layer, length, endFrame} response shape', async () => {
  let capturedUrl, capturedBody;
  const fetchImpl = async (url, opts) => {
    capturedUrl = url; capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ success: true, character: CHARACTER_NAME.reimu, text: 'こんにちは', frame: 0, layer: 1, length: 42, endFrame: 42 }) };
  };
  const result = await addVoiceLine({ character: CHARACTER_NAME.reimu, text: 'こんにちは', frame: 0, layer: 1 }, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.length, 42);
  assert.equal(result.endFrame, 42);
  assert.ok(capturedUrl.endsWith('/api/items/voice'));
  assert.equal(capturedBody.character, CHARACTER_NAME.reimu);
});

test('addVoiceLine surfaces a character-not-found error rather than reporting success', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ success: false, error: 'キャラが見つかりません:nonexistent' }) });
  const result = await addVoiceLine({ character: 'nonexistent', text: 'x', frame: 0, layer: 0 }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'ITEM_INSERT_ERROR');
});

test('getProjectInfo reports the currently loaded project name/path (used to confirm we are not touching an existing Noemora project before writing anything)', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ vmType: 'MainViewModel', projectName: '', projectPath: '' }) });
  const result = await getProjectInfo({ fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.projectPath, '');
});

test('saveProject calls reflect/invoke with target=Main, method=SaveProject, and the project path as args (shape confirmed against the real plugin source)', async () => {
  let capturedBody;
  const fetchImpl = async (url, opts) => { capturedBody = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ success: true }) }; };
  await saveProject('/some/project.ymmp', { fetchImpl });
  assert.equal(capturedBody.target, 'Main');
  assert.equal(capturedBody.method, 'SaveProject');
  assert.deepEqual(capturedBody.args, ['/some/project.ymmp']);
});

test('reflectInvoke surfaces a {success:false} response body as a failure rather than treating any 200 as ok', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ success: false, error: 'method not found' }) });
  const result = await saveProject('/some/project.ymmp', { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'REFLECT_ERROR');
});

test('bridgeBaseUrl is overridable via env, defaulting to the confirmed real port (8765, from the plugin source, not a guess)', () => {
  assert.equal(bridgeBaseUrl({ YMM4_BRIDGE_URL: 'http://example.test:9999' }), 'http://example.test:9999');
  assert.ok(bridgeBaseUrl({}).endsWith(':8765'));
});

test('deleteItemsOnLayers posts {layers: [...]} to /api/items/delete (shape verified against the real plugin source)', async () => {
  let capturedBody;
  const fetchImpl = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ success: true, removed: 3 }) };
  };
  const result = await deleteItemsOnLayers([0, 1, 2], { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.removed, 3);
  assert.deepEqual(capturedBody.layers, [0, 1, 2]);
});

test('deleteItemsOnLayers surfaces a {success:false} response as a failure', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ success: false, error: 'timeline field failed' }) });
  const result = await deleteItemsOnLayers([0], { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'DELETE_ERROR');
});
