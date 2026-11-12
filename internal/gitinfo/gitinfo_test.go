package gitinfo

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestFindMainAndLinkedWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	base := t.TempDir()
	main := filepath.Join(base, "shop")
	if err := os.MkdirAll(filepath.Join(main, "apps", "web"), 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, main, "init", "-q")
	git(t, main, "commit", "-q", "--allow-empty", "-m", "init")
	wt := filepath.Join(base, "shop-feature")
	git(t, main, "worktree", "add", "-q", "-b", "feat/x", wt)

	l := NewLookup()
	r := l.Find(filepath.Join(main, "apps", "web"))
	if r == nil || r.Root != main || r.Worktree != main || r.WorktreeName != "" || r.Name() != "shop" {
		t.Fatalf("main checkout: %+v", r)
	}
	r = l.Find(wt)
	if r == nil {
		t.Fatal("linked worktree not found")
	}
	// Compare after resolving symlinks: TempDir may live behind one (macOS /var).
	gotRoot, _ := filepath.EvalSymlinks(r.Root)
	wantRoot, _ := filepath.EvalSymlinks(main)
	if gotRoot != wantRoot || r.WorktreeName != "shop-feature" || r.Name() != "shop" {
		t.Fatalf("linked worktree: %+v", r)
	}
	if b := r.Branch(); b != "feat/x" {
		t.Fatalf("linked worktree branch: %q", b)
	}
	// The branch is read on each call: a switch shows at once.
	git(t, wt, "switch", "-q", "-c", "feat/y")
	if b := l.Find(wt).Branch(); b != "feat/y" {
		t.Fatalf("branch after a switch: %q", b)
	}
	if b := l.Find(main).Branch(); b == "" || b == "feat/x" {
		t.Fatalf("main checkout branch: %q", b)
	}
	if l.Find(base) != nil && l.Find(base).Root == base {
		t.Fatalf("base is not a repository")
	}
}
