package render

import (
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"

	"ctx/internal/model"
)

// DeltaOf computes what appeared between a baseline report and the current
// one. What counts as news is deliberately narrow: a decision retired, an
// incident opened, a constraint orphaned, a new stated decision, the file
// deleted, or a run that failed. A passing run, a re-ordering, or an unstated
// commit becoming an owner is not news.
func DeltaOf(current, baseline model.Report) model.Delta {
	d := model.Delta{Scope: current.Scope}

	// A warning that was not there before (the clone went shallow, say) is
	// news; one the reader already saw is not.
	hadWarning := map[string]bool{}
	for _, w := range baseline.Warnings {
		hadWarning[w] = true
	}
	for _, w := range current.Warnings {
		if !hadWarning[w] {
			d.Warnings = append(d.Warnings, w)
		}
	}

	// Compare tombstones by commit, not by presence: a file deleted, restored,
	// and deleted again is two different removals, and the second may carry
	// the decision that matters.
	if current.Removed != nil && (baseline.Removed == nil || baseline.Removed.By != current.Removed.By) {
		d.Removed = current.Removed
	}

	// A record is new when its SHA was not in the baseline section. A
	// superseded record is also new when it gained a supersession the
	// baseline did not have — same commit, new reason to stop trusting it.
	d.Superseded = newRecords(current.Superseded, baseline.Superseded, false, supersessionsGrew)
	d.Active = newRecords(current.Active, baseline.Active, true, nil)
	// A record whose lines were rewritten out from under it moving into
	// orphaned is news. But when the whole FILE was just deleted, every record
	// the reader already has moves there at once, and the removed: headline
	// already says it — re-listing them would re-send what they already have.
	if d.Removed == nil {
		d.Orphaned = newRecords(current.Orphaned, baseline.Orphaned, false, nil)
	}

	had := map[string]bool{}
	for _, i := range baseline.OpenIncidents {
		had[i.SHA+"\x00"+i.Summary] = true
	}
	for _, i := range current.OpenIncidents {
		if !had[i.SHA+"\x00"+i.Summary] {
			d.OpenIncidents = append(d.OpenIncidents, i)
		}
	}

	wasFail := failSet(baseline)
	for key := range failSet(current) {
		if !wasFail[key] {
			sha, run, _ := strings.Cut(key, "\x00")
			d.FailedRuns = append(d.FailedRuns, model.FailedRun{SHA: sha, Run: run})
		}
	}
	slices.SortFunc(d.FailedRuns, func(a, b model.FailedRun) int {
		return strings.Compare(a.SHA+a.Run, b.SHA+b.Run)
	})
	return d
}

// newRecords returns the records in cur whose SHA is absent from base, or for
// which grew reports a meaningful change on a SHA present in both.
func newRecords(cur, base []model.Record, statedOnly bool, grew func(cur, base model.Record) bool) []model.Record {
	byShaBase := map[string]model.Record{}
	for _, r := range base {
		byShaBase[r.SHA] = r
	}
	var out []model.Record
	for _, r := range cur {
		if statedOnly && !r.Stated {
			continue
		}
		prev, seen := byShaBase[r.SHA]
		if !seen || (grew != nil && grew(r, prev)) {
			out = append(out, r)
		}
	}
	return out
}

func supersessionsGrew(cur, base model.Record) bool {
	had := map[string]bool{}
	for _, s := range base.SupersededBy {
		had[s.By] = true
	}
	for _, s := range cur.SupersededBy {
		if !had[s.By] {
			return true
		}
	}
	return false
}

// failSet keys every failing run in a report by commit and run text.
func failSet(report model.Report) map[string]bool {
	set := map[string]bool{}
	for _, group := range [][]model.Record{report.Active, report.Superseded, report.Orphaned} {
		for _, r := range group {
			for _, run := range r.Runs {
				if strings.EqualFold(run.Status, "fail") {
					set[r.SHA+"\x00"+run.String()] = true
				}
			}
		}
	}
	return set
}

// YAMLDelta writes a delta with the same fidelity as the full report — every
// new record carries its rejected alternatives, tier, oracle and runs, because
// the delta is the ONLY place the reader will ever see them for that record.
// Empty sections are omitted; an empty delta writes nothing at all.
func YAMLDelta(w io.Writer, d model.Delta) error {
	if d.Empty() {
		return nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "changed since your last edit to %s:\n", scalar(d.Scope))
	for _, w := range d.Warnings {
		fmt.Fprintf(&b, "warning: %s\n", w)
	}
	writeRemoval(&b, d.Removed)
	for _, sec := range []struct {
		name string
		list []model.Record
	}{{"active", d.Active}, {"superseded", d.Superseded}, {"orphaned", d.Orphaned}} {
		if len(sec.list) > 0 {
			writeSection(&b, sec.name, sec.list)
		}
	}
	if len(d.OpenIncidents) > 0 {
		b.WriteString("open_incidents:\n")
		for _, i := range d.OpenIncidents {
			fmt.Fprintf(&b, "  - %s: %s\n", Short(i.SHA), scalar(i.Summary))
		}
	}
	if len(d.FailedRuns) > 0 {
		b.WriteString("failed_runs:\n")
		for _, f := range d.FailedRuns {
			fmt.Fprintf(&b, "  - %s: %s\n", Short(f.SHA), scalar(f.Run))
		}
	}
	_, err := io.WriteString(w, b.String())
	return err
}

// JSONDelta writes the delta as JSON; an empty delta writes nothing.
func JSONDelta(w io.Writer, d model.Delta) error {
	if d.Empty() {
		return nil
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	return enc.Encode(d)
}
