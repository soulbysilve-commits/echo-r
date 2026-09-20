// Backward-compatible wrapper around registry.mjs, used by operator.mjs and
// tests. `connectors[name]` is a plain object (not a module namespace) so
// tests can monkey-patch `.publish` for a single test without touching the
// real connector module.
//
// PRIOR BUG (now fixed): this file used to be a generic per-channel stub
// whose isConfigured()/publish() gave every channel the same behavior
// regardless of whether a real API client existed — which let a status
// report call a channel "configured" when only a placeholder existed. Real
// clients now live in x.mjs / discord.mjs / reddit.mjs / qiita.mjs /
// youtube.mjs; this file only wires them up and reports the two facts
// (clientImplemented, authConfigured) truthfully via registry.mjs.
import { classify, classifyAll, connectorModule, allChannelNames } from './registry.mjs';

function wrap(name) {
  const mod = connectorModule(name);
  const info = classify(name);
  return {
    channel: name,
    mechanism: info.mechanism,
    clientImplemented: info.clientImplemented,
    isConfigured: () => classify(name).authConfigured, // re-checks env each call, same as before
    publish: mod ? (draft, opts) => mod.publish(draft, opts) : async () => ({ ok: false, connectionRequired: true, channel: name }),
  };
}

export const connectors = Object.fromEntries(allChannelNames().map((name) => [name, wrap(name)]));

/**
 * Simple CONNECTED/CONNECTION_REQUIRED map — kept for the existing `status`
 * output shape. Use registry.classifyAll() directly for the fuller
 * clientImplemented/authConfigured/liveReady breakdown.
 */
export function connectionStatus() {
  const all = classifyAll();
  return Object.fromEntries(
    Object.entries(all).map(([name, info]) => [name, info.liveReady ? 'CONNECTED' : info.status])
  );
}
