# ECHO Agent — License Signing & Verification (v1)

Covers per-purchaser license issuance (this repo, server-side) and
offline verification (`echo_agent_license_v1.py`, ECHODiscord版 repo).

## Design constraint this had to satisfy

From the ECHODiscord版 repo's own
`docs/DEVELOPER_RELEASE_BUSINESS_CHECKLIST.md` §2, written before this
work started: *"no secret key material should be embedded in the
client binary"* and the mechanism must not *"silently break the
product's offline, no-forced-cloud-connection default."* Both are
satisfied by construction below: only a **public** key is embedded in
the binary, and verification is a purely local file check with no
network call.

## Ed25519, not HMAC

Asymmetric signing (Ed25519) rather than a shared HMAC secret — an HMAC
secret would have to exist in the binary to verify locally, which
means it exists in every customer's copy and can be extracted. With
Ed25519, the binary only ever holds the **public** verification key;
the private signing key lives exclusively in this website's
server-side environment (`ECHO_AGENT_LICENSE_PRIVATE_KEY`, PKCS8 DER,
base64) and is never committed, logged, or transmitted anywhere.

Cross-language compatibility (Node signs, Python verifies) was
verified directly this session: a Node-generated Ed25519 key pair
signed a test payload, and Python's `cryptography` library verified
that exact signature successfully — Ed25519 (RFC 8032) is a
deterministic, fully portable signature scheme with no
format/encoding ambiguity between implementations, unlike e.g. ECDSA's
DER-vs-raw signature encodings.

## Canonical JSON (must match byte-for-byte)

Both `lib/license.ts` `canonicalJson()` (Node) and
`echo_agent_license_v1.py` `_canonical_json_bytes()` (Python) implement
the same algorithm: object keys sorted, no extra whitespace,
ASCII-safe. License payload fields are always machine-generated
ids/ISO-8601 timestamps/integers, so this is guaranteed ASCII-only by
construction — the one condition under which JS's raw-UTF8
`JSON.stringify` and Python's `ensure_ascii=True` `json.dumps` are
byte-identical. If a future payload field could ever contain non-ASCII
text, this guarantee would need revisiting on both sides together.

## License payload schema

```json
{
  "schema": "veritasforge.echo-agent.license.v1",
  "license_id": "lic_...",
  "entitlement_id": "...",
  "product": "echo-agent",
  "release_id": "...",
  "stripe_checkout_session_id": "cs_...",
  "stripe_subscription_id": null,
  "issued_at": "2026-...",
  "valid_until": "2027-...",
  "license_version": 1
}
```

**No customer email or other direct PII is embedded.** `entitlement_id`
is this integration's own Checkout Session ID — sufficient to trace an
issued license back to a Stripe order without carrying the customer's
identity inside the license file itself.

## Issuance (`lib/license.ts`, called from the download-token route)

Only reachable after every check in `ECHO_AGENT_FULFILLMENT.md`
"Two-layer verification" passes. `issueLicense()` throws — the whole
request fails closed with 503 — if `ECHO_AGENT_LICENSE_PRIVATE_KEY`
isn't configured; there is no fallback unsigned/placeholder license
path.

## Verification (`echo_agent_license_v1.py`, ECHODiscord版 repo)

Inserted at the very first line of both product entry points'
`main()` — `echo_agent_cli_v1.py` and
`echo_agent_computer_use_service_v1.py` — before any runtime, WAL, or
state construction happens. Reads `ECHO_AGENT_LICENSE_FILE` (default
`license.echo` next to the working directory). On any failure —
missing file, malformed JSON, wrong schema, wrong product, bad
signature, expired, unsupported `license_version` — prints a single
`HOLD_LICENSE_<REASON>` sentinel to **stderr** (mirroring the existing
`HOLD_MISSING_COMPUTER_USE_API_TOKEN` convention already used
elsewhere in that codebase) and returns a non-zero exit code. Never
raises past the gate, never defaults to allow on an unrecognized
input.

Verified directly against the real compiled binary this session, not
just the Python source: the actual Nuitka-built `echo_agent_cli_v1.bin`
correctly refuses to run at all without a license file
(`HOLD_LICENSE_LICENSE_FILE_MISSING`, exit 2), and correctly proceeds
once given a license signed by the real matching private key — full
round trip through packaging, encryption, upload, authorized download,
decryption, extraction, and execution.

## Offline verification, and what that means for cancellation

`valid_until` is checked purely locally — no network call, honoring
the design constraint above. This has a direct, unavoidable
consequence, stated plainly rather than glossed over: **canceling a
Stripe subscription cannot reach into a customer's machine and revoke
a license or binary already delivered to them.** It only stops *new*
license issuance (the download-token route re-checks live subscription
status before issuing anything — see `ECHO_AGENT_FULFILLMENT.md`). A
license already handed out remains valid, offline, until its own
`valid_until` naturally expires. This is a deliberate tradeoff for the
offline-first design constraint, not an oversight.

## Tests

`test_echo_agent_license_v1.py` (ECHODiscord版 repo, 16 cases): valid
signature, tampered payload, tampered signature, wrong public key,
expired, wrong product, wrong schema, missing required field,
malformed JSON, unsupported license version, missing license file,
garbage license file, and — because the real production private key
can never exist in that repo by design — a throwaway-keypair test
override (`ECHO_AGENT_LICENSE_TEST_PUBLIC_KEY_B64`, still fully
signature-verified, only substitutes *which* key is trusted) plus two
static checks confirming the module's own source contains no private
key material and no signing function. `scripts/test-echo-agent-crypto.mjs`
(this repo) covers the issuing side: valid signature verifies, tampered
payload/wrong key fail, and issuance itself fails closed when
`ECHO_AGENT_LICENSE_PRIVATE_KEY` is unset.
