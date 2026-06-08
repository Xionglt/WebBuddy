#!/bin/bash
SCRIPT="$(readlink -f "$0" 2>/dev/null || realpath "$0")"
DIR="$(cd "$(dirname "$SCRIPT")/.." && pwd)"

if [ -f "$DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$DIR/.env"
  set +a
fi

: "${ANTHROPIC_BASE_URL:?Set ANTHROPIC_BASE_URL in .env or environment}"
: "${ANTHROPIC_AUTH_TOKEN:?Set ANTHROPIC_AUTH_TOKEN in .env or environment}"
: "${ANTHROPIC_MODEL:=glm-4.7}"
: "${API_TIMEOUT_MS:=3000000}"
: "${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:=1}"

exec node "$DIR/dist/cli.js" "$@"
