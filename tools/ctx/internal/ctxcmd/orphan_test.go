package ctxcmd

import (
	"strings"
	"testing"

	"ctx/internal/model"
	"ctx/internal/testutil"
)

// seedOrphanRepo builds a file whose first decision loses its lines to a later
// rewrite, so exactly one decision is orphaned and one is active.
func seedOrphanRepo(t *testing.T, tier string) (*testutil.Repo, string, string) {
	t.Helper()
	repo := testutil.NewRepo(t)
	// One line, rewritten in full: the first commit ends up owning nothing.
	// (A commit that merely deletes lines still owns whatever it left behind,
	// which is the commit-granularity limitation documented in the design.)
	repo.Write("infra/a.tf", "pinned = true\n")
	orphan := repo.Commit("infra: pin it",
		"Decision:pinned because the scheduler is not volume-aware",
		"Rejected:a nodeSelector on the workload",
		"Reversible:"+tier, "Oracle:contract")

	repo.Write("infra/a.tf", "unpinned = true\n")
	active := repo.Commit("infra: unpin", "Decision:unpinned after the scheduler learned volumes",
		"Reversible:true", "Oracle:drift")
	return repo, orphan, active
}

func TestCompileOrphanedIsTouchedMinusOwners(t *testing.T) {
	repo, orphan, active := seedOrphanRepo(t, "restore-only")

	report := Compile(testutil.Ctx(), repo.Repo, "infra/a.tf", CompileOpts{})

	if len(report.Active) != 1 || report.Active[0].SHA != active {
		t.Fatalf("active = %+v, want just %s", report.Active, active[:12])
	}
	if len(report.Orphaned) != 1 || report.Orphaned[0].SHA != orphan {
		t.Fatalf("orphaned = %+v, want just %s", report.Orphaned, orphan[:12])
	}
	if got := report.Orphaned[0].Rejected; len(got) != 1 {
		t.Errorf("an orphaned decision keeps its rejected list, got %v", got)
	}
}

// The threshold is what keeps a churned file's long tail out of the report.
func TestCompileOrphanThreshold(t *testing.T) {
	cases := []struct {
		tier      string
		wantShown int
	}{
		{"never", 1},
		{"restore-only", 1},
		{"true", 0}, // declared cheap to undo: counted, not printed
	}
	for _, tc := range cases {
		t.Run(tc.tier, func(t *testing.T) {
			repo, _, _ := seedOrphanRepo(t, tc.tier)
			report := Compile(testutil.Ctx(), repo.Repo, "infra/a.tf", CompileOpts{})

			if len(report.Orphaned) != tc.wantShown {
				t.Fatalf("orphaned shown = %d, want %d", len(report.Orphaned), tc.wantShown)
			}
			if wantHidden := 1 - tc.wantShown; report.OrphanedHidden != wantHidden {
				t.Fatalf("orphaned_hidden = %d, want %d", report.OrphanedHidden, wantHidden)
			}
			// -all overrides the threshold without changing anything else.
			all := Compile(testutil.Ctx(), repo.Repo, "infra/a.tf", CompileOpts{AllOrphaned: true})
			if len(all.Orphaned) != 1 || all.OrphanedHidden != 0 {
				t.Fatalf("-all orphaned = %d hidden = %d, want 1 and 0", len(all.Orphaned), all.OrphanedHidden)
			}
		})
	}
}

// An open incident makes an otherwise-cheap orphan worth surfacing.
func TestCompileOrphanShownWhenIncidentOpen(t *testing.T) {
	repo, orphan, _ := seedOrphanRepo(t, "true")
	repo.Git("notes", "--ref=incidents", "add", "-m",
		"at: 2026-01-01T00:00:00Z | status: open | summary: it broke", orphan)

	report := Compile(testutil.Ctx(), repo.Repo, "infra/a.tf", CompileOpts{})
	if len(report.Orphaned) != 1 || report.OrphanedHidden != 0 {
		t.Fatalf("orphaned = %d hidden = %d, want 1 and 0", len(report.Orphaned), report.OrphanedHidden)
	}
	if len(report.OpenIncidents) != 1 {
		t.Fatalf("open incidents = %+v, want the orphan's incident", report.OpenIncidents)
	}
}

// An explicit retirement outranks an implicit one: a superseded commit that
// also lost its lines is reported once, as superseded.
func TestCompileSupersededOrphanAppearsOnceAsSuperseded(t *testing.T) {
	repo, orphan, _ := seedOrphanRepo(t, "never")
	repo.Commit("Supersede "+orphan[:12], "Supersedes:"+orphan, "Reason:the world changed")
	if _, err := Reindex(testutil.Ctx(), repo.Repo); err != nil {
		t.Fatal(err)
	}

	report := Compile(testutil.Ctx(), repo.Repo, "infra/a.tf", CompileOpts{})
	if len(report.Orphaned) != 0 {
		t.Fatalf("orphaned = %+v, want none", report.Orphaned)
	}
	if len(report.Superseded) != 1 || report.Superseded[0].SHA != orphan {
		t.Fatalf("superseded = %+v, want just %s", report.Superseded, orphan[:12])
	}
}

// Orphanhood is a file-level property, so a ranged query reports the same
// orphans as the whole file while narrowing only what is active.
func TestCompileRangeKeepsFileLevelOrphans(t *testing.T) {
	repo, orphan, _ := seedOrphanRepo(t, "never")
	repo.Write("infra/a.tf", "unpinned = true\nextra = 2\n")
	newer := repo.Commit("infra: add extra", "Decision:extra knob", "Reversible:true", "Oracle:test")

	report := Compile(testutil.Ctx(), repo.Repo, "infra/a.tf:2-2", CompileOpts{})
	if len(report.Active) != 1 || report.Active[0].SHA != newer {
		t.Fatalf("active = %+v, want only the commit owning line 2", report.Active)
	}
	if len(report.Orphaned) != 1 || report.Orphaned[0].SHA != orphan {
		t.Fatalf("orphaned = %+v, want the file-level orphan %s", report.Orphaned, orphan[:12])
	}
}

func TestCompileRemovedPath(t *testing.T) {
	repo := testutil.NewRepo(t)
	repo.Write("infra/derp.tf", "region = 900\n")
	earlier := repo.Commit("infra: add derp", "Decision:DERP terminates on the VPS",
		"Reversible:true", "Oracle:test")
	repo.Git("rm", "-q", "infra/derp.tf")
	tomb := repo.Commit("infra: retire derp", "Decision:the VPS edge is retired",
		"Reversible:never", "Oracle:drift")

	report := Compile(testutil.Ctx(), repo.Repo, "infra/derp.tf", CompileOpts{})

	if report.Error != "" {
		t.Fatalf("a removed path is not an error, got %q", report.Error)
	}
	if report.Removed == nil {
		t.Fatal("removed = nil, want the tombstone")
	}
	if report.Removed.By != tomb || report.Removed.Reversible != model.TierNever {
		t.Fatalf("removed = %+v, want %s / never", report.Removed, tomb[:12])
	}
	if report.Removed.At == "" {
		t.Error("removed.at is empty, want the deletion date")
	}
	// The tombstone is the headline; it must not repeat inside orphaned.
	if len(report.Orphaned) != 1 || report.Orphaned[0].SHA != earlier {
		t.Fatalf("orphaned = %+v, want just the earlier decision %s", report.Orphaned, earlier[:12])
	}
	// Nothing survives, so the threshold does not apply: every decision shows.
	if report.OrphanedHidden != 0 {
		t.Errorf("orphaned_hidden = %d, want 0 on a removed path", report.OrphanedHidden)
	}
}

func TestCompileRemovedPathRecordsRename(t *testing.T) {
	repo := testutil.NewRepo(t)
	repo.Write("infra/old.tf", "a = 1\nb = 2\nc = 3\n")
	repo.Commit("infra: add", "Decision:the original home")
	repo.Git("mv", "infra/old.tf", "infra/new.tf")
	repo.Commit("infra: rename", "Decision:renamed for clarity")

	report := Compile(testutil.Ctx(), repo.Repo, "infra/old.tf", CompileOpts{})
	if report.Removed == nil || report.Removed.RenamedTo != "infra/new.tf" {
		t.Fatalf("removed = %+v, want renamed_to infra/new.tf", report.Removed)
	}
}

// A typo must stay an error: nothing was removed, the path never existed.
func TestCompileNeverExistedStaysAnError(t *testing.T) {
	repo := testutil.NewRepo(t)
	repo.Write("infra/a.tf", "a = 1\n")
	repo.Commit("infra: add", "Decision:something")

	report := Compile(testutil.Ctx(), repo.Repo, "docs/never.md", CompileOpts{})
	if report.Removed != nil {
		t.Fatalf("removed = %+v, want nil", report.Removed)
	}
	if !strings.Contains(report.Error, "no such path") {
		t.Fatalf("error = %q, want a no-such-path error", report.Error)
	}
}

// --grep matches prose as well as trailers, so a commit merely mentioning
// "Decision:" in its body must not be reported as an orphaned decision.
func TestCompileIgnoresProseMatches(t *testing.T) {
	repo := testutil.NewRepo(t)
	repo.Write("infra/a.tf", "a = 1\n")
	repo.Commit("infra: add", "Decision:the real one", "Reversible:never", "Oracle:test")
	repo.Write("infra/a.tf", "a = 2\n")
	repo.Git("add", "-A")
	repo.Git("commit", "-q", "-m", "infra: change\n\nA Decision: was discussed in the meeting but not recorded.\n")

	report := Compile(testutil.Ctx(), repo.Repo, "infra/a.tf", CompileOpts{})
	for _, o := range report.Orphaned {
		if !o.Stated {
			t.Fatalf("orphaned contains a prose match: %+v", o)
		}
	}
	if report.OrphanedHidden != 0 {
		t.Errorf("orphaned_hidden = %d, want prose matches ignored entirely", report.OrphanedHidden)
	}
}

// A file rewritten many times, each rewrite declaring a real cost to undo,
// passes the cost threshold on every generation. The cap is what keeps that
// from becoming a report nobody can read.
func TestCompileOrphanCap(t *testing.T) {
	repo := testutil.NewRepo(t)
	const generations = maxOrphansShown + 5
	for i := 0; i < generations; i++ {
		repo.Write("g.tf", "generation = "+strings.Repeat("x", i+1)+"\n")
		repo.Commit("gen", "Decision:generation "+strings.Repeat("x", i+1),
			"Reversible:never", "Oracle:contract")
	}

	report := Compile(testutil.Ctx(), repo.Repo, "g.tf", CompileOpts{})
	if len(report.Orphaned) != maxOrphansShown {
		t.Fatalf("orphaned shown = %d, want the cap %d", len(report.Orphaned), maxOrphansShown)
	}
	// Everything above the cap is counted, not dropped: generations-1 are
	// orphaned (the newest owns the surviving line), of which the cap is shown.
	if want := generations - 1 - maxOrphansShown; report.OrphanedHidden != want {
		t.Fatalf("orphaned_hidden = %d, want %d", report.OrphanedHidden, want)
	}
	if all := Compile(testutil.Ctx(), repo.Repo, "g.tf", CompileOpts{AllOrphaned: true}); len(all.Orphaned) != generations-1 {
		t.Fatalf("-all orphaned = %d, want all %d", len(all.Orphaned), generations-1)
	}
}
