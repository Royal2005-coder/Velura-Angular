package gitx

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

// Resolve turns any revision expression into a full commit SHA.
func (r *Repo) Resolve(ctx context.Context, rev string) (string, error) {
	sha, err := r.Text(ctx, "rev-parse", "--verify", "--quiet", rev+"^{commit}")
	if err != nil || sha == "" {
		return "", fmt.Errorf("not a commit: %s", rev)
	}
	return sha, nil
}

// Message returns the full commit message body.
func (r *Repo) Message(ctx context.Context, sha string) string {
	return r.Quiet(ctx, "show", "-s", "--format=%B", sha)
}

// Subject returns the first line of the commit message.
func (r *Repo) Subject(ctx context.Context, sha string) string {
	return r.Quiet(ctx, "show", "-s", "--format=%s", sha)
}

// TopLevel is the working tree root, or "." when there is not one (a bare repo).
func (r *Repo) TopLevel(ctx context.Context) string {
	if top := r.Quiet(ctx, "rev-parse", "--show-toplevel"); top != "" {
		return top
	}
	return "."
}

// HooksDir is where git looks for hooks, honouring core.hooksPath.
//
// --path-format=absolute (git >= 2.31) is required here: a bare --git-path
// returns a path relative to the CALLER's directory, so resolving it against
// anything else writes the hook outside the repository. An empty result means
// git is too old, and the caller must refuse rather than guess.
func (r *Repo) HooksDir(ctx context.Context) string {
	dir := r.Quiet(ctx, "rev-parse", "--path-format=absolute", "--git-path", "hooks")
	if !filepath.IsAbs(dir) {
		return ""
	}
	return dir
}

func (r *Repo) IsBare(ctx context.Context) bool {
	return r.Quiet(ctx, "rev-parse", "--is-bare-repository") == "true"
}

func (r *Repo) IsShallow(ctx context.Context) bool {
	return r.Quiet(ctx, "rev-parse", "--is-shallow-repository") == "true"
}

// IsLinkedWorktree reports whether this is a `git worktree add` checkout, which
// shares .git/config with its siblings but not the working tree.
func (r *Repo) IsLinkedWorktree(ctx context.Context) bool {
	dir := r.Quiet(ctx, "rev-parse", "--git-dir")
	common := r.Quiet(ctx, "rev-parse", "--git-common-dir")
	return dir != "" && common != "" && dir != common
}

// StagedFiles lists paths in the index that differ from HEAD.
func (r *Repo) StagedFiles(ctx context.Context) []string {
	return r.QuietLines(ctx, "diff", "--cached", "--name-only")
}

// HeadFiles lists paths touched by HEAD.
func (r *Repo) HeadFiles(ctx context.Context) []string {
	return r.QuietLines(ctx, "show", "--name-only", "--format=", "HEAD")
}

// Remotes lists configured remote names.
func (r *Repo) Remotes(ctx context.Context) []string {
	return r.QuietLines(ctx, "remote")
}

// SetConfig writes a single-valued config key.
func (r *Repo) SetConfig(ctx context.Context, key, value string) error {
	_, err := r.Text(ctx, "config", key, value)
	return err
}

// AddConfigOnce appends value to a multi-valued key unless it is already there.
// It reports whether it actually wrote anything.
func (r *Repo) AddConfigOnce(ctx context.Context, key, value string) (bool, error) {
	for _, existing := range r.QuietLines(ctx, "config", "--get-all", key) {
		if existing == value {
			return false, nil
		}
	}
	if _, err := r.Text(ctx, "config", "--add", key, value); err != nil {
		return false, err
	}
	return true, nil
}

// ConfigAll returns every value of a multi-valued key.
func (r *Repo) ConfigAll(ctx context.Context, key string) []string {
	return r.QuietLines(ctx, "config", "--get-all", key)
}

// IsDir reports whether path is a directory in HEAD. The empty string is the repository root.
// A path that is a file, or is not in HEAD at all, is not a directory.
func (r *Repo) IsDir(ctx context.Context, path string) bool {
	return r.Quiet(ctx, "cat-file", "-t", "HEAD:"+path) == "tree"
}

// Files lists the files beneath a directory in HEAD, in git's order, recursively.
// Submodules appear as paths too; blaming one fails and the caller counts it.
func (r *Repo) Files(ctx context.Context, dir string) []string {
	out := r.Quiet(ctx, "ls-tree", "-r", "--name-only", "-z", "HEAD", "--", pathspec(dir))
	var files []string
	for _, f := range strings.Split(out, "\x00") {
		if f = strings.TrimRight(f, "\n"); f != "" {
			files = append(files, f)
		}
	}
	return files
}
