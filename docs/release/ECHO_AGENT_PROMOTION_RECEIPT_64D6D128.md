# ECHO Agent — Production Promotion Receipt

Release `echoagent-win-20260916T154527Z-64d6d128` promoted to Production
distribution, 2026-09-18, after the license-signature incident (see
`docs/security/ECHO_AGENT_ENV_SECRET_BOUNDARY.md`) and the manifest
repair that followed it. No secret value appears anywhere below.

## Result

```
PRODUCTION_PROMOTION_SUCCESS=true
ACTIVE_RELEASE=echoagent-win-20260916T154527Z-64d6d128
```

## Provenance

| Field | Value |
|---|---|
| Old release id | `echoagent-win-20260914T072837Z-57d883c6` |
| New release id | `echoagent-win-20260916T154527Z-64d6d128` |
| Repaired manifest SHA256 | `9d3b6182b83765c81ebf4cebbdd8c6f7f14a109593f11d2c7b3e84c114f4203b` |
| Artifact SHA256 | `ffdced743a12c7cf94f7313865f3828ccd02f37d4ee6b1f836b8ea6243a382fa` |
| Compiled exe SHA256 | `5e033f13ec2c47034674a045194bfade8aefa6b5db653ee000c5f6c4fc0ea71c` |
| Final Production deployment id | `dpl_BkQu7sokX9D6ftpgQWHLnP9ph4b1` |
| Final deployment source SHA | `d65b9e5cc09c74c784a5728d0b4af3b376a95df3` |
| Rollback target | `echoagent-win-20260914T072837Z-57d883c6` |
| Promotion timestamp | 2026-09-18T05:38:43Z (deployment created); alias confirmed on it same window |

## Verified, via real Production runtime (not inferred, not local-only)

```
LIVE_MANIFEST_LOAD=PASS
LIVE_PRODUCTION_WRAP_PRESENT=PASS
LIVE_ARTIFACT_LOAD=PASS
LIVE_ENCRYPTED_HASH_MATCH=PASS
LIVE_UNWRAP=PASS
LIVE_DECRYPT=PASS
LIVE_PLAINTEXT_HASH_MATCH=PASS
LIVE_FULFILLMENT_PROOF=PASS
LIVE_LICENSE_SIGNER_PROOF=PASS
LIVE_ONE_TIME_CLAIM_FIRST_USE=PASS
LIVE_ONE_TIME_CLAIM_REPLAY_REJECTED=PASS
```

## Sales state at time of promotion

```
STRIPE_SALES_LIVE_ENABLED=false (real isStripeLiveSalesEnabled() gate function, not the raw flag alone)
```

## What this receipt does NOT claim

Sales are not live. No purchase can currently complete on the live site's
own configured state beyond what was already true before this promotion.
No customer entitlement, download token, or one-time-claim state used in
verification was real — all diagnostic checks used clearly-synthetic,
non-customer identifiers, and none consumed a real entitlement or made a
real payment. This receipt is a technical integrity/compatibility record,
not a launch announcement.

## Incident this promotion resolves

See `docs/release/ECHO_AGENT_PROMOTION_GATE_REQUIREMENTS.md` and
`docs/security/ECHO_AGENT_ENV_SECRET_BOUNDARY.md` for the full incident
record: an earlier promotion attempt of this same release id was found to
be undecryptable in Production (missing `wrapped_dek_by_env.production`)
and was rolled back within the same session with zero customer impact
(0 entitlements, 0 completed purchases during the ~49-minute exposure
window). The manifest was then repaired in place — `artifact.enc` was
never rebuilt or modified — and independently re-verified via real
Production runtime twice (once before this final promotion, once after)
before this receipt was written.
