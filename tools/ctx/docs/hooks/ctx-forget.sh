#!/usr/bin/env bash
# PostCompact / SessionStart: drop this session's memory of what it has already
# been shown. After a compaction the injected reports may be gone from the
# agent's context while the markers survive, which would leave the pre-edit
# hook silent about decisions the agent can no longer see.
set -uo pipefail
command -v jq >/dev/null 2>&1 || exit 0
session=$(cat | jq -r '.session_id // empty' 2>/dev/null) || exit 0
[ -n "$session" ] || exit 0
# Hashed exactly as ctx-context.sh hashes it, so the id never reaches a path.
if command -v md5sum >/dev/null 2>&1; then key=$(printf '%s' "$session" | md5sum | cut -d' ' -f1)
elif command -v md5 >/dev/null 2>&1;    then key=$(printf '%s' "$session" | md5 -q)
elif command -v shasum >/dev/null 2>&1; then key=$(printf '%s' "$session" | shasum | cut -d' ' -f1)
else exit 0; fi
rm -rf "${TMPDIR:-/tmp}/ctx-hook-seen/$key" 2>/dev/null || true
exit 0
