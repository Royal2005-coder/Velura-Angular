// Command ctx enforces "Documents as Commit, Code as Context": git commits are
// the source of truth for architectural decisions, refs/notes/* is a derived
// index, and `ctx for` compiles both into context an agent can ingest.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"ctx/internal/buildinfo"
	"ctx/internal/ctxcmd"
	"ctx/internal/gitx"
	"ctx/internal/model"
	"ctx/internal/render"
)

// Exit codes. Anything scripting ctx depends on these.
const (
	exitOK        = 0
	exitViolation = 1 // a gate violation or a command error
	exitUsage     = 2
)

const usage = `ctx — Documents as Commit, Code as Context

  ctx init [-no-push-spec] [-hooks] [-force]   configure notes refspecs, blame ignores, gate hook
  ctx supersede <sha> -reason <text>           write the reviewable empty commit retiring a decision
  ctx reindex                                  rebuild refs/notes/decisions from Supersedes: trailers
  ctx for <path>[:<a>-<b>] [-format yaml|json] [-all] [-since <baseline.json>]
                                               (path: a file, or a directory)
                                               compile the decision context for a scope
  ctx render [-format yaml|json] [-since <baseline.json>] < report.json
                                               re-render a report from stdin, no git involved
  ctx gate [-m <msgfile>]                      require Decision:/Oracle: trailers on gated paths
  ctx version                                  print version, commit and build date

trailers: Decision: | Rejected: (repeatable) | Reversible: true|restore-only|never
          Oracle: drift|test|contract | Supersedes: <sha> | Reason: <text>
notes:    decisions "superseded-by: <sha> | at: <ts> | reason: <t>"   (derived, rebuildable)
          runs      "at: <ts> | status: pass|fail | incident: <id>"   (appended by CI)
          incidents "at: <ts> | status: open|closed | summary: <t>"   (appended by CI)

gated paths: .ctx-gate-paths (tracked) > ctx.gate.path config (local) > infra/,pkg/core/ (default)
exit codes: 0 ok, 1 violation or error, 2 usage. Full contract in README.md.
`

func main() { os.Exit(run()) }

func run() int {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		return exitUsage
	}
	command, args := os.Args[1], os.Args[2:]

	switch command {
	case "help", "-h", "--help":
		fmt.Print(usage)
		return exitOK
	case "version", "-v", "--version":
		fmt.Println(buildinfo.String())
		return exitOK
	}

	// Cancel in-flight git children on Ctrl-C rather than orphaning them.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	repo, err := gitx.Open(ctx, "")
	if err != nil {
		fmt.Fprintln(os.Stderr, "ctx:", err)
		return exitViolation
	}
	env := ctxcmd.Env{Repo: repo, Out: os.Stdout, Err: os.Stderr}

	switch command {
	case "init":
		err = cmdInit(ctx, env, args)
	case "supersede":
		err = cmdSupersede(ctx, env, args)
	case "reindex":
		err = cmdReindex(ctx, env)
	case "for":
		err = cmdFor(ctx, env, args)
	case "render":
		err = cmdRender(env, args)
	case "gate":
		return cmdGate(ctx, env, args)
	default:
		fmt.Fprintf(os.Stderr, "ctx: unknown command %q (try `ctx help`)\n", command)
		return exitUsage
	}
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitUsage
		}
		fmt.Fprintln(os.Stderr, "ctx:", err)
		return exitViolation
	}
	return exitOK
}

func cmdInit(ctx context.Context, env ctxcmd.Env, args []string) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	noPush := fs.Bool("no-push-spec", false, "leave remote.<name>.push alone")
	hooks := fs.Bool("hooks", false, "install the commit-msg hook that runs ctx gate")
	force := fs.Bool("force", false, "replace an existing commit-msg hook")
	if _, err := parseFlags(fs, args); err != nil {
		return err
	}
	log, err := ctxcmd.Init(ctx, env.Repo, ctxcmd.InitOptions{
		PushSpec: !*noPush, Hooks: *hooks, Force: *force,
	})
	for _, line := range log {
		fmt.Fprintln(env.Out, line)
	}
	return err
}

func cmdSupersede(ctx context.Context, env ctxcmd.Env, args []string) error {
	fs := flag.NewFlagSet("supersede", flag.ContinueOnError)
	reason := fs.String("reason", "", "why the prior decision no longer holds (required)")
	positional, err := parseFlags(fs, args)
	if err != nil {
		return err
	}
	if len(positional) != 1 {
		return errors.New("usage: ctx supersede <target-sha> -reason <text>")
	}
	out, err := ctxcmd.Supersede(ctx, env.Repo, positional[0], *reason)
	if err != nil {
		return err
	}
	fmt.Fprintln(env.Out, out)
	fmt.Fprint(env.Out, "\nThis empty commit is the document, not a cache write: push it and let it\n"+
		"pass normal PR review. refs/notes/decisions stays untouched until CI runs\n"+
		"`ctx reindex` over the merged history and pushes refs/notes/*.\n")
	return nil
}

func cmdReindex(ctx context.Context, env ctxcmd.Env) error {
	result, err := ctxcmd.Reindex(ctx, env.Repo)
	for _, warning := range result.Warnings {
		fmt.Fprintln(env.Err, "warn:", warning)
	}
	if err != nil {
		return err
	}
	fmt.Fprintf(env.Out, "reindex: %d superseding commit(s) -> %d entry(ies) in refs/notes/decisions\n",
		result.Commits, result.Entries)
	fmt.Fprintln(env.Out, "push with: git push <remote> refs/notes/decisions")
	return nil
}

func cmdFor(ctx context.Context, env ctxcmd.Env, args []string) error {
	fs := flag.NewFlagSet("for", flag.ContinueOnError)
	format := fs.String("format", "yaml", "output format: yaml or json")
	all := fs.Bool("all", false, "include orphaned decisions that declared no cost to undo")
	since := fs.String("since", "", "path to a baseline report JSON; print only what changed since it")
	positional, err := parseFlags(fs, args)
	if err != nil {
		return err
	}
	if len(positional) != 1 {
		return errors.New("usage: ctx for <path>[:<start>-<end>] [-format yaml|json] [-all] [-since <baseline.json>]")
	}
	if *format != "yaml" && *format != "json" {
		return fmt.Errorf("unknown format %q: want yaml or json", *format)
	}
	report := ctxcmd.Compile(ctx, env.Repo, positional[0], ctxcmd.CompileOpts{AllOrphaned: *all})
	return emit(env.Out, report, *since, *format)
}

// cmdRender re-renders a report the caller already has, from stdin JSON. It
// never touches git: the hook compiles a scope once for its own checks and
// pipes the result here rather than paying for a second blame.
func cmdRender(env ctxcmd.Env, args []string) error {
	fs := flag.NewFlagSet("render", flag.ContinueOnError)
	format := fs.String("format", "yaml", "output format: yaml or json")
	since := fs.String("since", "", "path to a baseline report JSON; print only what changed since it")
	if _, err := parseFlags(fs, args); err != nil {
		return err
	}
	if *format != "yaml" && *format != "json" {
		return fmt.Errorf("unknown format %q: want yaml or json", *format)
	}
	body, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}
	var report model.Report
	if err := json.Unmarshal(body, &report); err != nil {
		return fmt.Errorf("stdin is not a ctx report: %w", err)
	}
	return emit(env.Out, report, *since, *format)
}

// emit writes either the full report or, given a usable baseline, only what
// changed since it. Anything that stops a confident comparison — no baseline,
// an unreadable one, one taken of a different scope, or a report that could
// not be compiled at all — falls back to the full report: "I could not tell"
// must never look like "nothing changed".
func emit(w io.Writer, report model.Report, since, format string) error {
	if since != "" && report.Error == "" {
		if baseline, ok := readBaseline(since); ok && baseline.Scope == report.Scope {
			delta := render.DeltaOf(report, baseline)
			if format == "json" {
				return render.JSONDelta(w, delta)
			}
			return render.YAMLDelta(w, delta)
		}
	}
	if format == "json" {
		return render.JSON(w, report)
	}
	return render.YAML(w, report)
}

func cmdGate(ctx context.Context, env ctxcmd.Env, args []string) int {
	fs := flag.NewFlagSet("gate", flag.ContinueOnError)
	msgFile := fs.String("m", "", "commit message file to check (commit-msg hook: pass $1)")
	if _, err := parseFlags(fs, args); err != nil {
		return exitUsage
	}
	result, err := ctxcmd.Gate(ctx, env.Repo, *msgFile)
	if err != nil {
		fmt.Fprintln(env.Err, "ctx gate:", err)
		return exitViolation
	}
	if !result.OK() {
		fmt.Fprintf(env.Err, "ctx gate: FAIL (%s)\n", result.Source)
		for _, violation := range result.Violations {
			fmt.Fprintln(env.Err, "  - "+violation)
		}
		return exitViolation
	}
	fmt.Fprintf(env.Out, "ctx gate: OK (%s) — %d file(s), %d gated\n",
		result.Source, len(result.Files), len(result.Gated))
	return exitOK
}

// readBaseline loads a previously saved report to diff against.
func readBaseline(path string) (model.Report, bool) {
	body, err := os.ReadFile(path)
	if err != nil {
		return model.Report{}, false
	}
	var baseline model.Report
	if err := json.Unmarshal(body, &baseline); err != nil {
		return model.Report{}, false
	}
	return baseline, true
}

// parseFlags accepts flags before or after positional arguments, because
// `ctx supersede <sha> -reason ...` is the order everybody types.
func parseFlags(fs *flag.FlagSet, args []string) ([]string, error) {
	var positional []string
	for len(args) > 0 {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		if fs.NArg() == 0 {
			break
		}
		positional = append(positional, fs.Arg(0))
		args = fs.Args()[1:]
	}
	return positional, nil
}
