# ctx

*Documents as Commit, Code as Context.*

`ctx` makes the reasoning behind a change part of the change. Architectural
decisions live in commit trailers, so they are immutable, reviewable and
attributable to the exact lines they govern. `ctx for` compiles them back out —
for the file an agent is about to edit, at the moment it is about to edit it.

Zero dependencies: the Go standard library, and the `git` binary.

## Model

**The commit is the document.** A decision is a `Decision:` trailer on the commit
that implements it. It cannot be edited without rewriting history, and it goes
through review because it *is* the change.

**`refs/notes/*` is a derived index.** Notes are keyed by commit SHA — the notes
tree is literally a filesystem whose filenames are commit SHAs, which is what
makes the join free. They are mutable and unreviewed, so nothing may live there
that cannot be rebuilt:

| ref | written by | rebuildable |
|---|---|---|
| `refs/notes/decisions` | `ctx reindex`, from `Supersedes:` trailers | yes, entirely |
| `refs/notes/runs` | CI, after each run | no — see *Limits* |
| `refs/notes/incidents` | CI or an operator, on failure | no — see *Limits* |

**`git blame` is the index from code to decision.** Which means a formatting
sweep can erase your architecture docs — so `.git-blame-ignore-revs` is part of
the contract, not an optional nicety.

## Trailer contract

```
Decision:   <what was decided, and why>
Rejected:   <an alternative that was considered and rejected>   (repeatable)
Reversible: true | restore-only | never
Oracle:     drift | test | contract
Supersedes: <sha>
Reason:     <why the superseded decision no longer holds>
```

`Reversible` states the cost of undoing: `true` — revert the commit;
`restore-only` — undoing needs a restore from backup; `never` — a one-way door.
`Oracle` states how a violation is *detected*: by a reconciler noticing drift,
by a test, or by a contract/schema check. A one-way door with no oracle is a
change nobody will notice going wrong, which is why the gate rejects it.

### Authoring trailers

Git reads only the **last paragraph** of a commit message as trailers, and a
wrapped value must be indented to continue. Both of these parse as *no*
trailers at all:

```
Decision: keep it            Decision: keep it because
Oracle: test                 of a second line

Signed-off-by: ...           (the wrap is not indented)
(a blank line demotes
 the block above it)
```

`ctx gate` says so explicitly when it sees a trailer-style line git did not
parse, because the bare "missing `Decision:`" violation reads like a lie.

## Note formats

Derived notes are pipe-delimited `key: value` lines. A value may contain a
pipe; a segment only starts a new key if its key half has no whitespace.

```
decisions  superseded-by: <sha> | at: <iso8601> | reason: <text>
runs       at: <iso8601> | status: pass|fail | incident: <id>
incidents  at: <iso8601> | status: open|closed | summary: <text>
```

## Commands

```
ctx init [-no-push-spec] [-hooks] [-force]     configure the repository
ctx supersede <sha> -reason <text>             retire a decision, reviewably
ctx reindex                                    rebuild refs/notes/decisions
ctx for <path>[:<a>-<b>] [-format yaml|json] [-all]    (path: a file or a directory)
                                               compile context for a scope
ctx gate [-m <msgfile>]                        enforce the contract
ctx version
```

Exit codes: `0` success, `1` gate violation or error, `2` usage.

### init

Sets `notes.mergeStrategy=cat_sort_uniq` (so concurrent CI appends merge instead
of conflicting), `notes.rewriteRef=refs/notes/*` (so notes survive a rebase),
`blame.ignoreRevsFile`, and the notes fetch/push refspecs on `origin`. Creates
`.git-blame-ignore-revs`. With `-hooks`, installs a `commit-msg` hook that runs
the gate.

> **Only `origin` is configured.** A repository commonly carries other remotes
> for unrelated purposes — a registry mirror, a stale fork kept as a pull-only
> upstream — and `ctx` cannot tell those from a genuine mirror of this project.
> Configuring them all means a later `git push <that remote>` starts pushing
> this repo's branches somewhere they do not belong. If a second remote really
> is this project, add its refspecs by hand.

> Setting `remote.origin.push` disables git's default `simple` push, so `init`
> also adds `refs/heads/*:refs/heads/*` — otherwise branches silently stop
> pushing. `-no-push-spec` leaves push configuration alone entirely.

### supersede

Writes an empty commit carrying `Supersedes:` and `Reason:`. It deliberately
does **not** write a note: the claim that a decision is dead must survive review
as a commit first. CI derives the note afterwards.

### for

The scope is a file, a line range of one (`path:12-40`), or a directory. A directory is every file
beneath it: a decision that owns a surviving line in any of them is `active`, and one that touched
the directory but owns none is `orphaned` — judged across the whole directory, so a rewrite of one
file does not orphan a decision that still holds in another. A directory is capped at 400 files
and says so when it is cut; narrow the scope to see the rest. A line range on a directory is an
error.

Blame runs with `-C`, so code moved or copied from another file that the same commit changed is
credited to the commit that wrote it, not to the commit that moved it. Extracting a function into
its own file is the ordinary refactor, and without this every extracted line blames to the
refactor and the decisions that governed it stop reaching the new file.

```yaml
scope: infra/storage/isaac-scratch.yaml
active:
  - sha: bed0d26cc4c7
    decision: "local-path PVC on the z8-2 NVMe, the pod pinned there by annotation"
    rejected:
      - Longhorn RWO (replica sync starves kubelet I/O and wedges the node)
    reversible: restore-only
    oracle: contract
    runs: ["2026-07-03T02:00:00Z pass -> none"]
superseded:
  - sha: d3cdd61d08c7 -> by 5f83b021fa14
    decision: Isaac Sim recording output lands on a 500Gi Longhorn RWO PVC
    reason: Longhorn replica traffic wedges the node under Isaac write load (INC-2026-014)
orphaned: []
open_incidents:
  - d3cdd61d08c7: z8-2 wedged in D-state during a 40GB Isaac recording
```

Four sections, and the difference between them is the point:

| section | meaning |
|---|---|
| `active` | owns surviving lines in the scope — the constraints in force now |
| `superseded` | retired deliberately, through a reviewed `Supersedes:` commit |
| `orphaned` | carries a decision but owns **no** surviving line, and nobody retired it — the code was removed or rewritten |
| `removed` | the path itself is gone; names the tombstone commit, and `renamed_to` when it moved |

`superseded` means a human decided the decision no longer holds, so its
`rejected` list is spent. `orphaned` means nobody decided anything — the code
just went away, possibly in a refactor that dropped the constraint by accident,
so its `rejected` list may well still bind.

Querying a path that is not in HEAD returns `removed:` rather than an error,
which is what makes a `Write` to a deleted path — a *resurrection* — visible
before it happens. A path that never existed is still an error.

Orphaned entries are shown only when they declared a real cost to undo
(`reversible: never` or `restore-only`) or carry an open incident, newest first
and capped at 10; `orphaned_hidden: N` counts the rest and `-all` shows them.
Without that filter a repeatedly rewritten file produces a report nobody reads:
120 generations measured at 485 lines before the cap, 50 after.

`-format json` emits the same report with full SHAs and typed fields.

### gate

Checks staged files (or HEAD) against the gated paths, resolved in order:
`git config --add ctx.gate.path <prefix|glob>` (a personal, unshared
override) → a tracked `.ctx-gate-paths` file, one path or glob per line,
`#` comments allowed → the built-in default of `infra/` and `pkg/core/`.

Commit `.ctx-gate-paths`, not just the config. Local config lives in
`.git/config`, which a clone never receives — a repository gated only through
config protects nobody but the person who set it up, silently, the moment
anyone else checks the repo out.

Two rules: a gated path requires a `Decision:` trailer, and `Reversible: never`
requires an `Oracle:`. Values outside the vocabulary are rejected, because a
misspelled tier would silently escape the second rule.

## Wiring

```sh
ctx init -hooks                      # commit-msg hook runs the gate locally

# CI, post-merge on the default branch
ctx reindex && git push origin refs/notes/decisions

# CI, after a run — plain git, no ctx needed
git notes --ref=runs append -m "at: $(date -Iseconds) | status: pass | incident: none" "$SHA"
git notes --ref=incidents append -m "at: $(date -Iseconds) | status: open | summary: $MSG" "$SUSPECT"
```

## Layout

```
cmd/ctx            argument parsing, exit codes, nothing else
internal/model     the vocabulary: tiers, oracles, records, the report
internal/gitx      the only package that executes git; Runner is fakeable
internal/render    YAML and JSON emitters
internal/ctxcmd    the five commands, each returning a result value
internal/testutil  throwaway repositories and a scripted git runner
```

## Documentation

- [docs/agents.md](docs/agents.md) — how an AI agent should read and act on the output
- [docs/claude-code.md](docs/claude-code.md) — the Claude Code skill and pre-edit hook
- [docs/adoption.md](docs/adoption.md) — rolling ctx out on an existing repository
- [docs/ci.md](docs/ci.md) — pipeline wiring, notes pushing, run and incident recording

## Development

```sh
make build      # static binary into bin/
make test       # unit + integration (integration shells out to real git)
make cover
make ci         # fmt-check, vet, test, build, and ctx gating its own commits
```

## Limits

- **`runs` and `incidents` cannot be rebuilt.** Only `decisions` is derived from
  the commit graph. A CI timestamp was never in a commit message, so if those
  refs are lost, the data is gone. Back them up or re-push from CI.
- **Shallow clones lie.** `git blame` stops at the graft boundary, attributing
  every line to it. `ctx for` warns, but cannot fix it — CI needs full history.
- **Linked worktrees share `.git/config`.** `blame.ignoreRevsFile` is therefore
  shared while the file itself is per-worktree; copy it into each one.
- **Copy detection is git's.** `-C` only looks at files the same commit changed, ignores copies
  under 40 alphanumeric characters, and does not follow a move across several commits. A line
  rewritten while it moves is new code and blames to the commit that rewrote it.
- **Granularity is the commit, not the line.** A commit that decided two things
  keeps its decision listed as active while *either* half survives, so a
  constraint deleted from a multi-purpose commit is not flagged. One decision
  per commit is the mitigation; the gate already encourages it.
- **The gate checks form, not truth.** A commit can carry a `Decision:` trailer
  that lies. Integrity comes from review; the gate only ensures there is
  something to review.
