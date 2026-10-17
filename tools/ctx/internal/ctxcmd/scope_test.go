package ctxcmd

import (
	"strings"
	"testing"

	"ctx/internal/model"
	"ctx/internal/testutil"
)

// A directory is a scope. It used to fall through to the tombstone lookup, which matched any
// file ever deleted beneath it and reported a live directory as removed.
func TestCompile_DirectoryScope(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("app/gone.ts", "export const gone = 1;\n")
	r.Commit("add a file that will be deleted", "Decision:gone had its reasons")
	r.Git("rm", "-q", "app/gone.ts")
	r.Commit("delete it")

	r.Write("app/a.ts", "export const alpha = 'the first file of the directory';\n")
	shaA := r.Commit("add a", "Decision:a is first")
	r.Write("app/nested/b.ts", "export const beta = 'the second file, one level down';\n")
	shaB := r.Commit("add b", "Decision:b lives below")

	for _, scope := range []string{"app", "app/"} {
		t.Run(scope, func(t *testing.T) {
			report := Compile(testutil.Ctx(), r.Repo, scope, CompileOpts{})

			if report.Removed != nil {
				t.Fatalf("a directory that exists is not removed: %+v", report.Removed)
			}
			if report.Error != "" {
				t.Fatalf("unexpected error: %s", report.Error)
			}
			var got []string
			for _, rec := range report.Active {
				got = append(got, rec.SHA)
			}
			if len(got) != 2 || !contains(got, shaA) || !contains(got, shaB) {
				t.Fatalf("active = %v, want the decisions of both files %s and %s", got, shaA, shaB)
			}
		})
	}
}

func TestCompile_DirectoryOrphansAreJudgedAcrossTheWholeDirectory(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("lib/x.go", "package lib // the constraint that still holds in this file\n")
	shaX := r.Commit("add x", "Decision:x constraint", "Reversible:never", "Oracle:test")
	r.Write("lib/y.go", "package lib // a file whose first decision was rewritten away\n")
	shaY := r.Commit("add y", "Decision:y constraint", "Reversible:never", "Oracle:test")
	r.Write("lib/y.go", "package lib // wholly new content, nothing of the old line survives\n")
	r.Commit("rewrite y")

	report := Compile(testutil.Ctx(), r.Repo, "lib", CompileOpts{})

	if len(report.Orphaned) != 1 || report.Orphaned[0].SHA != shaY {
		t.Fatalf("orphaned = %+v, want only %s", report.Orphaned, shaY)
	}
	for _, rec := range report.Active {
		if rec.SHA == shaY {
			t.Fatal("a rewritten-away decision must not be active")
		}
	}
	if !containsRecord(report.Active, shaX) {
		t.Fatalf("x still owns a line in lib/x.go, so it is active: %+v", report.Active)
	}
}

func TestCompile_DirectoryWithARangeIsRefused(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("app/a.ts", "export const alpha = 1;\n")
	r.Commit("add a", "Decision:a")

	report := Compile(testutil.Ctx(), r.Repo, "app:1-5", CompileOpts{})

	if !strings.Contains(report.Error, "line range") {
		t.Fatalf("a range on a directory should say so, got %q", report.Error)
	}
}

func TestCompile_DirectoryWithNoFilesSaysSoInsteadOfClaimingRemoval(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("app/a.ts", "export const alpha = 1;\n")
	r.Commit("add a", "Decision:a")
	r.Write("other/b.ts", "export const beta = 1;\n")
	r.Commit("add b")

	report := Compile(testutil.Ctx(), r.Repo, "nowhere", CompileOpts{})

	if report.Removed != nil || report.Error == "" {
		t.Fatalf("a path that never existed is an error, not a removal: %+v", report)
	}
}

// A decision follows its lines, and lines move. Blaming with -C credits code that was extracted
// into another file in the same commit to the commit that wrote it, so the constraint that
// governed it still reaches the file it now lives in.
func TestCompile_DecisionFollowsCodeMovedIntoAnotherFile(t *testing.T) {
	r := testutil.NewRepo(t)
	const body = "export function decideApproval(id: string, reason: string) { return door.call(id, reason); }\n" +
		"export function readApprovals(caseId: string) { return reads.listCaseApprovals(caseId); }\n"
	r.Write("panel.ts", body+"export const panel = 1;\n")
	shaOrigin := r.Commit("write the panel", "Decision:the door is the authority on a decision")

	r.Write("panel.ts", "export const panel = 1;\n")
	r.Write("useApprovals.ts", body)
	shaMove := r.Commit("move the logic into a hook", "Decision:fetching lives in a hook")

	report := Compile(testutil.Ctx(), r.Repo, "useApprovals.ts", CompileOpts{})

	if !containsRecord(report.Active, shaOrigin) {
		t.Fatalf("the decision that governed the moved lines should still reach them: %+v", report.Active)
	}
	if containsRecord(report.Active, shaMove) && len(report.Active) == 1 {
		t.Fatalf("blame credited the whole file to the move: %+v", report.Active)
	}
}

func containsRecord(records []model.Record, sha string) bool {
	for _, r := range records {
		if r.SHA == sha {
			return true
		}
	}
	return false
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
