package ctxcmd

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"ctx/internal/gitx"
)

// Supersede writes the empty commit that retires a prior decision. It does not
// touch refs/notes/*: the claim has to survive review as a commit first, and
// reindex derives the note from it afterwards.
func Supersede(ctx context.Context, repo *gitx.Repo, target, reason string) (string, error) {
	if strings.TrimSpace(reason) == "" {
		return "", errors.New("a reason is required: the superseding commit is the document")
	}
	sha, err := repo.Resolve(ctx, target)
	if err != nil {
		return "", err
	}
	subject := repo.Subject(ctx, sha)
	out, err := repo.Text(ctx, "commit", "--allow-empty",
		"-m", fmt.Sprintf("Supersede %s (%s)", sha[:12], subject),
		"--trailer", "Supersedes:"+sha,
		"--trailer", "Reason:"+strings.TrimSpace(reason))
	if err != nil {
		return "", err
	}
	return out, nil
}

// ReindexResult reports what a rebuild found.
type ReindexResult struct {
	Commits  int      // superseding commits scanned
	Entries  int      // targets written to refs/notes/decisions
	Warnings []string // trailers pointing at commits that do not exist
}

// Reindex rebuilds refs/notes/decisions from the Supersedes: trailers in the
// commit graph. The ref is deleted first: it is derived state, and a rebuild
// must not inherit anything that is no longer backed by a commit.
func Reindex(ctx context.Context, repo *gitx.Repo) (ReindexResult, error) {
	var result ReindexResult
	entries, err := repo.SupersedingCommits(ctx)
	if err != nil {
		return result, err
	}

	index := map[string][]string{}
	for _, entry := range entries {
		trailers := repo.ParseTrailers(ctx, entry.Body)
		targets := trailers["supersedes"]
		if len(targets) == 0 {
			continue // matched the grep, but not as a trailer
		}
		result.Commits++
		reason := SanitizeNoteValue(orDefault(trailers.First("reason"), "unspecified"))
		for _, raw := range targets {
			for _, ref := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' }) {
				target, err := repo.Resolve(ctx, ref)
				if err != nil {
					result.Warnings = append(result.Warnings,
						fmt.Sprintf("%s supersedes unknown commit %q", entry.SHA[:12], ref))
					continue
				}
				index[target] = append(index[target],
					fmt.Sprintf("superseded-by: %s | at: %s | reason: %s", entry.SHA, entry.When, reason))
			}
		}
	}

	if err := repo.DropNoteRef(ctx, gitx.NotesDecisions); err != nil {
		return result, err
	}
	for target, lines := range index {
		if err := repo.SetNote(ctx, gitx.NotesDecisions, target, strings.Join(lines, "\n")); err != nil {
			return result, err
		}
	}
	result.Entries = len(index)
	return result, nil
}

// SanitizeNoteValue flattens a value so it cannot forge a new "key: value"
// field in a pipe-delimited note line.
func SanitizeNoteValue(s string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(s, "|", "/")), " ")
}
