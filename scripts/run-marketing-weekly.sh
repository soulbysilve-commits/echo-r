#!/usr/bin/env bash
# Weekly wrapper — same lock/timeout/redacted-logging pattern as
# run-marketing-operator.sh, in its own lock file so a slow daily run and a
# weekly run never block each other unnecessarily (real overlap protection
# against a concurrent DAILY run is the shared operator_lock DB table both
# scripts' underlying node commands acquire — see lib/lock.mjs — this flock
# is only the OS-level guard against two weekly firings overlapping).
#
# Runs TWO things in sequence:
#   1. the weekly long-form operator (tools/marketing/weeklyLongForm.mjs /
#      weeklyOperator.mjs via `cli.mjs weekly-longform`) — DEV.to/Qiita
#      only, selects a COHERENT SET of several verified facts and drafts
#      one substantive article per channel, or NOOPs when there isn't
#      enough real technical material. Governed by MARKETING_MODE/
#      ECHO_MARKETING_AUTOMATION_ENABLED exactly like the daily operator.
#   2. the existing weekly report generator (`cli.mjs weekly`, lib/
#      weekly.mjs) — unchanged, read-only, now additionally reflects
#      whatever the long-form operator just did.
set -euo pipefail

# See run-marketing-operator.sh for why this is needed: systemd --user's
# minimal PATH resolves `node` to a stale v12 system package otherwise.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" --no-use
  nvm use --silent default >/dev/null 2>&1 || true
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Durable state — outside this (disposable) git worktree; see paths.mjs.
# (docs/marketing/reports/ stays IN the repo — those are meant to be
# committed history, unlike the lock/log files here.)
VAR_DIR="${MARKETING_STATE_DIR:-$HOME/.local/share/veritas-forge-marketing}"
LOG_DIR="$VAR_DIR/logs"
LOCK_FILE="$VAR_DIR/weekly.flock"
export MARKETING_STATE_DIR="$VAR_DIR"
TIMEOUT_SECONDS="${MARKETING_WEEKLY_TIMEOUT_SECONDS:-120}"

mkdir -p "$LOG_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) SKIP_OVERLAP: another weekly run holds $LOCK_FILE" >> "$LOG_DIR/weekly.log"
  exit 0
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
LOG_FILE="$LOG_DIR/weekly-$RUN_ID.log"

SECRETS_FILE="${MARKETING_SECRETS_FILE:-$HOME/.config/veritas-forge-marketing/secrets.env}"
if [ -f "$SECRETS_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
  set +a
fi

# Pre-LIVE hardening (same protection run-marketing-operator.sh already
# applies): MARKETING_MODE/ECHO_MARKETING_AUTOMATION_ENABLED must never be
# silently flippable by repo-local .env.local now that this wrapper can
# reach a real publish path, not just a read-only report.
PROTECTED_ENV_VARS=(MARKETING_MODE ECHO_MARKETING_AUTOMATION_ENABLED)
declare -A _PROTECTED_VALUE
for _pv in "${PROTECTED_ENV_VARS[@]}"; do
  if [ -n "${!_pv+set}" ]; then
    _PROTECTED_VALUE[$_pv]="${!_pv}"
  fi
done

if [ -f "$REPO_ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env.local"
  set +a
  for _pv in "${PROTECTED_ENV_VARS[@]}"; do
    if [ -n "${_PROTECTED_VALUE[$_pv]+set}" ]; then
      export "$_pv=${_PROTECTED_VALUE[$_pv]}"
    fi
  done
fi
unset _pv

cd "$REPO_ROOT"

EXIT_CODE=0
timeout "${TIMEOUT_SECONDS}s" node tools/marketing/cli.mjs weekly-longform >> "$LOG_FILE" 2>&1 || EXIT_CODE=$?
timeout "${TIMEOUT_SECONDS}s" node tools/marketing/cli.mjs weekly >> "$LOG_FILE" 2>&1 || EXIT_CODE=$?

node "$REPO_ROOT/tools/marketing/scripts/redact-log.mjs" "$LOG_FILE" 2>/dev/null || true

exit "$EXIT_CODE"
