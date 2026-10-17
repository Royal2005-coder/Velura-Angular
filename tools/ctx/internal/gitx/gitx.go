// Package gitx is the only place in ctx that executes git. Everything above it
// talks to Repo, and tests substitute a Runner instead of a real repository.
package gitx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// ErrNotRepo is returned by Open when dir is not inside a git repository.
var ErrNotRepo = errors.New("not a git repository")

// DefaultTimeout bounds a single git invocation so a wedged git (a lock held by
// another process, a filesystem in D-state) surfaces as an error, not a hang.
const DefaultTimeout = 30 * time.Second

// Runner executes one git command and returns its stdout.
type Runner interface {
	Run(ctx context.Context, stdin string, args ...string) (string, error)
}

// Error carries git's stderr, which is the only part worth showing a human.
type Error struct {
	Args   []string
	Stderr string
	Err    error
}

func (e *Error) Error() string {
	if e.Stderr != "" {
		return fmt.Sprintf("git %s: %s", strings.Join(e.Args, " "), e.Stderr)
	}
	return fmt.Sprintf("git %s: %v", strings.Join(e.Args, " "), e.Err)
}

func (e *Error) Unwrap() error { return e.Err }

// ExecRunner runs the real git binary.
type ExecRunner struct {
	Dir     string
	Timeout time.Duration
}

func (x ExecRunner) Run(ctx context.Context, stdin string, args ...string) (string, error) {
	timeout := x.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = x.Dir
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb

	err := cmd.Run()
	stdout := strings.TrimRight(out.String(), "\n")
	if err != nil {
		if ctx.Err() != nil {
			err = fmt.Errorf("timed out after %s: %w", timeout, err)
		}
		return stdout, &Error{Args: args, Stderr: strings.TrimSpace(errb.String()), Err: err}
	}
	return stdout, nil
}

// Repo is a git repository seen through a Runner.
type Repo struct{ runner Runner }

func New(r Runner) *Repo { return &Repo{runner: r} }

// Open verifies that dir is inside a repository before returning a Repo.
func Open(ctx context.Context, dir string) (*Repo, error) {
	r := New(ExecRunner{Dir: dir})
	if _, err := r.Text(ctx, "rev-parse", "--git-dir"); err != nil {
		return nil, ErrNotRepo
	}
	return r, nil
}

// Text runs git and returns trimmed stdout.
func (r *Repo) Text(ctx context.Context, args ...string) (string, error) {
	return r.runner.Run(ctx, "", args...)
}

// Pipe runs git with stdin attached.
func (r *Repo) Pipe(ctx context.Context, stdin string, args ...string) (string, error) {
	return r.runner.Run(ctx, stdin, args...)
}

// Quiet runs git and discards the error. Use it only where failure and empty
// output mean the same thing: a missing notes ref, an unborn HEAD, a config key
// that was never set.
func (r *Repo) Quiet(ctx context.Context, args ...string) string {
	out, _ := r.runner.Run(ctx, "", args...)
	return out
}

// QuietLines is Quiet split into non-empty trimmed lines.
func (r *Repo) QuietLines(ctx context.Context, args ...string) []string {
	return Lines(r.Quiet(ctx, args...))
}

// Lines splits output into non-empty, space-trimmed lines.
func Lines(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}
