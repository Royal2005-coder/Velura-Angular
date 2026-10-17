package render

import (
	"strconv"
	"strings"
	"testing"

	"ctx/internal/model"
)

func TestScalar(t *testing.T) {
	t.Run("plain text stays unquoted", func(t *testing.T) {
		cases := []string{"hello world", "use option A", "abc", "a.b.c-not-a-number"}
		for _, s := range cases {
			if got := scalar(s); got != s {
				t.Errorf("scalar(%q) = %q, want unquoted %q", s, got, s)
			}
		}
	})

	t.Run("unsafe runes force quoting", func(t *testing.T) {
		for _, r := range unsafeRunes {
			s := "a" + string(r) + "b"
			want := strconv.Quote(s)
			if got := scalar(s); got != want {
				t.Errorf("scalar(%q) = %q, want %q", s, got, want)
			}
		}
	})

	t.Run("leading dash gets quoted", func(t *testing.T) {
		s := "-foo"
		want := strconv.Quote(s)
		if got := scalar(s); got != want {
			t.Errorf("scalar(%q) = %q, want %q", s, got, want)
		}
	})

	t.Run("reserved YAML literals are quoted", func(t *testing.T) {
		cases := []string{
			"null", "Null", "NULL",
			"~",
			"true", "True", "TRUE",
			"false", "False", "FALSE",
			"yes", "Yes", "YES",
			"no", "No", "NO",
			"on", "On", "ON",
			"off", "Off", "OFF",
			"nan", "NaN", "NAN",
			"123", "-123", "+123",
			"1.5", "-1.5",
			"2026-01-01",
			"2026-01-01T00:00:00Z",
		}
		for _, s := range cases {
			want := strconv.Quote(s)
			if got := scalar(s); got != want {
				t.Errorf("scalar(%q) = %q, want %q (reserved literal must be quoted)", s, got, want)
			}
		}
	})

	t.Run("empty and whitespace-only input renders as empty string", func(t *testing.T) {
		for _, s := range []string{"", "   ", "\t", "\n", "  \t \n "} {
			if got := scalar(s); got != `""` {
				t.Errorf("scalar(%q) = %q, want %q", s, got, `""`)
			}
		}
	})
}

// sha40 returns a deterministic 40-hex-char SHA using fill as the repeated
// character, so tests read as "sha1", "sha2" rather than opaque hex blobs.
func sha40(fill byte) string {
	return strings.Repeat(string(fill), 40)
}

func TestYAMLEmptyReport(t *testing.T) {
	var b strings.Builder
	if err := YAML(&b, model.Report{}); err != nil {
		t.Fatalf("YAML() error = %v", err)
	}
	want := "scope: \"\"\n" +
		"active: []\n" +
		"superseded: []\n" +
		"orphaned: []\n" +
		"open_incidents: []\n"
	if b.String() != want {
		t.Fatalf("YAML() =\n%q\nwant\n%q", b.String(), want)
	}
}

func TestYAMLActiveRecordRejectedIsBlockSequence(t *testing.T) {
	sha := sha40('1')
	report := model.Report{
		Scope: "pkg/foo",
		Active: []model.Record{{
			Decision: model.Decision{
				SHA:        sha,
				Decision:   "use X",
				Rejected:   []string{"opt A", "opt B"},
				Reversible: model.TierTrue,
				Oracle:     model.OracleTest,
			},
		}},
	}
	var b strings.Builder
	if err := YAML(&b, report); err != nil {
		t.Fatalf("YAML() error = %v", err)
	}
	want := "scope: pkg/foo\n" +
		"active:\n" +
		"  - sha: " + Short(sha) + "\n" +
		"    decision: use X\n" +
		"    rejected:\n" +
		"      - opt A\n" +
		"      - opt B\n" +
		"    reversible: \"true\"\n" +
		"    oracle: test\n" +
		"superseded: []\n" +
		"orphaned: []\n" +
		"open_incidents: []\n"
	if b.String() != want {
		t.Fatalf("YAML() =\n%s\nwant\n%s", b.String(), want)
	}
}

func TestYAMLSupersededRecordRejectedIsFlowSequence(t *testing.T) {
	shaOld := sha40('1')
	shaNew := sha40('2')
	report := model.Report{
		Superseded: []model.Record{{
			Decision: model.Decision{
				SHA:      shaOld,
				Decision: "use Y",
				Rejected: []string{"r1", "r2"},
			},
			SupersededBy: []model.Supersession{{By: shaNew}},
		}},
	}
	var b strings.Builder
	if err := YAML(&b, report); err != nil {
		t.Fatalf("YAML() error = %v", err)
	}
	want := "scope: \"\"\n" +
		"active: []\n" +
		"superseded:\n" +
		"  - sha: " + Short(shaOld) + " -> by " + Short(shaNew) + "\n" +
		"    decision: use Y\n" +
		"    rejected: [\"r1\", \"r2\"]\n" +
		"orphaned: []\n" +
		"open_incidents: []\n"
	if b.String() != want {
		t.Fatalf("YAML() =\n%s\nwant\n%s", b.String(), want)
	}
}

func TestYAMLTwoSupersessionsJoinByAndReasons(t *testing.T) {
	shaOld := sha40('1')
	shaY := sha40('2')
	shaZ := sha40('3')
	report := model.Report{
		Superseded: []model.Record{{
			Decision: model.Decision{SHA: shaOld, Decision: "use Y"},
			SupersededBy: []model.Supersession{
				{By: shaY, Reason: "r1"},
				{By: shaZ, Reason: "r2"},
			},
		}},
	}
	var b strings.Builder
	if err := YAML(&b, report); err != nil {
		t.Fatalf("YAML() error = %v", err)
	}
	want := "scope: \"\"\n" +
		"active: []\n" +
		"superseded:\n" +
		"  - sha: " + Short(shaOld) + " -> by " + Short(shaY) + ", " + Short(shaZ) + "\n" +
		"    decision: use Y\n" +
		"    reason: [\"r1\", \"r2\"]\n" +
		"orphaned: []\n" +
		"open_incidents: []\n"
	if b.String() != want {
		t.Fatalf("YAML() =\n%s\nwant\n%s", b.String(), want)
	}
}

func TestYAMLOneSupersessionReasonIsPlainScalar(t *testing.T) {
	shaOld := sha40('1')
	shaY := sha40('2')
	report := model.Report{
		Superseded: []model.Record{{
			Decision:     model.Decision{SHA: shaOld, Decision: "use Y"},
			SupersededBy: []model.Supersession{{By: shaY, Reason: "single reason"}},
		}},
	}
	var b strings.Builder
	if err := YAML(&b, report); err != nil {
		t.Fatalf("YAML() error = %v", err)
	}
	want := "scope: \"\"\n" +
		"active: []\n" +
		"superseded:\n" +
		"  - sha: " + Short(shaOld) + " -> by " + Short(shaY) + "\n" +
		"    decision: use Y\n" +
		"    reason: single reason\n" +
		"orphaned: []\n" +
		"open_incidents: []\n"
	if b.String() != want {
		t.Fatalf("YAML() =\n%s\nwant\n%s", b.String(), want)
	}
}

func TestYAMLRunsFlowListAndNoneIncident(t *testing.T) {
	sha := sha40('1')
	report := model.Report{
		Active: []model.Record{{
			Decision: model.Decision{SHA: sha, Decision: "use X"},
			Runs: []model.Run{
				{At: "2026-01-01", Status: "pass", Incident: "INC-1"},
				{At: "2026-01-02", Status: "fail"},
			},
		}},
	}
	var b strings.Builder
	if err := YAML(&b, report); err != nil {
		t.Fatalf("YAML() error = %v", err)
	}
	want := "scope: \"\"\n" +
		"active:\n" +
		"  - sha: " + Short(sha) + "\n" +
		"    decision: use X\n" +
		"    runs: [\"2026-01-01 pass -> INC-1\", \"2026-01-02 fail -> none\"]\n" +
		"superseded: []\n" +
		"orphaned: []\n" +
		"open_incidents: []\n"
	if b.String() != want {
		t.Fatalf("YAML() =\n%s\nwant\n%s", b.String(), want)
	}
}

func TestYAMLWarningsBeforeScope(t *testing.T) {
	report := model.Report{Warnings: []string{"w1", "w2"}, Scope: "s"}
	var b strings.Builder
	if err := YAML(&b, report); err != nil {
		t.Fatalf("YAML() error = %v", err)
	}
	want := "warning: w1\n" +
		"warning: w2\n" +
		"scope: s\n" +
		"active: []\n" +
		"superseded: []\n" +
		"orphaned: []\n" +
		"open_incidents: []\n"
	if b.String() != want {
		t.Fatalf("YAML() =\n%s\nwant\n%s", b.String(), want)
	}
}

func TestYAMLErrorEmittedLast(t *testing.T) {
	report := model.Report{Scope: "s", Error: "boom"}
	var b strings.Builder
	if err := YAML(&b, report); err != nil {
		t.Fatalf("YAML() error = %v", err)
	}
	want := "scope: s\n" +
		"active: []\n" +
		"superseded: []\n" +
		"orphaned: []\n" +
		"open_incidents: []\n" +
		"error: boom\n"
	if b.String() != want {
		t.Fatalf("YAML() =\n%s\nwant\n%s", b.String(), want)
	}
}

func TestYAMLOpenIncidents(t *testing.T) {
	report := model.Report{
		OpenIncidents: []model.OpenIncident{
			{SHA: sha40('1'), Summary: "db down"},
		},
	}
	var b strings.Builder
	if err := YAML(&b, report); err != nil {
		t.Fatalf("YAML() error = %v", err)
	}
	want := "scope: \"\"\n" +
		"active: []\n" +
		"superseded: []\n" +
		"orphaned: []\n" +
		"open_incidents:\n" +
		"  - " + Short(sha40('1')) + ": db down\n"
	if b.String() != want {
		t.Fatalf("YAML() =\n%s\nwant\n%s", b.String(), want)
	}
}

// TestYAMLHostileStringsRoundTrip is the strongest assertion in this file: for
// a set of decisions chosen to look like YAML syntax (reserved literals,
// mapping/comment/quote-triggering characters, and non-ASCII text), the
// emitted "decision:" value must be exactly recoverable. Rather than pulling
// in a YAML library, this decodes the double-quoted form the same way any
// YAML 1.1 parser would have to: Go's escaping and YAML's double-quoted
// scalar escaping agree on this input, so strconv.Unquote is a faithful
// round-trip check, and a plain (unquoted) scalar must equal the original
// input exactly.
func TestYAMLHostileStringsRoundTrip(t *testing.T) {
	cases := []struct {
		decision  string
		wantQuote bool
	}{
		{"null", true},
		{"true", true},
		{"has: colon", true},
		{"with # hash", true},
		{`embedded "quote"`, true},
		{"unicode ключ 日本語", false},
		{"plain decision text", false},
	}

	var records []model.Record
	for i, c := range cases {
		records = append(records, model.Record{
			Decision: model.Decision{SHA: sha40(byte('a' + i)), Decision: c.decision},
		})
	}
	report := model.Report{Active: records}

	var b strings.Builder
	if err := YAML(&b, report); err != nil {
		t.Fatalf("YAML() error = %v", err)
	}

	var decisionLines []string
	for _, line := range strings.Split(b.String(), "\n") {
		if strings.HasPrefix(line, "    decision: ") {
			decisionLines = append(decisionLines, strings.TrimPrefix(line, "    decision: "))
		}
	}
	if len(decisionLines) != len(cases) {
		t.Fatalf("got %d decision lines, want %d:\n%s", len(decisionLines), len(cases), b.String())
	}

	for i, c := range cases {
		emitted := decisionLines[i]
		isQuoted := strings.HasPrefix(emitted, `"`) && strings.HasSuffix(emitted, `"`)
		if isQuoted != c.wantQuote {
			t.Errorf("decision %q: emitted %q, quoted=%v want quoted=%v", c.decision, emitted, isQuoted, c.wantQuote)
			continue
		}
		if isQuoted {
			got, err := strconv.Unquote(emitted)
			if err != nil {
				t.Errorf("decision %q: emitted %q does not unquote: %v", c.decision, emitted, err)
				continue
			}
			if got != c.decision {
				t.Errorf("decision %q: round-tripped to %q", c.decision, got)
			}
		} else if emitted != c.decision {
			t.Errorf("decision %q: emitted unquoted as %q", c.decision, emitted)
		}
	}
}
