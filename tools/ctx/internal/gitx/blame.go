package gitx

import (
	"context"
	"regexp"
	"strconv"
	"strings"
)

// Every --line-porcelain entry opens with "<40-hex> <orig> <final> [count]".
var blameHeader = regexp.MustCompile(`^([0-9a-f]{40}) \d+ (\d+)`)

// zeroSHA marks a line that is not committed yet.
const zeroSHA = "0000000000000000000000000000000000000000"

// BlameLine attributes one surviving line to the commit that last touched it.
type BlameLine struct {
	SHA  string
	Line int // line number in HEAD, 1-indexed
}

// BlameOpts selects what to attribute.
type BlameOpts struct {
	Path           string
	IgnoreRevsFile string // absolute path, so it resolves from any directory
}

// Blame attributes every surviving line of a file.
//
// The whole file is always blamed, never a -L range: a range is filtered by
// the caller from this result. One git process serves both the ranged view and
// the file-level ownership set that orphan detection needs, and the porcelain
// header already carries the final line number to filter on.
func (r *Repo) Blame(ctx context.Context, o BlameOpts) ([]BlameLine, error) {
	// -C credits a line moved or copied from another file that the same commit changed to the
	// commit that wrote it, not to the commit that moved it. Without it, extracting code into a
	// new file (the ordinary refactor) hands every moved line to the refactor, and the decisions
	// that governed it stop reaching the file where it now lives. git ignores copies shorter than
	// 40 alphanumeric characters, so boilerplate lines are not mistaken for moves.
	args := []string{"blame", "--line-porcelain", "-C"}
	if o.IgnoreRevsFile != "" {
		args = append(args, "--ignore-revs-file", o.IgnoreRevsFile)
	}
	args = append(args, "HEAD", "--", o.Path)

	out, err := r.Text(ctx, args...)
	if err != nil {
		return nil, err
	}
	var lines []BlameLine
	for _, line := range strings.Split(out, "\n") {
		m := blameHeader.FindStringSubmatch(line)
		if m == nil || m[1] == zeroSHA {
			continue
		}
		n, _ := strconv.Atoi(m[2])
		lines = append(lines, BlameLine{SHA: m[1], Line: n})
	}
	return lines, nil
}

// SHAsIn returns the distinct commits owning lines within [lo,hi], in
// first-appearance order. A zero lo means every line.
func SHAsIn(lines []BlameLine, lo, hi int) []string {
	var shas []string
	seen := map[string]bool{}
	for _, l := range lines {
		if lo > 0 && (l.Line < lo || l.Line > hi) {
			continue
		}
		if seen[l.SHA] {
			continue
		}
		seen[l.SHA] = true
		shas = append(shas, l.SHA)
	}
	return shas
}
