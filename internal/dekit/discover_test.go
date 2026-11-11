package dekit

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func touch(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("tasks: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestDiscover(t *testing.T) {
	base := t.TempDir()
	touch(t, filepath.Join(base, "repos", "dekit.yaml"))
	touch(t, filepath.Join(base, "repos", "shop", "dekit.yaml"))
	touch(t, filepath.Join(base, "repos", "shop", "node_modules", "x", "dekit.yaml"))
	touch(t, filepath.Join(base, "repos", "a", "b", "c", "d", "dekit.yaml")) // too deep
	if err := os.MkdirAll(filepath.Join(base, "repos", "blog", "src"), 0o755); err != nil {
		t.Fatal(err)
	}

	got := Discover([]string{filepath.Join(base, "repos")})
	want := []Project{{Root: filepath.Join(base, "repos")}, {Root: filepath.Join(base, "repos", "shop")}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}

	// A folder without dekit.yaml uses the nearest one above, filtered.
	blog := filepath.Join(base, "repos", "blog")
	got = Discover([]string{blog})
	if len(got) != 1 || got[0].Root != filepath.Join(base, "repos") || len(got[0].Within) != 1 || got[0].Within[0] != blog {
		t.Fatalf("got %+v", got)
	}

	// The same root chosen directly too: unfiltered wins.
	got = Discover([]string{blog, filepath.Join(base, "repos")})
	if got[0].Within != nil {
		t.Fatalf("unfiltered should win: %+v", got)
	}

	// Two folders inside the same project: both stay visible.
	shopDocs := filepath.Join(base, "repos", "docs")
	if err := os.MkdirAll(shopDocs, 0o755); err != nil {
		t.Fatal(err)
	}
	got = Discover([]string{blog, shopDocs})
	if len(got) != 1 || len(got[0].Within) != 2 || !got[0].Shows(filepath.Join(shopDocs, "x")) || !got[0].Shows(blog) || got[0].Shows(filepath.Join(base, "repos", "other")) {
		t.Fatalf("union of folders: %+v", got)
	}
}

func TestInside(t *testing.T) {
	sep := string(filepath.Separator)
	root := sep + filepath.Join("a", "b")
	cases := map[string]bool{
		root:                                true,
		filepath.Join(root, "c"):            true,
		sep + filepath.Join("a", "bc"):      false,
		sep + "a":                           false,
		filepath.Join(root, "..", "b", "x"): true,
	}
	for p, want := range cases {
		if got := Inside(filepath.Clean(p), root); got != want {
			t.Errorf("Inside(%q, %q) = %v", p, root, got)
		}
	}
}
