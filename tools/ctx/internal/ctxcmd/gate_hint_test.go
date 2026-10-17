package ctxcmd_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ctx/internal/ctxcmd"
	"ctx/internal/gitx"
	"ctx/internal/testutil"
)

// TestMisplacedTrailerHint covers the mistake that blocked ctx's own first
// commits: trailers written above a separate attribution paragraph, and a
// trailer value wrapped onto an unindented second line. In both cases git
// parses no Decision: at all, and the bare violation reads like a lie.
func TestMisplacedTrailerHint(t *testing.T) {
	cases := []struct {
		name     string
		message  string
		wantHint bool
	}{
		{
			name:     "trailers demoted by a later paragraph",
			message:  "subject\n\nDecision: keep it\nOracle: test\n\nClaude-Session: https://example\n",
			wantHint: true,
		},
		{
			name:     "value wrapped onto an unindented line",
			message:  "subject\n\nDecision: keep it because\nof a second line\n",
			wantHint: true,
		},
		{
			name:     "well-formed trailer block yields no hint",
			message:  "subject\n\nDecision: keep it\nOracle: test\nClaude-Session: https://example\n",
			wantHint: false,
		},
		{
			name:     "no trailer-style line at all yields no hint",
			message:  "subject\n\njust a body paragraph\n",
			wantHint: false,
		},
	}

	repo := testutil.NewRepo(t)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			trailers := repo.ParseTrailers(testutil.Ctx(), tc.message)
			hint := ctxcmd.MisplacedTrailerHint(tc.message, trailers)
			if got := hint != ""; got != tc.wantHint {
				t.Fatalf("hint = %q, want present=%v (parsed trailers: %v)", hint, tc.wantHint, trailers)
			}
		})
	}
}

// TestGateReportsHintAlongsideViolation checks the hint reaches the operator
// through Gate, not just the helper.
func TestGateReportsHintAlongsideViolation(t *testing.T) {
	repo := testutil.NewRepo(t)
	repo.Write("infra/main.tf", "resource {}\n")
	repo.Commit("infra: seed", "Decision:seeded", "Reversible:true", "Oracle:drift")
	repo.Write("infra/main.tf", "resource { x = 1 }\n")
	repo.Git("add", "-A")

	msg := filepath.Join(repo.Dir, "msg.txt")
	body := "infra: change it\n\nDecision: a real decision\n\nClaude-Session: https://example\n"
	if err := os.WriteFile(msg, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := ctxcmd.Gate(testutil.Ctx(), repo.Repo, msg)
	if err != nil {
		t.Fatal(err)
	}
	if result.OK() {
		t.Fatal("expected the gate to fail: git parses no Decision: trailer here")
	}
	joined := strings.Join(result.Violations, "\n")
	if !strings.Contains(joined, "missing `Decision:` trailer") {
		t.Errorf("want the missing-trailer violation, got:\n%s", joined)
	}
	if !strings.Contains(joined, "LAST paragraph") {
		t.Errorf("want the hint explaining why, got:\n%s", joined)
	}
}

// compile-time guard that the helper keeps its exported shape
var _ = func(t gitx.Trailers) string { return ctxcmd.MisplacedTrailerHint("", t) }
