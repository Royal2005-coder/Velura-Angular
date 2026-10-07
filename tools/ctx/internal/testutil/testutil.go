// Package testutil builds throwaway repositories and fake git runners for tests.
package testutil

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"ctx/internal/gitx"
)

// Repo is a real git repository in a temp directory, plus a gitx.Repo bound to it.
type Repo struct {
	T   *testing.T
	Dir string
	*gitx.Repo
}

// NewRepo initialises an empty repository with deterministic identity.
func NewRepo(t *testing.T) *Repo {
	t.Helper()
	dir := t.TempDir()
	r := &Repo{T: t, Dir: dir, Repo: gitx.New(gitx.ExecRunner{Dir: dir})}
	r.Git("init", "-q", "-b", "main", ".")
	r.Git("config", "user.name", "ctx test")
	r.Git("config", "user.email", "test@example.com")
	r.Git("config", "commit.gpgsign", "false")
	return r
}

// Git runs a git command in the repo and fails the test if it errors.
func (r *Repo) Git(args ...string) string {
	r.T.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = r.Dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_DATE=2026-01-01T00:00:00+00:00",
		"GIT_COMMITTER_DATE=2026-01-01T00:00:00+00:00")
	out, err := cmd.CombinedOutput()
	if err != nil {
		r.T.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimRight(string(out), "\n")
}

// GitErr runs a git command and returns its output and error without failing.
func (r *Repo) GitErr(args ...string) (string, error) {
	r.T.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = r.Dir
	out, err := cmd.CombinedOutput()
	return strings.TrimRight(string(out), "\n"), err
}

// Write creates or replaces a file, making parent directories as needed.
func (r *Repo) Write(path, content string) {
	r.T.Helper()
	full := filepath.Join(r.Dir, path)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		r.T.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		r.T.Fatal(err)
	}
}

// Commit stages everything and commits with the given message, returning the SHA.
// Trailers are passed as "Key:value" strings.
func (r *Repo) Commit(message string, trailers ...string) string {
	r.T.Helper()
	r.Git("add", "-A")
	args := []string{"commit", "-q", "--allow-empty", "-m", message}
	for _, t := range trailers {
		args = append(args, "--trailer", t)
	}
	r.Git(args...)
	return r.Git("rev-parse", "HEAD")
}

// Ctx returns a context for a test call.
func Ctx() context.Context { return context.Background() }

// FakeRunner answers scripted git invocations, keyed by the joined arguments.
// It records every call so tests can assert on what was asked of git.
type FakeRunner struct {
	mu        sync.Mutex
	Responses map[string]string
	Errors    map[string]error
	Calls     []string
	Stdin     []string
}

func (f *FakeRunner) Run(_ context.Context, stdin string, args ...string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := strings.Join(args, " ")
	f.Calls = append(f.Calls, key)
	f.Stdin = append(f.Stdin, stdin)
	if err, ok := f.Errors[key]; ok {
		return "", err
	}
	return f.Responses[key], nil
}

// Called reports whether a command matching substring was run.
func (f *FakeRunner) Called(substring string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, call := range f.Calls {
		if strings.Contains(call, substring) {
			return true
		}
	}
	return false
}
