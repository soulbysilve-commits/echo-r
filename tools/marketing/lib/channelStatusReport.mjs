// The unified per-channel status block (multi-channel expansion mandate
// sections 6/20): CLIENT/AUTH_CONFIGURED/AUTH/ENABLED/CANARY/MODE/
// LIVE_READY/LAST_PUBLICATION/TODAY_COUNT/BLOCKER, computed the same way
// for every channel so `status` never has to special-case each one's shape.
// Pure local reads only (classify() is an env check, channel_state/ledger
// queries are local DB reads) — same "status never makes a live network
// call" rule every other status field already follows; AUTH here is a
// durable fact from the last real `auth-check` run (lib/authCheck.mjs's
// authCheckGeneric), never re-derived live here.
import { classify } from '../connectors/registry.mjs';
import { channelPolicy, MODE } from './channelPolicy.mjs';
import { channelEnabled } from './channelFlags.mjs';
import { todaysPublications, ensureLedgerV2Schema } from './ledger.mjs';
import { getChannelState } from './channelState.mjs';
import { getActivationBoundary } from './activation.mjs';

export function allExpansionChannelNames() {
  return ['bluesky', 'mastodon', 'devto', 'qiita', 'zenn', 'hashnode', 'linkedin', 'reddit', 'producthunt', 'hackernews', 'note'];
}

// Channels actually reachable from the unattended daily scheduler
// (operator.mjs's runOnce() — see its runBlueskyCycle/runMastodonCycle/
// runDevToCycle/runQiitaCycle) — never inferred from MODE alone (zenn
// shares the same AUTO_PUBLIC_ELIGIBLE class but its MODE is AUTO_DRAFT,
// not AUTO_PUBLIC — it has no write API at all, see channelPolicy.mjs;
// only explicitly listed here once a channel is verifiably wired, one at a
// time, per its own real canary + activation boundary).
const SCHEDULER_WIRED_CHANNELS = new Set(['bluesky', 'mastodon', 'devto', 'qiita']);

/**
 * The durable AUTH state label (mandate section 4): AUTH_REQUIRED (no
 * credentials, or credentials present but never checked — "configured" is
 * not "proven"), AUTH_VALID/AUTH_INVALID (the last real auth-check's
 * result, from channel_state — never a live call here). A transient
 * API_ERROR at check time is never persisted as either VALID or INVALID
 * (see lib/authCheck.mjs), so it can never surface as a stale AUTH_INVALID
 * here either — it simply stays AUTH_REQUIRED until a check actually
 * resolves one way or the other.
 */
function authStateFor(authConfigured, channelState) {
  if (!authConfigured) return 'AUTH_REQUIRED';
  if (!channelState.auth_checked_at) return 'AUTH_REQUIRED';
  return channelState.auth_valid ? 'AUTH_VALID' : 'AUTH_INVALID';
}

export function buildChannelStatus(db, channel, env = process.env) {
  ensureLedgerV2Schema(db);
  const info = classify(channel, env);
  const policy = channelPolicy(channel);
  const enabled = channelEnabled(channel, env);
  const channelState = getChannelState(db, channel);
  const authState = authStateFor(info.authConfigured, channelState);
  const canaryPass = !!channelState.canary_passed;
  const todayCount = todaysPublications(db).filter((r) => r.channel === channel).length;
  const lastRow = db.prepare(
    'SELECT published_at FROM publication_ledger WHERE channel = ? AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1'
  ).get(channel);

  let liveReady = false;
  let blocker;
  // AUTO_PREPARE_HUMAN_APPROVAL channels (Reddit self-promotion, Product
  // Hunt, Hacker News, note) are NEVER "live ready" in the auto-publish
  // sense, by design — even Reddit's real client (used for AUTO_WITH_POLICY
  // replies, a different action type on the same channel) never makes
  // self-promotion auto-publish-ready.
  if (policy.mode === MODE.AUTO_PREPARE_HUMAN_APPROVAL) {
    liveReady = false;
    blocker = 'HUMAN_APPROVAL_REQUIRED_BY_DESIGN (this channel never auto-publishes, regardless of auth/enable state)';
  } else if (info.mechanism === 'REAL_CLIENT_IMPLEMENTED') {
    // Mandate section 5: AUTH_VALID (not merely configured) + ENABLED +
    // CANARY_PASS are all independently required before a channel counts as
    // unattended-public-ready (PUBLIC_MARKETING_MODE=LIVE and the
    // activation boundary are separate, global/per-event checks made
    // elsewhere — see operator.mjs's own liveAllowed logic).
    liveReady = authState === 'AUTH_VALID' && enabled && canaryPass && policy.mode !== MODE.DISABLED;
    blocker = liveReady ? null
      : authState !== 'AUTH_VALID' ? authState
      : !enabled ? 'CHANNEL_DISABLED'
      : !canaryPass ? 'CANARY_NOT_PASSED'
      : 'MODE_DISABLED';
  } else if (info.mechanism === 'CAPABILITY_DETECTION_ONLY') {
    liveReady = false;
    blocker = !info.authConfigured
      ? 'AUTH_REQUIRED'
      : `run \`connector capability ${channel}\` for the live READY/PLAN_REQUIRED/API_APPROVAL_REQUIRED state`;
  } else {
    liveReady = false;
    blocker = info.mechanism;
  }

  return {
    CLIENT: info.clientImplemented,
    AUTH_CONFIGURED: info.authConfigured,
    AUTH: authState,
    ENABLED: enabled,
    CANARY: canaryPass,
    MODE: policy.mode,
    SCHEDULER_WIRED: SCHEDULER_WIRED_CHANNELS.has(channel),
    LIVE_NOT_BEFORE: getActivationBoundary(db, channel),
    LIVE_READY: liveReady,
    LAST_PUBLICATION: lastRow?.published_at ?? null,
    TODAY_COUNT: todayCount,
    BLOCKER: blocker,
  };
}

export function buildAllChannelStatus(db, env = process.env) {
  return Object.fromEntries(allExpansionChannelNames().map((ch) => [ch, buildChannelStatus(db, ch, env)]));
}
