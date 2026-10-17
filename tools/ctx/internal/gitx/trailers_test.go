package gitx_test

import (
	"errors"
	"reflect"
	"testing"

	"ctx/internal/gitx"
	"ctx/internal/testutil"
)

const trailersKey = "interpret-trailers --parse"

func TestParseTrailers(t *testing.T) {
	t.Run("repeated keys accumulate in order, lowercase, trimmed", func(t *testing.T) {
		fr := &testutil.FakeRunner{Responses: map[string]string{
			trailersKey: "Rejected: option A\nRejected:   option B  \nReversible: true\n",
		}}
		repo := gitx.New(fr)

		got := repo.ParseTrailers(testutil.Ctx(), "irrelevant message")
		want := gitx.Trailers{
			"rejected":   {"option A", "option B"},
			"reversible": {"true"},
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("ParseTrailers() = %#v, want %#v", got, want)
		}
	})

	t.Run("uppercase keys normalise to lowercase", func(t *testing.T) {
		fr := &testutil.FakeRunner{Responses: map[string]string{
			trailersKey: "REVIEWED-BY: alice",
		}}
		repo := gitx.New(fr)

		got := repo.ParseTrailers(testutil.Ctx(), "msg")
		want := gitx.Trailers{"reviewed-by": {"alice"}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("ParseTrailers() = %#v, want %#v", got, want)
		}
	})

	t.Run("runner error yields an empty, non-nil map", func(t *testing.T) {
		fr := &testutil.FakeRunner{Errors: map[string]error{
			trailersKey: errors.New("boom"),
		}}
		repo := gitx.New(fr)

		got := repo.ParseTrailers(testutil.Ctx(), "msg")
		if got == nil {
			t.Fatal("ParseTrailers() = nil, want non-nil empty map")
		}
		if len(got) != 0 {
			t.Fatalf("ParseTrailers() = %#v, want empty", got)
		}
	})

	t.Run("timestamp value containing colons survives intact", func(t *testing.T) {
		fr := &testutil.FakeRunner{Responses: map[string]string{
			trailersKey: "At: 2026-01-01T00:00:00Z",
		}}
		repo := gitx.New(fr)

		got := repo.ParseTrailers(testutil.Ctx(), "msg")
		want := gitx.Trailers{"at": {"2026-01-01T00:00:00Z"}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("ParseTrailers() = %#v, want %#v", got, want)
		}
	})
}

func TestTrailersFirst(t *testing.T) {
	trailers := gitx.Trailers{"rejected": {"a", "b"}}

	if got := trailers.First("rejected"); got != "a" {
		t.Fatalf("First(rejected) = %q, want %q", got, "a")
	}
	if got := trailers.First("missing"); got != "" {
		t.Fatalf("First(missing) = %q, want empty", got)
	}
}

func TestTrailersHas(t *testing.T) {
	cases := []struct {
		name     string
		trailers gitx.Trailers
		key      string
		want     bool
	}{
		{"present with content", gitx.Trailers{"foo": {"bar"}}, "foo", true},
		{"whitespace-only value is not present", gitx.Trailers{"foo": {"   "}}, "foo", false},
		{"missing key", gitx.Trailers{}, "foo", false},
		{"empty value", gitx.Trailers{"foo": {""}}, "foo", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.trailers.Has(tc.key); got != tc.want {
				t.Fatalf("Has(%q) = %v, want %v", tc.key, got, tc.want)
			}
		})
	}
}
