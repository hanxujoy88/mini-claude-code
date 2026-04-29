#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$PROJECT_DIR/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env.local"
  set +a
elif [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env"
  set +a
fi

if [[ -z "${MINI_CLAUDE_API_KEY:-}" ]]; then
  echo "Missing MINI_CLAUDE_API_KEY."
  echo "Create $PROJECT_DIR/.env.local from .env.example, or run:"
  echo "  MINI_CLAUDE_API_KEY='sk-...' ./scripts/start-kimi.sh"
  exit 1
fi

export MINI_CLAUDE_PROVIDER="${MINI_CLAUDE_PROVIDER:-moonshot}"
export MINI_CLAUDE_MODEL="${MINI_CLAUDE_MODEL:-kimi-k2.6}"

cd "$PROJECT_DIR"
exec npm start -- "$@"
