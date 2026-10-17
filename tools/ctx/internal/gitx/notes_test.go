package gitx_test

import (
	"reflect"
	"testing"

	"ctx/internal/gitx"
)

func TestFields(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want map[string]string
	}{
		{
			name: "documented k: v | k: v form",
			in:   "who: alice | at: 2026-01-01 | summary: did stuff",
			want: map[string]string{"who": "alice", "at": "2026-01-01", "summary": "did stuff"},
		},
		{
			name: "value containing a literal pipe is not truncated",
			in:   "summary: a | see b",
			want: map[string]string{"summary": "a | see b"},
		},
		{
			name: "timestamp value containing colons",
			in:   "at: 2026-01-01T00:00:00Z",
			want: map[string]string{"at": "2026-01-01T00:00:00Z"},
		},
		{
			name: "segment with no colon and no prior key is dropped",
			in:   "just some text with no colon",
			want: map[string]string{},
		},
		{
			name: "key containing a space is a continuation, not a key",
			in:   "who: alice | foo bar: baz",
			want: map[string]string{"who": "alice | foo bar: baz"},
		},
		{
			name: "empty string",
			in:   "",
			want: map[string]string{},
		},
		{
			name: "leading and trailing whitespace is trimmed",
			in:   "  who : alice  ",
			want: map[string]string{"who": "alice"},
		},
		{
			name: "uppercase keys normalise to lowercase",
			in:   "WHO: Alice",
			want: map[string]string{"who": "Alice"},
		},
		{
			name: "repeated keys: last one wins (single-value map)",
			in:   "who: alice | who: bob",
			want: map[string]string{"who": "bob"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := gitx.Fields(tc.in)
			if got == nil {
				t.Fatal("Fields() = nil, want a non-nil map")
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Fields(%q) = %#v, want %#v", tc.in, got, tc.want)
			}
		})
	}
}
