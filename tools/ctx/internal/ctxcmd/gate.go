package ctxcmd

import (
	"context"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"ctx/internal/gitx"
	"ctx/internal/model"
)

// DefaultGatePaths are the tracked paths that require a stated decision when
// neither a repository nor a personal override configures anything.
var DefaultGatePaths = []string{"infra/", "pkg/core/"}

// GatePathsFile is checked into the repository, so a gate scope travels with
// a clone instead of living only in one contributor's local git config. A
// clone is exactly where the safety net matters most: it is the state a new
// contributor, a CI runner, or an agent starts from, and git config is never
// part of what a clone or fetch transmits.
const GatePathsFile = ".ctx-gate-paths"

// GateResult is the verdict for one commit or staging area.
type GateResult struct {
	Source     string   // what was inspected, for the operator
	Files      []string // every path in scope
	Gated      []string // the subset matching a gated prefix
	Violations []string
}

func (g GateResult) OK() bool { return len(g.Violations) == 0 }

// Gate enforces the trailer contract. msgFile is the commit-msg hook's $1; when
// empty, the staged files are checked against HEAD's message instead.
func Gate(ctx context.Context, repo *gitx.Repo, msgFile string) (GateResult, error) {
	result := GateResult{Source: "HEAD"}
	files := repo.HeadFiles(ctx)
	message := repo.Message(ctx, "HEAD")

	// A bare repository has no index, so `git diff --cached` would report the
	// entire tree as staged. Only a working tree can have staged changes.
	staged := []string{}
	if !repo.IsBare(ctx) {
		staged = repo.StagedFiles(ctx)
	}
	if len(staged) > 0 {
		files, result.Source = staged, "staged"
	}
	switch {
	case msgFile != "":
		body, err := os.ReadFile(msgFile)
		if err != nil {
			return result, err
		}
		message = string(body)
		result.Source += " + " + msgFile
		// -m means a commit-msg hook is validating the commit about to be made,
		// not auditing one that already exists. Nothing staged there means that
		// commit will be EMPTY (git commit --allow-empty, the shape ctx supersede
		// itself writes) and touches no files at all — falling back to HEAD would
		// gate it against whatever the PREVIOUS, unrelated commit happened to
		// change, which is wrong regardless of what that commit was.
		if len(staged) == 0 {
			files, result.Source = nil, "empty commit + "+msgFile
		}
	case result.Source == "staged":
		result.Source = "staged, message from HEAD (pass -m in a commit-msg hook)"
	}

	patterns := GatePaths(ctx, repo)
	result.Files = files
	for _, file := range files {
		if Match(file, patterns) {
			result.Gated = append(result.Gated, file)
		}
	}
	trailers := repo.ParseTrailers(ctx, message)
	result.Violations = Evaluate(trailers, result.Gated)
	if hint := MisplacedTrailerHint(message, trailers); hint != "" && len(result.Violations) > 0 {
		result.Violations = append(result.Violations, "hint: "+hint)
	}
	return result, nil
}

// Evaluate applies the trailer rules. It is pure, so the policy is testable
// without a repository.
func Evaluate(trailers gitx.Trailers, gated []string) []string {
	var violations []string
	tier := model.Tier(trailers.First("reversible"))
	oracle := model.Oracle(trailers.First("oracle"))

	if len(gated) > 0 && !trailers.Has("decision") {
		violations = append(violations,
			"missing `Decision:` trailer; gated paths touched: "+strings.Join(gated, ", "))
	}
	// A one-way door with no detector is a change nobody will notice going wrong.
	if tier == model.TierNever && oracle == "" {
		violations = append(violations,
			fmt.Sprintf("`Reversible: never` requires an `Oracle:` trailer (%s)", model.OracleNames()))
	}
	// A misspelled tier silently escapes the rule above, so the vocabulary is
	// closed rather than advisory.
	if tier != "" && !tier.Valid() {
		violations = append(violations,
			fmt.Sprintf("`Reversible: %s` is not one of %s", tier, model.TierNames()))
	}
	if oracle != "" && !oracle.Valid() {
		violations = append(violations,
			fmt.Sprintf("`Oracle: %s` is not one of %s", oracle, model.OracleNames()))
	}
	return violations
}

// contractKey matches a trailer-looking line anywhere in a commit message.
var contractKey = regexp.MustCompile(`(?mi)^(decision|rejected|reversible|oracle|supersedes|reason):`)

// MisplacedTrailerHint explains the authoring mistake that produces a
// "missing Decision:" violation on a message that visibly contains one: git
// reads only the LAST paragraph as trailers, so a blank line above them (an
// attribution footer, say) demotes the whole block to body text.
func MisplacedTrailerHint(message string, trailers gitx.Trailers) string {
	if trailers.Has("decision") || !contractKey.MatchString(message) {
		return ""
	}
	return "the message contains a trailer-style line that git did not parse as a trailer; " +
		"every trailer must sit in the LAST paragraph, and a wrapped value must be indented"
}

// GatePaths resolves the gated-path list. Precedence: a personal override in
// git config (git config --add ctx.gate.path <prefix|glob>) wins when set, for
// a contributor who wants to gate something extra just for themselves; failing
// that, the tracked `.ctx-gate-paths` file, which is what a normal clone
// actually gets; failing that, DefaultGatePaths.
func GatePaths(ctx context.Context, repo *gitx.Repo) []string {
	if configured := repo.ConfigAll(ctx, "ctx.gate.path"); len(configured) > 0 {
		return configured
	}
	if tracked := readGatePathsFile(ctx, repo); len(tracked) > 0 {
		return tracked
	}
	return DefaultGatePaths
}

// readGatePathsFile parses one prefix or glob per line; blank lines and lines
// starting with # are ignored, matching .git-blame-ignore-revs' own shape.
func readGatePathsFile(ctx context.Context, repo *gitx.Repo) []string {
	body, err := os.ReadFile(filepath.Join(repo.TopLevel(ctx), GatePathsFile))
	if err != nil {
		return nil
	}
	var paths []string
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		paths = append(paths, line)
	}
	return paths
}

// Match reports whether a path falls under a gated prefix or glob.
func Match(file string, patterns []string) bool {
	for _, pattern := range patterns {
		pattern = strings.TrimSuffix(strings.TrimSuffix(strings.TrimSpace(pattern), "*"), "/")
		if pattern == "" {
			continue
		}
		if file == pattern || strings.HasPrefix(file, pattern+"/") {
			return true
		}
		if ok, _ := path.Match(pattern, file); ok {
			return true
		}
	}
	return false
}
