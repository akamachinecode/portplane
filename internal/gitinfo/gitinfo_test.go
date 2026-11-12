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
	// Compare after resolving symlinks: TempDir may live behind one (macOS
	// /var), or under a short name (Windows RUNNER~1), and Root never does.
	real := func(p string) string {
		r, err := filepath.EvalSymlinks(p)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	r := l.Find(filepath.Join(main, "apps", "web"))
	if r == nil || r.Root != real(main) || r.Worktree != main || r.WorktreeName != "" || r.Name() != "shop" {
		t.Fatalf("main checkout: %+v", r)
	}
	r = l.Find(wt)
	if r == nil {
		t.Fatal("linked worktree not found")
	}
	if r.Root != real(main) || r.WorktreeName != "shop-feature" || r.Name() != "shop" {
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

// Repositories reached through a symbolic link (macOS's /var, a ~/Repos that
// points elsewhere): git writes the worktree's gitdir with the real path, and
// both checkouts must still name the same Root.
func TestRootIsTheSameThroughASymlink(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	base := t.TempDir()
	realDir := filepath.Join(base, "real")
	if err := os.MkdirAll(filepath.Join(realDir, "shop"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(realDir, link); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	main := filepath.Join(link, "shop")
	git(t, main, "init", "-q")
	git(t, main, "commit", "-q", "--allow-empty", "-m", "init")
	wt := filepath.Join(link, "shop-feature")
	git(t, main, "worktree", "add", "-q", wt)

	l := NewLookup()
	a, b := l.Find(main), l.Find(wt)
	if a == nil || b == nil || a.Root != b.Root {
		t.Fatalf("main %+v and worktree %+v disagree on the repository", a, b)
	}
	if b.WorktreeName != "shop-feature" || b.Worktree != wt {
		t.Fatalf("worktree: %+v", b)
	}
}
