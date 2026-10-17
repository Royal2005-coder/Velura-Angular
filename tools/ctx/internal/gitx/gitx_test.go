package gitx_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"ctx/internal/gitx"
	"ctx/internal/testutil"
)

func TestLines(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"trailing newlines", "a\nb\n\n", []string{"a", "b"}},
		{"blank and whitespace-only lines", "a\n\n   \nb", []string{"a", "b"}},
		{"crlf", "a\r\nb\r\n", []string{"a", "b"}},
		{"empty input", "", nil},
		{"only whitespace", "   \n\t\n", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := gitx.Lines(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("Lines(%q) = %#v, want %#v", tc.in, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("Lines(%q)[%d] = %q, want %q", tc.in, i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestErrorPrefersStderr(t *testing.T) {
	e := &gitx.Error{Args: []string{"status"}, Stderr: "fatal: boom", Err: errors.New("exit status 1")}
	got := e.Error()
	if got != "git status: fatal: boom" {
		t.Fatalf("Error() = %q, want %q", got, "git status: fatal: boom")
	}
}

func TestErrorFallsBackToWrappedErr(t *testing.T) {
	wrapped := errors.New("exit status 1")
	e := &gitx.Error{Args: []string{"status"}, Err: wrapped}
	got := e.Error()
	if got != "git status: exit status 1" {
		t.Fatalf("Error() = %q, want %q", got, "git status: exit status 1")
	}
}

func TestErrorUnwrap(t *testing.T) {
	sentinel := errors.New("sentinel")
	e := &gitx.Error{Args: []string{"status"}, Err: sentinel}

	if !errors.Is(e, sentinel) {
		t.Fatal("errors.Is(e, sentinel) = false, want true")
	}

	var target *gitx.Error
	if !errors.As(e, &target) {
		t.Fatal("errors.As(e, &target) = false, want true")
	}
	if target.Unwrap() != sentinel {
		t.Fatalf("Unwrap() = %v, want %v", target.Unwrap(), sentinel)
	}
}

func TestExecRunnerHappyPath(t *testing.T) {
	repo := testutil.NewRepo(t)
	runner := gitx.ExecRunner{Dir: repo.Dir}

	out, err := runner.Run(testutil.Ctx(), "", "rev-parse", "--git-dir")
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if out != ".git" {
		t.Fatalf("Run() = %q, want %q", out, ".git")
	}
}

func TestExecRunnerFailureCarriesStderr(t *testing.T) {
	repo := testutil.NewRepo(t)
	runner := gitx.ExecRunner{Dir: repo.Dir}

	_, err := runner.Run(testutil.Ctx(), "", "not-a-real-git-subcommand")
	if err == nil {
		t.Fatal("Run() error = nil, want non-nil")
	}
	var gerr *gitx.Error
	if !errors.As(err, &gerr) {
		t.Fatalf("error is not *gitx.Error: %v (%T)", err, err)
	}
	if gerr.Stderr == "" {
		t.Fatal("gerr.Stderr is empty, want git's error message")
	}
}

func TestExecRunnerCancelledContextFailsFast(t *testing.T) {
	repo := testutil.NewRepo(t)
	runner := gitx.ExecRunner{Dir: repo.Dir, Timeout: 5 * time.Second}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan error, 1)
	go func() {
		_, err := runner.Run(ctx, "", "status")
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Run() with a cancelled context returned nil error, want an error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run() hung instead of failing fast on a cancelled context")
	}
}
