# Claude Code integration

Two pieces, and they do different jobs. The **skill** teaches the agent how to
read and write the decision record when it decides to. The **hook** removes the
"when it decides to" — it fires on every edit, whether the agent thought to ask
or not.

Install both; the hook is the one that changes behaviour.

## Skill

`~/.claude/skills/ctx/SKILL.md` — loaded when a task looks like editing code in
a repository that carries decision trailers. It documents how to interpret each
field, and how to write trailers and supersessions back.

Ships with this repository; copy it to a machine with:

```sh
mkdir -p ~/.claude/skills/ctx
cp docs/skill/SKILL.md ~/.claude/skills/ctx/SKILL.md
```

Invoke it explicitly with `/ctx` when you want the agent to consult the record
before a specific change.

## Hook

Ships with this repository; install it with:

```sh
mkdir -p ~/.claude/hooks
cp docs/hooks/ctx-context.sh ~/.claude/hooks/ctx-context.sh
chmod +x ~/.claude/hooks/ctx-context.sh
```

Then wire it as a `PreToolUse` hook on `Edit|Write` in
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/ctx-context.sh",
            "timeout": 15,
            "statusMessage": "Reading decision context (ctx)"
          }
        ]
      }
    ]
  }
}
```

Before any file is edited or written, the hook runs `ctx for` on it and returns
the report as `additionalContext`, so the decision record is in front of the
model *before* it makes the change rather than after.

It is a silent no-op — exit 0, no output — when any of these hold:

- `ctx` is not installed
- the target is not inside a git repository
- nothing about the file was actually *recorded*: no `stated` decision in
  `active`/`superseded`/`orphaned`, and the path is not `removed`
- nothing has changed since this agent last saw this file's report

That last one is a diff, not a memory of having spoken. On first sight of a
file the hook stores the full report JSON as a baseline under
`$TMPDIR/ctx-hook-seen/`. Every later edit compiles the scope once, and if
the report differs from the baseline, `ctx render -since` prints **only what
appeared** — a decision retired, an incident opened, a constraint orphaned,
the file deleted, a run that failed — under a preamble saying the context
CHANGED. A passing run or an unstated commit is not news. Measured: ~800
bytes for the first fire, ~260 for a delta naming one new incident, 0 while
nothing changes.

The baseline is refreshed on every evaluation, silent ones included, so a
closed-then-reopened incident or a re-deleted file is announced rather than
masked by a stale comparison.

Three facts about the key, all measured rather than assumed:

- A subagent shares the parent's `session_id` **and** `transcript_path`.
  `agent_id` is the only field that tells them apart, and it is absent for
  the parent — so the key is `session_id` + `agent_id`, and a subagent is
  never silenced by a report only its parent was shown.
- Both ids are hashed before they touch the filesystem. The harness is the
  normal producer, but the script reads whatever is on stdin, and an id like
  `../..` must not be able to name a path outside `ctx-hook-seen`.
- No `session_id` at all fails **open**: the hook shows the full report every
  time rather than risk hiding the one thing worth surfacing.

### Compaction and resume

A long session compacts, and the injected report may be summarised away
while the baseline survives — leaving the hook silent about a decision the
agent can no longer see. `ctx-forget.sh` drops the session's baselines so the
next edit to each file starts over. Install and wire it:

```sh
cp docs/hooks/ctx-forget.sh ~/.claude/hooks/ctx-forget.sh
chmod +x ~/.claude/hooks/ctx-forget.sh
```

```json
"PostCompact":  [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/ctx-forget.sh", "timeout": 10 }] }],
"SessionStart": [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/ctx-forget.sh", "timeout": 10 }] }]
```

Baselines older than two days are expired by their own age, never by the
age of the directory holding them.

Adoption therefore stays genuinely incremental — the hook is invisible in a
repository that has not adopted the contract, and costs nothing there.

### What it looks like

Editing a file whose commit says `Decision: retries capped at 3 …` with
`Reversible: never` injects:

```
Recorded decision context for this file (`ctx for`). Treat `rejected` as
already-tried, `reversible: never` as do-not-proceed-alone, and an open
incident as a warning:

scope: config.toml
active:
  - sha: 4b00a3ebed78
    decision: retries capped at 3 because the upstream LB already retries
    rejected:
      - exponential backoff with jitter
    reversible: never
    oracle: contract
```

### Scope and cost

Runs once per Edit/Write on the whole file (no line range — the tool call does
not carry one reliably), typically 30ms. The 15s timeout is generous
protection against a wedged git, not an expected duration.

To limit it to particular repositories, add a guard to the script rather than
narrowing the matcher — the matcher cannot see paths.

### Verifying

```sh
echo '{"tool_name":"Edit","tool_input":{"file_path":"/abs/path/to/file"}}' \
  | bash ~/.claude/hooks/ctx-context.sh
```

Prints JSON when there is context, nothing when there is not. If the hook does
not fire in a running session, open `/hooks` once to reload the config.

## The write-back half

Reading is only half the loop. An agent that consumes decisions but never
records them degrades the record over time. The skill instructs it to add
trailers when a change rests on a new decision, and `ctx init -hooks` installs
the `commit-msg` gate so a gated path cannot be committed without one — by a
human or by an agent.
