// Registry of all read-only source adapters (mandate section 3).
import * as echoAgent from './echoAgent.mjs';
import * as echoApp from './echoApp.mjs';
import * as noemora from './noemora.mjs';
import * as officialSite from './officialSite.mjs';

export const adapters = [echoAgent, echoApp, noemora, officialSite];

export function findAdapter(name) {
  const aliases = { 'echo-agent': echoAgent, 'echo-app': echoApp, noemora, site: officialSite, 'official-site': officialSite };
  return aliases[name] ?? null;
}
