package gitx_test

import (
	"strings"
	"testing"

	"ctx/internal/gitx"
	"ctx/internal/testutil"
)

// These mirror the unexported separators in log.go. They are control
// characters that cannot occur in a commit message, so hardcoding them here
// does not make the test brittle to anything but the documented wire format.
const (
	logRecordSep = "\x1e"
	logFieldSep  = "\x1f"
)

// logKey reproduces the exact argv git.SupersedingCommits sends, joined the
// way testutil.FakeRunner keys its responses.
func logKey() string {
	args := []string{"log", "--all", "--not", "--glob=refs/notes/*",
		"-i", "--grep=Supersedes:", "--format=%H" + logFieldSep + "%aI" + logFieldSep + "%B" + logRecordSep}
	return strings.Join(args, " ")
}

func record(sha, when, body string) string {
	return sha + logFieldSep + when + logFieldSep + body + logRecordSep + "\n"
}

func TestSupersedingCommits(t *testing.T) {
	t.Run("correct splitting of multiple records", func(t *testing.T) {
		sha1 := strings.Repeat("a", 40)
		sha2 := strings.Repeat("b", 40)
		out := record(sha1, "2026-01-01T00:00:00+00:00", "fix: do the thing\n\nSupersedes: old") +
			record(sha2, "2026-01-02T00:00:00+00:00", "fix: do it better\n\nSupersedes: old2")

		fr := &testutil.FakeRunner{Responses: map[string]string{logKey(): out}}
		repo := gitx.New(fr)

		got, err := repo.SupersedingCommits(testutil.Ctx())
		if err != nil {
			t.Fatalf("SupersedingCommits() error = %v", err)
		}
		want := []gitx.LogEntry{
			{SHA: sha1, When: "2026-01-01T00:00:00+00:00", Body: "fix: do the thing\n\nSupersedes: old"},
			{SHA: sha2, When: "2026-01-02T00:00:00+00:00", Body: "fix: do it better\n\nSupersedes: old2"},
		}
		if len(got) != len(want) {
			t.Fatalf("SupersedingCommits() = %#v, want %#v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("entry %d = %#v, want %#v", i, got[i], want[i])
			}
		}
	})

	t.Run("malformed record with wrong field count is skipped", func(t *testing.T) {
		sha1 := strings.Repeat("a", 40)
		sha2 := strings.Repeat("c", 40)
		bad := sha1 + logFieldSep + "2026-01-01T00:00:00+00:00" + logRecordSep + "\n" // only 2 fields
		out := bad + record(sha2, "2026-01-03T00:00:00+00:00", "good one")

		fr := &testutil.FakeRunner{Responses: map[string]string{logKey(): out}}
		repo := gitx.New(fr)

		got, err := repo.SupersedingCommits(testutil.Ctx())
		if err != nil {
			t.Fatalf("SupersedingCommits() error = %v", err)
		}
		want := []gitx.LogEntry{{SHA: sha2, When: "2026-01-03T00:00:00+00:00", Body: "good one"}}
		if len(got) != len(want) || got[0] != want[0] {
			t.Fatalf("SupersedingCommits() = %#v, want %#v", got, want)
		}
	})

	t.Run("malformed record with a short sha is skipped", func(t *testing.T) {
		short := "abc123"
		sha2 := strings.Repeat("d", 40)
		out := record(short, "2026-01-01T00:00:00+00:00", "body") +
			record(sha2, "2026-01-04T00:00:00+00:00", "good one")

		fr := &testutil.FakeRunner{Responses: map[string]string{logKey(): out}}
		repo := gitx.New(fr)

		got, err := repo.SupersedingCommits(testutil.Ctx())
		if err != nil {
			t.Fatalf("SupersedingCommits() error = %v", err)
		}
		want := []gitx.LogEntry{{SHA: sha2, When: "2026-01-04T00:00:00+00:00", Body: "good one"}}
		if len(got) != len(want) || got[0] != want[0] {
			t.Fatalf("SupersedingCommits() = %#v, want %#v", got, want)
		}
	})

	t.Run("empty output yields no entries", func(t *testing.T) {
		fr := &testutil.FakeRunner{Responses: map[string]string{logKey(): ""}}
		repo := gitx.New(fr)

		got, err := repo.SupersedingCommits(testutil.Ctx())
		if err != nil {
			t.Fatalf("SupersedingCommits() error = %v", err)
		}
		if len(got) != 0 {
			t.Fatalf("SupersedingCommits() = %#v, want empty", got)
		}
	})

	t.Run("args exclude notes refs and include the grep pre-filter", func(t *testing.T) {
		fr := &testutil.FakeRunner{Responses: map[string]string{logKey(): ""}}
		repo := gitx.New(fr)

		if _, err := repo.SupersedingCommits(testutil.Ctx()); err != nil {
			t.Fatalf("SupersedingCommits() error = %v", err)
		}
		if !fr.Called("--not") {
			t.Fatalf("expected --not in call args, got %#v", fr.Calls)
		}
		if !fr.Called("--glob=refs/notes/*") {
			t.Fatalf("expected --glob=refs/notes/* in call args, got %#v", fr.Calls)
		}
		if !fr.Called("-i --grep=Supersedes:") {
			t.Fatalf("expected -i --grep=Supersedes: pre-filter in call args, got %#v", fr.Calls)
		}
	})
}
