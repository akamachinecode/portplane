// Package gitinfo finds the git repository and worktree a folder belongs to,
// by reading .git directly (no git process per lookup).
package gitinfo

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Repo describes where a folder sits in git.
type Repo struct {
	// Root is the main checkout of the repository.
	Root string
	// Worktree is the checkout that contains the folder (equal to Root for
	// the main checkout).
	Worktree string
	// WorktreeName is empty for the main checkout, else the linked worktree's
	// folder name.
	WorktreeName string
	// GitDir is the checkout's own git directory (<root>/.git for the main
	// checkout, <root>/.git/worktrees/<name> for a linked one), where HEAD
	// lives. Empty when it could not be told.
	GitDir string
}

// Name is the repository's display name: its main checkout's folder name.
func (r Repo) Name() string { return filepath.Base(r.Root) }

// Lookup caches results per directory; safe for concurrent use.
type Lookup struct {
	mu    sync.Mutex
	cache map[string]*Repo
}

// NewLookup returns an empty cache.
func NewLookup() *Lookup { return &Lookup{cache: map[string]*Repo{}} }

// Find returns the repository that contains dir, or nil when dir is not in one.
func (l *Lookup) Find(dir string) *Repo {
	if dir == "" {
		return nil
	}
	dir = filepath.Clean(dir)
	l.mu.Lock()
	r, ok := l.cache[dir]
	l.mu.Unlock()
	if ok {
		return r
	}
	r = find(dir)
	l.mu.Lock()
	l.cache[dir] = r
	l.mu.Unlock()
	return r
}

func find(dir string) *Repo {
	for d := dir; ; {
		gitPath := filepath.Join(d, ".git")
		if fi, err := os.Stat(gitPath); err == nil {
			if fi.IsDir() {
				return &Repo{Root: d, Worktree: d, GitDir: gitPath}
			}
			if r := fromGitFile(d, gitPath); r != nil {
				return r
			}
			return &Repo{Root: d, Worktree: d}
		}
		parent := filepath.Dir(d)
		if parent == d {
			return nil
		}
		d = parent
	}
}

// fromGitFile resolves a linked worktree: its .git file says
// "gitdir: <main>/.git/worktrees/<name>", and that directory's commondir
// points back at <main>/.git.
func fromGitFile(worktree, gitFile string) *Repo {
	b, err := os.ReadFile(gitFile)
	if err != nil {
		return nil
	}
	line := strings.TrimSpace(string(b))
	gitdir, ok := strings.CutPrefix(line, "gitdir:")
	if !ok {
		return nil
	}
	gitdir = strings.TrimSpace(gitdir)
	if !filepath.IsAbs(gitdir) {
		gitdir = filepath.Join(worktree, gitdir)
	}
	c, err := os.ReadFile(filepath.Join(gitdir, "commondir"))
	if err != nil {
		// No commondir: a submodule (gitdir under .git/modules), not a linked
		// worktree. It is its own repository.
		return &Repo{Root: worktree, Worktree: worktree, GitDir: gitdir}
	}
	common := strings.TrimSpace(string(c))
	if !filepath.IsAbs(common) {
		common = filepath.Join(gitdir, common)
	}
	common = filepath.Clean(common)
	// common is <main>/.git for a normal repository; a submodule's gitdir
	// lives under .git/modules and has no commondir: treat it as its own repo.
	if filepath.Base(common) != ".git" {
		return &Repo{Root: worktree, Worktree: worktree, GitDir: gitdir}
	}
	root := filepath.Dir(common)
	if root == worktree {
		return &Repo{Root: root, Worktree: worktree, GitDir: gitdir}
	}
	return &Repo{Root: root, Worktree: worktree, WorktreeName: filepath.Base(worktree), GitDir: gitdir}
}

// Branch is the branch the checkout has out now, read from its HEAD on every
// call (it changes with git switch, so it is never cached). A detached HEAD
// gives the commit's first seven characters; an unreadable one gives "".
func (r *Repo) Branch() string {
	if r == nil || r.GitDir == "" {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(r.GitDir, "HEAD"))
	if err != nil {
		return ""
	}
	head := strings.TrimSpace(string(b))
	if ref, ok := strings.CutPrefix(head, "ref:"); ok {
		ref = strings.TrimSpace(ref)
		if name, ok := strings.CutPrefix(ref, "refs/heads/"); ok {
			return name
		}
		return ref
	}
	if len(head) >= 7 && isHex(head) {
		return head[:7]
	}
	return ""
}

func isHex(s string) bool {
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
