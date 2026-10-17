package ctxcmd

import (
	"os/exec"
	"reflect"
	"strings"
	"testing"

	"ctx/internal/gitx"
	"ctx/internal/model"
	"ctx/internal/testutil"
)

// TestParseScope locks in the "path" vs "path:range" disambiguation, including
// the case that sent this into a bug report: a file literally named "foo:12"
// must never be misread as a line-range spec.
func TestParseScope(t *testing.T) {
	cases := []struct {
		name   string
		arg    string
		exists map[string]bool
		want   Scope
	}{
		{
			name: "plain path with no colon",
			arg:  "path",
			want: Scope{Path: "path"},
		},
		{
			name: "single line number",
			arg:  "path:5",
			want: Scope{Path: "path", Lo: 5, Hi: 5},
		},
		{
			name: "line range",
			arg:  "path:3-7",
			want: Scope{Path: "path", Lo: 3, Hi: 7},
		},
		{
			name: "reversed range clamps Hi down to Lo",
			arg:  "path:7-3",
			want: Scope{Path: "path", Lo: 7, Hi: 7},
		},
		{
			name: "non-numeric suffix is the whole path",
			arg:  "path:abc",
			want: Scope{Path: "path:abc"},
		},
		{
			name: "windows-ish drive path is the whole path",
			arg:  "C:/x",
			want: Scope{Path: "C:/x"},
		},
		{
			name:   "a file literally named foo:12 wins over range parsing",
			arg:    "foo:12",
			exists: map[string]bool{"foo:12": true},
			want:   Scope{Path: "foo:12"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			orig := FileExists
			FileExists = func(path string) bool { return tc.exists[path] }
			t.Cleanup(func() { FileExists = orig })

			if got := ParseScope(tc.arg); got != tc.want {
				t.Errorf("ParseScope(%q) = %+v, want %+v", tc.arg, got, tc.want)
			}
		})
	}
}

// TestCompile_TrailersJoinedThroughBlameWithFallback covers the compile happy
// path: a commit with the full trailer set, blamed through a real file, plus a
// commit with no Decision: trailer falling back to its subject line.
func TestCompile_TrailersJoinedThroughBlameWithFallback(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("infra/main.tf", "line one\n")
	shaA := r.Commit("add main.tf") // no Decision: trailer

	r.Write("infra/main.tf", "line one\nline two\n")
	shaB := r.Commit("tighten policy",
		"Decision:require review",
		"Rejected:auto-approve",
		"Rejected:skip review",
		"Reversible:true",
		"Oracle:test",
	)

	report := Compile(testutil.Ctx(), r.Repo, "infra/main.tf", CompileOpts{})
	if report.Error != "" {
		t.Fatalf("unexpected Report.Error: %s", report.Error)
	}
	if len(report.Active) != 2 {
		t.Fatalf("want 2 active records, got %d: %+v", len(report.Active), report.Active)
	}

	first, second := report.Active[0], report.Active[1]
	if first.SHA != shaA {
		t.Errorf("blame order: Active[0].SHA = %s, want %s (shaA)", first.SHA, shaA)
	}
	if first.Decision.Decision != "add main.tf" {
		t.Errorf("commit with no Decision: trailer should fall back to its subject, got %q", first.Decision.Decision)
	}

	if second.SHA != shaB {
		t.Errorf("blame order: Active[1].SHA = %s, want %s (shaB)", second.SHA, shaB)
	}
	if second.Decision.Decision != "require review" {
		t.Errorf("Decision = %q, want %q", second.Decision.Decision, "require review")
	}
	if want := []string{"auto-approve", "skip review"}; !reflect.DeepEqual([]string(second.Rejected), want) {
		t.Errorf("Rejected = %v, want %v", second.Rejected, want)
	}
	if second.Reversible != model.TierTrue {
		t.Errorf("Reversible = %q, want %q", second.Reversible, model.TierTrue)
	}
	if second.Oracle != model.OracleTest {
		t.Errorf("Oracle = %q, want %q", second.Oracle, model.OracleTest)
	}
}

// TestCompile_DedupsRepeatedSHA locks in that a commit touching every line in
// scope appears exactly once, not once per line.
func TestCompile_DedupsRepeatedSHA(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\nb\nc\n")
	sha := r.Commit("add f", "Decision:seed file")

	report := Compile(testutil.Ctx(), r.Repo, "f.txt", CompileOpts{})
	if len(report.Active) != 1 {
		t.Fatalf("want 1 record (one SHA touching all 3 lines), got %d: %+v", len(report.Active), report.Active)
	}
	if report.Active[0].SHA != sha {
		t.Errorf("SHA = %s, want %s", report.Active[0].SHA, sha)
	}
}

// TestCompile_LineRangeScopeOnlyIncludesTouchingCommits checks that a scope
// narrowed to a line range picks up only the commit(s) that touched those
// lines, not every commit that ever touched the file.
func TestCompile_LineRangeScopeOnlyIncludesTouchingCommits(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	r.Commit("add a", "Decision:seed")
	r.Write("f.txt", "a\nb\n")
	shaB := r.Commit("add b", "Decision:extend")
	r.Write("f.txt", "a\nb\nc\n")
	r.Commit("add c", "Decision:extend more")

	report := Compile(testutil.Ctx(), r.Repo, "f.txt:2-2", CompileOpts{})
	if len(report.Active) != 1 {
		t.Fatalf("want 1 record for line 2 only, got %d: %+v", len(report.Active), report.Active)
	}
	if report.Active[0].SHA != shaB {
		t.Errorf("SHA = %s, want %s (the commit that added line 2)", report.Active[0].SHA, shaB)
	}
}

// TestCompile_BlameIgnoreRevsFileHonoured commits a real mechanical reformat
// (reindenting a line, no content change worth attributing), lists it in
// .git-blame-ignore-revs, and asserts blame walks through it to the
// decision-bearing commit underneath.
func TestCompile_BlameIgnoreRevsFileHonoured(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "alpha\nbeta\ngamma\n")
	shaDecision := r.Commit("add f", "Decision:seed the file")

	r.Write("f.txt", "alpha\n   beta\ngamma\n")
	shaReformat := r.Commit("style: reindent")

	r.Write(BlameIgnoreFile, shaReformat+"\n")
	r.Commit("record blame-ignore revision")

	report := Compile(testutil.Ctx(), r.Repo, "f.txt", CompileOpts{})
	if report.Error != "" {
		t.Fatalf("unexpected Report.Error: %s", report.Error)
	}

	for _, rec := range report.Active {
		if rec.SHA == shaReformat {
			t.Fatalf("reformat commit %s should be ignored by blame, but resurfaced: %+v", shaReformat, report.Active)
		}
	}
	var found bool
	for _, rec := range report.Active {
		if rec.SHA == shaDecision {
			found = true
			if rec.Decision.Decision != "seed the file" {
				t.Errorf("Decision = %q, want %q", rec.Decision.Decision, "seed the file")
			}
		}
	}
	if !found {
		t.Fatalf("decision-bearing commit %s did not resurface in %+v", shaDecision, report.Active)
	}
}

// TestCompile_PathNotInHeadSetsError checks the graceful-failure path: a scope
// that blame cannot resolve sets Report.Error and returns empty sections
// rather than failing the whole command.
func TestCompile_PathNotInHeadSetsError(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	r.Commit("seed", "Decision:seed")

	report := Compile(testutil.Ctx(), r.Repo, "does-not-exist.txt", CompileOpts{})
	if report.Error == "" {
		t.Fatal("want Report.Error set for a path that is not in HEAD")
	}
	if len(report.Active) != 0 || len(report.Superseded) != 0 || len(report.OpenIncidents) != 0 {
		t.Errorf("want empty sections when Report.Error is set, got %+v", report)
	}
}

// TestCompile_ShallowCloneAddsWarning checks that a shallow clone gets flagged:
// blame may stop at the graft boundary and report the wrong SHA.
func TestCompile_ShallowCloneAddsWarning(t *testing.T) {
	src := testutil.NewRepo(t)
	src.Write("f.txt", "a\n")
	src.Commit("c1", "Decision:one")
	src.Write("f.txt", "a\nb\n")
	src.Commit("c2", "Decision:two")

	cloneDir := t.TempDir()
	if out, err := exec.Command("git", "clone", "-q", "--depth", "1", "file://"+src.Dir, cloneDir).CombinedOutput(); err != nil {
		t.Fatalf("git clone --depth 1: %v\n%s", err, out)
	}
	clone := gitx.New(gitx.ExecRunner{Dir: cloneDir})

	report := Compile(testutil.Ctx(), clone, "f.txt", CompileOpts{})
	var found bool
	for _, w := range report.Warnings {
		if strings.Contains(w, "shallow") {
			found = true
		}
	}
	if !found {
		t.Errorf("want a shallow-clone warning, got %v", report.Warnings)
	}
}

// TestCompile_SupersededByMultipleCommits locks in that two different
// superseding commits naming the same target both show up in
// Record.SupersededBy: an earlier version overwrote instead of appending.
func TestCompile_SupersededByMultipleCommits(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	target := r.Commit("original decision", "Decision:use approach A")

	r.Write("f.txt", "a\nb\n")
	r.Commit("unrelated change")

	if _, err := Supersede(testutil.Ctx(), r.Repo, target, "switched to approach B"); err != nil {
		t.Fatalf("Supersede 1: %v", err)
	}
	if _, err := Supersede(testutil.Ctx(), r.Repo, target, "switched again to approach C"); err != nil {
		t.Fatalf("Supersede 2: %v", err)
	}
	if _, err := Reindex(testutil.Ctx(), r.Repo); err != nil {
		t.Fatalf("Reindex: %v", err)
	}

	record := LoadRecord(testutil.Ctx(), r.Repo, target)
	if len(record.SupersededBy) != 2 {
		t.Fatalf("want 2 supersessions on the same target, got %d: %+v", len(record.SupersededBy), record.SupersededBy)
	}
}

// TestCompile_IncidentSummaryPreservesLiteralPipe locks in that an incident
// summary containing a literal "|" survives whole through the pipe-delimited
// note-line parser instead of being truncated at the first pipe.
func TestCompile_IncidentSummaryPreservesLiteralPipe(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	sha := r.Commit("add f", "Decision:seed")

	summary := "disk io | network both degraded"
	line := "at: 2026-01-01T00:00:00Z | status: open | summary: " + summary
	if err := r.AppendNote(testutil.Ctx(), gitx.NotesIncidents, sha, line); err != nil {
		t.Fatalf("AppendNote: %v", err)
	}

	report := Compile(testutil.Ctx(), r.Repo, "f.txt", CompileOpts{})
	if len(report.OpenIncidents) != 1 {
		t.Fatalf("want 1 open incident, got %d: %+v", len(report.OpenIncidents), report.OpenIncidents)
	}
	if got := report.OpenIncidents[0].Summary; got != summary {
		t.Errorf("Summary = %q, want %q (the pipe must survive)", got, summary)
	}
}

// TestCompile_OpenIncidentsExcludesClosedAndResolved checks the status filter:
// closed/resolved incidents (in either case) are excluded, and an incident
// with no status field at all is treated as open.
func TestCompile_OpenIncidentsExcludesClosedAndResolved(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	sha := r.Commit("add f", "Decision:seed")

	notes := []string{
		"at: t1 | status: closed | summary: fixed already",
		"at: t2 | status: Resolved | summary: also fixed",
		"at: t3 | status: CLOSED | summary: still fixed",
		"at: t4 | status: open | summary: still broken",
		"summary: no status field at all",
	}
	for _, n := range notes {
		if err := r.AppendNote(testutil.Ctx(), gitx.NotesIncidents, sha, n); err != nil {
			t.Fatalf("AppendNote(%q): %v", n, err)
		}
	}

	report := Compile(testutil.Ctx(), r.Repo, "f.txt", CompileOpts{})
	var summaries []string
	for _, inc := range report.OpenIncidents {
		summaries = append(summaries, inc.Summary)
	}
	want := []string{"still broken", "no status field at all"}
	if !reflect.DeepEqual(summaries, want) {
		t.Errorf("open incident summaries = %v, want %v", summaries, want)
	}
}
