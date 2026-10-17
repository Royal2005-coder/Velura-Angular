package gitx

import (
	"context"
	"strings"
)

// PathDecisions returns every decision-bearing commit in a path's life, newest
// first, following the path through renames. It answers "what has ever been
// decided about this file", including commits whose lines no longer survive
// and including the commit that deleted it.
//
// --grep keeps the trailer parser off commits that cannot carry a decision;
// the match is a superset (it also hits prose mentioning "Decision:"), which
// the caller filters by actually parsing trailers.
func (r *Repo) PathDecisions(ctx context.Context, path string) []string {
	return r.QuietLines(ctx, "log", "--follow", "-i", "--grep=Decision:", "--format=%H", "--", path)
}

// Tombstone is the commit that removed a path from the tree.
type Tombstone struct {
	SHA       string
	At        string // author date, ISO 8601
	RenamedTo string // destination when the removal was a rename, else ""
}

// FindTombstone locates the commit that deleted a path, or nil when the path
// was never in the history at all (a typo, rather than something removed).
func (r *Repo) FindTombstone(ctx context.Context, path string) *Tombstone {
	// --full-history: git's default path-limited traversal applies "history
	// simplification" that can decide a merge commit is TREESAME to a parent
	// and prune the whole branch carrying the deletion from view. That
	// simplification gets it wrong across a merge of unrelated histories (a
	// repo reconciling with a template's initial commit, a subtree merge) —
	// a real one on ctx-demo silently turned a real tombstone into "no such
	// path", which is indistinguishable from the path never having existed.
	out := r.Quiet(ctx, "log", "--full-history", "-1", "-M", "--diff-filter=DR", "--name-status",
		"--format=%H"+fieldSep+"%aI", "--", path)
	head, _, ok := strings.Cut(out, "\n")
	if !ok && out == "" {
		return nil
	}
	sha, at, ok := strings.Cut(strings.TrimSpace(head), fieldSep)
	if !ok || len(sha) != 40 {
		return nil
	}
	tomb := &Tombstone{SHA: sha, At: at}

	// A single-path pathspec cannot show git the rename destination, so a
	// `git mv` reports as D here. Re-read the commit's whole diff to recover it.
	//
	// -M1% rather than git's 50% default: a rename bundled with real edits in
	// the same commit — renaming a file while also updating what's in it, an
	// entirely ordinary pattern — routinely drops similarity below 50% on a
	// small file. The old path is already fixed by the caller, so widening the
	// threshold only affects whether THIS known pair still counts as a rename;
	// it cannot attach the wrong destination to a different deleted file.
	for _, line := range Lines(r.Quiet(ctx, "show", "-M1%", "--name-status", "--format=", sha)) {
		fields := strings.Split(line, "\t")
		if len(fields) == 3 && strings.HasPrefix(fields[0], "R") && fields[1] == path {
			tomb.RenamedTo = fields[2]
			break
		}
	}
	return tomb
}

// TreeDecisions is PathDecisions for a directory: every decision-bearing commit that touched
// anything beneath it, newest first. It does not follow renames, which git only does for a single
// file, so a file renamed into the directory is seen from the rename onward.
func (r *Repo) TreeDecisions(ctx context.Context, dir string) []string {
	return r.QuietLines(ctx, "log", "-i", "--grep=Decision:", "--format=%H", "--", pathspec(dir))
}

// pathspec is a directory as git wants it: the repository root is ".", not the empty string.
func pathspec(dir string) string {
	if dir == "" {
		return "."
	}
	return dir
}
