#!/usr/bin/env bash
# Non-interactive marketing operator wrapper (mandate section 33/34).
#
# Safety properties this script guarantees:
#   - single-run lock (flock) so overlapping timer/cron firings never run concurrently
#   - hard timeout on the underlying engine invocation
#   - logs are redacted for secret-shaped strings before being kept on disk
#   - never echoes environment variables
#   - exits non-zero on failure without ever raising an exception past this script
#
# Usage:
#   scripts/run-marketing-operator.sh                 # engine=claude (default), DRY_RUN unless
#                                                       # MARKETING_MODE=LIVE and
#                                                       # ECHO_MARKETING_AUTOMATION_ENABLED=true
#   MARKETING_OPERATOR_ENGINE=node scripts/run-marketing-operator.sh
#
# This script does NOT install itself as a cron/systemd job. See
# docs/marketing/SCHEDULER.md for the (manual, opt-in) activation step.

set -euo pipefail

# systemd --user runs with a minimal PATH (/usr/bin etc.) which on this
# machine resolves `node` to a stale v12 system package, not the v22 nvm
# install this project needs (discovered by actually triggering the unit,
# not just reading it — the failure mode is a SyntaxError on `??`, which is
# an easy one to misdiagnose as an application bug instead of a PATH issue).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" --no-use
  nvm use --silent default >/dev/null 2>&1 || true
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Durable state — outside this (disposable) git worktree. Matches
# tools/marketing/lib/paths.mjs's default; override both consistently via
# MARKETING_STATE_DIR if you ever need to.
VAR_DIR="${MARKETING_STATE_DIR:-$HOME/.local/share/veritas-forge-marketing}"
LOG_DIR="$VAR_DIR/logs"
LOCK_FILE="$VAR_DIR/operator.flock"
STATUS_FILE="$VAR_DIR/health.json"
export MARKETING_STATE_DIR="$VAR_DIR"
TIMEOUT_SECONDS="${MARKETING_OPERATOR_TIMEOUT_SECONDS:-600}"
ENGINE="${MARKETING_OPERATOR_ENGINE:-claude}"   # claude | node | test

mkdir -p "$LOG_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) SKIP_OVERLAP: another run holds $LOCK_FILE" >> "$LOG_DIR/operator.log"
  exit 0
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
LOG_FILE="$LOG_DIR/run-$RUN_ID.log"
STARTED_AT="$(date -u +%FT%TZ)"

# Credentials live in a private, untracked file OUTSIDE this (disposable)
# git worktree — never inside it. .env.local (if present, repo-local, also
# untracked/gitignored) is loaded second so it can override for local dev,
# but the durable source of truth is the private config dir. Neither is ever
# echoed.
SECRETS_FILE="${MARKETING_SECRETS_FILE:-$HOME/.config/veritas-forge-marketing/secrets.env}"
if [ -f "$SECRETS_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
  set +a
fi

# Pre-LIVE hardening: global safety-control variables must never be
# silently flippable by repo-local .env.local. If systemd's own
# Environment= (or SECRETS_FILE above) already set one of these, that
# trusted value is snapshotted here and force-restored after .env.local
# loads, no matter what .env.local says — repo-local config can still set
# these for a developer running this wrapper by hand with no trusted value
# already present (nothing to protect in that case), but it can never
# override a value the trusted parent environment already supplied. This is
# the actual enforcement point for the invariant every unit file comment
# in deploy/systemd/ claims ("always DRY_RUN... until a human deliberately
# changes this unit file") — before this, that claim was not quite true.
PROTECTED_ENV_VARS=(MARKETING_MODE ECHO_MARKETING_AUTOMATION_ENABLED)
declare -A _PROTECTED_VALUE
for _pv in "${PROTECTED_ENV_VARS[@]}"; do
  if [ -n "${!_pv+set}" ]; then
    _PROTECTED_VALUE[$_pv]="${!_pv}"
  fi
done

# Overridable (same pattern as SECRETS_FILE above) so tests can point this at
# an isolated temp file instead of ever touching the real repo root.
ENV_LOCAL_FILE="${MARKETING_ENV_LOCAL_FILE:-$REPO_ROOT/.env.local}"
if [ -f "$ENV_LOCAL_FILE" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ENV_LOCAL_FILE"
  set +a
  for _pv in "${PROTECTED_ENV_VARS[@]}"; do
    if [ -n "${_PROTECTED_VALUE[$_pv]+set}" ]; then
      export "$_pv=${_PROTECTED_VALUE[$_pv]}"
    fi
  done
fi
unset _pv

cd "$REPO_ROOT"

if [ "${MARKETING_OPERATOR_RUNNING:-}" = "1" ]; then
  echo "$(date -u +%FT%TZ) RECURSION_BLOCKED: already running inside a marketing operator invocation" >> "$LOG_FILE"
  exit 0
fi

EXIT_CODE=0
case "$ENGINE" in
  node)
    # No MARKETING_OPERATOR_RUNNING export here: this is a single, deterministic,
    # non-recursive command (cli.mjs run cannot invoke itself), so there is
    # nothing for the flag to guard against on this path — exporting it here
    # would make operator.mjs's own isNestedInvocation() check misfire against
    # its own first, legitimate invocation, which is exactly what happened
    # the first time this was tested for real under systemd.
    timeout "${TIMEOUT_SECONDS}s" node tools/marketing/cli.mjs run >> "$LOG_FILE" 2>&1 || EXIT_CODE=$?
    ;;
  claude)
    if ! command -v claude >/dev/null 2>&1; then
      echo "$(date -u +%FT%TZ) ERROR: claude CLI not found on PATH" >> "$LOG_FILE"
      EXIT_CODE=127
    else
      # Exported only for this branch: `claude -p` runs a full agentic session
      # that could, via its own tool use, try to re-invoke this wrapper or
      # `cli.mjs run` directly — both would inherit this and correctly refuse.
      export MARKETING_OPERATOR_RUNNING=1
      PROMPT_FILE="$REPO_ROOT/tools/marketing/operator-prompt.md"
      timeout "${TIMEOUT_SECONDS}s" claude -p "$(cat "$PROMPT_FILE")" --output-format json >> "$LOG_FILE" 2>&1 || EXIT_CODE=$?
    fi
    ;;
  test)
    # Test-only hook: run an arbitrary command via $MARKETING_TEST_COMMAND so the
    # lock/timeout/logging mechanics can be exercised without invoking claude or node cli.
    timeout "${TIMEOUT_SECONDS}s" bash -c "${MARKETING_TEST_COMMAND:-true}" >> "$LOG_FILE" 2>&1 || EXIT_CODE=$?
    ;;
  *)
    echo "unknown MARKETING_OPERATOR_ENGINE: $ENGINE" >&2
    EXIT_CODE=2
    ;;
esac

COMPLETED_AT="$(date -u +%FT%TZ)"

node "$REPO_ROOT/tools/marketing/scripts/redact-log.mjs" "$LOG_FILE" 2>/dev/null || true

cat > "$STATUS_FILE" <<JSON
{
  "run_id": "$RUN_ID",
  "engine": "$ENGINE",
  "started_at": "$STARTED_AT",
  "completed_at": "$COMPLETED_AT",
  "exit_code": $EXIT_CODE,
  "log_file": "$LOG_FILE"
}
JSON

exit "$EXIT_CODE"
