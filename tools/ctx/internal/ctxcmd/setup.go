package ctxcmd

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"ctx/internal/gitx"
)

// InitOptions selects what `ctx init` configures.
type InitOptions struct {
	PushSpec bool // write remote.<name>.push refspecs
	Hooks    bool // install the commit-msg gate hook
	Force    bool // overwrite an existing hook
}

const hookScript = `#!/usr/bin/env sh
# installed by ctx init -hooks
exec ctx gate -m "$1"
`

const blameIgnoreHeader = `# Revisions ignored by ` + "`git blame`" + ` and ` + "`ctx for`" + `: reformatting,
# renames, mechanical rewrites. One full 40-character SHA per line.
`

// Init configures the repository and returns a log of what changed.
func Init(ctx context.Context, repo *gitx.Repo, opts InitOptions) ([]string, error) {
	var log []string

	for _, setting := range [][2]string{
		{"notes.mergeStrategy", "cat_sort_uniq"}, // concurrent CI appends must merge, not conflict
		{"notes.rewriteRef", "refs/notes/*"},     // notes follow their commit through a rebase
		{"blame.ignoreRevsFile", BlameIgnoreFile},
	} {
		if err := repo.SetConfig(ctx, setting[0], setting[1]); err != nil {
			return log, err
		}
		log = append(log, fmt.Sprintf("config %s = %s", setting[0], setting[1]))
	}

	// Only origin: a repo commonly carries other remotes for unrelated purposes
	// (a registry mirror, a fork used as a pull-only upstream), and origin is the
	// only one ctx can assume is actually this project. Configuring every remote
	// blindly means a later `git push <that other remote>` starts pushing this
	// repo's branches into whatever project that remote happens to point at.
	if remote := primaryRemote(repo.Remotes(ctx)); remote != "" {
		specs := [][2]string{{"remote." + remote + ".fetch", "+refs/notes/*:refs/notes/*"}}
		if opts.PushSpec {
			// An explicit push refspec disables the default `simple` push, so the
			// branch refspec has to come along with it or branches stop pushing.
			specs = append(specs,
				[2]string{"remote." + remote + ".push", "refs/heads/*:refs/heads/*"},
				[2]string{"remote." + remote + ".push", "refs/notes/*:refs/notes/*"})
		}
		for _, spec := range specs {
			added, err := repo.AddConfigOnce(ctx, spec[0], spec[1])
			if err != nil {
				return log, err
			}
			if added {
				log = append(log, fmt.Sprintf("config %s += %s", spec[0], spec[1]))
			}
		}
	} else if len(repo.Remotes(ctx)) > 0 {
		log = append(log, "no \"origin\" remote found; skipping notes refspecs — "+
			"configure them by hand for whichever remote is this project (git config --add remote.<name>.fetch ...)")
	}

	if repo.IsLinkedWorktree(ctx) {
		log = append(log, "warning: linked worktree; blame.ignoreRevsFile is shared config, so copy "+
			BlameIgnoreFile+" into every worktree or plain `git blame` will fail there")
	}

	ignorePath := filepath.Join(repo.TopLevel(ctx), BlameIgnoreFile)
	if !FileExists(ignorePath) {
		if err := os.WriteFile(ignorePath, []byte(blameIgnoreHeader), 0o644); err != nil {
			return log, err
		}
		log = append(log, "created "+BlameIgnoreFile)
	}

	if opts.Hooks {
		line, err := installHook(ctx, repo, opts.Force)
		if err != nil {
			return log, err
		}
		log = append(log, line)
	}
	return log, nil
}

// installHook writes the commit-msg hook that runs the gate on every commit.
// primaryRemote picks the one remote ctx trusts to be this project.
func primaryRemote(remotes []string) string {
	for _, r := range remotes {
		if r == "origin" {
			return r
		}
	}
	return ""
}

func installHook(ctx context.Context, repo *gitx.Repo, force bool) (string, error) {
	dir := repo.HooksDir(ctx)
	if dir == "" {
		return "", fmt.Errorf("cannot locate the hooks directory (git 2.31 or newer is required for -hooks)")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	hook := filepath.Join(dir, "commit-msg")
	if existing, err := os.ReadFile(hook); err == nil && !force {
		if string(existing) == hookScript {
			return "hook commit-msg already installed", nil
		}
		return "", fmt.Errorf("%s exists and is not the ctx hook; re-run with -force to replace it", hook)
	}
	if err := os.WriteFile(hook, []byte(hookScript), 0o755); err != nil {
		return "", err
	}
	return "installed hook " + hook, nil
}
