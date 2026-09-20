// Single source of truth for what is actually true about each channel.
// This exists specifically to prevent the bug flagged in the prior report:
// a generic connector interface existing must never be reported as a channel
// being "ready." clientImplemented and authConfigured are tracked and
// reported as two separate, independently-true-or-false facts, always.
import * as x from './x.mjs';
import * as discord from './discord.mjs';
import * as reddit from './reddit.mjs';
import * as qiita from './qiita.mjs';
import * as youtube from './youtube.mjs';
import * as bluesky from './bluesky.mjs';
import * as mastodon from './mastodon.mjs';
import * as devto from './devto.mjs';

const REAL_CLIENTS = { x, discord, reddit, qiita, youtube, bluesky, mastodon, devto };

// Capability-detection-only clients (multi-channel expansion mandate
// sections 8/9): a real client exists and makes real read-only API calls,
// but publish() deliberately refuses — see hashnode.mjs/linkedin.mjs.
// Tracked separately from REAL_CLIENTS so classify() never reports these as
// LIVE-publish-ready just because a client module exists.
import * as hashnode from './hashnode.mjs';
import * as linkedin from './linkedin.mjs';
const CAPABILITY_ONLY_CLIENTS = { hashnode, linkedin };

// Channels with no real API client implemented here, and why — each value is
// a factual statement about the platform's actual publishing mechanisms, not
// a placeholder to fill in later with a fabricated client.
const NON_API_CHANNELS = {
  producthunt: {
    mechanism: 'MANUAL_ONLY',
    note: 'Product Hunt launches must be created through the website; there is no supported API for creating a launch. (A GraphQL API exists for reading data and posting comments on an existing launch, which could become REAL_CLIENT_IMPLEMENTED later if comment-automation is wanted — not built here since section 17 also gates launch until sales are live.) A real launch-package preparer exists (lib/humanApprovalPackage.mjs) — AUTO_PREPARE_HUMAN_APPROVAL workflow mode, never auto-submission.',
  },
  zenn: {
    mechanism: 'UPLOAD_PACKAGE_ONLY',
    note: 'Zenn has no public write API. Publishing is via "git sync" — Zenn watches a GitHub repo you connect in its dashboard and auto-publishes markdown pushed to it. lib/zenn.mjs generates real Zenn-formatted markdown (frontmatter + body) into a dedicated content directory (published: false by default); wiring an actual Zenn-connected repo and pushing are still one-time/deliberate manual steps, never done automatically here.',
  },
  note: {
    mechanism: 'BROWSER_WORKFLOW_REQUIRED',
    note: 'note.com has no public publishing API of any kind (read or write), and this project never uses undocumented/private browser APIs. A real prepared-package generator exists (lib/humanApprovalPackage.mjs) for a human to paste into the web editor — AUTO_PREPARE_HUMAN_APPROVAL, never automated submission.',
  },
  hackernews: {
    mechanism: 'MANUAL_ONLY',
    note: 'Hacker News has no publish API by design. Show HN posts and comments are always manual. A real prepared-package generator exists (lib/humanApprovalPackage.mjs) — AUTO_PREPARE_HUMAN_APPROVAL, never automated submission.',
  },
};

export function classify(name, env = process.env) {
  const mod = REAL_CLIENTS[name];
  if (mod) {
    const authConfigured = mod.isAuthConfigured(env);
    return {
      channel: name,
      mechanism: 'REAL_CLIENT_IMPLEMENTED',
      clientImplemented: true,
      authConfigured,
      dryRunReady: true, // a real client always supports DRY_RUN since DRY_RUN never calls it
      liveReady: authConfigured,
      status: authConfigured ? 'READY_FOR_LIVE' : 'AUTH_REQUIRED',
      requiredEnvVars: mod.REQUIRED_ENV_VARS,
    };
  }
  const capMod = CAPABILITY_ONLY_CLIENTS[name];
  if (capMod) {
    const authConfigured = capMod.isAuthConfigured(env);
    return {
      channel: name,
      mechanism: 'CAPABILITY_DETECTION_ONLY',
      clientImplemented: false, // publish() is a deliberate stub — never reported as a real publish path
      authConfigured,
      dryRunReady: false,
      liveReady: false, // real live-readiness requires a dedicated capability check (READY state), never inferred from authConfigured alone
      status: authConfigured ? 'AUTH_CONFIGURED_CAPABILITY_UNKNOWN' : 'AUTH_REQUIRED',
      requiredEnvVars: capMod.REQUIRED_ENV_VARS,
      note: `real read-only capability detection exists (${capMod.channel}.mjs's detectCapability()) — run \`connector capability ${name}\` for the live AUTH_REQUIRED/PLAN_REQUIRED/API_APPROVAL_REQUIRED/READY state`,
    };
  }
  const info = NON_API_CHANNELS[name];
  if (info) {
    return {
      channel: name,
      mechanism: info.mechanism,
      clientImplemented: false,
      authConfigured: false,
      dryRunReady: false,
      liveReady: false,
      status: info.mechanism,
      requiredEnvVars: [],
      note: info.note,
    };
  }
  return {
    channel: name, mechanism: 'INTERFACE_ONLY', clientImplemented: false,
    authConfigured: false, dryRunReady: false, liveReady: false, status: 'INTERFACE_ONLY', requiredEnvVars: [],
  };
}

export function allChannelNames() {
  return [...Object.keys(REAL_CLIENTS), ...Object.keys(CAPABILITY_ONLY_CLIENTS), ...Object.keys(NON_API_CHANNELS)];
}

export function capabilityOnlyModule(name) {
  return CAPABILITY_ONLY_CLIENTS[name];
}

export function connectorModule(name) {
  return REAL_CLIENTS[name];
}

export function classifyAll(env = process.env) {
  return Object.fromEntries(allChannelNames().map((name) => [name, classify(name, env)]));
}
