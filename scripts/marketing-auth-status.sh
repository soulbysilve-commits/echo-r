#!/usr/bin/env bash
# Reports ONLY which required environment variable NAMES are missing per
# channel — never values. Credentials load from the private, untracked
# secrets file outside every git worktree (see docs/marketing/CONNECTION_SETUP.md).
#
# Usage:
#   scripts/marketing-auth-status.sh          # all channels
#   scripts/marketing-auth-status.sh x        # just one channel
set -euo pipefail

SECRETS_FILE="${MARKETING_SECRETS_FILE:-$HOME/.config/veritas-forge-marketing/secrets.env}"
if [ -f "$SECRETS_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
  set +a
fi
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$REPO_ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env.local"
  set +a
fi

FILTER="${1:-}"

declare -A REQUIRED_VARS=(
  [x]="X_API_KEY X_API_SECRET X_ACCESS_TOKEN X_ACCESS_TOKEN_SECRET"
  [youtube]="YOUTUBE_CLIENT_ID YOUTUBE_CLIENT_SECRET YOUTUBE_REFRESH_TOKEN"
  [discord]="DISCORD_WEBHOOK_URL"
  [reddit]="REDDIT_CLIENT_ID REDDIT_CLIENT_SECRET REDDIT_USERNAME REDDIT_PASSWORD"
  [qiita]="QIITA_ACCESS_TOKEN"
)
declare -A ENABLE_FLAGS=(
  [x]="MARKETING_X_ENABLED" [youtube]="MARKETING_YOUTUBE_ENABLED" [discord]="MARKETING_DISCORD_ENABLED"
  [reddit]="MARKETING_REDDIT_ENABLED" [qiita]="MARKETING_QIITA_ENABLED"
)

# Print channels in a fixed, priority order (x/youtube first, per current focus).
ORDER="x youtube discord reddit qiita"

for channel in $ORDER; do
  if [ -n "$FILTER" ] && [ "$FILTER" != "$channel" ]; then continue; fi
  echo "=== ${channel^^} ==="
  missing=0
  for var in ${REQUIRED_VARS[$channel]}; do
    if [ -z "${!var:-}" ]; then
      echo "  MISSING: $var"
      missing=1
    else
      echo "  PRESENT: $var"
    fi
  done
  flag="${ENABLE_FLAGS[$channel]}"
  echo "  ENABLE_FLAG: $flag=${!flag:-false}"
  if [ "$missing" -eq 0 ]; then
    echo "  -> all required vars present (does not confirm validity — run: node tools/marketing/cli.mjs auth-check $channel)"
  fi
  echo
done

if [ -z "$FILTER" ]; then
  echo "MARKETING_MODE=${MARKETING_MODE:-DRY_RUN}"
  echo "ECHO_MARKETING_AUTOMATION_ENABLED=${ECHO_MARKETING_AUTOMATION_ENABLED:-false}"
  echo
  echo "Secrets file: $SECRETS_FILE $([ -f "$SECRETS_FILE" ] && echo "(exists, mode $(stat -c '%a' "$SECRETS_FILE" 2>/dev/null || echo '?'))" || echo "(not found)")"
fi
