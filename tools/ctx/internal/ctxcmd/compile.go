package ctxcmd

import (
	"context"
	"fmt"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"ctx/internal/gitx"
	"ctx/internal/model"
)

// maxBlameWorkers bounds the git processes in flight while resolving a scope.
// Each record costs up to five git invocations, so a wide range over a long
// history is process-bound, not CPU-bound.
var maxBlameWorkers = min(8, runtime.NumCPU())

// maxOrphansShown caps the orphaned section. The cost threshold alone does not
// bound it: a file rewritten many times, each rewrite declaring Reversible:
// never, yields one qualifying orphan per generation. Benchmarked at 120
// generations that is a 485-line report — fast to produce and useless to read.
// The newest are kept, since PathDecisions returns newest first; the rest are
// counted in orphaned_hidden, and -all lifts the cap.
const maxOrphansShown = 10

// maxDirFiles bounds a directory scope. Each file costs a blame, so a scope over a whole
// monorepo is cut off and says so rather than running for minutes. Narrow the scope to see the rest.
const maxDirFiles = 400

var lineRange = regexp.MustCompile(`^(\d+)(?:-(\d+))?$`)

// Scope is a file, optionally narrowed to a line range.
type Scope struct {
	Path   string
	Lo, Hi int
}

func (s Scope) String() string {
	if s.Lo > 0 {
		return fmt.Sprintf("%s:%d-%d", s.Path, s.Lo, s.Hi)
	}
	return s.Path
}

// ParseScope splits "path:start-end". A path that exists on disk wins over a
// range spec, because "foo:12" is a legal filename.
func ParseScope(arg string) Scope {
	if FileExists(arg) {
		return Scope{Path: arg}
	}
	i := strings.LastIndex(arg, ":")
	if i <= 0 {
		return Scope{Path: arg}
	}
	m := lineRange.FindStringSubmatch(arg[i+1:])
	if m == nil {
		return Scope{Path: arg}
	}
	lo, _ := strconv.Atoi(m[1])
	hi := lo
	if m[2] != "" {
		if parsed, _ := strconv.Atoi(m[2]); parsed > lo {
			hi = parsed
		}
	}
	return Scope{Path: arg[:i], Lo: lo, Hi: hi}
}

// CompileOpts tunes what a scope report includes.
type CompileOpts struct {
	AllOrphaned bool // include orphaned decisions that declared no cost to undo
}

// Compile is `ctx for`: blame the scope, then join every commit it names
// against its trailers and its derived notes.
//
// It answers three questions, not one. What governs these lines now (active),
// what was deliberately retired (superseded), and what was decided about this
// path but no longer owns any surviving line (orphaned) — the last being the
// case blame alone cannot see.
func Compile(ctx context.Context, repo *gitx.Repo, arg string, opts CompileOpts) model.Report {
	scope := ParseScope(arg)
	scope.Path = normalizeDir(scope.Path)
	report := model.Report{Scope: scope.String()}

	if repo.IsShallow(ctx) {
		report.Warnings = append(report.Warnings,
			"shallow clone; blame stops at the graft boundary, so these SHAs may be wrong")
	}

	// A directory is a scope of its own. It must be recognised before blame, because blame
	// refuses one and the failure would otherwise fall through to the tombstone lookup, which
	// matches any file ever deleted beneath it and calls a live directory removed.
	if repo.IsDir(ctx, scope.Path) {
		return compileDir(ctx, repo, report, scope, opts)
	}

	lines, err := repo.Blame(ctx, blameOptsFor(ctx, repo, scope.Path))
	if err != nil {
		// The path is not in HEAD. Either it was removed — in which case its
		// decisions are still the answer, and why it went is the headline — or
		// it never existed, which stays an error.
		return removedReport(ctx, repo, report, scope, err)
	}

	inScope := gitx.SHAsIn(lines, scope.Lo, scope.Hi)
	owners := map[string]bool{}
	for _, l := range lines {
		owners[l.SHA] = true
	}

	// Orphans are file-level: a commit that owns surviving lines anywhere in
	// the file is not orphaned, even when the queried range excludes them.
	var orphanSHAs []string
	for _, sha := range repo.PathDecisions(ctx, scope.Path) {
		if !owners[sha] {
			orphanSHAs = append(orphanSHAs, sha)
		}
	}

	fill(ctx, repo, &report, inScope, orphanSHAs, opts)
	return report
}

// compileDir answers for a directory: the decisions that own a surviving line in any file beneath
// it are active, and the ones that touched it but own none are orphaned. Ownership is judged across
// the whole directory, so a decision that survives in one file is not orphaned by another's rewrite.
func compileDir(ctx context.Context, repo *gitx.Repo, report model.Report, scope Scope, opts CompileOpts) model.Report {
	if scope.Lo > 0 {
		report.Error = fmt.Sprintf("a line range applies to a file; %q is a directory", scope.Path)
		return report
	}
	files := repo.Files(ctx, scope.Path)
	if len(files) > maxDirFiles {
		report.Warnings = append(report.Warnings, fmt.Sprintf(
			"%d files beneath %s; only the first %d were blamed, so decisions on the rest are missing: narrow the scope",
			len(files), scope.Path, maxDirFiles))
		files = files[:maxDirFiles]
	}

	blamed := blameAll(ctx, repo, files)
	var inScope []string
	owners := map[string]bool{}
	seen := map[string]bool{}
	failed := 0
	for _, lines := range blamed {
		if lines == nil {
			failed++
			continue
		}
		for _, l := range lines {
			owners[l.SHA] = true
			if !seen[l.SHA] {
				seen[l.SHA] = true
				inScope = append(inScope, l.SHA)
			}
		}
	}
	if failed > 0 {
		report.Warnings = append(report.Warnings,
			fmt.Sprintf("%d file(s) could not be blamed (a submodule, or a file git refused)", failed))
	}

	var orphanSHAs []string
	for _, sha := range repo.TreeDecisions(ctx, scope.Path) {
		if !owners[sha] {
			orphanSHAs = append(orphanSHAs, sha)
		}
	}
	fill(ctx, repo, &report, inScope, orphanSHAs, opts)
	return report
}

// blameAll blames every file concurrently, bounded like record loading. A file that cannot be
// blamed is nil in the result, in the position of the file, so the order stays stable.
func blameAll(ctx context.Context, repo *gitx.Repo, files []string) [][]gitx.BlameLine {
	out := make([][]gitx.BlameLine, len(files))
	sem := make(chan struct{}, maxBlameWorkers)
	var wg sync.WaitGroup
	for i, file := range files {
		wg.Add(1)
		go func(i int, file string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			lines, err := repo.Blame(ctx, blameOptsFor(ctx, repo, file))
			if err == nil && lines == nil {
				lines = []gitx.BlameLine{} // an empty file blamed fine: not a failure
			}
			out[i] = lines
		}(i, file)
	}
	wg.Wait()
	return out
}

// fill joins the commits a scope names against their trailers and notes, and files each under
// active, superseded or orphaned.
func fill(ctx context.Context, repo *gitx.Repo, report *model.Report, inScope, orphanSHAs []string, opts CompileOpts) {
	for _, record := range loadRecords(ctx, repo, inScope) {
		if record.Superseded() {
			report.Superseded = append(report.Superseded, record)
		} else {
			report.Active = append(report.Active, record)
		}
		addIncidents(report, record)
	}
	collectOrphans(ctx, repo, report, orphanSHAs, opts)
}

func blameOptsFor(ctx context.Context, repo *gitx.Repo, path string) gitx.BlameOpts {
	opts := gitx.BlameOpts{Path: path}
	if ignore := filepath.Join(repo.TopLevel(ctx), BlameIgnoreFile); FileExists(ignore) {
		opts.IgnoreRevsFile = ignore
	}
	return opts
}

// normalizeDir turns the spellings of a directory into the one git wants: no trailing slash, and
// "" for the repository root.
func normalizeDir(path string) string {
	path = strings.TrimSuffix(strings.TrimPrefix(path, "./"), "/")
	if path == "." {
		return ""
	}
	return path
}

// removedReport turns a failed blame into the tombstone report when the path
// was removed, and leaves it an error when the path never existed.
func removedReport(ctx context.Context, repo *gitx.Repo, report model.Report, scope Scope, blameErr error) model.Report {
	tomb := repo.FindTombstone(ctx, scope.Path)
	if tomb == nil {
		report.Error = blameErr.Error()
		return report
	}
	tombstone := LoadRecord(ctx, repo, tomb.SHA)
	report.Removed = &model.Removal{
		By:         tomb.SHA,
		At:         tomb.At,
		Decision:   tombstone.Decision.Decision,
		Reversible: tombstone.Reversible,
		Oracle:     tombstone.Oracle,
		RenamedTo:  tomb.RenamedTo,
	}
	// Nothing survives, so every decision ever made about the path is orphaned
	// — except the tombstone itself, which the removed: headline already states.
	var orphans []string
	for _, sha := range repo.PathDecisions(ctx, scope.Path) {
		if sha != tomb.SHA {
			orphans = append(orphans, sha)
		}
	}
	collectOrphans(ctx, repo, &report, orphans, CompileOpts{AllOrphaned: true})
	return report
}

// collectOrphans loads candidate orphans and files them. A commit that was
// explicitly superseded belongs under that heading instead: a reviewed
// retirement outranks an implicit one.
func collectOrphans(ctx context.Context, repo *gitx.Repo, report *model.Report, shas []string, opts CompileOpts) {
	for _, record := range loadRecords(ctx, repo, shas) {
		// --grep matches prose too, so confirm the trailer actually parsed.
		if !record.Stated {
			continue
		}
		if record.Superseded() {
			report.Superseded = append(report.Superseded, record)
			addIncidents(report, record)
			continue
		}
		if !opts.AllOrphaned && (!record.Costly() || len(report.Orphaned) >= maxOrphansShown) {
			report.OrphanedHidden++
			continue
		}
		report.Orphaned = append(report.Orphaned, record)
		addIncidents(report, record)
	}
}

func addIncidents(report *model.Report, record model.Record) {
	for _, incident := range record.Incidents {
		report.OpenIncidents = append(report.OpenIncidents,
			model.OpenIncident{SHA: record.SHA, Summary: incident.Summary})
	}
}

// loadRecords resolves every SHA concurrently but returns them in blame order.
func loadRecords(ctx context.Context, repo *gitx.Repo, shas []string) []model.Record {
	records := make([]model.Record, len(shas))
	sem := make(chan struct{}, maxBlameWorkers)
	var wg sync.WaitGroup
	for i, sha := range shas {
		wg.Add(1)
		go func(i int, sha string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			records[i] = LoadRecord(ctx, repo, sha)
		}(i, sha)
	}
	wg.Wait()
	return records
}

// LoadRecord joins one commit's trailers (source of truth) with the notes
// derived from them (secondary index).
func LoadRecord(ctx context.Context, repo *gitx.Repo, sha string) model.Record {
	trailers := repo.TrailersOf(ctx, sha)

	decision := trailers.First("decision")
	stated := strings.TrimSpace(decision) != ""
	if !stated {
		// No Decision: trailer. The subject is a weak substitute, but an agent
		// reading "style: fmt sweep" learns more than it does from an empty field.
		decision = repo.Subject(ctx, sha)
	}
	record := model.Record{Decision: model.Decision{
		SHA:        sha,
		Stated:     stated,
		Decision:   decision,
		Rejected:   trailers["rejected"],
		Reversible: model.Tier(trailers.First("reversible")),
		Oracle:     model.Oracle(trailers.First("oracle")),
	}}

	for _, line := range repo.NoteLines(ctx, gitx.NotesDecisions, sha) {
		f := gitx.Fields(line)
		if f["superseded-by"] == "" {
			continue
		}
		record.SupersededBy = append(record.SupersededBy, model.Supersession{
			By:     f["superseded-by"],
			At:     f["at"],
			Reason: orDefault(f["reason"], "unspecified"),
		})
	}
	for _, line := range repo.NoteLines(ctx, gitx.NotesRuns, sha) {
		f := gitx.Fields(line)
		if f["at"] == "" {
			record.Runs = append(record.Runs, model.Run{Raw: line})
			continue
		}
		record.Runs = append(record.Runs, model.Run{
			At: f["at"], Status: orDefault(f["status"], "unknown"), Incident: f["incident"],
		})
	}
	for _, line := range repo.NoteLines(ctx, gitx.NotesIncidents, sha) {
		f := gitx.Fields(line)
		incident := model.Incident{At: f["at"], Status: f["status"], Summary: orDefault(f["summary"], line)}
		if incident.Open() {
			record.Incidents = append(record.Incidents, incident)
		}
	}
	return record
}

func orDefault(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}
