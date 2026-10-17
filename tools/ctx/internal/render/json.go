package render

import (
	"encoding/json"
	"io"

	"ctx/internal/model"
)

// JSON writes the report as indented JSON. The schema is model.Report, so an
// agent gets typed fields (and full SHAs) instead of parsing the YAML.
func JSON(w io.Writer, report model.Report) error {
	// Keep the zero value of a list as [] rather than null: consumers should not
	// have to distinguish "no active decisions" from "field missing".
	if report.Active == nil {
		report.Active = []model.Record{}
	}
	if report.Superseded == nil {
		report.Superseded = []model.Record{}
	}
	if report.Orphaned == nil {
		report.Orphaned = []model.Record{}
	}
	if report.OpenIncidents == nil {
		report.OpenIncidents = []model.OpenIncident{}
	}
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	return encoder.Encode(report)
}
