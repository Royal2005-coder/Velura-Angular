package render

import (
	"encoding/json"
	"strings"
	"testing"

	"ctx/internal/model"
)

func TestJSONNilSlicesMarshalAsEmptyArrays(t *testing.T) {
	var b strings.Builder
	if err := JSON(&b, model.Report{}); err != nil {
		t.Fatalf("JSON() error = %v", err)
	}
	want := "{\n" +
		"  \"scope\": \"\",\n" +
		"  \"active\": [],\n" +
		"  \"superseded\": [],\n" +
		"  \"orphaned\": [],\n  \"open_incidents\": []\n" +
		"}\n"
	if b.String() != want {
		t.Fatalf("JSON() =\n%s\nwant\n%s", b.String(), want)
	}
}

func TestJSONSchemaKeys(t *testing.T) {
	var b strings.Builder
	report := model.Report{
		Scope:  "pkg/foo",
		Active: []model.Record{{Decision: model.Decision{SHA: strings.Repeat("a", 40), Decision: "x"}}},
	}
	if err := JSON(&b, report); err != nil {
		t.Fatalf("JSON() error = %v", err)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(b.String()), &raw); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, b.String())
	}
	for _, key := range []string{"scope", "active", "superseded", "open_incidents"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("missing top-level key %q in output:\n%s", key, b.String())
		}
	}
}

func TestJSONPreservesFullSHA(t *testing.T) {
	sha := strings.Repeat("f", 40)
	report := model.Report{
		Active: []model.Record{{Decision: model.Decision{SHA: sha, Decision: "x"}}},
	}
	var b strings.Builder
	if err := JSON(&b, report); err != nil {
		t.Fatalf("JSON() error = %v", err)
	}

	var decoded model.Report
	if err := json.Unmarshal([]byte(b.String()), &decoded); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if len(decoded.Active) != 1 || decoded.Active[0].SHA != sha {
		t.Fatalf("decoded active = %#v, want SHA %q", decoded.Active, sha)
	}
	if !strings.Contains(b.String(), sha) {
		t.Fatalf("output does not contain full 40-char SHA %q:\n%s", sha, b.String())
	}
}

func TestJSONHTMLEscapingIsOff(t *testing.T) {
	report := model.Report{
		Active: []model.Record{{Decision: model.Decision{
			SHA:      strings.Repeat("a", 40),
			Decision: "a < b & c",
		}}},
	}
	var b strings.Builder
	if err := JSON(&b, report); err != nil {
		t.Fatalf("JSON() error = %v", err)
	}
	if !strings.Contains(b.String(), "a < b & c") {
		t.Fatalf("expected literal '<' and '&' to survive unescaped, got:\n%s", b.String())
	}
	if strings.Contains(b.String(), `\u003c`) || strings.Contains(b.String(), `\u0026`) {
		t.Fatalf("output was HTML-escaped, want raw characters:\n%s", b.String())
	}
}

func TestJSONEndsWithNewline(t *testing.T) {
	var b strings.Builder
	if err := JSON(&b, model.Report{}); err != nil {
		t.Fatalf("JSON() error = %v", err)
	}
	out := b.String()
	if !strings.HasSuffix(out, "\n") {
		t.Fatalf("output does not end with a newline: %q", out)
	}
	if strings.HasSuffix(strings.TrimSuffix(out, "\n"), "\n") {
		t.Fatalf("output ends with more than one newline: %q", out)
	}
}
