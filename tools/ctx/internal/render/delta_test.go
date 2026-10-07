package render

import (
	"strings"
	"testing"

	"ctx/internal/model"
)

func rec(sha byte, decision string, stated bool) model.Record {
	return model.Record{Decision: model.Decision{SHA: sha40(sha), Stated: stated, Decision: decision}}
}

func deltaOf(t *testing.T, current, baseline model.Report) string {
	t.Helper()
	var b strings.Builder
	if err := YAMLDelta(&b, DeltaOf(current, baseline)); err != nil {
		t.Fatalf("YAMLDelta() error = %v", err)
	}
	return b.String()
}

// An unchanged report must produce nothing at all — that silence is the whole
// point of the baseline.
func TestDeltaSilentWhenUnchanged(t *testing.T) {
	r := model.Report{Scope: "a.tf", Active: []model.Record{rec('a', "keep it", true)}}
	if got := deltaOf(t, r, r); got != "" {
		t.Fatalf("Delta() = %q, want empty", got)
	}
}

func TestDeltaFiresPerSection(t *testing.T) {
	base := model.Report{Scope: "a.tf"}
	cases := []struct {
		name    string
		current model.Report
		want    string
	}{
		{
			"a new stated decision",
			model.Report{Scope: "a.tf", Active: []model.Record{rec('a', "new call", true)}},
			"active:",
		},
		{
			"a decision retired",
			model.Report{Scope: "a.tf", Superseded: []model.Record{{
				Decision:     model.Decision{SHA: sha40('b'), Decision: "old call"},
				SupersededBy: []model.Supersession{{By: sha40('c'), Reason: "world changed"}},
			}}},
			"superseded:",
		},
		{
			"a constraint orphaned",
			model.Report{Scope: "a.tf", Orphaned: []model.Record{rec('d', "lost its code", true)}},
			"orphaned:",
		},
		{
			"an incident opened",
			model.Report{Scope: "a.tf", OpenIncidents: []model.OpenIncident{{SHA: sha40('e'), Summary: "it broke"}}},
			"open_incidents:",
		},
		{
			"the file deleted",
			model.Report{Scope: "a.tf", Removed: &model.Removal{By: sha40('f'), Decision: "retired"}},
			"removed:",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := deltaOf(t, tc.current, base)
			if !strings.Contains(got, tc.want) {
				t.Fatalf("Delta() = %q, want it to contain %q", got, tc.want)
			}
			if !strings.HasPrefix(got, "changed since your last edit to a.tf:") {
				t.Errorf("Delta() should name the scope it is reporting on, got %q", got)
			}
		})
	}
}

// An unstated decision is a commit subject, not a decision — it must not
// trigger a delta, or every ordinary commit becomes news.
func TestDeltaIgnoresUnstatedActive(t *testing.T) {
	current := model.Report{Scope: "a.tf", Active: []model.Record{rec('a', "chore: bump image", false)}}
	if got := deltaOf(t, current, model.Report{Scope: "a.tf"}); got != "" {
		t.Fatalf("Delta() = %q, want empty for an unstated commit subject", got)
	}
}

// A run that passed is not news; one that failed is.
func TestDeltaRunsOnlyFireOnFailure(t *testing.T) {
	withRuns := func(runs ...model.Run) model.Report {
		r := rec('a', "keep it", true)
		r.Runs = runs
		return model.Report{Scope: "a.tf", Active: []model.Record{r}}
	}
	base := withRuns()

	pass := withRuns(model.Run{At: "2026-01-01T00:00:00Z", Status: "pass"})
	if got := deltaOf(t, pass, base); got != "" {
		t.Errorf("a passing run is not news, got %q", got)
	}

	fail := withRuns(model.Run{At: "2026-01-02T00:00:00Z", Status: "fail", Incident: "INC-1"})
	got := deltaOf(t, fail, base)
	if !strings.Contains(got, "failed_runs:") || !strings.Contains(got, "INC-1") {
		t.Errorf("a failing run must fire and name its incident, got %q", got)
	}
}

// Only the new entry is reported, never the ones already shown.
func TestDeltaReportsOnlyWhatIsNew(t *testing.T) {
	base := model.Report{Scope: "a.tf", OpenIncidents: []model.OpenIncident{{SHA: sha40('a'), Summary: "old news"}}}
	current := model.Report{Scope: "a.tf", OpenIncidents: []model.OpenIncident{
		{SHA: sha40('a'), Summary: "old news"},
		{SHA: sha40('b'), Summary: "fresh news"},
	}}
	got := deltaOf(t, current, base)
	if strings.Contains(got, "old news") {
		t.Errorf("Delta() repeated an entry the reader already had: %q", got)
	}
	if !strings.Contains(got, "fresh news") {
		t.Errorf("Delta() = %q, want the new incident", got)
	}
}

// A removal already known at baseline is not re-announced.
func TestDeltaRemovalOnlyOnFirstAppearance(t *testing.T) {
	removed := &model.Removal{By: sha40('f'), Decision: "retired"}
	base := model.Report{Scope: "a.tf", Removed: removed}
	current := model.Report{Scope: "a.tf", Removed: removed}
	if got := deltaOf(t, current, base); got != "" {
		t.Fatalf("Delta() = %q, want empty when the removal was already known", got)
	}
}

// A second removal by a different commit is news even when a removal was
// already known: the file was restored and deleted again, and the second
// deletion may be the one carrying Reversible: never.
func TestDeltaRemovalByDifferentCommitFires(t *testing.T) {
	base := model.Report{Scope: "a.tf", Removed: &model.Removal{By: sha40('a'), Decision: "dropped"}}
	current := model.Report{Scope: "a.tf", Removed: &model.Removal{By: sha40('b'), Decision: "banned for good", Reversible: model.TierNever}}
	got := deltaOf(t, current, base)
	if !strings.Contains(got, "banned for good") {
		t.Fatalf("Delta() = %q, want the second removal", got)
	}
}

// A second supersession landing on a record already superseded is news: same
// SHA, new reason to stop trusting it.
func TestDeltaSecondSupersessionFires(t *testing.T) {
	first := model.Record{
		Decision:     model.Decision{SHA: sha40('a'), Decision: "old"},
		SupersededBy: []model.Supersession{{By: sha40('b'), Reason: "first"}},
	}
	second := first
	second.SupersededBy = []model.Supersession{{By: sha40('b'), Reason: "first"}, {By: sha40('c'), Reason: "second"}}
	base := model.Report{Scope: "a.tf", Superseded: []model.Record{first}}
	current := model.Report{Scope: "a.tf", Superseded: []model.Record{second}}
	got := deltaOf(t, current, base)
	if !strings.Contains(got, "second") {
		t.Fatalf("Delta() = %q, want the new supersession", got)
	}
	if got := deltaOf(t, base, base); got != "" {
		t.Errorf("an unchanged supersession must stay silent, got %q", got)
	}
}

// A new record in a delta carries everything the full report would — the
// delta is the only place the reader will ever see that record's rejected
// alternatives, tier and oracle.
func TestDeltaRecordsKeepFullFidelity(t *testing.T) {
	r := model.Record{Decision: model.Decision{
		SHA: sha40('a'), Stated: true, Decision: "cap at 3",
		Rejected: []string{"backoff with jitter"}, Reversible: model.TierNever, Oracle: model.OracleContract,
	}}
	got := deltaOf(t, model.Report{Scope: "a.tf", Active: []model.Record{r}}, model.Report{Scope: "a.tf"})
	for _, want := range []string{"backoff with jitter", "reversible: never", "oracle: contract"} {
		if !strings.Contains(got, want) {
			t.Errorf("Delta() dropped %q from a new record:\n%s", want, got)
		}
	}
}

func TestJSONDeltaEmptyWritesNothing(t *testing.T) {
	var b strings.Builder
	if err := JSONDelta(&b, model.Delta{Scope: "a.tf"}); err != nil {
		t.Fatal(err)
	}
	if b.Len() != 0 {
		t.Fatalf("JSONDelta() on an empty delta = %q, want nothing", b.String())
	}
}

// When the file itself was just deleted, every record the reader already has
// moves into orphaned at once. The removed: headline already says so; listing
// them again would re-send what the reader has.
func TestDeltaFreshRemovalDoesNotReannounceKnownRecords(t *testing.T) {
	known := rec('a', "pin the CNI", true)
	base := model.Report{Scope: "x.tf", Active: []model.Record{known}}
	current := model.Report{Scope: "x.tf",
		Removed:  &model.Removal{By: sha40('d'), Decision: "gone"},
		Orphaned: []model.Record{known},
	}
	got := deltaOf(t, current, base)
	if !strings.Contains(got, "removed:") {
		t.Fatalf("Delta() = %q, want the removal", got)
	}
	if strings.Contains(got, "orphaned:") {
		t.Errorf("Delta() re-announced a record the reader already had under orphaned:\n%s", got)
	}
}

// Without a removal, a record losing its lines and moving to orphaned IS news:
// a constraint went away and nobody retired it.
func TestDeltaOrphanTransitionWithoutRemovalFires(t *testing.T) {
	known := rec('a', "pin the CNI", true)
	base := model.Report{Scope: "x.tf", Active: []model.Record{known}}
	current := model.Report{Scope: "x.tf", Orphaned: []model.Record{known}}
	if got := deltaOf(t, current, base); !strings.Contains(got, "orphaned:") {
		t.Fatalf("Delta() = %q, want the active->orphaned transition", got)
	}
}

// A warning the reader has not seen — the clone went shallow — is news.
func TestDeltaNewWarningFires(t *testing.T) {
	base := model.Report{Scope: "x.tf"}
	current := model.Report{Scope: "x.tf", Warnings: []string{"shallow clone; SHAs may be wrong"}}
	got := deltaOf(t, current, base)
	if !strings.Contains(got, "warning: shallow clone") {
		t.Fatalf("Delta() = %q, want the new warning", got)
	}
	if got := deltaOf(t, current, current); got != "" {
		t.Errorf("an already-seen warning must stay silent, got %q", got)
	}
}
