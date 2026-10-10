package gitx

import (
	"context"
	"strings"
)

// Record separators that cannot occur in a commit message.
const (
	recordSep = "\x1e"
	fieldSep  = "\x1f"
)

// LogEntry is one commit from a history scan.
type LogEntry struct {
	SHA  string
	When string // author date, ISO 8601
	Body string
}

// SupersedingCommits returns every commit that mentions a Supersedes: trailer.
//
// refs/notes/* is excluded: those commits are derived state and grow with every
// CI append, and a note's own message must never be read as a decision. The
// --grep pre-filter keeps the trailer parser off the rest of the history.
func (r *Repo) SupersedingCommits(ctx context.Context) ([]LogEntry, error) {
	out, err := r.Text(ctx, "log", "--all", "--not", "--glob=refs/notes/*",
		"-i", "--grep=Supersedes:", "--format=%H"+fieldSep+"%aI"+fieldSep+"%B"+recordSep)
	if err != nil {
		return nil, err
	}
	var entries []LogEntry
	for _, record := range strings.Split(out, recordSep) {
		parts := strings.SplitN(strings.TrimLeft(record, "\n"), fieldSep, 3)
		if len(parts) != 3 || len(parts[0]) != 40 {
			continue
		}
		entries = append(entries, LogEntry{SHA: parts[0], When: parts[1], Body: parts[2]})
	}
	return entries, nil
}
