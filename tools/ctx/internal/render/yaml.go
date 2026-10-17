// Package render turns a compiled Report into the bytes an agent ingests.
package render

import (
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"ctx/internal/model"
)

// reservedScalar matches text a YAML parser would read as something other than
// a string: null, booleans, numbers, dates. Left bare, `Decision: null` comes
// back from any YAML library as None, and `Reversible: true` as a boolean.
var reservedScalar = regexp.MustCompile(`(?i)^(null|~|true|false|yes|no|on|off|nan|[-+.0-9]+|\d{4}-\d\d-\d\d.*)$`)

// unsafeRunes are the characters that force quoting in a plain YAML scalar.
const unsafeRunes = ":#{}[]&*!|>'\"%@`,\t"

// scalar renders a YAML scalar, quoting only when it would otherwise be
// ambiguous. Quoting everything would be safe but doubles the token cost.
func scalar(s string) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if s == "" {
		return `""`
	}
	if strings.ContainsAny(s, unsafeRunes) || strings.HasPrefix(s, "-") || reservedScalar.MatchString(s) {
		return strconv.Quote(s)
	}
	return s
}

// oneLine flattens a value for use inside a flow sequence.
func oneLine(s string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(s, "|", "/")), " ")
}

// flow renders a compact ["a", "b"] sequence.
func flow(items []string) string {
	quoted := make([]string, len(items))
	for i, s := range items {
		quoted[i] = strconv.Quote(oneLine(s))
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}

// Short abbreviates a SHA for display.
func Short(sha string) string {
	if len(sha) > 12 {
		return sha[:12]
	}
	return sha
}

// YAML writes the report as the token-efficient document ctx is built around.
func YAML(w io.Writer, report model.Report) error {
	var b strings.Builder
	for _, warning := range report.Warnings {
		fmt.Fprintf(&b, "warning: %s\n", warning)
	}
	fmt.Fprintf(&b, "scope: %s\n", scalar(report.Scope))
	writeRemoval(&b, report.Removed)
	writeSection(&b, "active", report.Active)
	writeSection(&b, "superseded", report.Superseded)
	writeSection(&b, "orphaned", report.Orphaned)

	if len(report.OpenIncidents) == 0 {
		b.WriteString("open_incidents: []\n")
	} else {
		b.WriteString("open_incidents:\n")
		for _, incident := range report.OpenIncidents {
			fmt.Fprintf(&b, "  - %s: %s\n", Short(incident.SHA), scalar(incident.Summary))
		}
	}
	if report.OrphanedHidden > 0 {
		fmt.Fprintf(&b, "orphaned_hidden: %d\n", report.OrphanedHidden)
	}
	if report.Error != "" {
		fmt.Fprintf(&b, "error: %s\n", scalar(report.Error))
	}
	_, err := io.WriteString(w, b.String())
	return err
}

// writeRemoval reports the tombstone: the path is gone, and this is who took
// it out and what they said about it.
func writeRemoval(b *strings.Builder, removal *model.Removal) {
	if removal == nil {
		return
	}
	fmt.Fprintf(b, "removed:\n  by: %s\n", Short(removal.By))
	for _, kv := range [][2]string{
		{"at", removal.At},
		{"decision", removal.Decision},
		{"reversible", string(removal.Reversible)},
		{"oracle", string(removal.Oracle)},
		{"renamed_to", removal.RenamedTo},
	} {
		if kv[1] != "" {
			fmt.Fprintf(b, "  %s: %s\n", kv[0], scalar(kv[1]))
		}
	}
}

func writeSection(b *strings.Builder, name string, records []model.Record) {
	if len(records) == 0 {
		fmt.Fprintf(b, "%s: []\n", name)
		return
	}
	fmt.Fprintf(b, "%s:\n", name)
	for _, record := range records {
		if record.Superseded() {
			by := make([]string, len(record.SupersededBy))
			for i, s := range record.SupersededBy {
				by[i] = Short(s.By)
			}
			fmt.Fprintf(b, "  - sha: %s -> by %s\n", Short(record.SHA), strings.Join(by, ", "))
		} else {
			fmt.Fprintf(b, "  - sha: %s\n", Short(record.SHA))
		}
		fmt.Fprintf(b, "    decision: %s\n", scalar(record.Decision.Decision))

		// Active decisions get a block sequence (readable, and what an agent is
		// most likely to act on); superseded ones get the compact form.
		if len(record.Rejected) > 0 {
			if name == "active" {
				b.WriteString("    rejected:\n")
				for _, item := range record.Rejected {
					fmt.Fprintf(b, "      - %s\n", scalar(item))
				}
			} else {
				fmt.Fprintf(b, "    rejected: %s\n", flow(record.Rejected))
			}
		}
		if record.Reversible != "" {
			fmt.Fprintf(b, "    reversible: %s\n", scalar(string(record.Reversible)))
		}
		if record.Oracle != "" {
			fmt.Fprintf(b, "    oracle: %s\n", scalar(string(record.Oracle)))
		}
		if reasons := supersedeReasons(record); len(reasons) == 1 {
			fmt.Fprintf(b, "    reason: %s\n", scalar(reasons[0]))
		} else if len(reasons) > 1 {
			fmt.Fprintf(b, "    reason: %s\n", flow(reasons))
		}
		if len(record.Runs) > 0 {
			runs := make([]string, len(record.Runs))
			for i, run := range record.Runs {
				runs[i] = run.String()
			}
			fmt.Fprintf(b, "    runs: %s\n", flow(runs))
		}
	}
}

func supersedeReasons(record model.Record) []string {
	var reasons []string
	for _, s := range record.SupersededBy {
		if s.Reason != "" {
			reasons = append(reasons, s.Reason)
		}
	}
	return reasons
}
