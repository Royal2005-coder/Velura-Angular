#!/usr/bin/env bash
# PreToolUse (Edit|Write): inject the recorded decision context for the file
# about to be changed.
#
# Silent when: ctx is missing, the path is outside a git repo, nothing is
# actually recorded, or nothing has changed since this agent last saw this
# file's report. Otherwise: the full report on first sight, and afterwards only
# what changed. ctx-forget.sh clears the memory on compaction or resume.
set -uo pipefail
PATH="${HOME:-}/.local/bin:$PATH"

# jq is how stdin gets parsed at all; without it there is nothing to do.
command -v jq >/dev/null 2>&1 || exit 0
input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
session=$(printf '%s' "$input" | jq -r '.session_id // empty')
# A subagent shares the parent's session_id AND transcript_path (measured).
# agent_id is the only field that tells them apart, and it is absent for the
# parent; without it in the key the parent's memory silences the subagent.
agent=$(printf '%s' "$input" | jq -r '.agent_id // empty')
[ -n "$file" ] || exit 0
command -v ctx >/dev/null 2>&1 || exit 0

# Ids come from the harness, but this script trusts whatever is on stdin, so
# they are hashed before touching the filesystem: no id can ever resolve to a
# path outside ctx-hook-seen, whatever it contains.
# Linux ships md5sum, macOS ships md5, most things ship shasum. With none of
# them there is no safe key, so de-dup is simply off (full report every time)
# rather than a half-built path that errors on every edit.
if command -v md5sum >/dev/null 2>&1; then h() { printf '%s' "$1" | md5sum | cut -d' ' -f1; }
elif command -v md5 >/dev/null 2>&1;    then h() { printf '%s' "$1" | md5 -q; }
elif command -v shasum >/dev/null 2>&1; then h() { printf '%s' "$1" | shasum | cut -d' ' -f1; }
else h() { return 1; }; fi
root_seen="${TMPDIR:-/tmp}/ctx-hook-seen"
seen_dir=""; marker=""
if [ -n "$session" ] && h x >/dev/null 2>&1; then
  seen_dir="$root_seen/$(h "$session")/$(h "${agent:-parent}")"
  marker="$seen_dir/$(h "$file")"
  # Expire by marker age, never by directory age (a dir's mtime does not move
  # when a file inside it is rewritten), and never touch the root itself.
  find "$root_seen" -mindepth 1 -type f -mtime +2 -delete 2>/dev/null || true
  find "$root_seen" -mindepth 1 -type d -empty -delete 2>/dev/null || true
fi

dir=$(dirname "$file")
while [ -n "$dir" ] && [ "$dir" != "/" ] && [ ! -d "$dir" ]; do
  dir=$(dirname "$dir")
done
[ -d "$dir" ] || exit 0
root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$root" ] || exit 0
rel=${file#"$root"/}

# The ONE compile per edit. Everything below re-renders this JSON.
json=$(cd "$root" && ctx for "$rel" -format json 2>/dev/null) || exit 0
[ -n "$json" ] || exit 0
worth=$(printf '%s' "$json" | jq -r '
  ((([.active[], .superseded[], .orphaned[]] | map(select(.stated)) | length) > 0)
   or (.removed != null))' 2>/dev/null) || exit 0
[ "$worth" = "true" ] || exit 0

report=""; preamble="Recorded decision context for this file (\`ctx for\`). Treat \`rejected\` as already-tried, \`reversible: never\` as do-not-proceed-alone, an open incident as a warning, and \`orphaned\` as a decision whose code went away without anyone retiring it:"
if [ -n "$marker" ] && [ -f "$marker" ]; then
  if report=$(printf '%s' "$json" | ctx render -since "$marker" 2>/dev/null); then
    preamble=""   # the delta carries its own one-line header
  else
    # An older ctx without `render`, or an unreadable baseline: fall back to
    # the full report. A hook updated ahead of its binary must get louder.
    report=$(printf '%s' "$json" | ctx render 2>/dev/null) || report=$(cd "$root" && ctx for "$rel" 2>/dev/null) || exit 0
  fi
else
  report=$(printf '%s' "$json" | ctx render 2>/dev/null) || report=$(cd "$root" && ctx for "$rel" 2>/dev/null) || exit 0
fi

# The baseline is what this agent has most recently been able to compare
# against, so it is refreshed on EVERY evaluation — including silent ones.
# Leaving it stale after a silent run is how a closed-then-reopened incident,
# or a second deletion of a resurrected file, went unannounced.
if [ -n "$marker" ]; then
  mkdir -p "$seen_dir" 2>/dev/null && printf '%s' "$json" > "$marker" 2>/dev/null || true
fi
[ -n "$report" ] || exit 0

jq -n --arg c "$report" --arg p "$preamble" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: (if $p == "" then $c else $p + "\n\n" + $c end)
  }
}'
