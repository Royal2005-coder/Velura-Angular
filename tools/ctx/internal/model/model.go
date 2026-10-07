// Package model holds the vocabulary of the decision record. Nothing here
// touches git or does I/O, so the rules are cheap to test.
package model

import "strings"

// Tier is the value of the Reversible: trailer — how hard the change is to undo.
type Tier string

const (
	TierTrue        Tier = "true"         // revert the commit and you are back
	TierRestoreOnly Tier = "restore-only" // undoing needs a restore from backup
	TierNever       Tier = "never"        // one-way door
)

// Oracle is the value of the Oracle: trailer — how a violation gets detected.
type Oracle string

const (
	OracleDrift    Oracle = "drift"    // reconciler or drift detector notices
	OracleTest     Oracle = "test"     // a test fails
	OracleContract Oracle = "contract" // a schema or contract check fails
)

var (
	tiers   = []Tier{TierTrue, TierRestoreOnly, TierNever}
	oracles = []Oracle{OracleDrift, OracleTest, OracleContract}
)

func (t Tier) Valid() bool {
	for _, v := range tiers {
		if t == v {
			return true
		}
	}
	return false
}

func (o Oracle) Valid() bool {
	for _, v := range oracles {
		if o == v {
			return true
		}
	}
	return false
}

// TierNames and OracleNames render the vocabulary for error messages.
func TierNames() string {
	s := make([]string, len(tiers))
	for i, t := range tiers {
		s[i] = string(t)
	}
	return strings.Join(s, "|")
}

func OracleNames() string {
	s := make([]string, len(oracles))
	for i, o := range oracles {
		s[i] = string(o)
	}
	return strings.Join(s, "|")
}

// Decision is what a single commit asserts: the source of truth, read from
// the commit message trailers and therefore immutable and peer-reviewed.
type Decision struct {
	SHA string `json:"sha"`
	// Stated is true when Decision came from a Decision: trailer rather than
	// falling back to the commit subject. Only a stated decision counts as a
	// decision: the subject fallback is context, not a claim anyone reviewed.
	// Exposed in JSON so a consumer can tell a real decision from a commit
	// subject — without it, every tracked file in every repo looks decorated.
	Stated     bool     `json:"stated"`
	Decision   string   `json:"decision"`
	Rejected   []string `json:"rejected,omitempty"`
	Reversible Tier     `json:"reversible,omitempty"`
	Oracle     Oracle   `json:"oracle,omitempty"`
}

// Supersession, Run and Incident are derived state, read from refs/notes/*.
type Supersession struct {
	By     string `json:"by"`
	At     string `json:"at,omitempty"`
	Reason string `json:"reason,omitempty"`
}

type Run struct {
	At       string `json:"at"`
	Status   string `json:"status"`
	Incident string `json:"incident,omitempty"`
	Raw      string `json:"-"` // set when the note line did not parse
}

func (r Run) String() string {
	if r.Raw != "" {
		return r.Raw
	}
	inc := r.Incident
	if inc == "" {
		inc = "none"
	}
	status := r.Status
	if status == "" {
		status = "unknown"
	}
	return r.At + " " + status + " -> " + inc
}

type Incident struct {
	At      string `json:"at,omitempty"`
	Status  string `json:"status,omitempty"`
	Summary string `json:"summary"`
}

func (i Incident) Open() bool {
	switch strings.ToLower(i.Status) {
	case "closed", "resolved":
		return false
	}
	return true
}

// Record is one blamed commit joined with everything derived about it.
type Record struct {
	Decision
	SupersededBy []Supersession `json:"superseded_by,omitempty"`
	Runs         []Run          `json:"runs,omitempty"`
	Incidents    []Incident     `json:"incidents,omitempty"`
}

func (r Record) Superseded() bool { return len(r.SupersededBy) > 0 }

// Removal is the commit that took a path out of the tree: the tombstone, plus
// whatever that commit stated about why.
type Removal struct {
	By         string `json:"by"`
	At         string `json:"at,omitempty"`
	Decision   string `json:"decision,omitempty"`
	Reversible Tier   `json:"reversible,omitempty"`
	Oracle     Oracle `json:"oracle,omitempty"`
	RenamedTo  string `json:"renamed_to,omitempty"`
}

// Report is the compiled answer for one scope, and the thing an agent ingests.
// Active, Superseded, Orphaned and OpenIncidents all keep blame or history
// order, so the output is stable across runs.
type Report struct {
	Scope          string         `json:"scope"`
	Warnings       []string       `json:"warnings,omitempty"`
	Removed        *Removal       `json:"removed,omitempty"`
	Active         []Record       `json:"active"`
	Superseded     []Record       `json:"superseded"`
	Orphaned       []Record       `json:"orphaned"`
	OpenIncidents  []OpenIncident `json:"open_incidents"`
	OrphanedHidden int            `json:"orphaned_hidden,omitempty"`
	Error          string         `json:"error,omitempty"`
}

// OpenIncident pairs an unresolved incident with the commit it is attributed to.
type OpenIncident struct {
	SHA     string `json:"sha"`
	Summary string `json:"summary"`
}

// Costly reports whether a decision declared a real cost to undo. It is the
// threshold for surfacing an orphaned decision: one that lost its code without
// anyone retiring it matters when undoing was expensive, and is cheap history
// when the decision itself said a revert would do.
func (r Record) Costly() bool {
	return r.Reversible == TierNever || r.Reversible == TierRestoreOnly || len(r.Incidents) > 0
}

// FailedRun is a run that failed since a baseline was taken. It lives outside
// Record so a delta can announce the failure without re-sending the record
// the reader already has.
type FailedRun struct {
	SHA string `json:"sha"`
	Run string `json:"run"`
}

// Delta is what appeared between two reports of the same scope: only the
// records, incidents and failures that are new. An empty Delta means the
// reader already has everything the current report would tell them.
type Delta struct {
	Scope         string         `json:"scope"`
	Warnings      []string       `json:"warnings,omitempty"`
	Removed       *Removal       `json:"removed,omitempty"`
	Active        []Record       `json:"active,omitempty"`
	Superseded    []Record       `json:"superseded,omitempty"`
	Orphaned      []Record       `json:"orphaned,omitempty"`
	OpenIncidents []OpenIncident `json:"open_incidents,omitempty"`
	FailedRuns    []FailedRun    `json:"failed_runs,omitempty"`
}

func (d Delta) Empty() bool {
	return len(d.Warnings) == 0 && d.Removed == nil && len(d.Active) == 0 && len(d.Superseded) == 0 &&
		len(d.Orphaned) == 0 && len(d.OpenIncidents) == 0 && len(d.FailedRuns) == 0
}
