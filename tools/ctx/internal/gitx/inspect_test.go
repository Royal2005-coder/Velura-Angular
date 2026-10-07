package gitx_test

import (
	"reflect"
	"testing"

	"ctx/internal/testutil"
)

func TestIsDir(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("app/nested/a.ts", "export const a = 1;\n")
	r.Write("top.txt", "x\n")
	r.Commit("seed")

	cases := map[string]bool{
		"app":             true,
		"app/nested":      true,
		"":                true, // the repository root
		"top.txt":         false,
		"app/missing":     false,
		"app/nested/a.ts": false,
	}
	for path, want := range cases {
		if got := r.IsDir(testutil.Ctx(), path); got != want {
			t.Errorf("IsDir(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestFiles(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("app/b.ts", "b\n")
	r.Write("app/nested/a.ts", "a\n")
	r.Write("app/odd name.ts", "o\n")
	r.Write("elsewhere.ts", "e\n")
	r.Commit("seed")

	got := r.Files(testutil.Ctx(), "app")
	want := []string{"app/b.ts", "app/nested/a.ts", "app/odd name.ts"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Files(app) = %v, want %v", got, want)
	}
	if all := r.Files(testutil.Ctx(), ""); len(all) != 4 {
		t.Fatalf("Files(root) = %v, want all four files", all)
	}
	if none := r.Files(testutil.Ctx(), "nope"); len(none) != 0 {
		t.Fatalf("Files(nope) = %v, want none", none)
	}
}

func TestTreeDecisionsSpansEveryFileBeneathTheDirectory(t *testing.T) {
	r := testutil.NewRepo(t)
	r.Write("app/a.ts", "a\n")
	a := r.Commit("a", "Decision:a")
	r.Write("app/sub/b.ts", "b\n")
	b := r.Commit("b", "Decision:b")
	r.Write("other/c.ts", "c\n")
	r.Commit("c", "Decision:c")

	got := r.TreeDecisions(testutil.Ctx(), "app")
	want := []string{b, a} // newest first
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("TreeDecisions(app) = %v, want %v", got, want)
	}
}
