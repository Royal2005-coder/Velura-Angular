package gitx_test

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"ctx/internal/gitx"
	"ctx/internal/testutil"
)

const (
	blameSHA1 = "1111111111111111111111111111111111111111"
	blameSHA2 = "2222222222222222222222222222222222222222"
	blameSHA3 = "3333333333333333333333333333333333333333"
	blameZero = "0000000000000000000000000000000000000000"
)

// porcelain builds a fake --line-porcelain body: one header line per entry,
// followed by a tab-indented content line, matching the shape git emits.
func porcelain(headers ...string) string {
	var b strings.Builder
	for _, h := range headers {
		b.WriteString(h)
		b.WriteString("\n\tsome line content\n")
	}
	return b.String()
}

func TestBlame(t *testing.T) {
	t.Run("keeps every line with its final line number", func(t *testing.T) {
		fr := &testutil.FakeRunner{Responses: map[string]string{
			"blame --line-porcelain -C HEAD -- foo.go": porcelain(
				blameSHA1+" 1 1 1",
				blameSHA2+" 4 2 1",
				blameSHA1+" 9 3 1",
			),
		}}
		got, err := gitx.New(fr).Blame(testutil.Ctx(), gitx.BlameOpts{Path: "foo.go"})
		if err != nil {
			t.Fatalf("Blame() error = %v", err)
		}
		want := []gitx.BlameLine{
			{SHA: blameSHA1, Line: 1},
			{SHA: blameSHA2, Line: 2},
			{SHA: blameSHA1, Line: 3},
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("Blame() = %#v, want %#v", got, want)
		}
	})

	t.Run("skips the not-yet-committed line", func(t *testing.T) {
		fr := &testutil.FakeRunner{Responses: map[string]string{
			"blame --line-porcelain -C HEAD -- foo.go": porcelain(
				blameZero+" 1 1 1",
				blameSHA1+" 2 2 1",
			),
		}}
		got, err := gitx.New(fr).Blame(testutil.Ctx(), gitx.BlameOpts{Path: "foo.go"})
		if err != nil {
			t.Fatalf("Blame() error = %v", err)
		}
		if len(got) != 1 || got[0].SHA != blameSHA1 {
			t.Fatalf("Blame() = %#v, want only the committed line", got)
		}
	})

	t.Run("propagates a runner error", func(t *testing.T) {
		want := errors.New("no such path")
		fr := &testutil.FakeRunner{Errors: map[string]error{
			"blame --line-porcelain -C HEAD -- foo.go": want,
		}}
		got, err := gitx.New(fr).Blame(testutil.Ctx(), gitx.BlameOpts{Path: "foo.go"})
		if !errors.Is(err, want) {
			t.Fatalf("Blame() error = %v, want %v", err, want)
		}
		if got != nil {
			t.Fatalf("Blame() lines = %#v, want nil", got)
		}
	})

	// The whole file is always blamed: a range is filtered from the result, so
	// one process serves both the ranged view and file-level ownership.
	t.Run("never passes -L", func(t *testing.T) {
		fr := &testutil.FakeRunner{Responses: map[string]string{
			"blame --line-porcelain -C HEAD -- foo.go": porcelain(blameSHA1 + " 1 1 1"),
		}}
		if _, err := gitx.New(fr).Blame(testutil.Ctx(), gitx.BlameOpts{Path: "foo.go"}); err != nil {
			t.Fatalf("Blame() error = %v", err)
		}
		if fr.Called("-L") {
			t.Fatalf("did not expect -L in call args, got %#v", fr.Calls)
		}
	})

	t.Run("passes --ignore-revs-file only when set", func(t *testing.T) {
		with := &testutil.FakeRunner{Responses: map[string]string{
			"blame --line-porcelain -C --ignore-revs-file /abs/.git-blame-ignore-revs HEAD -- foo.go": porcelain(blameSHA1 + " 1 1 1"),
		}}
		if _, err := gitx.New(with).Blame(testutil.Ctx(), gitx.BlameOpts{
			Path: "foo.go", IgnoreRevsFile: "/abs/.git-blame-ignore-revs",
		}); err != nil {
			t.Fatalf("Blame() error = %v", err)
		}
		if !with.Called("--ignore-revs-file /abs/.git-blame-ignore-revs") {
			t.Fatalf("expected --ignore-revs-file in call args, got %#v", with.Calls)
		}

		without := &testutil.FakeRunner{Responses: map[string]string{
			"blame --line-porcelain -C HEAD -- foo.go": porcelain(blameSHA1 + " 1 1 1"),
		}}
		if _, err := gitx.New(without).Blame(testutil.Ctx(), gitx.BlameOpts{Path: "foo.go"}); err != nil {
			t.Fatalf("Blame() error = %v", err)
		}
		if without.Called("--ignore-revs-file") {
			t.Fatalf("did not expect --ignore-revs-file in call args, got %#v", without.Calls)
		}
	})
}

func TestSHAsIn(t *testing.T) {
	lines := []gitx.BlameLine{
		{SHA: blameSHA1, Line: 1},
		{SHA: blameSHA2, Line: 2},
		{SHA: blameSHA1, Line: 3},
		{SHA: blameSHA3, Line: 4},
	}
	cases := []struct {
		name   string
		lo, hi int
		want   []string
	}{
		{"whole file, first-appearance order, deduped", 0, 0, []string{blameSHA1, blameSHA2, blameSHA3}},
		{"single line", 2, 2, []string{blameSHA2}},
		{"range spanning a repeat", 2, 4, []string{blameSHA2, blameSHA1, blameSHA3}},
		{"range past the end", 90, 99, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := gitx.SHAsIn(lines, tc.lo, tc.hi); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("SHAsIn(%d,%d) = %#v, want %#v", tc.lo, tc.hi, got, tc.want)
			}
		})
	}
}
