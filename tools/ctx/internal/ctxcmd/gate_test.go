package ctxcmd

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"ctx/internal/gitx"
	"ctx/internal/testutil"
)

// TestEvaluate is a table-driven test over the trailer rules. Evaluate is a
// pure function, so no repository is needed.
func TestEvaluate(t *testing.T) {
	cases := []struct {
		name     string
		trailers gitx.Trailers
		gated    []string
		want     []string // substrings, one per expected violation, in order
	}{
		{
			name:     "gated path with no Decision fails",
			trailers: gitx.Trailers{},
			gated:    []string{"infra/a.tf"},
			want:     []string{"missing `Decision:`"},
		},
		{
			name:     "gated path with Decision passes",
			trailers: gitx.Trailers{"decision": {"do the thing"}},
			gated:    []string{"infra/a.tf"},
			want:     nil,
		},
		{
			name:     "whitespace-only Decision counts as missing",
			trailers: gitx.Trailers{"decision": {"   "}},
			gated:    []string{"infra/a.tf"},
			want:     []string{"missing `Decision:`"},
		},
		{
			name:     "no gated paths means no Decision is required",
			trailers: gitx.Trailers{},
			gated:    nil,
			want:     nil,
		},
		{
			name:     "Reversible never without Oracle fails",
			trailers: gitx.Trailers{"decision": {"x"}, "reversible": {"never"}},
			gated:    nil,
			want:     []string{"requires an `Oracle:`"},
		},
		{
			name: "Reversible never with Oracle passes",
			trailers: gitx.Trailers{
				"decision": {"x"}, "reversible": {"never"}, "oracle": {"test"},
			},
			gated: nil,
			want:  nil,
		},
		{
			name:     "invalid tier value fails",
			trailers: gitx.Trailers{"decision": {"x"}, "reversible": {"sometimes"}},
			gated:    nil,
			want:     []string{"is not one of"},
		},
		{
			name:     "invalid oracle value fails",
			trailers: gitx.Trailers{"decision": {"x"}, "oracle": {"vibes"}},
			gated:    nil,
			want:     []string{"is not one of"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Evaluate(tc.trailers, tc.gated)
			if len(got) != len(tc.want) {
				t.Fatalf("Evaluate() = %v, want %d violation(s) matching %v", got, len(tc.want), tc.want)
			}
			for i, want := range tc.want {
				if !strings.Contains(got[i], want) {
					t.Errorf("violation[%d] = %q, want substring %q", i, got[i], want)
				}
			}
		})
	}
}

// TestMatch is a table-driven test over the path-matching rules used to
// decide which files are gated.
func TestMatch(t *testing.T) {
	cases := []struct {
		name     string
		file     string
		patterns []string
		want     bool
	}{
		{"prefix match", "infra/k3s/a.tf", []string{"infra/"}, true},
		{"exact match", "infra", []string{"infra"}, true},
		{"glob pattern", "pkg/core/foo.go", []string{"pkg/core/*.go"}, true},
		{"trailing star prefix", "infra/anything/here.tf", []string{"infra/*"}, true},
		{"non match", "docs/readme.md", []string{"infra/", "pkg/core/"}, false},
		{"prefix must not match a longer directory name", "infrastructure/x", []string{"infra"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Match(tc.file, tc.patterns); got != tc.want {
				t.Errorf("Match(%q, %v) = %v, want %v", tc.file, tc.patterns, got, tc.want)
			}
		})
	}
}

// TestGate_BareRepoUsesHeadNotWholeTree locks in that in a bare repository
// `git diff --cached` lists the entire tree, so Gate must not treat that as
// staged: it must fall back to "HEAD" and evaluate HEAD's files.
func TestGate_BareRepoUsesHeadNotWholeTree(t *testing.T) {
	src := testutil.NewRepo(t)
	src.Write("infra/a.tf", "x\n")
	src.Write("other.txt", "y\n")
	src.Commit("init", "Decision:seed the infra")

	bareDir := t.TempDir()
	if out, err := exec.Command("git", "clone", "-q", "--bare", src.Dir, bareDir).CombinedOutput(); err != nil {
		t.Fatalf("git clone --bare: %v\n%s", err, out)
	}
	bare := gitx.New(gitx.ExecRunner{Dir: bareDir})

	result, err := Gate(testutil.Ctx(), bare, "")
	if err != nil {
		t.Fatalf("Gate: %v", err)
	}
	if result.Source != "HEAD" {
		t.Errorf("Source = %q, want %q (a bare repo has no staging area)", result.Source, "HEAD")
	}
	want := []string{"infra/a.tf", "other.txt"}
	if !reflect.DeepEqual(result.Files, want) {
		t.Errorf("Files = %v, want %v", result.Files, want)
	}
}

// TestGate_EmptyCommitViaHookIgnoresPreviousCommitFiles is the exact case
// ctx supersede's own commit hits when the commit-msg hook runs: an empty
// commit (--allow-empty, nothing staged) carrying only Supersedes:/Reason:,
// no Decision:. Building a real GitOps history with ctx supersede + -hooks
// surfaced this: the previous fix incorrectly fell back to HEAD's files —
// whatever the prior, unrelated commit happened to touch — and gated the
// empty commit against them, failing every supersede regardless of what
// came before it in history.
func TestGate_EmptyCommitViaHookIgnoresPreviousCommitFiles(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("infra/unrelated.tf", "x\n")
	r.Commit("infra: something with no bearing on the supersede", "Decision:seed")

	msgPath := filepath.Join(t.TempDir(), "COMMIT_MSG")
	body := "Supersede abc123 (old decision)\n\nSupersedes:abc123\nReason:the world changed\n"
	if err := os.WriteFile(msgPath, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	// Nothing staged: this mirrors `git commit --allow-empty` exactly.
	result, err := Gate(testutil.Ctx(), r.Repo, msgPath)
	if err != nil {
		t.Fatalf("Gate: %v", err)
	}
	if !result.OK() {
		t.Errorf("an empty commit touches no gated files and must pass, got violations: %v", result.Violations)
	}
	if len(result.Files) != 0 || len(result.Gated) != 0 {
		t.Errorf("Files = %v, Gated = %v, want both empty for an empty commit", result.Files, result.Gated)
	}
}

// TestGate_MessageFileHandlesCRLFAndTrailingWhitespace checks that -m reads
// the message from a file, and that a CRLF-terminated file with trailing
// whitespace in a trailer value still parses correctly.
func TestGate_MessageFileHandlesCRLFAndTrailingWhitespace(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("infra/a.tf", "x\n")
	r.Commit("init", "Decision:seed")

	msgPath := filepath.Join(t.TempDir(), "COMMIT_MSG")
	body := "Adjust infra\r\n\r\nDecision: adjust the thing\r\nReversible: true  \r\n"
	if err := os.WriteFile(msgPath, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := Gate(testutil.Ctx(), r.Repo, msgPath)
	if err != nil {
		t.Fatalf("Gate: %v", err)
	}
	if !strings.Contains(result.Source, msgPath) {
		t.Errorf("Source = %q, want it to name the message file %q", result.Source, msgPath)
	}
	if !result.OK() {
		t.Errorf("Violations = %v, want none (CRLF/whitespace trailers should still parse)", result.Violations)
	}
}

// TestGatePathsPrecedence: local git config wins when set; failing that, the
// tracked .ctx-gate-paths file; failing that, the built-in defaults. The
// tracked file exists because git config is exactly what a fresh clone does
// NOT get, and a clone is where the gate's protection has to hold.
func TestGatePathsPrecedence(t *testing.T) {
	t.Run("falls back to defaults when nothing is configured", func(t *testing.T) {
		r := testutil.NewRepo(t)
		r.Write("f.txt", "x\n")
		r.Commit("seed")
		got := GatePaths(testutil.Ctx(), r.Repo)
		if !reflect.DeepEqual(got, DefaultGatePaths) {
			t.Errorf("GatePaths() = %v, want the defaults %v", got, DefaultGatePaths)
		}
	})

	t.Run("tracked .ctx-gate-paths is used when config is unset", func(t *testing.T) {
		r := testutil.NewRepo(t)
		r.Write(GatePathsFile, "platform/\n# a comment\n\nclusters/\n")
		r.Commit("seed")
		got := GatePaths(testutil.Ctx(), r.Repo)
		if want := []string{"platform/", "clusters/"}; !reflect.DeepEqual(got, want) {
			t.Errorf("GatePaths() = %v, want %v (comments and blank lines skipped)", got, want)
		}
	})

	t.Run("local git config overrides the tracked file", func(t *testing.T) {
		r := testutil.NewRepo(t)
		r.Write(GatePathsFile, "platform/\n")
		r.Commit("seed")
		r.Git("config", "--add", "ctx.gate.path", "only-this/")
		got := GatePaths(testutil.Ctx(), r.Repo)
		if want := []string{"only-this/"}; !reflect.DeepEqual(got, want) {
			t.Errorf("GatePaths() = %v, want the config override %v, not the tracked file", got, want)
		}
	})

	t.Run("the tracked file survives a fresh clone; git config does not", func(t *testing.T) {
		src := testutil.NewRepo(t)
		src.Write(GatePathsFile, "platform/\n")
		src.Write("platform/app.yaml", "x\n")
		src.Commit("seed")
		src.Git("config", "--add", "ctx.gate.path", "only-local/") // never committed, never cloned

		cloneDir := t.TempDir()
		if out, err := exec.Command("git", "clone", "-q", src.Dir, cloneDir).CombinedOutput(); err != nil {
			t.Fatalf("git clone: %v\n%s", err, out)
		}
		clone := gitx.New(gitx.ExecRunner{Dir: cloneDir})

		got := GatePaths(testutil.Ctx(), clone)
		if want := []string{"platform/"}; !reflect.DeepEqual(got, want) {
			t.Errorf("a fresh clone got GatePaths() = %v, want the tracked file's %v, not the source-only local config", got, want)
		}

		// The point end to end: an edit to the tracked path is still gated
		// right after cloning, with no per-clone setup step required.
		if err := os.WriteFile(filepath.Join(cloneDir, "platform/app.yaml"), []byte("y\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		addCmd := exec.Command("git", "add", "-A")
		addCmd.Dir = cloneDir
		if out, err := addCmd.CombinedOutput(); err != nil {
			t.Fatalf("git add: %v\n%s", err, out)
		}
		msgPath := filepath.Join(t.TempDir(), "msg")
		if err := os.WriteFile(msgPath, []byte("chore: undecided edit\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		result, err := Gate(testutil.Ctx(), clone, msgPath)
		if err != nil {
			t.Fatalf("Gate: %v", err)
		}
		if result.OK() {
			t.Error("a fresh clone must still gate the tracked path with no Decision:, got OK")
		}
	})
}

// TestGate_MessageFileMissingReturnsError checks that a nonexistent -m file
// surfaces as an error rather than being silently ignored.
func TestGate_MessageFileMissingReturnsError(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("infra/a.tf", "x\n")
	r.Commit("init", "Decision:seed")

	_, err := Gate(testutil.Ctx(), r.Repo, filepath.Join(t.TempDir(), "does-not-exist"))
	if err == nil {
		t.Fatal("want an error for a nonexistent message file")
	}
}

// TestGate_ConfigOverridesDefaultGatePaths checks that
// `git config --add ctx.gate.path <x>` replaces the default gate paths
// rather than adding to them.
func TestGate_ConfigOverridesDefaultGatePaths(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("infra/a.tf", "x\n")
	r.Write("app/main.go", "package main\n")
	r.Commit("init", "Decision:seed")
	r.Git("config", "--add", "ctx.gate.path", "app/")

	result, err := Gate(testutil.Ctx(), r.Repo, "")
	if err != nil {
		t.Fatalf("Gate: %v", err)
	}
	want := []string{"app/main.go"}
	if !reflect.DeepEqual(result.Gated, want) {
		t.Errorf("Gated = %v, want %v (configured paths should replace the defaults)", result.Gated, want)
	}
}
