// Shared HTTP helper for real connector clients: bounded retry, backoff, and
// consistent error classification. Every real connector (x.mjs, discord.mjs,
// reddit.mjs, qiita.mjs, youtube.mjs) goes through this so retry/rate-limit
// behavior is implemented once and tested once.

export const ERROR_CLASS = {
  AUTH_ERROR: 'AUTH_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  BAD_REQUEST: 'BAD_REQUEST',
  TRANSIENT: 'TRANSIENT',
  UNKNOWN: 'UNKNOWN',
};

export function classifyStatus(status) {
  if (status === 401 || status === 403) return ERROR_CLASS.AUTH_ERROR;
  if (status === 429) return ERROR_CLASS.RATE_LIMITED;
  if (status >= 400 && status < 500) return ERROR_CLASS.BAD_REQUEST;
  if (status >= 500) return ERROR_CLASS.TRANSIENT;
  return ERROR_CLASS.UNKNOWN;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls `attemptFn()` which must return a Response-like object
 * ({ ok, status, headers: Map-like with .get(), json(), text() }).
 * Retries transient (5xx) failures with exponential backoff, up to
 * `maxRetries` times. Retries a single 429 once if the API tells us the
 * reset is within `maxRateLimitWaitMs`; otherwise surfaces RATE_LIMITED
 * immediately so the caller can defer to a later scheduled run instead of
 * blocking. Never retries 4xx (other than the bounded 429 case) — those are
 * request-shape errors that won't succeed on retry.
 */
export async function requestWithRetry(attemptFn, {
  maxRetries = 2,
  baseDelayMs = 300,
  maxRateLimitWaitMs = 5000,
  sleepFn = sleep,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response;
    try {
      response = await attemptFn();
    } catch (err) {
      lastError = { errorClass: ERROR_CLASS.TRANSIENT, message: String(err?.message ?? err) };
      if (attempt < maxRetries) {
        await sleepFn(baseDelayMs * 2 ** attempt);
        continue;
      }
      return { ok: false, ...lastError };
    }

    if (response.ok) {
      return { ok: true, response };
    }

    const errorClass = classifyStatus(response.status);

    if (errorClass === ERROR_CLASS.RATE_LIMITED) {
      const resetHeader = response.headers?.get?.('x-rate-limit-reset');
      const resetAt = resetHeader ? Number(resetHeader) * 1000 : null;
      const waitMs = resetAt ? Math.max(0, resetAt - Date.now()) : null;
      if (waitMs !== null && waitMs <= maxRateLimitWaitMs && attempt < maxRetries) {
        await sleepFn(waitMs);
        continue;
      }
      return { ok: false, errorClass, status: response.status, resetAt, response };
    }

    if (errorClass === ERROR_CLASS.TRANSIENT && attempt < maxRetries) {
      await sleepFn(baseDelayMs * 2 ** attempt);
      continue;
    }

    return { ok: false, errorClass, status: response.status, response };
  }
  return { ok: false, ...lastError };
}
