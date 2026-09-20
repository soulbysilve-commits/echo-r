# Marketing Operator

Autonomous marketing system for Veritas Forge. See `docs/marketing/AUTONOMOUS_MARKETING_AUDIT.md` for current status and `docs/marketing/VERITAS_FORGE_PUBLIC_FACTS.md` for the claim registry every piece of content must trace to.

## CLI

```sh
node tools/marketing/cli.mjs status   # current operator/channel/ledger status
node tools/marketing/cli.mjs plan     # ranked story candidates from the fact registry
node tools/marketing/cli.mjs verify   # validate the fact registry itself
node tools/marketing/cli.mjs run      # one observe→select→draft→policy→publish→ledger cycle
node tools/marketing/cli.mjs sources                        # per-adapter source health
node tools/marketing/cli.mjs scan [echo-agent|echo-app|noemora|site] [--dry-run]  # read-only product-repo scan → marketing_events
node tools/marketing/cli.mjs activate                       # safe public-live activation: durable PUBLIC_LIVE_NOT_BEFORE boundary + backlog classification
node tools/marketing/cli.mjs video auto-run                 # full automatic video pipeline, one candidate
node tools/marketing/cli.mjs ymm4 status                    # real YMM4 process/bridge health check (never starts anything)
node tools/marketing/cli.mjs ymm4 ensure                    # one bounded safe auto-start/recovery attempt — see docs/marketing/YMM4_STARTUP_AUDIT.md
node tools/marketing/cli.mjs ymm4 idle-template status       # is the configured idle/bootstrap template (marketing_idle_blank.ymmp) verified clean (0 items)?
node tools/marketing/cli.mjs ymm4 idle-template create       # ONE-TIME, human/ops-triggered: create it via the live app's real CreateProject()/SaveProject(), then restore what was loaded — see docs/marketing/YMM4_STARTUP_AUDIT.md
node tools/marketing/cli.mjs connector status <name>         # is a real API client implemented + are credentials configured, for any channel
node tools/marketing/cli.mjs connector capability <hashnode|linkedin>  # live AUTH_REQUIRED/PLAN_REQUIRED/API_APPROVAL_REQUIRED/READY capability check
node tools/marketing/cli.mjs channel-run <channel> <factId> [subreddit]  # explicit, human/ops-triggered single-channel publish attempt — see "Multi-channel expansion" below
node tools/marketing/cli.mjs prepare producthunt <factId>    # builds and records a Product Hunt launch package, PENDING_HUMAN_APPROVAL, never submits
node tools/marketing/cli.mjs zenn generate <factId>          # generates a Zenn-formatted markdown article (published: false) into content/zenn/, never pushes
```

## Multi-channel expansion

Channels beyond X/YouTube (`docs/marketing/AUTONOMOUS_MARKETING_AUDIT.md`'s
original scope): Bluesky, Mastodon, DEV.to, Qiita (`AUTO_PUBLIC_ELIGIBLE`),
Zenn (`AUTO_DRAFT` — git-sync only, no write API), Hashnode/LinkedIn
(`CONDITIONAL_AUTO` — capability detection only), Reddit self-promotion/
Product Hunt/Hacker News/note (`HUMAN_APPROVAL_REQUIRED` —
`AUTO_PREPARE_HUMAN_APPROVAL`, never auto-submitted). See
`lib/channelPolicy.mjs` for the full class/mode registry and
`lib/multiChannelPublish.mjs`'s `publishToChannel()` for the shared
evidence/policy/kill-switch/per-channel-enable/activation-boundary/
frequency-guard/stagger pipeline every channel's explicit publish attempt
routes through. **Not wired into the unattended daily scheduler
(`run`/`runOnce`) yet** — every new channel is only ever triggered
explicitly via `channel-run`/`prepare`/`zenn generate`, same
"infrastructure first, never silently live" split as `canary`/`auth-check`.
New channel env vars (`MARKETING_<CHANNEL>_ENABLED`, per-channel
credentials, `MARKETING_<CHANNEL>_MAX_PER_DAY`/`MAX_PER_WEEK`) live in
`~/.config/veritas-forge-marketing/secrets.env`, never committed.

`run` now also runs the source scan + video pipeline daily cycle (see `docs/marketing/AUTOMATIC_EVENT_SOURCE_AUDIT.md` for what each adapter actually reads).

Modes (env vars):
- `MARKETING_MODE=DRY_RUN` (default) — observes, drafts, policy-checks, and records intent; never calls an external connector.
- `MARKETING_MODE=LIVE` — may publish, but only when `ECHO_MARKETING_AUTOMATION_ENABLED=true` (the kill switch, default `false`) and the target channel's connector is configured.

## Scheduling

Not installed by default. See `docs/marketing/SCHEDULER.md` and `scripts/run-marketing-operator.sh`.

## Tests

```sh
node --test "tools/marketing/test/**/*.test.mjs"
```

## Layout

```
tools/marketing/
├── cli.mjs              entry point
├── operator.mjs         observe → select → draft → policy → publish → ledger loop
├── operator-prompt.md    prompt used when scripts/run-marketing-operator.sh runs with ENGINE=claude
├── lib/
│   ├── db.mjs           node:sqlite schema + open/close
│   ├── facts.mjs        VERITAS_FORGE_PUBLIC_FACTS.md parser/validator
│   ├── scoring.mjs      MARKETING_VALUE ranking
│   ├── draft.mjs        fact -> channel-specific draft (claims always traceable to a FACT id)
│   ├── policy.mjs       risk classification + claim/spam/deception checks
│   ├── ledger.mjs       idempotent publication_ledger
│   ├── memory.mjs       marketing_memory (validated analytics)
│   ├── lock.mjs         single-run operator lock (stale-lock recovery)
│   ├── redact.mjs        secret redaction for logs
│   ├── sourceEventSchema.mjs   canonical normalized-event schema + fingerprint
│   ├── sourceQualityGate.mjs   INGEST/IGNORE/HOLD_PRIVATE/NEEDS_REVIEW classification
│   ├── sourceCursors.mjs       durable per-source scan cursors
│   ├── sourceIngestion.mjs     adapter -> normalize -> gate -> ingest -> cursor orchestration
│   ├── activation.mjs          durable PUBLIC_LIVE_NOT_BEFORE boundary + backlog classification
│   ├── ymm4Process.mjs         real Windows YMM4 process control (Get/Start/Stop-Process)
│   ├── ymm4Health.mjs          deterministic HEALTHY/NOT_RUNNING/.../STARTING check + durable ownership state
│   └── ymm4Startup.mjs         ensureYmm4Ready() — bounded safe auto-start/recovery, never a duplicate instance
├── sourceAdapters/       read-only per-product-repo evidence scanners (see AUTOMATIC_EVENT_SOURCE_AUDIT.md)
├── connectors/          per-channel isConfigured()/publish(); CONNECTION_REQUIRED when no credentials
├── windows/              native PowerShell (no WSL/Node dep) — YMM4 login startup task + installer, see YMM4_STARTUP_AUDIT.md
└── test/                node:test suite
```

No new npm dependencies — everything runs on Node 22's built-in `node:sqlite` and `node:test`.
