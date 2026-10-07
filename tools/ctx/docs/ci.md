# CI integration

Two jobs matter: the **gate** on proposed changes, and the **reindex** after
merge. Everything else is optional.

## Requirements

- **Full history.** `git blame` and `ctx reindex` both need it. Shallow clones
  attribute every line to the graft boundary; `ctx for` warns, but the answer
  is wrong. Set `fetch-depth: 0` (GitHub Actions) or `GIT_DEPTH: 0` (GitLab CI).
- **Notes refspec**, if the job reads notes:
  `git config --add remote.origin.fetch '+refs/notes/*:refs/notes/*' && git fetch origin`
- **Push permission** for `refs/notes/*` on the reindex job only.

## Gate on merge requests

```yaml
gate:
  script:
    - ctx gate -m <(git log -1 --format=%B)   # or check each commit in the MR
```

To check every commit in a branch rather than just the tip:

```sh
for sha in $(git rev-list origin/main..HEAD); do
  git log -1 --format=%B "$sha" > /tmp/msg
  git checkout -q "$sha" -- .    # stage that commit's tree
  ctx gate -m /tmp/msg || exit 1
done
```

Exit codes: `0` pass, `1` violation, `2` usage.

## Reindex after merge

Run on the default branch only, after the merge commit lands:

```yaml
reindex:
  rules: [{ if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' }]
  script:
    - git fetch origin '+refs/notes/*:refs/notes/*' || true
    - ctx reindex
    - git push origin refs/notes/decisions
```

`reindex` deletes and rebuilds `refs/notes/decisions` from the `Supersedes:`
trailers in the commit graph, so it is idempotent and safe to re-run. It never
touches `refs/notes/runs` or `refs/notes/incidents`.

The push is a force-free fast-forward only if no one else rebuilt concurrently.
If two pipelines race, the loser should simply re-run — the ref is derived.

## Recording runs

`ctx` does not write these; CI does, with plain git:

```sh
git notes --ref=runs append \
  -m "at: $(date -Iseconds) | status: ${CI_JOB_STATUS} | incident: none" "$CI_COMMIT_SHA"
git push origin refs/notes/runs
```

Concurrent appends from parallel jobs are why `init` sets
`notes.mergeStrategy=cat_sort_uniq`: on a conflict, git concatenates and
de-duplicates the lines instead of failing. Fetch before append, and re-run on
a rejected push.

## Recording incidents

When something breaks, attribute it to the suspect commit — the one `ctx for`
will surface to whoever (or whatever) next edits those lines:

```sh
git notes --ref=incidents append \
  -m "at: $(date -Iseconds) | status: open | summary: ${DESCRIPTION}" "$SUSPECT_SHA"
```

Close it by appending a `status: closed` line for the same incident. `ctx for`
filters closed and resolved incidents out of `open_incidents`. An incident left
open keeps surfacing even after the decision it blames has been superseded —
that is deliberate, and it is the nag that gets it closed.

Values may contain a literal `|`; a segment only starts a new field when its
key half has no whitespace.

## Losing the notes

`refs/notes/decisions` is derived — rebuild it with `ctx reindex` and move on.
`runs` and `incidents` are **not** derivable from the commit graph. Back those
refs up, or be able to replay them from your CI system's own history.
