package gitx

import (
	"context"
	"strings"
)

// Trailers are the parsed key/value pairs at the foot of a commit message.
// Keys are lower-cased; a key may repeat (Rejected:, Supersedes:).
type Trailers map[string][]string

// First returns the first value for key, or "".
func (t Trailers) First(key string) string {
	if v := t[key]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// Has reports whether key carries at least one non-empty value.
func (t Trailers) Has(key string) bool { return strings.TrimSpace(t.First(key)) != "" }

// ParseTrailers delegates to git's own trailer parser, so folded values and
// continuation lines behave exactly as they do everywhere else in git.
// A message with no trailers is not an error: it yields an empty map.
func (r *Repo) ParseTrailers(ctx context.Context, message string) Trailers {
	t := Trailers{}
	out, err := r.Pipe(ctx, message, "interpret-trailers", "--parse")
	if err != nil {
		return t
	}
	for _, line := range Lines(out) {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		k = strings.ToLower(strings.TrimSpace(k))
		t[k] = append(t[k], strings.TrimSpace(v))
	}
	return t
}

// TrailersOf reads a commit message and parses its trailers.
func (r *Repo) TrailersOf(ctx context.Context, sha string) Trailers {
	return r.ParseTrailers(ctx, r.Message(ctx, sha))
}
