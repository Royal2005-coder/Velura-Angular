# Using ctx from an AI coding agent

This is the reason the tool exists. An agent editing a file has the code and
the tests; what it lacks is the set of options already tried and rejected, the
cost of undoing the change, and the failures the current arrangement was
adopted to avoid. `ctx for` supplies exactly that, in the smallest form that
carries it.

## The contract

**Before editing a file, run `ctx for <path>` (a directory works too: it reports every file beneath it) — or `ctx for <path>:<start>-<end>`
when the edit is local to a range.** Read the result as follows.

### `active` — decisions currently governing these lines

Each entry is a commit that still stands.

- `decision` — why the code is the way it is. Treat it as a constraint, not
  trivia. If your change contradicts it, you are not fixing a bug; you are
  reversing a decision, and that needs to be stated, not slipped in.
- `rejected` — alternatives already considered and discarded. **Do not propose
  one of these without addressing why it was rejected.** This is the field that
  saves the most wasted work: the obvious refactor is frequently the one that
  was tried and reverted.
- `reversible` — the cost of being wrong:
  - `true` — a revert restores the previous state. Normal caution.
  - `restore-only` — undoing requires restoring from backup. Verify before
    proceeding; say so in the change description.
  - `never` — a one-way door (a migration, a deleted resource, an issued
    credential). Do not proceed autonomously. Surface it and ask.
- `oracle` — how a violation would be *detected*: `drift` (a reconciler
  notices), `test` (a test fails), `contract` (a schema check fails). This
  tells you what to run after your change to know whether you broke it.
- `runs` — CI history for that commit, newest last, `<timestamp> <status> ->
  <incident>`. A trailing `fail` means the current arrangement is already
  unhealthy; do not stack a change on top without acknowledging it.

### `superseded` — decisions that no longer apply

`sha: X -> by Y` with a `reason`. These are the traps. The code may still look
like it did under the old decision, and the old rationale may still be quoted
in comments or in an older README. **Anything in a superseded entry's
`rejected` list is not necessarily rejected any more** — the reason it was
superseded may be exactly that the rejection was wrong.

### `orphaned` — decisions whose code went away

A commit that carries a `Decision:` about this file but owns **no surviving
line**, and that nobody retired. Its lines were removed or rewritten.

This is not the same as `superseded`, and the difference decides how you treat
it. Superseded means a human decided the decision no longer holds, through a
reviewed commit. Orphaned means *nobody decided anything* — the code simply
stopped existing, possibly in a refactor that dropped the constraint by
accident. So an orphaned entry's `rejected` list may well still be binding, and
the fact that it lost its code unretired is itself the warning. If you are
about to re-introduce something an orphaned decision argued against, say so
rather than proceeding.

Only orphans that declared a real cost to undo (`reversible: never` or
`restore-only`) or carry an open incident are shown, newest first and capped.
`orphaned_hidden: N` counts the rest; `ctx for <path> -all` shows them.

### `removed` — the path itself is gone

Present when the path is not in HEAD but was, in which case it replaces what
would otherwise be an error. It names the commit that removed it, the date, and
what that commit stated. `renamed_to` appears when the removal was a rename —
follow it rather than re-creating the file.

**A `Write` to a path with a `removed` section is a resurrection.** Something
was deliberately taken out and you are putting it back. Read the removal
`decision` before continuing, and if it says `reversible: never`, stop and ask.

### `open_incidents`

`<sha>: <summary>` — unresolved failures attributed to a commit touching these
lines. An open incident against the decision you are about to modify is the
strongest signal in the output: someone already got hurt here.

### `warnings`

`shallow clone; …` means blame stopped at the graft boundary and **the SHAs are
wrong**. Do not trust the rest of the document; fetch full history first.

## Worked example

```yaml
scope: infra/storage/isaac-scratch.yaml
active:
  - sha: bed0d26cc4c7
    decision: "local-path PVC on the z8-2 NVMe, the pod pinned there by annotation"
    rejected:
      - Longhorn RWO (replica sync starves kubelet I/O and wedges the node)
    reversible: restore-only
    oracle: contract
superseded:
  - sha: d3cdd61d08c7 -> by 5f83b021fa14
    reason: Longhorn replica traffic wedges the node under Isaac write load (INC-2026-014)
open_incidents:
  - d3cdd61d08c7: z8-2 wedged in D-state during a 40GB Isaac recording
```

An agent asked to "clean up the hard-coded node pin" now knows: the pin is
load-bearing, the obvious alternative (a normal RWO volume) has been tried and
took a node down, undoing needs a restore, and a contract check is what will
catch a regression. Without this it removes the pin, and the incident recurs.

## Writing the change back

If your change stands on a new decision, put it in the commit message as
trailers — that is what the next agent will read:

```
Decision: <one line, why this and not the alternatives>
Rejected: <what you considered and did not do>
Reversible: true | restore-only | never
Oracle: drift | test | contract
```

All trailers must be in the **last paragraph** of the message, one line per
value (indent to continue). `ctx gate` rejects a gated change without them.

If your change reverses a standing decision, do not silently overwrite it:

```sh
ctx supersede <old-sha> -reason "<what changed in the world>"
```

That writes an empty commit which must pass review. The notes index is rebuilt
from it by CI afterwards.

## JSON

`ctx for <path> -format json` emits the same report with full 40-character
SHAs, typed run and incident objects, and `[]` rather than `null` for empty
lists. Schema is `model.Report` in the source.

Each record carries **`stated`**, and it matters more than it looks. When a
commit has no `Decision:` trailer, `ctx` falls back to its subject line so the
field is never empty — `stated: false` marks exactly that case. A subject line
is a changelog entry, not a decision anyone reviewed: it has no rejected
alternatives, no reversibility, no oracle. **Filter on `stated` before treating
an entry as a constraint**, or a repository that never adopted the contract
will look thoroughly documented while telling you nothing. Use it when an agent parses the
output programmatically; the YAML exists because it costs fewer tokens when
pasted into a prompt.

## Cost

A scope resolves in tens of milliseconds (150 distinct commits in ~230ms), so
calling it before every edit is affordable. Output is typically 10–40 lines.
