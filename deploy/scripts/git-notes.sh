#!/bin/sh
# Git notes = "why" overlay. Does not rewrite commits. Does not change git config.
# Usage:
#   sh deploy/scripts/git-notes.sh fetch
#   sh deploy/scripts/git-notes.sh show
#   sh deploy/scripts/git-notes.sh add KAN-15 "Do not rewrite apps/api as Angular."
#   sh deploy/scripts/git-notes.sh push
set -eu

cmd="${1:-show}"
root="$(git rev-parse --show-toplevel)"
cd "$root"

case "$cmd" in
  fetch)
    git fetch origin refs/notes/commits:refs/notes/commits || true
    ;;
  show)
    git log --show-notes --oneline -20
    ;;
  add)
    key="${2:-}"
    text="${3:-}"
    sha="${4:-HEAD}"
    if [ -z "$key" ] || [ -z "$text" ]; then
      echo "usage: sh deploy/scripts/git-notes.sh add KAN-n \"why this commit\" [sha]"
      exit 1
    fi
    git notes add -f -m "${key}
${text}

Do not add docs/KAN-n.md. Types/JSDoc = what. This note + MR = why." "$sha"
    echo "Note attached to $(git rev-parse --short "$sha"). Run: sh deploy/scripts/git-notes.sh push"
    ;;
  push)
    git push origin refs/notes/commits
    ;;
  *)
    echo "usage: sh deploy/scripts/git-notes.sh fetch|show|add|push"
    exit 1
    ;;
esac
