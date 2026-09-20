// Client for the "ymm4MCP" HTTP control plugin discovered already vendored
// and in active use at /mnt/c/Users/Silver/NoemoraYMMBridge (see
// docs/marketing/YMM4_AUTOMATION_AUDIT.md) — driving the real
// ECHODiscord版/local_commentary/noemora_ymm4_*.py pipeline's same plugin
// surface, NOT a second competing automation path.
//
// This module NEVER launches YukkuriMovieMaker.exe itself — only a passive
// HTTP reachability probe. If the plugin isn't reachable (because YMM4 isn't
// open), callers must fall back to an import-ready package, per mandate
// section 14 ("do NOT fake success").
//
// mechanism note: this talks to a THIRD-PARTY plugin, not an official YMM4
// API — there is no official YMM4 automation API. Treat this the same way
// as any other REAL_CLIENT_IMPLEMENTED connector: real code, tested via
// mocks, gated on the bridge actually being reachable.
//
// Real-environment fix (YMM4 unattended-startup mandate section 3: "Check
// from the environment that actually reaches it... reuse the verified
// Windows-side / powershell.exe relay when needed"): global `fetch` cannot
// reach the bridge from WSL2 at all (confirmed — see lib/psHttpRelay.mjs's
// own docstring: WSL2 localhost-forwarding does not reach it, even though
// Invoke-WebRequest from real PowerShell does). Every function below now
// defaults to psFetch, not `fetch` — the previous `fetch` default meant a
// caller that never explicitly passed fetchImpl (the real CLI path,
// outside of tests, which always inject their own mock) could never
// actually have reached the live bridge from this environment. Tests are
// unaffected — they always inject an explicit fetchImpl mock.
import { requestWithRetry } from '../connectors/http.mjs';
import { psFetch } from './psHttpRelay.mjs';

// Confirmed against the real plugin source (McpHttpServer.cs: `public const
// int Port = 8765`) and empirically (GET /api/status returns a real
// response) — not a guess. Override via YMM4_BRIDGE_URL if ever needed
// (e.g. WSL2 cannot reach `localhost` directly — see psHttpRelay.mjs for
// why and how requests are relayed through powershell.exe instead).
const DEFAULT_BASE_URL = 'http://localhost:8765';

export function bridgeBaseUrl(env = process.env) {
  return env.YMM4_BRIDGE_URL || DEFAULT_BASE_URL;
}

/**
 * Passive reachability check only — a GET with a short timeout. Never
 * attempts to start YMM4 or the plugin if this fails.
 */
export async function checkReachable({ env = process.env, fetchImpl = psFetch, timeoutMs = 2000 } = {}) {
  const url = `${bridgeBaseUrl(env)}/api/status`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetchImpl(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return { ok: false, reachable: false, status: response.status };
    const data = await response.json();
    return { ok: true, reachable: true, status: data };
  } catch (err) {
    return { ok: false, reachable: false, error: String(err?.message ?? err) };
  }
}

export async function getItems({ env = process.env, fetchImpl = psFetch, retryOpts } = {}) {
  const url = `${bridgeBaseUrl(env)}/api/items`;
  const result = await requestWithRetry(() => fetchImpl(url), retryOpts);
  if (!result.ok) return { ok: false, errorClass: result.errorClass };
  const data = await result.response.json();
  return { ok: true, items: data.items ?? [], count: data.count ?? data.items?.length ?? 0 };
}

/**
 * Deletes all items on the given layers — shape verified against the real
 * plugin source (McpHttpServer.cs DeleteItems: `{layers: [...]}` deletes
 * everything on those layer indices; a single {frame, layer} pair deletes
 * one specific item instead). Used to clear a project's timeline before
 * assembling a new, unrelated demo run's narration into it, so successive
 * automatic runs never mix content from different stories.
 */
export async function deleteItemsOnLayers(layers, { env = process.env, fetchImpl = psFetch, retryOpts } = {}) {
  const url = `${bridgeBaseUrl(env)}/api/items/delete`;
  const body = JSON.stringify({ layers });
  const result = await requestWithRetry(
    () => fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass };
  const data = await result.response.json();
  if (data.success === false) return { ok: false, errorClass: 'DELETE_ERROR', message: data.error };
  return { ok: true, removed: data.removed };
}

// Character search (McpHttpServer.cs AddVoiceItem) strips a "ゆっくり" prefix
// and does a substring match against the project's registered character
// names — pass the real registered name (confirmed via GET
// /api/debug/voicecmd against the live project) here, not an English code.
export const CHARACTER_NAME = { reimu: 'ゆっくり霊夢', marisa: 'ゆっくり魔理沙' };

/**
 * Inserts one dialogue line as a VoiceItem — this actually triggers real
 * voice synthesis on the live instance (AddVoiceItemCommandParameter /
 * AddVoiceItemAsync in the plugin source) and the plugin polls for the
 * synthesized item's real length before responding, so a successful
 * response means audio was genuinely generated, not just a timeline
 * placeholder inserted silently.
 */
export async function addVoiceLine({ character, text, frame, layer }, { env = process.env, fetchImpl = psFetch, retryOpts } = {}) {
  const url = `${bridgeBaseUrl(env)}/api/items/voice`;
  const body = JSON.stringify({ character, text, frame, layer });
  const result = await requestWithRetry(
    () => fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass };
  const data = await result.response.json();
  if (data.success === false) return { ok: false, errorClass: 'ITEM_INSERT_ERROR', message: data.error };
  return { ok: true, frame: data.frame, layer: data.layer, length: data.length, endFrame: data.endFrame };
}

/**
 * Generic reflect-invoke call, used for SaveProject and other .NET-side
 * calls the existing pipeline drives this way (see
 * noemora_ymm4_initial_save_v2.py / noemora_ymm4_render_worker_v1.py).
 *
 * Request shape corrected against the real plugin source
 * (YMM4McpPlugin/McpHttpServer.cs ReflectInvoke): {target, method, args} —
 * NOT the {member, args} shape originally guessed here before this was ever
 * run against the live bridge.
 */
export async function reflectInvoke(target, method, args, { env = process.env, fetchImpl = psFetch, retryOpts } = {}) {
  const url = `${bridgeBaseUrl(env)}/api/reflect/invoke`;
  const body = JSON.stringify({ target, method, args });
  const result = await requestWithRetry(
    () => fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass };
  const data = await result.response.json();
  if (data.success === false) return { ok: false, errorClass: 'REFLECT_ERROR', message: data.error };
  return { ok: true, data };
}

export async function saveProject(projectPath, opts) {
  return reflectInvoke('Main', 'SaveProject', [projectPath], opts);
}

// Confirmed BROKEN for project identity (2026-09-16 project-open-detection
// audit): the plugin's GetProjectInfo() (McpHttpServer.cs) reads
// GetPropStr(vm, "ProjectName") / GetPropStr(vm, "ProjectPath") — neither
// property exists on this build's MainViewModel at all (confirmed via a
// live /api/debug/vm property dump), so both always come back "" even with
// a real project loaded — never treat projectName/projectPath from this
// endpoint as authoritative. `vmType`/`error` are still valid here (they
// reflect whether GetMainViewModel() resolved at all, a completely
// separate code path from the broken prop lookups) — this is still the
// right signal for "is the application itself responsive" (STARTING vs
// BLOCKED_DIALOG vs actually up). See getProjectIdentity() below for the
// real project-loaded signal.
export async function getProjectInfo({ env = process.env, fetchImpl = psFetch, retryOpts } = {}) {
  const url = `${bridgeBaseUrl(env)}/api/project`;
  const result = await requestWithRetry(() => fetchImpl(url), retryOpts);
  if (!result.ok) return { ok: false, errorClass: result.errorClass };
  return { ok: true, ...(await result.response.json()) };
}

/**
 * Generic reflect-GET call — real, already-implemented plugin capability
 * (McpHttpServer.cs ReflectGet/ResolvePath), used instead of inventing any
 * new endpoint. ResolvePath auto-unwraps a ReactiveProperty<T>'s .Value,
 * which is exactly what makes this work where GetProjectInfo()'s naive
 * `as string` cast fails silently.
 */
export async function reflectGet(target, path, { env = process.env, fetchImpl = psFetch, retryOpts } = {}) {
  const url = `${bridgeBaseUrl(env)}/api/reflect/get`;
  const body = JSON.stringify({ target, path });
  const result = await requestWithRetry(
    () => fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass };
  const data = await result.response.json();
  if (data.success === false) return { ok: false, errorClass: 'REFLECT_GET_ERROR', message: data.error };
  return { ok: true, type: data.type, value: data.value };
}

/**
 * The AUTHORITATIVE "is a project actually loaded, and what's its path"
 * signal — confirmed live against the real plugin/app (2026-09-16):
 * MainViewModel exposes `IsEmptyProject` (bool) and `ProjectFilePath`
 * (IReadOnlyReactiveProperty<string>, auto-unwrapped by reflectGet above),
 * NOT the "ProjectName"/"ProjectPath" properties getProjectInfo() looks
 * for. Never derive project-loaded state from getProjectInfo() again.
 */
export async function getProjectIdentity(opts = {}) {
  const emptyResult = await reflectGet('Main', 'IsEmptyProject', opts);
  const pathResult = await reflectGet('Main', 'ProjectFilePath', opts);
  if (!emptyResult.ok) return { ok: false, errorClass: emptyResult.errorClass, message: emptyResult.message };
  if (!pathResult.ok) return { ok: false, errorClass: pathResult.errorClass, message: pathResult.message };
  const isEmpty = emptyResult.value === true;
  const projectPath = typeof pathResult.value === 'string' && pathResult.value !== '' ? pathResult.value : null;
  return { ok: true, isEmpty, projectPath };
}
