package appicon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>`

// a 1x1 PNG
var png = []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 'I', 'H', 'D', 'R', 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89}

func write(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestFindPrefersTheAppsOwnIconThenWalksUpToTheCheckout(t *testing.T) {
	repo := t.TempDir()
	web := filepath.Join(repo, "apps", "web")
	api := filepath.Join(repo, "apps", "api")
	write(t, filepath.Join(web, "public", "favicon.ico"), []byte{0, 0, 1, 0, 1, 0})
	write(t, filepath.Join(web, "app", "icon.svg"), []byte(svg))
	write(t, filepath.Join(repo, ".portplane", "icon.svg"), []byte(svg))
	if err := os.MkdirAll(api, 0o755); err != nil {
		t.Fatal(err)
	}

	img, ok := Find(web, repo)
	if !ok || img.Path != filepath.Join(web, "app", "icon.svg") || img.Mime != "image/svg+xml" {
		t.Fatalf("web: %v %+v, want its app/icon.svg (SVG before ICO)", ok, img.Path)
	}
	img, ok = Find(api, repo)
	if !ok || img.Path != filepath.Join(repo, ".portplane", "icon.svg") {
		t.Fatalf("api: %v %q, want the repository's .portplane/icon.svg", ok, img.Path)
	}
	if _, ok := Find(t.TempDir(), ""); ok {
		t.Fatal("an empty folder has no icon")
	}
}

func TestFindNeverLeavesTheCheckout(t *testing.T) {
	outer := t.TempDir()
	write(t, filepath.Join(outer, "favicon.svg"), []byte(svg))
	repo := filepath.Join(outer, "repo")
	dir := filepath.Join(repo, "web")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if img, ok := Find(dir, repo); ok {
		t.Fatalf("found %s above the checkout", img.Path)
	}
	// a folder outside its root is searched alone
	if _, ok := Find(outer, repo); !ok {
		t.Fatal("the folder itself is always searched")
	}
}

func TestReadRefusesWhatIsNotAnIcon(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "fake.png"), []byte("not a png"))
	write(t, filepath.Join(dir, "fake.svg"), []byte("hello"))
	write(t, filepath.Join(dir, "notes.txt"), []byte(svg))
	write(t, filepath.Join(dir, "big.svg"), []byte("<svg>"+strings.Repeat(" ", MaxSize)+"</svg>"))
	write(t, filepath.Join(dir, "ok.png"), png)
	for _, name := range []string{"fake.png", "fake.svg", "notes.txt", "big.svg"} {
		if _, err := Read(filepath.Join(dir, name)); err == nil {
			t.Errorf("%s was read as an icon", name)
		}
	}
	if _, err := Read("relative/icon.svg"); err == nil {
		t.Error("a relative path was accepted")
	}
	if img, err := Read(filepath.Join(dir, "ok.png")); err != nil || img.Mime != "image/png" {
		t.Errorf("ok.png: %v %q", err, img.Mime)
	}
}

func TestCandidatesSkipDependenciesAndRankKnownPlacesFirst(t *testing.T) {
	repo := t.TempDir()
	write(t, filepath.Join(repo, "node_modules", "pkg", "logo.svg"), []byte(svg))
	write(t, filepath.Join(repo, "docs", "brand-mark.svg"), []byte(svg))
	write(t, filepath.Join(repo, "public", "favicon.svg"), []byte(svg))
	write(t, filepath.Join(repo, "public", "photo.png"), png)
	got := Candidates(repo, 10)
	var paths []string
	for _, c := range got {
		rel, _ := filepath.Rel(repo, c.Path)
		paths = append(paths, filepath.ToSlash(rel))
	}
	want := []string{"public/favicon.svg", "docs/brand-mark.svg"}
	if strings.Join(paths, ",") != strings.Join(want, ",") {
		t.Fatalf("candidates %v, want %v", paths, want)
	}
	if len(Candidates(repo, 1)) != 1 {
		t.Fatal("the limit is ignored")
	}
}
