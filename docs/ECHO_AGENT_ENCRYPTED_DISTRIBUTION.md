# ECHO Agent — Encrypted Distribution (v1)

Covers the private storage, envelope encryption, and delivery model
for the compiled ECHO Agent release artifact. Companion to
`ECHO_AGENT_FULFILLMENT.md` (the authorization flow that gates access
to what's described here) and `ECHO_AGENT_LICENSE.md` (per-purchaser
licensing).

## Important security claim (read this first)

This is **private-distribution-at-rest encryption + authorized
delivery** — not a claim that the binary a customer eventually runs on
their own machine is somehow unrecoverable. The Nuitka standalone
build's own hardening (`no_docstrings`, source exclusion, the existing
planner-text obfuscation documented in the ECHODiscord版 repo's
`docs/PROPRIETARY_RELEASE_BUILD.md`) is unchanged and not weakened by
anything here. `ANTI_REVERSE_ENGINEERING_CLAIM=false`.

## What's actually private

The release artifact — a ZIP of both compiled Nuitka `.dist` output
directories — is **never** placed under `public/`, `static/`, or any
Next.js public asset path, and no public URL for it exists anywhere in
this codebase (`PUBLIC_ARTIFACT_PRESENT=false`, verified this session
by attempting direct requests to plausible static paths against a real
running server — both 404). It lives only in private, authenticated
S3-compatible object storage (`lib/storage.ts`,
`ECHO_AGENT_STORAGE_*`), and is only ever readable by this server's
own backend code, gated on the authorization flow in
`ECHO_AGENT_FULFILLMENT.md`.

## Envelope encryption (AES-256-GCM, standard primitives only)

`lib/artifactCrypto.ts` — Node's own `crypto.createCipheriv`/
`createDecipheriv`, no custom cipher construction:

1. A fresh random 256-bit DEK (data encryption key) per release.
2. The release ZIP is AES-256-GCM-encrypted under that DEK (random
   96-bit IV, standard GCM auth tag).
3. The DEK itself is wrapped (also AES-256-GCM) under a server-side
   KEK (key encryption key) — `ECHO_AGENT_ARTIFACT_KEK_B64`, a 32-byte
   secret that:
   - Never enters this repo.
   - Never enters the artifact or the license.
   - Never reaches the browser.
   - Is never logged (grepped for this session — absent from all
     application logs and from the manifest itself).
4. Only the **wrapped** DEK is stored, in the release manifest, never
   the raw DEK.

## Release manifest

`lib/release.ts` `ReleaseManifest` — stored at
`artifacts/<release-id>/manifest.json`, alongside the encrypted object
at `artifacts/<release-id>/artifact.enc`:

```json
{
  "schema": "veritasforge.echo-agent.release-manifest.v1",
  "release_id": "...",
  "artifact_sha256": "... (plaintext ZIP hash)",
  "encrypted_sha256": "... (ciphertext hash)",
  "algorithm": "aes-256-gcm",
  "iv": "... (base64)",
  "auth_tag": "... (base64)",
  "wrapped_dek": "... (base64)",
  "wrapped_dek_iv": "... (base64)",
  "wrapped_dek_auth_tag": "... (base64)",
  "original_filename": "ECHO-Agent-<release-id>.zip",
  "content_type": "application/zip",
  "byte_size": 30149822,
  "created_at": "..."
}
```

No plaintext DEK, KEK, or any other secret ever appears in the
manifest.

## Packaging (`scripts/package-echo-agent-release.mjs`)

Operator-run, not part of any request path or `npm run build`. Takes
the Nuitka build output directories (see the ECHODiscord版 repo's
`docs/PROPRIETARY_RELEASE_BUILD.md`), assembles them into one ZIP
(`scripts/lib/zip.mjs` — a small dependency-free ZIP writer; no `zip`
binary or third-party package needed), encrypts it, and uploads the
encrypted object + manifest.

**Known-sensitive paths are excluded unconditionally** — a compiled
binary's default state root is relative to its own bundle directory,
so smoke-testing a build in place (exactly what verifying this
pipeline required) can leave real runtime state (WAL files, task
records) sitting right next to the binary; `scripts/lib/zip.mjs`
excludes `real_account_agent_state/`, `.env_users/`, `backups/`,
`__pycache__/`, `.env*`, `*.log`, `*.db*` by name/pattern regardless of
what an operator's local build workspace happens to contain, mirroring
the same list already established in the ECHODiscord版 repo's own
`.gitignore`/`docs/DEVELOPER_RELEASE_MANIFEST.md`. **This was not a
hypothetical** — the first real packaging run this session shipped a
WAL file from this session's own binary smoke-test before the
exclusion was added; caught, fixed, and re-verified before treating
the pipeline as done.

If `ECHO_AGENT_STORAGE_*` isn't configured, the script still encrypts
and writes the result locally, and reports the upload as `SKIPPED` —
never fakes a successful upload.

## Download delivery (`app/api/echo-agent-download/route.ts`)

Only reachable after the full authorization chain in
`ECHO_AGENT_FULFILLMENT.md` issues a one-time token. On a valid,
unconsumed token:

1. Atomically claims the token (see `ECHO_AGENT_FULFILLMENT.md`
   "Download token TTL and one-time semantics").
2. Unwraps the DEK with the KEK (throws — request fails — on any
   tamper or wrong KEK; GCM authentication failure is fatal by design,
   never swallowed).
3. Streams the encrypted object from storage through
   `crypto.createDecipheriv`, chunk by chunk, straight into the HTTP
   response body (`Content-Disposition: attachment`). **No plaintext
   copy is ever written to disk anywhere** — decryption happens
   in-memory, request-scoped; the unwrapped DEK and decrypted bytes
   exist only for the lifetime of that single request.

## Measured artifact size and platform fit

The real compiled release built this session: two Nuitka standalone
`.dist` directories, ~41MB each (~82MB combined uncompressed), packed
into a ~29–30MB ZIP (DEFLATE). Well within a single Vercel Node
function invocation's streaming response — no chunked/presigned-URL
fallback was needed for this artifact size.
`export const maxDuration = 60` on the download route is a generous
margin over the few seconds actual decrypt+stream took in this
session's own real, full end-to-end test (real Nuitka binaries,
packaged, uploaded, downloaded, decrypted, SHA-256-verified byte-for-
byte identical to the source ZIP, extracted, and executed
successfully). If a future release grows past what a single function
invocation can comfortably stream, the documented fallback (a
short-lived presigned URL, explicitly *not* strict one-time) is
described in the original integration spec §15 — not implemented here
because it wasn't needed for the artifact actually built.

## `STRICT_ONE_TIME_DOWNLOAD`

`true` for this implementation, backed by the storage layer's atomic
conditional-write primitive (`IfNoneMatch: "*"`, supported by both AWS
S3 and Cloudflare R2) — not an in-memory Set, not a "get then put"
check with a race window. If a provider's conditional write is ever
found to be unsupported/unreliable in practice, `putObjectIfAbsent`
(`lib/storage.ts`) throws rather than silently downgrading to a
non-atomic write, so this claim is never made falsely.
