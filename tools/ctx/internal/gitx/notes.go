package gitx

import (
	"context"
	"strings"
)

// Note refs. These hold derived state only: refs/notes/decisions is rebuilt
// from commit trailers by reindex, and runs/incidents are appended by CI.
const (
	NotesDecisions = "decisions"
	NotesRuns      = "runs"
	NotesIncidents = "incidents"
)

// NoteLines returns the lines of a note, or nil when there is no note.
func (r *Repo) NoteLines(ctx context.Context, ref, sha string) []string {
	return Lines(r.Quiet(ctx, "notes", "--ref="+ref, "show", sha))
}

// SetNote replaces the whole note for sha.
func (r *Repo) SetNote(ctx context.Context, ref, sha, body string) error {
	_, err := r.Text(ctx, "notes", "--ref="+ref, "add", "-f", "-m", body, sha)
	return err
}

// AppendNote adds a line to a note, creating it when absent. CI uses plain git
// for this; the method exists so tests and tooling do not have to.
func (r *Repo) AppendNote(ctx context.Context, ref, sha, line string) error {
	_, err := r.Text(ctx, "notes", "--ref="+ref, "append", "-m", line, sha)
	return err
}

// DropNoteRef deletes an entire notes ref. Safe when the ref does not exist.
func (r *Repo) DropNoteRef(ctx context.Context, ref string) error {
	full := "refs/notes/" + ref
	if r.Quiet(ctx, "rev-parse", "--verify", "--quiet", full) == "" {
		return nil
	}
	_, err := r.Text(ctx, "update-ref", "-d", full)
	return err
}

// Fields parses one derived-note line of the form "k: v | k: v | k: v".
//
// A segment that does not look like a key (it has no colon, or its key half
// contains whitespace) is treated as a continuation of the previous value, so
// free text containing a pipe survives intact.
func Fields(line string) map[string]string {
	fields, key := map[string]string{}, ""
	for _, segment := range strings.Split(line, "|") {
		k, v, ok := strings.Cut(segment, ":")
		k = strings.ToLower(strings.TrimSpace(k))
		switch {
		case ok && k != "" && !strings.ContainsAny(k, " \t"):
			key = k
			fields[key] = strings.TrimSpace(v)
		case key != "":
			fields[key] += " | " + strings.TrimSpace(segment)
		}
	}
	return fields
}
