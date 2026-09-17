import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * Short-lived, single-purpose download authorization tokens for the
 * ECHO Agent encrypted artifact. HMAC-SHA256 signed (compact, not a
 * general-purpose JWT) -- see app/api/echo-agent-download-token and
 * app/api/echo-agent-download. The token itself never appears in a
 * URL/query string; it is only ever set into a short-lived HttpOnly
 * cookie by the token-issuing route and read back from that same
 * cookie by the download route.
 */

const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 3600;

/** HttpOnly cookie the download-token route sets and the download
 * route reads back; scoped to the download route's own path so it is
 * never sent anywhere else. The token is never placed in a URL/query
 * string. */
export const DOWNLOAD_SESSION_COOKIE = "echo_agent_download_session";

export interface DownloadTokenPayload {
  jti: string;
  sessionId: string;
  entitlementId: string;
  releaseId: string;
  issuedAt: string;
  expiresAt: string;
}

/** Reads and validates ECHO_AGENT_DOWNLOAD_TOKEN_TTL_SECONDS. Returns
 * null (fail closed) on an unset, non-numeric, non-positive, or
 * unreasonably large value -- never silently clamps a bad value into
 * something "close enough." */
export function getDownloadTokenTtlSeconds(): number | null {
  const raw = process.env.ECHO_AGENT_DOWNLOAD_TOKEN_TTL_SECONDS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return null;
  if (parsed > MAX_TTL_SECONDS) return null;
  return parsed;
}

function getSecret(): Buffer | null {
  const raw = process.env.ECHO_AGENT_DOWNLOAD_TOKEN_SECRET;
  if (typeof raw !== "string" || raw.trim().length < 16) return null;
  return Buffer.from(raw.trim(), "utf8");
}

export function isDownloadTokenSigningConfigured(): boolean {
  return getSecret() !== null;
}

function sign(payloadB64: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export interface IssueDownloadTokenInput {
  sessionId: string;
  entitlementId: string;
  releaseId: string;
}

/** Throws if signing is not configured or the TTL env value is
 * invalid -- callers must catch and fail closed (503), never issue an
 * unsigned/default-TTL token. */
export function issueDownloadToken(input: IssueDownloadTokenInput): { token: string; payload: DownloadTokenPayload } {
  const secret = getSecret();
  if (!secret) throw new Error("download_token_signing_not_configured");
  const ttlSeconds = getDownloadTokenTtlSeconds();
  if (ttlSeconds === null) throw new Error("download_token_ttl_invalid");

  const now = new Date();
  const payload: DownloadTokenPayload = {
    jti: randomBytes(24).toString("base64url"),
    sessionId: input.sessionId,
    entitlementId: input.entitlementId,
    releaseId: input.releaseId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = sign(payloadB64, secret);
  return { token: `${payloadB64}.${signature}`, payload };
}

export type VerifyDownloadTokenResult =
  | { ok: true; payload: DownloadTokenPayload }
  | { ok: false; reason: "not_configured" | "malformed" | "bad_signature" | "expired" };

export function verifyDownloadToken(token: string): VerifyDownloadTokenResult {
  const secret = getSecret();
  if (!secret) return { ok: false, reason: "not_configured" };

  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadB64, signature] = parts;

  const expectedSignature = sign(payloadB64, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: DownloadTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload?.jti !== "string" ||
    typeof payload?.sessionId !== "string" ||
    typeof payload?.entitlementId !== "string" ||
    typeof payload?.releaseId !== "string" ||
    typeof payload?.expiresAt !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }

  const expiresAt = new Date(payload.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload };
}
