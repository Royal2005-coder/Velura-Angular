package ctxcmd

import (
	"reflect"
	"strings"
	"testing"

	"ctx/internal/gitx"
	"ctx/internal/testutil"
)

// TestReindex_RebuildsDecisionsLeavesRunsAndIncidentsUntouched locks in that
// Reindex deletes and rebuilds refs/notes/decisions from scratch — discarding
// any hand-written garbage that was in there — while leaving refs/notes/runs
// and refs/notes/incidents completely untouched.
func TestReindex_RebuildsDecisionsLeavesRunsAndIncidentsUntouched(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	target := r.Commit("decision commit", "Decision:pick approach A")

	if err := r.SetNote(testutil.Ctx(), gitx.NotesDecisions, target, "garbage: not derived from any commit"); err != nil {
		t.Fatalf("SetNote decisions: %v", err)
	}
	if err := r.SetNote(testutil.Ctx(), gitx.NotesRuns, target, "at: t1 | status: pass"); err != nil {
		t.Fatalf("SetNote runs: %v", err)
	}
	if err := r.SetNote(testutil.Ctx(), gitx.NotesIncidents, target, "at: t1 | status: open | summary: broke"); err != nil {
		t.Fatalf("SetNote incidents: %v", err)
	}

	runsBefore := r.NoteLines(testutil.Ctx(), gitx.NotesRuns, target)
	incidentsBefore := r.NoteLines(testutil.Ctx(), gitx.NotesIncidents, target)

	// No Supersedes: commit exists anywhere in history, so a correct rebuild
	// produces an empty decisions ref.
	if _, err := Reindex(testutil.Ctx(), r.Repo); err != nil {
		t.Fatalf("Reindex: %v", err)
	}

	if decisionsAfter := r.NoteLines(testutil.Ctx(), gitx.NotesDecisions, target); len(decisionsAfter) != 0 {
		t.Errorf("hand-written decisions note should have been discarded by the rebuild, got %v", decisionsAfter)
	}
	if runsAfter := r.NoteLines(testutil.Ctx(), gitx.NotesRuns, target); !reflect.DeepEqual(runsAfter, runsBefore) {
		t.Errorf("runs note changed: before %v, after %v", runsBefore, runsAfter)
	}
	if incidentsAfter := r.NoteLines(testutil.Ctx(), gitx.NotesIncidents, target); !reflect.DeepEqual(incidentsAfter, incidentsBefore) {
		t.Errorf("incidents note changed: before %v, after %v", incidentsBefore, incidentsAfter)
	}
}

// TestReindex_UnknownSupersedesTargetWarnsButOthersStillWrite locks in that a
// Supersedes: trailer naming a commit that does not exist yields a warning,
// not an error, and that the other (valid) entries in the same run still get
// written.
func TestReindex_UnknownSupersedesTargetWarnsButOthersStillWrite(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	target := r.Commit("decision commit", "Decision:pick approach A")

	r.Write("f.txt", "a\nb\n")
	r.Commit("unrelated change")

	bogus := "0123456789abcdef0123456789abcdef01234567"
	r.Commit("supersede two things",
		"Supersedes:"+target,
		"Supersedes:"+bogus,
		"Reason:cleanup",
	)

	result, err := Reindex(testutil.Ctx(), r.Repo)
	if err != nil {
		t.Fatalf("Reindex returned an error instead of a warning: %v", err)
	}
	if len(result.Warnings) != 1 {
		t.Fatalf("want 1 warning for the unresolvable target, got %v", result.Warnings)
	}
	if !strings.Contains(result.Warnings[0], bogus) {
		t.Errorf("warning %q should name the unresolved ref %q", result.Warnings[0], bogus)
	}
	if result.Entries != 1 {
		t.Errorf("Entries = %d, want 1 (the valid target should still be written)", result.Entries)
	}

	lines := r.NoteLines(testutil.Ctx(), gitx.NotesDecisions, target)
	if len(lines) != 1 {
		t.Fatalf("want a decisions note for the valid target, got %v", lines)
	}
}

// TestSupersede_WritesEmptyCommitWithTrailers checks that Supersede writes an
// empty commit carrying Supersedes: and Reason: trailers, verified through
// plain `git log` rather than through ctx's own readers.
func TestSupersede_WritesEmptyCommitWithTrailers(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	target := r.Commit("original decision", "Decision:approach A")

	if _, err := Supersede(testutil.Ctx(), r.Repo, target, "  switched to approach B  "); err != nil {
		t.Fatalf("Supersede: %v", err)
	}

	subject := r.Git("log", "-1", "--format=%s")
	if !strings.Contains(subject, target[:12]) {
		t.Errorf("subject %q should name the superseded commit %s", subject, target[:12])
	}
	body := r.Git("log", "-1", "--format=%B")
	if !strings.Contains(body, "Supersedes: "+target) {
		t.Errorf("body %q missing Supersedes trailer for %s", body, target)
	}
	if !strings.Contains(body, "Reason: switched to approach B") {
		t.Errorf("body %q missing trimmed Reason trailer", body)
	}

	treeParent := r.Git("show", "-s", "--format=%T", "HEAD~1")
	treeHead := r.Git("show", "-s", "--format=%T", "HEAD")
	if treeParent != treeHead {
		t.Errorf("Supersede should write an empty commit: parent tree %s, head tree %s", treeParent, treeHead)
	}
}

// TestSupersede_RejectsEmptyOrWhitespaceReason checks that an empty or
// whitespace-only reason is rejected: the superseding commit is the document.
func TestSupersede_RejectsEmptyOrWhitespaceReason(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	target := r.Commit("original decision", "Decision:approach A")

	for _, reason := range []string{"", "   ", "\t\n"} {
		if _, err := Supersede(testutil.Ctx(), r.Repo, target, reason); err == nil {
			t.Errorf("Supersede with reason %q: want an error", reason)
		}
	}
}

// TestSupersede_RejectsUnresolvableTarget checks that an unresolvable target
// revision is rejected before any commit is written.
func TestSupersede_RejectsUnresolvableTarget(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	r.Commit("seed", "Decision:seed")

	head := r.Git("rev-parse", "HEAD")
	if _, err := Supersede(testutil.Ctx(), r.Repo, "not-a-real-rev", "cleanup"); err == nil {
		t.Fatal("want an error for an unresolvable target")
	}
	if got := r.Git("rev-parse", "HEAD"); got != head {
		t.Errorf("HEAD moved despite the error: %s -> %s", head, got)
	}
}

// TestSupersede_DoesNotTouchDecisionsRef checks that Supersede does not create
// or modify refs/notes/decisions: the note is derived by reindex from the
// commit afterwards, not written directly by Supersede.
func TestSupersede_DoesNotTouchDecisionsRef(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("f.txt", "a\n")
	target := r.Commit("original decision", "Decision:approach A")

	if before := r.Quiet(testutil.Ctx(), "rev-parse", "--verify", "--quiet", "refs/notes/decisions"); before != "" {
		t.Fatalf("precondition failed: refs/notes/decisions already exists: %s", before)
	}

	if _, err := Supersede(testutil.Ctx(), r.Repo, target, "cleanup"); err != nil {
		t.Fatalf("Supersede: %v", err)
	}

	if after := r.Quiet(testutil.Ctx(), "rev-parse", "--verify", "--quiet", "refs/notes/decisions"); after != "" {
		t.Errorf("Supersede must not create refs/notes/decisions, but it now resolves to %s", after)
	}
}
