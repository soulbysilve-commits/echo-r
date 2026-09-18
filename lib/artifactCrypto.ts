import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "crypto";

/**
 * AES-256-GCM envelope encryption for the ECHO Agent private artifact.
 *
 * Standard Node `crypto` primitives only -- no custom/home-rolled
 * cipher construction. A random 256-bit DEK (data encryption key)
 * encrypts the artifact bytes; the DEK itself is wrapped (also with
 * AES-256-GCM) under a server-side KEK (key encryption key,
 * ECHO_AGENT_ARTIFACT_KEK_B64) that never leaves this process, is
 * never logged, never sent to the browser, never stored in the
 * manifest, and never embedded in the artifact or the license.
 *
 * This is private-distribution-at-rest encryption plus authorized
 * delivery -- not a claim that the binary a customer eventually runs
 * on their own machine is unrecoverable. See
 * ECHO_AGENT_ENCRYPTED_DISTRIBUTION.md.
 */

const DEK_BYTES = 32; // AES-256
const IV_BYTES = 12; // standard GCM nonce size
const KEK_BYTES = 32; // AES-256

export interface AesGcmResult {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES);
}

function aesGcmEncrypt(plaintext: Buffer, key: Buffer): AesGcmResult {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

function aesGcmDecrypt(ciphertext: Buffer, key: Buffer, iv: Buffer, authTag: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  // Throws (auth tag mismatch) on any ciphertext/authTag/key tamper --
  // GCM authentication failure is fatal by design, never swallowed.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// `vercel env pull` cannot return plaintext for a Vercel "Sensitive"-typed
// variable (ECHO_AGENT_ARTIFACT_KEK_B64 is one) and substitutes this exact
// literal string instead. See docs/security/ECHO_AGENT_ENV_SECRET_BOUNDARY.md
// "Vercel Sensitive placeholder incident" -- this must never be treated as a
// usable KEK.
const VERCEL_SENSITIVE_PLACEHOLDER = "[SENSITIVE]";

function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Reads and validates ECHO_AGENT_ARTIFACT_KEK_B64. Returns null (not
 * throw) if unset/malformed so callers can fail closed with a clear
 * "not configured" response rather than a stack trace. */
export function getArtifactKek(): Buffer | null {
  const raw = process.env.ECHO_AGENT_ARTIFACT_KEK_B64;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (stripSurroundingQuotes(trimmed) === VERCEL_SENSITIVE_PLACEHOLDER) {
    console.error(
      "ECHO_AGENT_ARTIFACT_KEK_B64 is the Vercel Sensitive-variable placeholder; plaintext KEK is not available through env pull.",
    );
    return null;
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(trimmed, "base64");
  } catch {
    return null;
  }
  if (buf.length !== KEK_BYTES) return null;
  return buf;
}

export interface WrappedDek {
  wrappedDek: Buffer;
  wrappedDekIv: Buffer;
  wrappedDekAuthTag: Buffer;
}

export function wrapDek(dek: Buffer, kek: Buffer): WrappedDek {
  const { ciphertext, iv, authTag } = aesGcmEncrypt(dek, kek);
  return { wrappedDek: ciphertext, wrappedDekIv: iv, wrappedDekAuthTag: authTag };
}

/** Throws if the KEK is wrong or the wrapped DEK was tampered with --
 * callers must treat any throw here as a hard failure, never fall
 * back to an unwrapped/default key. */
export function unwrapDek(wrapped: WrappedDek, kek: Buffer): Buffer {
  return aesGcmDecrypt(wrapped.wrappedDek, kek, wrapped.wrappedDekIv, wrapped.wrappedDekAuthTag);
}

export interface EncryptedArtifact extends AesGcmResult {
  dek: Buffer;
}

/** Encrypts a full artifact buffer with a freshly generated DEK.
 * Callers wrap the returned `dek` with the KEK (wrapDek) before
 * persisting anything -- the raw DEK itself must never be written to
 * storage or the manifest. */
export function encryptArtifact(plaintext: Buffer): EncryptedArtifact {
  const dek = generateDek();
  const { ciphertext, iv, authTag } = aesGcmEncrypt(plaintext, dek);
  return { ciphertext, iv, authTag, dek };
}

/** Throws (GCM auth failure) on any ciphertext/authTag/DEK tamper. */
export function decryptArtifact(ciphertext: Buffer, dek: Buffer, iv: Buffer, authTag: Buffer): Buffer {
  return aesGcmDecrypt(ciphertext, dek, iv, authTag);
}

/** Constant-time comparison for the checkout-nonce-hash check and any
 * other secret-derived value comparison. Returns false (never throws)
 * on length mismatch instead of leaking timing information through an
 * early exception path. */
export function constantTimeEqualHex(aHex: string, bHex: string): boolean {
  if (typeof aHex !== "string" || typeof bHex !== "string") return false;
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
