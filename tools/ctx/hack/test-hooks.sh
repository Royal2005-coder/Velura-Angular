#!/usr/bin/env bash
# Tests for the Claude Code hook scripts. Runs the vendored copies in
# docs/hooks/ against a throwaway repo and a private TMPDIR, so nothing here
# can touch the real ~/.claude state or a real session's markers.
set -uo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
CTX_BIN="${CTX_BIN:-$here/bin/ctx}"
HOOK="$here/docs/hooks/ctx-context.sh"
FORGET="$here/docs/hooks/ctx-forget.sh"

export TMPDIR; TMPDIR=$(mktemp -d)
export PATH="$(dirname "$CTX_BIN"):$PATH"
trap 'rm -rf "$TMPDIR"' EXIT

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

repo=$TMPDIR/repo; mkdir -p "$repo"; cd "$repo"
git init -q -b main . && git config user.email t@t && git config user.name T
printf 'retries = 3\n' > cfg.toml && git add -A
git commit -q -m "cap retries" --trailer "Decision:retries capped at 3" --trailer "Reversible:never" --trailer "Oracle:contract"
sha=$(git rev-parse HEAD)
printf 'x\n' > plain.txt && git add -A && git commit -q -m "chore: plain"

payload(){ printf '{"session_id":"%s"%s,"tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$1" "${3:+,\"agent_id\":\"$3\"}" "$2"; }
fire(){ payload "$@" | bash "$HOOK" | wc -c | tr -d ' '; }
nonzero(){ [ "$1" -gt 0 ] && echo yes || echo no; }

echo "de-dup and re-fire"
check "first edit fires"                "$(nonzero "$(fire S1 "$repo/cfg.toml")")" yes
check "unchanged repeat is silent"      "$(fire S1 "$repo/cfg.toml")" 0
git notes --ref=incidents add -f -m "at: 2026-01-01T00:00:00Z | status: open | summary: LB melted" "$sha"
check "opened incident fires a delta"   "$(nonzero "$(fire S1 "$repo/cfg.toml")")" yes
git notes --ref=incidents add -f -m "at: 2026-01-01T00:00:00Z | status: closed | summary: LB melted" "$sha"
check "closed incident is silent"       "$(fire S1 "$repo/cfg.toml")" 0
git notes --ref=incidents add -f -m "at: 2026-01-02T00:00:00Z | status: open | summary: LB melted" "$sha"
check "REOPENED incident fires (stale baseline bug)" "$(nonzero "$(fire S1 "$repo/cfg.toml")")" yes

echo "buckets"
check "subagent gets its own report"    "$(nonzero "$(fire S1 "$repo/cfg.toml" agentA)")" yes
check "new session fires again"         "$(nonzero "$(fire S2 "$repo/cfg.toml")")" yes
check "no session_id fails open, twice" "$(printf '{"tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$repo/cfg.toml" | bash "$HOOK" | wc -c | tr -d ' ')" \
                                        "$(printf '{"tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$repo/cfg.toml" | bash "$HOOK" | wc -c | tr -d ' ')"

echo "silence where nothing is recorded"
check "unstated file is silent"         "$(fire S3 "$repo/plain.txt")" 0
check "outside a repo is silent"        "$(fire S3 "$TMPDIR/nowhere.txt")" 0
check "no file_path is silent"          "$(printf '{"session_id":"S3","tool_name":"Bash","tool_input":{}}' | bash "$HOOK" | wc -c | tr -d ' ')" 0

echo "forget"
mkdir -p "$TMPDIR/ctx-hook-seen/keepme/parent"; touch "$TMPDIR/ctx-hook-seen/keepme/parent/m"
printf '{"session_id":"S1"}' | bash "$FORGET"
check "forget clears its own session"   "$(nonzero "$(fire S1 "$repo/cfg.toml")")" yes
check "forget leaves other sessions"    "$([ -f "$TMPDIR/ctx-hook-seen/keepme/parent/m" ] && echo kept || echo gone)" kept
printf '{"session_id":"never-existed"}' | bash "$FORGET"; check "forget on a missing dir exits 0" "$?" 0
printf '{}' | bash "$FORGET"; check "forget with no session_id exits 0" "$?" 0

echo "safety"
mkdir -p "$TMPDIR/canary"; touch "$TMPDIR/canary/f"
printf '{"session_id":"../canary"}' | bash "$FORGET"
check "forget cannot traverse out"      "$([ -f "$TMPDIR/canary/f" ] && echo safe || echo ESCAPED)" safe
payload "../canary" "$repo/cfg.toml" | bash "$HOOK" >/dev/null
check "hook markers stay under ctx-hook-seen" "$(find "$TMPDIR" -type f -newer "$TMPDIR/canary/f" -not -path "$TMPDIR/ctx-hook-seen/*" -not -path "$repo/*" | wc -l | tr -d ' ')" 0

echo "prune"
mkdir -p "$TMPDIR/ctx-hook-seen/stale/parent"; touch "$TMPDIR/ctx-hook-seen/stale/parent/old"
touch -d '3 days ago' "$TMPDIR/ctx-hook-seen/stale/parent/old" "$TMPDIR/ctx-hook-seen/stale" "$TMPDIR/ctx-hook-seen"
fire S9 "$repo/cfg.toml" >/dev/null
check "stale marker expired"            "$([ -f "$TMPDIR/ctx-hook-seen/stale/parent/old" ] && echo kept || echo expired)" expired
check "root survives an old mtime"      "$([ -d "$TMPDIR/ctx-hook-seen" ] && echo yes || echo no)" yes
check "fresh markers survive"           "$(nonzero "$(find "$TMPDIR/ctx-hook-seen" -type f | wc -l | tr -d ' ')")" yes

echo "robustness"
check "HOME unset does not abort"       "$(printf '{"tool_name":"Bash","tool_input":{}}' | env -u HOME bash "$HOOK" >/dev/null 2>&1; echo $?)" 0
stub=$TMPDIR/stub; mkdir -p "$stub"; for t in md5sum md5 shasum; do printf '#!/bin/sh\nexit 127\n' > "$stub/$t"; chmod +x "$stub/$t"; done
check "no hasher fails open, no stderr" "$(payload S4 "$repo/cfg.toml" | PATH="$stub:$PATH" bash "$HOOK" 2>&1 >/dev/null | wc -c | tr -d ' ')" 0

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
