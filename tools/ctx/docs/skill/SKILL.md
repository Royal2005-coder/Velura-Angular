---
name: ctx
description: Read the recorded decision context for code before changing it — the architectural decision governing those lines, alternatives already tried and rejected, how reversible the change is, and any open incidents attributed to it. Use when editing files in a repository that carries decision trailers (it has a .git-blame-ignore-revs file, or `git log` shows `Decision:` trailers), and especially before touching infrastructure, migrations, auth, or anything a `ctx gate` protects.
---

# ctx — decision context for code

`ctx` compiles the decision record out of git history for a specific file or
line range. Commit trailers are the source of truth; `refs/notes/*` is a
derived index. Run it **before** editing, not after.

## Read before you edit

```sh
ctx for path/to/file.go            # whole file
ctx for path/to/file.go:40-80      # just the lines you are changing
ctx for path/to/file.go -format json
```

If the command is missing, the repository is not set up for this — say so and
move on rather than guessing. If it prints `warning: shallow clone`, the SHAs
are wrong; fetch full history before trusting anything else in the output.

If a report's decisions read like commit subjects ("fix(slurm): reclaim the
GPU") rather than reasons, that repository has not adopted the contract:
`ctx` falls back to the subject line when a commit carries no `Decision:`
trailer. In JSON that is `stated: false`. Treat those as changelog, not
constraints — and do not cite them as prior decisions.

## Act on what it returns

- **`rejected`** — an alternative already tried and discarded. Never propose
  one without addressing why it was rejected. The obvious refactor is often
  exactly the one that was reverted.
- **`reversible: never`** — a one-way door (migration, deleted resource,
  issued credential). Do not proceed autonomously; surface it and ask.
- **`reversible: restore-only`** — undoing needs a restore from backup. Verify
  first and say so in the change description.
- **`oracle`** — how a violation gets detected (`drift`, `test`, `contract`).
  This tells you what to run afterwards to know you did not break it.
- **`superseded`** — the decision no longer applies, and its `rejected` list is
  no longer authoritative. The reason it was superseded may be that the
  rejection was wrong. Do not cite a superseded decision as a constraint.
- **`orphaned`** — a decision about this file that owns no surviving line and
  that nobody retired: its code was removed or rewritten. Unlike `superseded`,
  no one decided it no longer holds, so its `rejected` list may still bind.
  Treat re-introducing what it argued against as a change worth flagging.
  `orphaned_hidden: N` counts cheap ones not shown; `-all` reveals them.
- **`removed`** — the path is not in HEAD but used to be. A `Write` to such a
  path is a *resurrection*: read the removal `decision` first, and stop and ask
  if it says `reversible: never`. Follow `renamed_to` rather than re-creating.
- **`open_incidents`** — an unresolved failure blamed on these lines. The
  strongest signal in the output: someone already got hurt here.
- **`runs`** ending in `fail` — the current arrangement is already unhealthy.
  Say so before stacking a change on top.

## Write the decision back

When your change rests on a new decision, put it in the commit message so the
next reader gets it. All trailers must be in the **last paragraph**, one line
per value, with no blank line before them (a blank line demotes the block to
body text and git parses none of it):

```
feat(storage): pin scratch to node-local NVMe

Decision: local-path PVC on the node NVMe, pod pinned by annotation
Rejected: Longhorn RWO, whose replica sync starves kubelet I/O
Reversible: restore-only
Oracle: contract
```

`Reversible` is `true | restore-only | never`; `Oracle` is
`drift | test | contract`. `ctx gate` rejects a gated change that omits
`Decision:`, or that says `Reversible: never` without an `Oracle:`.

## Reversing an existing decision

Do not silently overwrite it. Write the reviewable record:

```sh
ctx supersede <old-sha> -reason "<what changed in the world>"
```

That creates an empty commit carrying the claim, which goes through normal
review. `refs/notes/decisions` is rebuilt from it by CI (`ctx reindex`) — never
edit notes by hand to record a supersession.

## Commands

| command | purpose |
|---|---|
| `ctx for <path>[:<a>-<b>]` | compile decision context for a scope |
| `ctx gate [-m <msgfile>]` | check the trailer contract (0 pass, 1 violation) |
| `ctx supersede <sha> -reason <t>` | retire a decision, reviewably |
| `ctx reindex` | rebuild `refs/notes/decisions` (CI does this) |
| `ctx init [-hooks]` | configure a repository |
