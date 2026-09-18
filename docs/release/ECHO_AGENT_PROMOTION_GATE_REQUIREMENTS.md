# ECHO Agent — Production Promotion Gate Requirements

Written 2026-09-18, after the license-signature incident on release
`echoagent-win-20260916T154527Z-64d6d128` (see
`docs/security/ECHO_AGENT_ENV_SECRET_BOUNDARY.md` and
`scripts/test-echo-agent-license-signer-trust-root.mjs`). There is no
automated release orchestrator in this repo today — every promotion so
far has been a manually-run, manually-gated sequence. This document
records the sequence that manual process must always follow, so a
future orchestrator (or a future manual operator) has a single
authoritative checklist instead of re-deriving it each time.

## Required sequence

A candidate release must pass every stage below, in order, before the
next stage may begin. A release must **never** reach
`PROMOTION_READY` if any stage failed or was skipped.

1. **Candidate discovered** — dist directory exists, executable SHA256
   matches the recorded build hash.
2. **Source/release validation** — the compiled dist contains no stray
   `.py`/`.pyc`, no planner-prompt leak, no private-key marker, no
   embedded live secret value (see the string-scan pattern used in
   this incident's forensics).
3. **Compiled binary present** — PE format confirmed, required runtime
   DLLs/closure present (file count sanity check against the previous
   known-good release).
4. **Signer/trust-root proof** — the *actual* Production
   `ECHO_AGENT_LICENSE_PRIVATE_KEY` (never exported, never copied
   locally) must be proven, inside trusted Production runtime, to
   derive the same Ed25519 public key as the candidate binary's
   embedded `_PUBLIC_KEY_B64`. A **local** `.env.local` copy of the
   signing key is not sufficient evidence on its own — it can drift
   independently of the real Production value (exactly what happened
   in this incident) and must itself be checked against the known
   trust root (`scripts/verify-license-signer-matches-release.mjs`)
   before being trusted for anything, including a local smoke test.
5. **Compiled binary accepts a signer-compatible license** — a
   short-lived, unmistakably-synthetic license, signed by the proven
   signer from stage 4, must be accepted (not `HOLD_LICENSE_*`) by the
   actual compiled candidate binary. This is the step that would have
   caught this incident immediately, and did once corrected — see the
   A/B test against both the 09-14 and 09-16 binaries.
6. **`PACKAGE_READY`** — only after stages 1–5 all pass: KEK
   compatibility proven, local encrypt/decrypt roundtrip proven,
   fulfillment-compatibility proven (hermetic, local-only).
7. **`PROMOTION_READY`** — only after `PACKAGE_READY` and stage 5's
   binary-level license proof both hold for the *exact* candidate
   about to be promoted (not an earlier candidate with the same
   version number — rebuilding invalidates every prior proof and
   requires re-running the full sequence).

## Safe provenance to record per release (no private keys, ever)

- Compiled executable SHA256 (both CLI and service binaries where
  applicable).
- License trust-root **public**-key fingerprint (the public key
  itself is safe to record verbatim; it is not a secret).
- Source-closure hash manifest (see
  `docs/release/ECHO_AGENT_SOURCE_PROVENANCE.md` — separate document,
  since untracked Python release sources are a distinct structural
  risk from this incident and should not be conflated with it).
- Signer-compatibility PASS/FAIL and the timestamp it was proven at.
- Smoke-test timestamp and which two binaries (old/new) were compared.

## What this incident proved does *not* need to be re-litigated

- `release_id` is a carried license field, never bound/validated by
  the verifier (`echo_agent_license_v1.py`'s `verify_license_bytes`) —
  a promotion gate does not need per-release-id license reissuance
  logic; the same trust root and canonicalization apply across
  releases sharing that root.
- Canonical JSON compatibility between `lib/license.ts` (JS) and
  `echo_agent_license_v1.py` (Python) is proven stable for
  ASCII-only payload fields (the only kind this system issues) and is
  not a recurring risk unless the payload schema itself changes.

## What remains open

- No automated orchestrator exists yet to *enforce* this sequence
  mechanically — today it depends on a human (or an assisting agent)
  following this document. Building that enforcement is future work,
  not done by this document alone.
- Stage 4/5's Production-runtime proof requires a temporary,
  narrowly-scoped self-test route deployed to Production and removed
  immediately after — this is a real (if brief) Production deployment
  action and must be explicitly approved by the release owner each
  time, not automated without review.
