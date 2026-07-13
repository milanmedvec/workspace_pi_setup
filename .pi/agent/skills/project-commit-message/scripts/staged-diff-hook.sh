#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <ticket_id>" >&2
  echo "Example: $0 25553" >&2
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

ticket_id="$1"
ticket_id="${ticket_id#\#}"

if [[ -z "$ticket_id" ]]; then
  echo "Error: ticket_id cannot be empty." >&2
  usage
  exit 2
fi

if [[ ! "$ticket_id" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "Error: ticket_id must contain only letters, numbers, underscores, or hyphens." >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"

if [[ -z "$repo_root" ]]; then
  echo "Error: not inside a git work tree." >&2
  exit 1
fi

if git -C "$repo_root" diff --staged --quiet -- . ':(exclude)src/__generated__/**'; then
  echo "No non-generated staged changes found."
  exit 3
fi

echo "Ticket: #$ticket_id"
echo "Commit prefix: #$ticket_id - "
echo
echo "Staged diff excluding src/__generated__/:"
git -C "$repo_root" diff --staged -- . ':(exclude)src/__generated__/**'
