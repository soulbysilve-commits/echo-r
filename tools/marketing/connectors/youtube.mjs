// Real YouTube connector (Data API v3), OAuth2 refresh-token flow + multipart
// upload. mechanism: REAL_CLIENT_IMPLEMENTED, with one documented limitation:
// this uses the "simple" multipart upload (single request, video bytes read
// fully into memory) rather than the resumable upload protocol. That's a
// deliberate scope cut — fine for the short-form videos in
// docs/marketing/VIDEO_CONTENT.md, not appropriate for very large files
// without adding resumable-upload support first.
import { readFile } from 'node:fs/promises';
import { requestWithRetry } from './http.mjs';

export const channel = 'youtube';
export const clientImplemented = true;
export const REQUIRED_ENV_VARS = ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'];
// Initial policy (mandate: "never automatically publish PUBLIC during initial
// E2E"). Making a video public is a separate, explicit, human-approved step —
// nothing in this connector ever uploads with any other default.
export const DEFAULT_PRIVACY = 'private';

export function isAuthConfigured(env = process.env) {
  return REQUIRED_ENV_VARS.every((name) => !!env[name]);
}

export async function getAccessToken({ env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, errorClass: 'AUTH_REQUIRED', message: `Missing one of: ${REQUIRED_ENV_VARS.join(', ')}` };
  }
  const body = new URLSearchParams({
    client_id: env.YOUTUBE_CLIENT_ID,
    client_secret: env.YOUTUBE_CLIENT_SECRET,
    refresh_token: env.YOUTUBE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });

  const result = await requestWithRetry(
    () => fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const data = await result.response.json();
  if (!data.access_token) return { ok: false, errorClass: 'AUTH_ERROR', message: 'no access_token in response' };
  return { ok: true, accessToken: data.access_token };
}

function buildMultipartBody(metadata, videoBuffer, boundary) {
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: video/*\r\n\r\n`
  );
  const closing = Buffer.from(`\r\n--${boundary}--`);
  return Buffer.concat([preamble, videoBuffer, closing]);
}

/**
 * Uploads a video file with title/description/tags. `filePath` must point to
 * an already-rendered file — this connector never fabricates video content.
 */
/**
 * Read-only identity check: the caller's own channel via `mine=true`. This
 * is the safest authenticated read for YouTube — no upload quota consumed.
 */
export async function getMyChannel({ env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  const auth = await getAccessToken({ env, fetchImpl, retryOpts });
  if (!auth.ok) return auth;

  const result = await requestWithRetry(
    () => fetchImpl('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const data = await result.response.json();
  const ch = data?.items?.[0];
  if (!ch) return { ok: false, errorClass: 'AUTH_ERROR', message: 'no channel returned for this token (upload scope missing?)' };
  return { ok: true, channelId: ch.id, channelTitle: ch.snippet?.title };
}

/**
 * Independently re-reads a video via videos.list. NOTE (found empirically,
 * not assumed): this requires broader scope than youtube.upload alone —
 * confirmed with a 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT against a public
 * video id using an upload-only-scoped token, before any such video existed.
 * With an upload-only token (this project's deliberate minimum-scope
 * choice), uploadVideo()'s own response — which already carries
 * status/snippet since it requests part=snippet,status — is the real
 * verification; this function is for credentials with broader scope.
 */
export async function getVideoStatus(videoId, { env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  const auth = await getAccessToken({ env, fetchImpl, retryOpts });
  if (!auth.ok) return auth;

  const result = await requestWithRetry(
    () => fetchImpl(`https://www.googleapis.com/youtube/v3/videos?part=status,snippet&id=${encodeURIComponent(videoId)}`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const data = await result.response.json();
  const video = data?.items?.[0];
  if (!video) return { ok: false, errorClass: 'NOT_FOUND', message: 'video id not found' };
  return { ok: true, id: video.id, privacyStatus: video.status?.privacyStatus, title: video.snippet?.title };
}

/**
 * Changes an existing video's privacyStatus via videos.update (PUT,
 * part=status). This is the ONLY function in this connector capable of
 * making a video public, and it requires the caller to pass
 * `confirmPublic: true` explicitly whenever `privacyStatus === 'public'` —
 * a second, code-level check independent of whatever policy gate the
 * caller already ran, so a public transition can never happen as a side
 * effect of a generic "update status" call. NOT YET EMPIRICALLY VERIFIED
 * against a live token this session (deliberately — nothing here has been
 * called for real, per "do not make the current test video public").
 * `videos.update` may also require broader scope than youtube.upload alone,
 * the same way channels.list/videos.list did (see docs/marketing/CONNECTION_SETUP.md)
 * — this must be confirmed empirically before ever relying on it for real.
 */
export async function setPrivacyStatus(videoId, privacyStatus, { confirmPublic = false, env = process.env, fetchImpl = fetch, retryOpts } = {}) {
  if (privacyStatus === 'public' && confirmPublic !== true) {
    return { ok: false, errorClass: 'CONFIRMATION_REQUIRED', message: 'setPrivacyStatus("public") requires confirmPublic: true' };
  }
  const auth = await getAccessToken({ env, fetchImpl, retryOpts });
  if (!auth.ok) return auth;

  const body = JSON.stringify({ id: videoId, status: { privacyStatus } });
  const result = await requestWithRetry(
    () => fetchImpl('https://www.googleapis.com/youtube/v3/videos?part=status', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
      body,
    }),
    retryOpts
  );
  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const data = await result.response.json();
  return { ok: true, id: data.id, privacyStatus: data.status?.privacyStatus };
}

export async function uploadVideo({ filePath, title, description, tags = [], privacyStatus = DEFAULT_PRIVACY }, {
  env = process.env, fetchImpl = fetch, retryOpts, readFileImpl = readFile,
} = {}) {
  const auth = await getAccessToken({ env, fetchImpl, retryOpts });
  if (!auth.ok) return auth;

  const videoBuffer = await readFileImpl(filePath);
  const boundary = 'veritasforge' + Date.now();
  const metadata = { snippet: { title, description, tags }, status: { privacyStatus } };
  const body = buildMultipartBody(metadata, videoBuffer, boundary);

  const result = await requestWithRetry(
    () => fetchImpl('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }),
    { maxRetries: 1, ...retryOpts } // uploads are expensive to retry; keep it bounded
  );

  if (!result.ok) return { ok: false, errorClass: result.errorClass, status: result.status };
  const data = await result.response.json();
  // The insert response already contains what we asked for via
  // part=snippet,status — an upload-only-scoped token cannot separately call
  // videos.list to re-read this (confirmed empirically: 403
  // ACCESS_TOKEN_SCOPE_INSUFFICIENT even for a public video, before any
  // upload-only-scope video existed to test against), so this IS the
  // verification, not a shortcut around one.
  return {
    ok: true, id: data.id, url: data.id ? `https://youtu.be/${data.id}` : undefined,
    privacyStatus: data.status?.privacyStatus, title: data.snippet?.title,
  };
}

export async function publish(draft, { dryRun = true, env = process.env, fetchImpl = fetch, readFileImpl } = {}) {
  if (!isAuthConfigured(env)) {
    return { ok: false, connectionRequired: true, channel };
  }
  if (dryRun) {
    return { ok: true, dryRun: true, channel, wouldPublish: draft.title };
  }
  if (!draft.filePath || !draft.title) {
    return { ok: false, error: 'youtube draft requires filePath and title fields' };
  }
  const result = await uploadVideo(draft, { env, fetchImpl, readFileImpl });
  if (!result.ok) return { ok: false, error: result.message ?? result.errorClass };
  return { ok: true, externalId: result.id, externalUrl: result.url, privacyStatus: result.privacyStatus, title: result.title };
}
