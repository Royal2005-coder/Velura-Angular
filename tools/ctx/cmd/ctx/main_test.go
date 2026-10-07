package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// binary is built once and exercised as a real process, because exit codes and
// stream routing are the contract this package owns.
var binary string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "ctx-cli")
	if err != nil {
		panic(err)
	}
	binary = filepath.Join(dir, "ctx")
	build := exec.Command("go", "build", "-o", binary, ".")
	if out, err := build.CombinedOutput(); err != nil {
		panic(string(out))
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// runResult captures one invocation.
type runResult struct {
	stdout, stderr string
	code           int
}

func runCLI(t *testing.T, dir string, args ...string) runResult {
	t.Helper()
	cmd := exec.Command(binary, args...)
	cmd.Dir = dir
	var out, errb strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	code := 0
	var exit *exec.ExitError
	if err != nil {
		if !asExitError(err, &exit) {
			t.Fatalf("running ctx %v: %v", args, err)
		}
		code = exit.ExitCode()
	}
	return runResult{stdout: out.String(), stderr: errb.String(), code: code}
}

func asExitError(err error, target **exec.ExitError) bool {
	e, ok := err.(*exec.ExitError)
	if ok {
		*target = e
	}
	return ok
}

// repo builds a throwaway repository with one gated commit.
func repo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git("init", "-q", "-b", "main", ".")
	git("config", "user.name", "ctx test")
	git("config", "user.email", "test@example.com")
	if err := os.MkdirAll(filepath.Join(dir, "infra"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "infra", "main.tf"), []byte("resource {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", "-A")
	git("commit", "-q", "-m", "infra: seed", "--trailer", "Decision:seeded", "--trailer", "Reversible:true", "--trailer", "Oracle:drift")
	return dir
}

func TestUsageExitsTwo(t *testing.T) {
	got := runCLI(t, t.TempDir())
	if got.code != 2 {
		t.Errorf("bare invocation: exit = %d, want 2", got.code)
	}
	if !strings.Contains(got.stderr, "ctx — Documents as Commit") {
		t.Errorf("usage should go to stderr, got %q", got.stderr)
	}
}

func TestUnknownCommandExitsTwo(t *testing.T) {
	got := runCLI(t, repo(t), "nope")
	if got.code != 2 {
		t.Errorf("exit = %d, want 2", got.code)
	}
	if !strings.Contains(got.stderr, `unknown command "nope"`) {
		t.Errorf("stderr = %q", got.stderr)
	}
}

func TestHelpAndVersionExitZeroOnStdout(t *testing.T) {
	// Neither may require a repository: `ctx help` has to work anywhere.
	for _, arg := range []string{"help", "--help", "-h"} {
		got := runCLI(t, t.TempDir(), arg)
		if got.code != 0 || !strings.Contains(got.stdout, "ctx init") {
			t.Errorf("%s: exit=%d stdout=%q", arg, got.code, got.stdout)
		}
	}
	got := runCLI(t, t.TempDir(), "version")
	if got.code != 0 || !strings.HasPrefix(got.stdout, "ctx ") {
		t.Errorf("version: exit=%d stdout=%q", got.code, got.stdout)
	}
}

func TestOutsideRepositoryExitsOne(t *testing.T) {
	dir := t.TempDir()
	for _, args := range [][]string{{"gate"}, {"for", "x.go"}, {"reindex"}} {
		got := runCLI(t, dir, args...)
		if got.code != 1 {
			t.Errorf("%v outside a repo: exit = %d, want 1", args, got.code)
		}
		if !strings.Contains(got.stderr, "not a git repository") {
			t.Errorf("%v: stderr = %q", args, got.stderr)
		}
	}
}

func TestGateExitCodes(t *testing.T) {
	dir := repo(t)
	if got := runCLI(t, dir, "gate"); got.code != 0 {
		t.Errorf("clean HEAD: exit = %d (%s)", got.code, got.stderr)
	}

	msg := filepath.Join(dir, "msg.txt")
	if err := os.WriteFile(msg, []byte("infra: change with no decision\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "infra", "main.tf"), []byte("resource { x = 1 }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	add := exec.Command("git", "add", "-A")
	add.Dir = dir
	if out, err := add.CombinedOutput(); err != nil {
		t.Fatalf("git add: %v\n%s", err, out)
	}

	got := runCLI(t, dir, "gate", "-m", msg)
	if got.code != 1 {
		t.Errorf("violation: exit = %d, want 1", got.code)
	}
	if !strings.Contains(got.stderr, "missing `Decision:` trailer") {
		t.Errorf("violation must be reported on stderr, got %q", got.stderr)
	}
	if got.stdout != "" {
		t.Errorf("a failing gate must print nothing to stdout, got %q", got.stdout)
	}
}

// A directory is a scope: it exits 0 with the decisions beneath it, and never reports a directory
// that exists as removed.
func TestForDirectory(t *testing.T) {
	dir := repo(t)

	got := runCLI(t, dir, "for", "infra")
	if got.code != 0 || !strings.HasPrefix(got.stdout, "scope: infra\n") {
		t.Fatalf("directory: exit=%d stdout=%q stderr=%q", got.code, got.stdout, got.stderr)
	}
	if strings.Contains(got.stdout, "removed:") || strings.Contains(got.stdout, "error:") {
		t.Errorf("a directory that exists is neither removed nor an error:\n%s", got.stdout)
	}
	if slash := runCLI(t, dir, "for", "infra/"); slash.stdout != got.stdout {
		t.Errorf("a trailing slash changes the answer:\n%s\nvs\n%s", slash.stdout, got.stdout)
	}
}

func TestForFormats(t *testing.T) {
	dir := repo(t)

	yaml := runCLI(t, dir, "for", "infra/main.tf")
	if yaml.code != 0 || !strings.HasPrefix(yaml.stdout, "scope: infra/main.tf\n") {
		t.Fatalf("yaml: exit=%d stdout=%q", yaml.code, yaml.stdout)
	}

	js := runCLI(t, dir, "for", "infra/main.tf", "-format", "json")
	if js.code != 0 || !strings.HasPrefix(js.stdout, "{\n  \"scope\"") {
		t.Fatalf("json: exit=%d stdout=%q", js.code, js.stdout)
	}

	// Flags must work on either side of the positional argument.
	swapped := runCLI(t, dir, "for", "-format", "json", "infra/main.tf")
	if swapped.stdout != js.stdout {
		t.Errorf("flag order changed the output:\n%q\n%q", swapped.stdout, js.stdout)
	}

	bad := runCLI(t, dir, "for", "infra/main.tf", "-format", "toml")
	if bad.code != 1 || !strings.Contains(bad.stderr, "unknown format") {
		t.Errorf("bad format: exit=%d stderr=%q", bad.code, bad.stderr)
	}
}

func TestSupersedeRequiresReason(t *testing.T) {
	dir := repo(t)
	head := exec.Command("git", "rev-parse", "HEAD")
	head.Dir = dir
	sha, err := head.Output()
	if err != nil {
		t.Fatal(err)
	}
	target := strings.TrimSpace(string(sha))

	if got := runCLI(t, dir, "supersede", target); got.code != 1 || !strings.Contains(got.stderr, "reason is required") {
		t.Errorf("missing reason: exit=%d stderr=%q", got.code, got.stderr)
	}
	if got := runCLI(t, dir, "supersede", "deadbeef", "-reason", "x"); got.code != 1 || !strings.Contains(got.stderr, "not a commit") {
		t.Errorf("bad target: exit=%d stderr=%q", got.code, got.stderr)
	}
	if got := runCLI(t, dir, "supersede", target, "-reason", "superseded in a test"); got.code != 0 {
		t.Errorf("valid supersede: exit=%d stderr=%q", got.code, got.stderr)
	}
}

// -since must never turn a failed compile into silence: "I could not tell"
// has to look different from "nothing changed".
func TestForSinceFallsBackToFullReportOnError(t *testing.T) {
	dir := repo(t)
	base := filepath.Join(dir, "base.json")
	if err := os.WriteFile(base, []byte(`{"scope":"x","active":[],"superseded":[],"orphaned":[],"open_incidents":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	got := runCLI(t, dir, "for", "does/not/exist.go", "-since", base)
	if got.code != 0 || !strings.Contains(got.stdout, "error:") {
		t.Fatalf("exit=%d stdout=%q, want the full report carrying its error line", got.code, got.stdout)
	}

	// A missing or corrupt baseline, or one taken of another scope, is not a
	// baseline: fall back to the full report, never to silence.
	for name, setup := range map[string]func() string{
		"missing": func() string { return filepath.Join(dir, "nope.json") },
		"corrupt": func() string {
			p := filepath.Join(dir, "bad.json")
			os.WriteFile(p, []byte("not json{"), 0o644)
			return p
		},
		"other scope": func() string {
			p := filepath.Join(dir, "other.json")
			os.WriteFile(p, []byte(`{"scope":"somewhere/else.tf","active":[],"superseded":[],"orphaned":[],"open_incidents":[]}`), 0o644)
			return p
		},
	} {
		got := runCLI(t, dir, "for", "infra/main.tf", "-since", setup())
		if got.code != 0 || !strings.HasPrefix(got.stdout, "scope: infra/main.tf\n") {
			t.Errorf("%s baseline: exit=%d stdout=%q, want the full report", name, got.code, got.stdout)
		}
	}

	// A bogus -format is rejected even when -since would otherwise short-circuit.
	bad := runCLI(t, dir, "for", "infra/main.tf", "-since", base, "-format", "toml")
	if bad.code != 1 || !strings.Contains(bad.stderr, "unknown format") {
		t.Fatalf("exit=%d stderr=%q, want format validated before -since", bad.code, bad.stderr)
	}
}

// render re-emits a report from stdin without touching git, and applies
// -since to it exactly as `for` would.
func TestRenderFromStdin(t *testing.T) {
	dir := repo(t)
	full := runCLI(t, dir, "for", "infra/main.tf", "-format", "json")
	cmd := exec.Command(binary, "render")
	cmd.Dir = dir
	cmd.Stdin = strings.NewReader(full.stdout)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.HasPrefix(string(out), "scope: infra/main.tf\n") {
		t.Fatalf("render = %q, want the YAML report", out)
	}

	base := filepath.Join(dir, "base.json")
	if err := os.WriteFile(base, []byte(full.stdout), 0o644); err != nil {
		t.Fatal(err)
	}
	same := exec.Command(binary, "render", "-since", base)
	same.Dir = dir
	same.Stdin = strings.NewReader(full.stdout)
	if out, err := same.Output(); err != nil || len(out) != 0 {
		t.Fatalf("render -since against itself = %q err=%v, want nothing", out, err)
	}
}
