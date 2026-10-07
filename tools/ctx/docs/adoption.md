# Adopting ctx in an existing repository

`ctx` reads history it did not write, so adoption is incremental: it starts
returning value on the first decision you record, and never demands a backfill.

## 1. Install and initialise

```sh
make install            # ~/.local/bin/ctx, override with PREFIX=
cd /path/to/repo
ctx init -hooks
```

`init` writes repository config (notes merge strategy, rewriteRef, notes
refspecs on `origin`, `blame.ignoreRevsFile`), creates `.git-blame-ignore-revs`,
and installs the `commit-msg` hook. Commit the ignore file — it is part of the
contract, not a local preference.

Only `origin` gets refspecs. If another remote is genuinely a mirror of this
project, add its refspecs by hand; `ctx` will not guess, because a repo's other
remotes are frequently something else entirely.

### First, check the clone is not shallow

```sh
git rev-parse --is-shallow-repository    # must print false
git fetch --unshallow                    # if it printed true
```

This is not optional and it is not about `ctx`. In a shallow clone `git blame`
attributes every line older than the graft boundary to the boundary commit —
measured at **32% of all lines** on a real 388-commit GitOps repo cloned at
depth 1. Every one of those attributions is wrong, for `ctx` and for any human
running `git blame`. `ctx for` warns when it detects this, but it cannot
reconstruct history that was never fetched.

## 2. Choose gated paths deliberately

The default is `infra/` and `pkg/core/`. Replace it with the paths where a
wrong change is *expensive*, not merely important — written into a **tracked
file**, not local config:

```sh
cat > .ctx-gate-paths <<'EOF'
infra
db/migrations
internal/auth
EOF
git add .ctx-gate-paths
```

Commit it. `git config --add ctx.gate.path <x>` still works, but it lives in
`.git/config`, which git never sends anywhere — a teammate's first clone, a CI
runner, or an agent working from a fresh checkout all fall back to the
built-in defaults with no warning, silently un-gating everything you just
configured. `.ctx-gate-paths` is checked into the repo for exactly the reason
`.git-blame-ignore-revs` is: the thing it protects only works if it travels
with the code. Config still wins when set — for a personal, unshared
override — but the tracked file is what a clone actually gets.

One path or glob per line; `#` comments and blank lines are ignored. Listing
replaces the defaults rather than extending them, so list everything you want
gated. Good candidates: anything that provisions
infrastructure, anything that migrates data, anything a consumer depends on by
contract, anything security-relevant. Bad candidates: test fixtures, docs,
generated code — gating them trains people to write `Decision: bump version`
and the signal dies.

> Gate paths are local config. To make them team-wide, set them in CI (where
> the gate runs on the merge request) and treat the local hook as a fast
> pre-check.

## 3. Seed the blame ignore file

One `gofmt`/`prettier`/`terraform fmt` sweep is enough to detach every decision
in a file from the lines it governs. Find past sweeps:

```sh
git log --all --format='%H %s' --grep -Ei '(fmt|format|prettier|lint|whitespace|rename)'
git log --all --format='%H %s' --shortstat | grep -B1 'files changed' | less
```

Append the full 40-character SHAs of the mechanical ones. Verify a sweep is
actually being skipped:

```sh
ctx for path/to/file.go          # before: the sweep owns the lines
echo <sha> >> .git-blame-ignore-revs
ctx for path/to/file.go          # after: the real decision resurfaces
```

Note that a commit which *added* lines cannot be ignored away — blame has
nowhere else to attribute them. Ignoring works for reformats and rewrites of
existing lines.

## 4. Record decisions going forward

You cannot retrofit trailers onto merged commits without rewriting history, and
you should not try. The rule that works: **when you next touch a gated path,
state the decision then.** Within a few months the paths that change often —
the ones an agent is most likely to touch — are covered, and the ones that
never change did not need it.

For a decision that has no natural commit (an existing arrangement nobody
wrote down), an empty commit is legitimate:

```sh
git commit --allow-empty \
  --trailer "Decision:the API VIP is a LAN address so workers survive a VPN outage" \
  --trailer "Reversible:never" --trailer "Oracle:drift" \
  -m "docs(infra): record the API endpoint decision"
```

It will not attach to any line via blame, but it is in the log and in review.

## 5. Wire CI

See [ci.md](ci.md). The minimum is a `ctx gate` on merge requests and a
`ctx reindex` after merge.

## Rollout order that works

1. `ctx init` everywhere, gate nothing yet. People get used to seeing trailers.
2. Gate one path that genuinely hurts when it breaks.
3. Add `ctx for` to the agent workflow ([claude-code.md](claude-code.md)) —
   this is where the payback is, because agents read every time, and humans
   only read when they remember to.
4. Widen gated paths as the habit sticks.
