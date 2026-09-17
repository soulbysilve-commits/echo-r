import { createHash } from "crypto";
import type { NextRequest } from "next/server";
import { constantTimeEqualHex } from "./artifactCrypto";

/** Name of the HttpOnly cookie binding a browser to the Checkout
 * Session it created (set by app/api/echo-agent-checkout/route.ts,
 * read by app/api/echo-agent-download-token/route.ts). Never trust
 * session_id alone as proof that the browser asking for a download
 * token is the one that paid -- see ECHO_AGENT_FULFILLMENT.md
 * "Checkout browser binding". */
export const CHECKOUT_NONCE_COOKIE = "echo_agent_checkout_nonce";

export function hashCheckoutNonceHex(nonceHex: string): string {
  return createHash("sha256").update(Buffer.from(nonceHex, "hex")).digest("hex");
}

/** Shared browser-binding check, factored out of
 * app/api/echo-agent-download-token/route.ts so
 * app/api/echo-agent-activation-code/route.ts (retrieving the
 * customer's activation code for on-screen display) uses the exact
 * same verification, not a re-implementation that could quietly
 * drift. `expectedHash` is `session.metadata.checkout_nonce_hash`
 * from the live-refetched Checkout Session -- callers must always
 * pass the freshly-retrieved value, never a cached one. */
export function verifyCheckoutNonceCookie(request: NextRequest, expectedHash: string | null | undefined): boolean {
  const cookieNonceHex = request.cookies.get(CHECKOUT_NONCE_COOKIE)?.value;
  if (!cookieNonceHex || typeof expectedHash !== "string" || !expectedHash) return false;
  let actualHash: string;
  try {
    actualHash = hashCheckoutNonceHex(cookieNonceHex);
  } catch {
    return false;
  }
  return constantTimeEqualHex(actualHash, expectedHash);
}
