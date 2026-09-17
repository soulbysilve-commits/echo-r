import { createDecipheriv } from "crypto";
import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";
import { getFulfillmentMode } from "../../../lib/stripe";
import { claimDownloadToken } from "../../../lib/entitlement";
import { getReleaseManifest, releaseArtifactKey, selectWrappedDek } from "../../../lib/release";
import { getObjectStore } from "../../../lib/storage";
import { unwrapDek } from "../../../lib/artifactCrypto";
import { verifyDownloadToken, DOWNLOAD_SESSION_COOKIE } from "../../../lib/downloadToken";

/**
 * Streams the decrypted ECHO Agent release artifact to an authorized,
 * one-time download session. Never reads a token from the URL/query
 * string -- only from the HttpOnly cookie set by
 * app/api/echo-agent-download-token. Never writes a plaintext copy to
 * disk anywhere; decryption happens in-memory, chunk by chunk, piped
 * straight into the HTTP response body.
 *
 * KEK unwrap happens here, request-scoped -- the unwrapped DEK and
 * plaintext bytes exist only for the lifetime of this single request.
 */

export const runtime = "nodejs";
// Real built release artifact is ~82MB (see
// ECHO_AGENT_ENCRYPTED_DISTRIBUTION.md for the measured size) -- 60s
// is a generous margin over the few seconds actual decrypt+stream
// takes at typical network speeds.
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (getFulfillmentMode() !== "automatic_download") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  const token = request.cookies.get(DOWNLOAD_SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "no download session" }, { status: 401 });
  }

  const verified = verifyDownloadToken(token);
  if (!verified.ok) {
    const status = verified.reason === "expired" ? 401 : verified.reason === "not_configured" ? 503 : 403;
    return NextResponse.json({ error: verified.reason }, { status });
  }

  // Atomic one-time consumption -- the storage layer's conditional
  // create-if-absent is the actual enforcement; a second request with
  // the same jti (replay, double-click, or a genuine race) can only
  // ever have one winner.
  let claim: { claimed: boolean };
  try {
    claim = await claimDownloadToken(verified.payload.jti);
  } catch (error) {
    console.error("download: could not record one-time claim:", error);
    return NextResponse.json({ error: "fulfillment storage not available" }, { status: 503 });
  }
  if (!claim.claimed) {
    return NextResponse.json({ error: "download already used" }, { status: 410 });
  }

  const store = getObjectStore();
  if (!store) {
    return NextResponse.json({ error: "storage not configured" }, { status: 503 });
  }

  const manifest = await getReleaseManifest(verified.payload.releaseId).catch(() => null);
  if (!manifest) {
    console.error("download: release manifest not found:", verified.payload.releaseId);
    return NextResponse.json({ error: "release not available" }, { status: 503 });
  }

  const kekRaw = process.env.ECHO_AGENT_ARTIFACT_KEK_B64;
  if (!kekRaw) {
    return NextResponse.json({ error: "artifact encryption not configured" }, { status: 503 });
  }
  const kek = Buffer.from(kekRaw.trim(), "base64");
  if (kek.length !== 32) {
    console.error("download: ECHO_AGENT_ARTIFACT_KEK_B64 is not a valid 32-byte key");
    return NextResponse.json({ error: "artifact encryption misconfigured" }, { status: 503 });
  }

  // Selects this environment's own wrapped_dek entry (keyed by the
  // same ECHO_AGENT_FULFILLMENT_NAMESPACE token lib/entitlement.ts
  // already uses to namespace storage keys) if the manifest has one,
  // otherwise falls back to the manifest's legacy top-level wrap --
  // see lib/release.ts selectWrappedDek(). Today, no manifest has a
  // wrapped_dek_by_env entry yet, so this is byte-for-byte the same
  // lookup as before for every existing release; it only starts
  // mattering once an operator additively rewraps a release for a
  // second environment (docs/security/ECHO_AGENT_ENV_SECRET_BOUNDARY.md).
  const wrappedEntry = selectWrappedDek(manifest, process.env.ECHO_AGENT_FULFILLMENT_NAMESPACE);

  let dek: Buffer;
  try {
    dek = unwrapDek(
      {
        wrappedDek: Buffer.from(wrappedEntry.wrapped_dek, "base64"),
        wrappedDekIv: Buffer.from(wrappedEntry.wrapped_dek_iv, "base64"),
        wrappedDekAuthTag: Buffer.from(wrappedEntry.wrapped_dek_auth_tag, "base64"),
      },
      kek,
    );
  } catch (error) {
    console.error("download: DEK unwrap failed (wrong KEK or tampered manifest):", error);
    return NextResponse.json({ error: "artifact unavailable" }, { status: 500 });
  }

  let encryptedStream: Readable;
  try {
    encryptedStream = await store.getObjectStream(releaseArtifactKey(verified.payload.releaseId));
  } catch (error) {
    console.error("download: encrypted artifact object not found:", verified.payload.releaseId, error);
    return NextResponse.json({ error: "artifact unavailable" }, { status: 503 });
  }

  const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(manifest.iv, "base64"));
  decipher.setAuthTag(Buffer.from(manifest.auth_tag, "base64"));
  decipher.on("error", (error) => {
    console.error("download: artifact decrypt/auth failed mid-stream:", error);
  });

  const decryptedStream = encryptedStream.pipe(decipher);
  const webStream = Readable.toWeb(decryptedStream) as unknown as ReadableStream<Uint8Array>;

  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": manifest.content_type || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${manifest.original_filename}"`,
      "Content-Length": String(manifest.byte_size),
      "Cache-Control": "no-store",
    },
  });
}
