// Real Discord connector via incoming webhook. mechanism: REAL_CLIENT_IMPLEMENTED.
// Webhook publication was chosen over a bot connection because it needs only
// one secret (the webhook URL itself), matches "release notes / announcements"
// (mandate section 13), and there is no existing Veritas Forge Discord bot
// infrastructure found in any of the four canonical repos to reuse.
import { requestWithRetry } from './http.mjs';

export const channel = 'discord';
export const clientImplemented = true;
export const REQUIRED_ENV_VARS = ['DISCORD_WEBHOOK_URL'];

export function isAuthConfigured(env = process.env) {
  return !!env.DISCORD_WEBHOOK_URL;
}

export async function postMessage(content, { env = process.env, fetchImpl = fetch, retryOpts, threadId } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing ${REQUIRED_ENV_VARS[0]}` };
  }
  const url = threadId ? `${env.DISCORD_WEBHOOK_URL}?thread_id=${threadId}&wait=true` : `${env.DISCORD_WEBHOOK_URL}?wait=true`;

  const result = await requestWithRetry(
    () => fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }),
    retryOpts
  );

  if (!result.ok) {
    return { ok: false, errorClass: result.errorClass, status: result.status };
  }
  const data = await result.response.json().catch(() => ({}));
  return { ok: true, messageId: data?.id, channelId: data?.channel_id };
}

export async function publish(draft, { dryRun = true, env = process.env, fetchImpl = fetch } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, connectionRequired: true, channel };
  }
  if (dryRun) {
    return { ok: true, dryRun: true, channel, wouldPublish: draft.text };
  }
  const result = await postMessage(draft.text, { env, fetchImpl });
  if (!result.ok) {
    return { ok: false, error: result.errorClass, retryable: result.errorClass === 'TRANSIENT' };
  }
  return { ok: true, externalId: result.messageId };
}
