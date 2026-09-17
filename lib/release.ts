import { getObjectStore } from "./storage.ts";

/**
 * The private, encrypted ECHO Agent release artifact + its manifest.
 * Both live under fixed, predictable storage keys derived from a
 * release id (ECHO_AGENT_ARTIFACT_RELEASE_ID) -- never a public URL,
 * never under public/static. See ECHO_AGENT_ENCRYPTED_DISTRIBUTION.md
 * for the full manifest schema and threat model.
 */

/** One KEK-wrapped copy of a release's DEK. `wrapped_dek` unwraps
 * (AES-256-GCM, see lib/artifactCrypto.ts unwrapDek) to the exact same
 * DEK as every other wrap of the same release -- only the wrapping KEK
 * differs between environments. Proven safe by
 * scripts/test-echo-agent-crypto.mjs's rewrap-under-independent-KEKs
 * cases: two different KEKs each produce a different `wrapped_dek` for
 * the identical DEK, each unwraps back to the identical DEK under its
 * own KEK, and neither KEK can unwrap the other's wrapped_dek. */
export interface WrappedDekEntry {
  wrapped_dek: string; // base64
  wrapped_dek_iv: string; // base64
  wrapped_dek_auth_tag: string; // base64
}

export interface ReleaseManifest {
  schema: "veritasforge.echo-agent.release-manifest.v1";
  release_id: string;
  artifact_sha256: string;
  encrypted_sha256: string;
  algorithm: "aes-256-gcm";
  iv: string; // base64
  auth_tag: string; // base64
  // Legacy/default wrap -- always present, always the wrap produced by
  // scripts/package-echo-agent-release.mjs at packaging time (today,
  // wrapped under whichever ECHO_AGENT_ARTIFACT_KEK_B64 the operator
  // had configured when they ran that script). Every manifest ever
  // written has these three fields; nothing here changes their
  // meaning or removes them -- this is what keeps every existing
  // manifest in storage (including the real
  // echoagent-win-20260913T022010Z-f950a3424ee4 one) working exactly
  // as before with zero migration required.
  wrapped_dek: string; // base64
  wrapped_dek_iv: string; // base64
  wrapped_dek_auth_tag: string; // base64
  // NEW, additive, optional: per-environment KEK-wrapped copies of the
  // SAME DEK used above, keyed by the same short environment token
  // lib/entitlement.ts's ECHO_AGENT_FULFILLMENT_NAMESPACE already
  // uses (e.g. "production"). Absent (every manifest written before
  // this field existed, and any manifest an operator hasn't bothered
  // to rewrap) means "no environment-specific wrap exists yet" --
  // callers MUST fall back to the legacy `wrapped_dek*` fields above,
  // never treat a missing entry as an error. This lets Sandbox and
  // Production each unwrap the identical shared, immutable
  // artifact.enc under their OWN independent KEK without ever
  // re-encrypting or duplicating that (potentially tens-of-MB)
  // ciphertext, and without requiring KEK sharing between
  // environments. See docs/security/ECHO_AGENT_ENV_SECRET_BOUNDARY.md.
  wrapped_dek_by_env?: Record<string, WrappedDekEntry>;
  original_filename: string;
  content_type: string;
  byte_size: number;
  created_at: string;
}

/** Picks which wrapped-DEK fields to unwrap for a given environment
 * token (e.g. process.env.ECHO_AGENT_FULFILLMENT_NAMESPACE, the same
 * value lib/entitlement.ts already uses to namespace storage keys --
 * pass null/undefined for the unnamespaced/Sandbox default). Returns
 * the environment-specific entry from `wrapped_dek_by_env` if one
 * exists for that token; otherwise falls back to the manifest's
 * legacy top-level fields. Never throws, never guesses a KEK -- it
 * only selects which already-wrapped bytes to hand to unwrapDek(); an
 * actually-wrong KEK still fails closed there via GCM auth failure. */
export function selectWrappedDek(manifest: ReleaseManifest, envToken: string | null | undefined): WrappedDekEntry {
  if (envToken) {
    const entry = manifest.wrapped_dek_by_env?.[envToken];
    if (entry) return entry;
  }
  return {
    wrapped_dek: manifest.wrapped_dek,
    wrapped_dek_iv: manifest.wrapped_dek_iv,
    wrapped_dek_auth_tag: manifest.wrapped_dek_auth_tag,
  };
}

export function releaseManifestKey(releaseId: string): string {
  return `artifacts/${releaseId}/manifest.json`;
}

export function releaseArtifactKey(releaseId: string): string {
  return `artifacts/${releaseId}/artifact.enc`;
}

export async function getReleaseManifest(releaseId: string): Promise<ReleaseManifest | null> {
  const store = getObjectStore();
  if (!store) return null;
  const key = releaseManifestKey(releaseId);
  const head = await store.headObject(key);
  if (!head.exists) return null;
  const buf = await store.getObjectBuffer(key);
  return JSON.parse(buf.toString("utf8")) as ReleaseManifest;
}
