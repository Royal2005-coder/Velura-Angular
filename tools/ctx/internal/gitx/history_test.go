package gitx_test

import (
	"reflect"
	"testing"

	"ctx/internal/gitx"
	"ctx/internal/testutil"
)

func TestPathDecisions(t *testing.T) {
	fr := &testutil.FakeRunner{Responses: map[string]string{
		"log --follow -i --grep=Decision: --format=%H -- infra/a.tf": blameSHA1 + "\n" + blameSHA2 + "\n",
	}}
	got := gitx.New(fr).PathDecisions(testutil.Ctx(), "infra/a.tf")
	if want := []string{blameSHA1, blameSHA2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("PathDecisions() = %#v, want %#v", got, want)
	}
	// --follow keeps a renamed file's earlier life in scope; --grep keeps the
	// trailer parser off commits that cannot carry a decision.
	for _, flag := range []string{"--follow", "--grep=Decision:"} {
		if !fr.Called(flag) {
			t.Errorf("expected %s in call args, got %#v", flag, fr.Calls)
		}
	}
}

func TestFindTombstone(t *testing.T) {
	const deleted = "infra/headscale/derp.tf"

	t.Run("deletion", func(t *testing.T) {
		fr := &testutil.FakeRunner{Responses: map[string]string{
			"log --full-history -1 -M --diff-filter=DR --name-status --format=%H\x1f%aI -- " + deleted: blameSHA1 + "\x1f2026-09-04T00:10:31+07:00\n\nD\t" + deleted,
			"show -M --name-status --format= " + blameSHA1:                                             "D\t" + deleted,
		}}
		got := gitx.New(fr).FindTombstone(testutil.Ctx(), deleted)
		if got == nil {
			t.Fatal("FindTombstone() = nil, want a tombstone")
		}
		if got.SHA != blameSHA1 || got.At != "2026-09-04T00:10:31+07:00" || got.RenamedTo != "" {
			t.Fatalf("FindTombstone() = %+v", got)
		}
	})

	// A single-path pathspec makes git report a rename as D, so the
	// destination has to come from the commit's whole diff.
	t.Run("rename recovers the destination", func(t *testing.T) {
		fr := &testutil.FakeRunner{Responses: map[string]string{
			"log --full-history -1 -M --diff-filter=DR --name-status --format=%H\x1f%aI -- " + deleted: blameSHA2 + "\x1f2026-09-04T01:00:00+07:00\n\nD\t" + deleted,
			"show -M1% --name-status --format= " + blameSHA2:                                           "R096\t" + deleted + "\tinfra/edge/derp.tf",
		}}
		got := gitx.New(fr).FindTombstone(testutil.Ctx(), deleted)
		if got == nil || got.RenamedTo != "infra/edge/derp.tf" {
			t.Fatalf("FindTombstone() = %+v, want RenamedTo infra/edge/derp.tf", got)
		}
	})

	// The bundled-edit case: a rename plus real content changes in the same
	// commit routinely drops below git's 50% default similarity threshold on a
	// small file, which is a completely ordinary way to rename something.
	t.Run("rename recovers the destination even with heavy edits", func(t *testing.T) {
		fr := &testutil.FakeRunner{Responses: map[string]string{
			"log --full-history -1 -M --diff-filter=DR --name-status --format=%H\x1f%aI -- " + deleted: blameSHA3 + "\x1f2026-08-25T13:00:00+07:00\n\nD\t" + deleted,
			"show -M1% --name-status --format= " + blameSHA3:                                           "R007\t" + deleted + "\tinfra/edge/new.tf",
		}}
		got := gitx.New(fr).FindTombstone(testutil.Ctx(), deleted)
		if got == nil || got.RenamedTo != "infra/edge/new.tf" {
			t.Fatalf("FindTombstone() = %+v, want RenamedTo infra/edge/new.tf", got)
		}
	})

	// A deletion whose branch later gets merged into another with NO shared
	// history — exactly the shape a repo gets by reconciling with a template's
	// auto-generated initial commit, which is what actually broke this on
	// ctx-demo. git's default path-limited history simplification can decide
	// the merge is TREESAME to a parent and prune the deleting commit from a
	// plain `git log -- path`, so a real tombstone reads as "path never
	// existed" — indistinguishable from a typo. This exercises the real git
	// binary; a FakeRunner cannot reproduce git's own simplification behavior.
	t.Run("survives a merge with an unrelated history", func(t *testing.T) {
		repo := testutil.NewRepo(t)
		repo.Write("infra/edge.tf", "vps = true\n")
		repo.Commit("infra: stand up the edge", "Decision:seed")
		repo.Git("rm", "-q", "infra/edge.tf")
		tomb := repo.Commit("infra: retire the edge", "Decision:no longer needed", "Reversible:never", "Oracle:drift")

		// A second, disconnected root — same shape as a GitLab project created
		// with "initialize with a README".
		repo.Git("checkout", "-q", "--orphan", "unrelated")
		repo.Write("README.md", "auto-generated\n")
		repo.Git("add", "-A")
		repo.Git("commit", "-q", "-m", "Initial commit")
		repo.Git("checkout", "-q", "main")
		repo.Git("merge", "-q", "--allow-unrelated-histories", "-m", "merge unrelated", "unrelated")

		got := repo.FindTombstone(testutil.Ctx(), "infra/edge.tf")
		if got == nil {
			t.Fatal("FindTombstone() = nil after an unrelated-history merge, want the real tombstone")
		}
		if got.SHA != tomb {
			t.Errorf("FindTombstone().SHA = %s, want %s", got.SHA, tomb)
		}
	})

	t.Run("a path that never existed has no tombstone", func(t *testing.T) {
		fr := &testutil.FakeRunner{}
		if got := gitx.New(fr).FindTombstone(testutil.Ctx(), "docs/never.md"); got != nil {
			t.Fatalf("FindTombstone() = %+v, want nil", got)
		}
	})
}
