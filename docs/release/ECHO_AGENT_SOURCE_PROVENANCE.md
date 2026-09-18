# ECHO Agent — Windows Release Source Provenance (plan)

Written 2026-09-18. This is a **separate** structural risk from the
license-signature incident (see
`docs/release/ECHO_AGENT_PROMOTION_GATE_REQUIREMENTS.md`) — it was
noticed while investigating that incident (the release Python sources
turned out to be untracked in the `ECHODiscord版` git repo), but the
signature bug itself was proven unrelated to this gap (both old and
new builds embed the byte-identical trust root; the drift was in a
local `.env.local` secret copy, not in the compiled sources).

## Current state

- `echo_agent_cli_v1.py`, `echo_agent_license_v1.py`, and the rest of
  the Windows release closure are **untracked** (`git status` shows
  `??`) in `/home/silver/ECHODiscord版`. There is no commit history to
  answer "what source produced this exact compiled binary" — the only
  evidence available is whatever was retained on disk at build time.
- The 2026-09-14 build (`C:\ECHOBuild\echo_agent_win_build_20260914T072331Z\`)
  *did* retain a `source_stage/` directory plus a hand-generated
  `SOURCE_SNAPSHOT_MANIFEST.txt` (SHA256 per staged file). This is
  exactly the right idea, done manually, once.
- The 2026-09-16 build
  (`C:\ECHOAgentProdRelease_20260916\`) retained `source_stage/` but
  had **no** manifest file — this gap is what made the earlier
  three-way hash comparison (old staged vs. new staged vs. current
  working tree) slower to establish than it should have been. A
  manifest was generated retroactively this session
  (`SOURCE_SNAPSHOT_MANIFEST.txt` in that same directory, hash-only,
  no source changed) as a stopgap, not a fix.

## Proposed durable fix

1. **Prefer git tracking for the real release sources**, in whatever
   repository is the actual source of truth for them, if there is no
   confidentiality/licensing reason they must stay out of version
   control. This is the strongest form of provenance (diffable
   history, blame, tags) and should be evaluated first before building
   parallel tooling to work around not having it.
2. **If they must stay untracked** (e.g. deliberate separation from a
   public or shared repo), make the manifest generation itself
   mechanical and mandatory, not hand-run:
   - A small script (same idea as `tools/compute_release_source_closure.py`,
     which already exists for deriving *which* files belong in the
     closure) that, given a `source_stage/` directory, writes
     `SOURCE_SNAPSHOT_MANIFEST.txt` with: relative file path, SHA256,
     and (if available) the source repository revision each file was
     copied from.
   - Run this script as a **required** step of the build process
     (`docs/PROPRIETARY_RELEASE_BUILD.md`), not an optional/manual
     one — the build should refuse to proceed (or at least loudly warn)
     if staging happened without producing this file.
   - Append the compiled executable's own SHA256 and the license
     trust-root public-key fingerprint to the same manifest once the
     build finishes, so one file answers "what source, what binary,
     what trust root" for a given release together.
3. **Keep every build's manifest+source_stage** (not just the most
   recent) somewhere durable, so a future incident like this one can
   do the same three-way comparison without needing to locate
   scattered build directories by guesswork, as this session did.

## Not done by this document

No script was written or installed this session — this is a plan
only, per the instruction that source-provenance hardening not be
mixed with the signer-incident work. If this plan is approved, the
manifest-generation script belongs in the `ECHODiscord版` repo (the
actual build repo), not in `echo-r`.
