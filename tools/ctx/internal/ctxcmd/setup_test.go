package ctxcmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ctx/internal/testutil"
)

// TestInit_SetsCoreConfig checks the three config settings Init always writes.
func TestInit_SetsCoreConfig(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	r.Commit("seed")

	if _, err := Init(testutil.Ctx(), r.Repo, InitOptions{}); err != nil {
		t.Fatalf("Init: %v", err)
	}

	checks := map[string]string{
		"notes.mergeStrategy":  "cat_sort_uniq",
		"notes.rewriteRef":     "refs/notes/*",
		"blame.ignoreRevsFile": BlameIgnoreFile,
	}
	for key, want := range checks {
		if got := r.Git("config", "--get", key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
}

// TestInit_CreatesBlameIgnoreFileOnlyWhenAbsent checks that the ignore file is
// created on a first run, and that a second run leaves an existing file's
// contents untouched.
func TestInit_CreatesBlameIgnoreFileOnlyWhenAbsent(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	r.Commit("seed")

	ignorePath := filepath.Join(r.Dir, BlameIgnoreFile)

	if _, err := Init(testutil.Ctx(), r.Repo, InitOptions{}); err != nil {
		t.Fatalf("Init (1st run): %v", err)
	}
	if _, err := os.Stat(ignorePath); err != nil {
		t.Fatalf("ignore file was not created: %v", err)
	}

	custom := "# hand-curated list\ndeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n"
	if err := os.WriteFile(ignorePath, []byte(custom), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := Init(testutil.Ctx(), r.Repo, InitOptions{}); err != nil {
		t.Fatalf("Init (2nd run): %v", err)
	}

	got, err := os.ReadFile(ignorePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != custom {
		t.Errorf("existing ignore file was overwritten: got %q, want %q", got, custom)
	}
}

// A repo may carry other remotes for unrelated purposes — a registry mirror,
// a stale fork used as a pull-only upstream. Only origin is configured: ctx
// cannot tell those apart from a genuine mirror of this project, and getting
// it wrong means a later `git push <that remote>` starts pushing this repo's
// branches into whatever project it actually points at.
func TestInit_OnlyConfiguresOriginNotOtherRemotes(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	r.Commit("seed")
	r.Git("remote", "add", "origin", "https://example.invalid/this-repo.git")
	r.Git("remote", "add", "mirror", "https://example.invalid/unrelated-project.git")

	if _, err := Init(testutil.Ctx(), r.Repo, InitOptions{PushSpec: true}); err != nil {
		t.Fatalf("Init: %v", err)
	}

	if got := r.Git("config", "--get-all", "remote.origin.fetch"); !strings.Contains(got, "+refs/notes/*:refs/notes/*") {
		t.Errorf("remote.origin.fetch = %q, want the notes refspec", got)
	}
	if out, err := r.GitErr("config", "--get-all", "remote.mirror.push"); err == nil {
		t.Errorf("remote.mirror.push should be untouched, got %q", out)
	}
	// git remote add itself sets a default fetch refspec; the point is that
	// ctx must not ADD the notes refspec on top of it.
	if got, _ := r.GitErr("config", "--get-all", "remote.mirror.fetch"); strings.Contains(got, "refs/notes") {
		t.Errorf("remote.mirror.fetch = %q, ctx must not add a notes refspec to a non-origin remote", got)
	}
}

// TestInit_PushSpecAddsRefspecsAndIsIdempotent checks that PushSpec:true adds
// both the heads and notes push refspecs plus the notes fetch refspec to a
// configured remote, and that a second run does not duplicate them.
func TestInit_PushSpecAddsRefspecsAndIsIdempotent(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	r.Commit("seed")
	r.Git("remote", "add", "origin", "https://example.invalid/repo.git")

	run := func() []string {
		log, err := Init(testutil.Ctx(), r.Repo, InitOptions{PushSpec: true})
		if err != nil {
			t.Fatalf("Init: %v", err)
		}
		return log
	}

	firstLog := strings.Join(run(), "\n")
	for _, want := range []string{
		"remote.origin.fetch += +refs/notes/*:refs/notes/*",
		"remote.origin.push += refs/heads/*:refs/heads/*",
		"remote.origin.push += refs/notes/*:refs/notes/*",
	} {
		if !strings.Contains(firstLog, want) {
			t.Errorf("first run log missing %q, got:\n%s", want, firstLog)
		}
	}

	fetchSpecs := r.Git("config", "--get-all", "remote.origin.fetch")
	if !strings.Contains(fetchSpecs, "+refs/notes/*:refs/notes/*") {
		t.Errorf("fetch refspecs = %q, want it to include the notes fetch refspec", fetchSpecs)
	}
	pushSpecs := r.Git("config", "--get-all", "remote.origin.push")
	wantPush := "refs/heads/*:refs/heads/*\nrefs/notes/*:refs/notes/*"
	if pushSpecs != wantPush {
		t.Errorf("push refspecs = %q, want %q", pushSpecs, wantPush)
	}

	secondLog := run()
	for _, line := range secondLog {
		if strings.Contains(line, "remote.origin.") {
			t.Errorf("second run should be idempotent, but logged: %q", line)
		}
	}
	if got := r.Git("config", "--get-all", "remote.origin.fetch"); got != fetchSpecs {
		t.Errorf("fetch refspecs changed on 2nd run: %q -> %q", fetchSpecs, got)
	}
	if got := r.Git("config", "--get-all", "remote.origin.push"); got != pushSpecs {
		t.Errorf("push refspecs changed on 2nd run: %q -> %q", pushSpecs, got)
	}
}

// TestInit_NoPushSpecLeavesPushUnset checks that PushSpec:false still wires up
// the notes fetch refspec but never touches remote.*.push.
func TestInit_NoPushSpecLeavesPushUnset(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	r.Commit("seed")
	r.Git("remote", "add", "origin", "https://example.invalid/repo.git")

	if _, err := Init(testutil.Ctx(), r.Repo, InitOptions{PushSpec: false}); err != nil {
		t.Fatalf("Init: %v", err)
	}

	if out, err := r.GitErr("config", "--get-all", "remote.origin.push"); err == nil {
		t.Errorf("remote.origin.push should be unset, got %q", out)
	}
	if got := r.Git("config", "--get-all", "remote.origin.fetch"); !strings.Contains(got, "+refs/notes/*:refs/notes/*") {
		t.Errorf("fetch refspecs = %q, want it to include the notes fetch refspec", got)
	}
}

// TestInit_HooksInstallsAndSecondRunIsNoop checks that Hooks:true installs an
// executable commit-msg hook containing `ctx gate`, and that re-running is a
// no-op.
func TestInit_HooksInstallsAndSecondRunIsNoop(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	r.Commit("seed")

	log, err := Init(testutil.Ctx(), r.Repo, InitOptions{Hooks: true})
	if err != nil {
		t.Fatalf("Init: %v", err)
	}

	hookPath := filepath.Join(r.Dir, ".git", "hooks", "commit-msg")
	info, err := os.Stat(hookPath)
	if err != nil {
		t.Fatalf("hook was not installed: %v", err)
	}
	if info.Mode()&0o111 == 0 {
		t.Errorf("hook is not executable: mode %v", info.Mode())
	}
	body, err := os.ReadFile(hookPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "ctx gate") {
		t.Errorf("hook body missing `ctx gate`: %q", body)
	}
	if joined := strings.Join(log, "\n"); !strings.Contains(joined, "installed hook") {
		t.Errorf("log missing install line: %v", log)
	}

	log2, err := Init(testutil.Ctx(), r.Repo, InitOptions{Hooks: true})
	if err != nil {
		t.Fatalf("Init (2nd run): %v", err)
	}
	if joined2 := strings.Join(log2, "\n"); !strings.Contains(joined2, "already installed") {
		t.Errorf("2nd run should be a no-op, got: %v", log2)
	}
}

// TestInit_HooksUnrelatedExistingHookErrorsUnlessForced checks that an
// unrelated pre-existing commit-msg hook blocks installation unless Force is
// set, and that Force replaces it.
func TestInit_HooksUnrelatedExistingHookErrorsUnlessForced(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	r.Commit("seed")

	hookDir := filepath.Join(r.Dir, ".git", "hooks")
	if err := os.MkdirAll(hookDir, 0o755); err != nil {
		t.Fatal(err)
	}
	hookPath := filepath.Join(hookDir, "commit-msg")
	other := "#!/bin/sh\necho not ctx\n"
	if err := os.WriteFile(hookPath, []byte(other), 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := Init(testutil.Ctx(), r.Repo, InitOptions{Hooks: true}); err == nil {
		t.Fatal("want an error: an unrelated commit-msg hook already exists")
	}
	body, err := os.ReadFile(hookPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != other {
		t.Errorf("unrelated hook should be left untouched, got %q", body)
	}

	if _, err := Init(testutil.Ctx(), r.Repo, InitOptions{Hooks: true, Force: true}); err != nil {
		t.Fatalf("Init with Force: %v", err)
	}
	body2, err := os.ReadFile(hookPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body2), "ctx gate") {
		t.Errorf("Force should replace the hook, got %q", body2)
	}
}
