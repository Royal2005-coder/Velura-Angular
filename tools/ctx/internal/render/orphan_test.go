package render

import (
	"encoding/json"
	"strings"
	"testing"

	"ctx/internal/model"
)

func TestYAMLRemovedSection(t *testing.T) {
	report := model.Report{
		Scope: "infra/derp.tf",
		Removed: &model.Removal{
			By: sha40('a'), At: "2026-09-04T00:10:31+07:00",
			Decision: "the VPS edge is retired", Reversible: model.TierNever,
			Oracle: model.OracleDrift, RenamedTo: "infra/edge/derp.tf",
		},
	}
	var b strings.Builder
	if err := YAML(&b, report); err != nil {
		t.Fatal(err)
	}
	want := "scope: infra/derp.tf\n" +
		"removed:\n" +
		"  by: aaaaaaaaaaaa\n" +
		"  at: \"2026-09-04T00:10:31+07:00\"\n" +
		"  decision: the VPS edge is retired\n" +
		"  reversible: never\n" +
		"  oracle: drift\n" +
		"  renamed_to: infra/edge/derp.tf\n" +
		"active: []\n" +
		"superseded: []\n" +
		"orphaned: []\n" +
		"open_incidents: []\n"
	if b.String() != want {
		t.Fatalf("YAML() =\n%s\nwant\n%s", b.String(), want)
	}
}

// removed is absent, not empty, when the path still exists.
func TestYAMLRemovedOmittedWhenPresent(t *testing.T) {
	var b strings.Builder
	if err := YAML(&b, model.Report{Scope: "a"}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(b.String(), "removed") {
		t.Fatalf("YAML() = %q, want no removed key", b.String())
	}
}

// Orphaned entries take the compact form: they are reference material, not the
// decision the reader is about to act on.
func TestYAMLOrphanedSectionAndHiddenCount(t *testing.T) {
	report := model.Report{
		Scope: "infra/a.tf",
		Orphaned: []model.Record{{Decision: model.Decision{
			SHA: sha40('b'), Decision: "pinned to a node", Rejected: []string{"a nodeSelector"},
			Reversible: model.TierRestoreOnly, Oracle: model.OracleContract,
		}}},
		OrphanedHidden: 7,
	}
	var b strings.Builder
	if err := YAML(&b, report); err != nil {
		t.Fatal(err)
	}
	got := b.String()
	for _, want := range []string{
		"orphaned:\n  - sha: bbbbbbbbbbbb\n",
		"    decision: pinned to a node\n",
		"    rejected: [\"a nodeSelector\"]\n",
		"    reversible: restore-only\n",
		"orphaned_hidden: 7\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("YAML() missing %q, got:\n%s", want, got)
		}
	}
	// The count is a tail marker; it must not precede the sections.
	if strings.Index(got, "orphaned_hidden") < strings.Index(got, "open_incidents") {
		t.Errorf("orphaned_hidden must follow open_incidents, got:\n%s", got)
	}
}

func TestYAMLOrphanedHiddenOmittedWhenZero(t *testing.T) {
	var b strings.Builder
	if err := YAML(&b, model.Report{}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(b.String(), "orphaned_hidden") {
		t.Fatalf("YAML() = %q, want no orphaned_hidden key", b.String())
	}
}

func TestJSONOrphanedAndRemoved(t *testing.T) {
	var b strings.Builder
	if err := JSON(&b, model.Report{
		Scope:   "a",
		Removed: &model.Removal{By: sha40('c'), At: "2026-09-04T00:00:00Z"},
	}); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(b.String()), &got); err != nil {
		t.Fatalf("JSON() is not valid JSON: %v", err)
	}
	if _, ok := got["orphaned"].([]any); !ok {
		t.Errorf("orphaned = %#v, want an empty array not null", got["orphaned"])
	}
	removed, ok := got["removed"].(map[string]any)
	if !ok {
		t.Fatalf("removed = %#v, want an object", got["removed"])
	}
	if removed["by"] != sha40('c') {
		t.Errorf("removed.by = %v, want the full 40-char sha", removed["by"])
	}
	if _, present := removed["renamed_to"]; present {
		t.Error("renamed_to must be omitted when the removal was not a rename")
	}
}
