// Package ctxcmd implements the five ctx commands. Each one returns a result
// value; printing and exit codes are the caller's business, which is what makes
// them testable without a terminal.
package ctxcmd

import (
	"io"
	"os"

	"ctx/internal/gitx"
)

// BlameIgnoreFile lists revisions blame must look through: reformatting,
// renames, mechanical rewrites.
const BlameIgnoreFile = ".git-blame-ignore-revs"

// Env is the ambient state a command needs.
type Env struct {
	Repo *gitx.Repo
	Out  io.Writer
	Err  io.Writer
}

// FileExists is a variable so tests can simulate a filesystem.
var FileExists = func(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
