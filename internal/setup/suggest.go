package setup

import (
	"os"
	"path/filepath"
	"strings"
)

// SuggestedFolderNames are where people usually keep their projects.
var SuggestedFolderNames = []string{"code", "Repos", "src", "projects", "dev", "workspace", "Developer", "Projects", "repos", "git"}

// FolderSuggestion is a folder in the home that holds projects.
type FolderSuggestion struct {
	Path  string `json:"path"`
	Repos int    `json:"repos"` // git repositories in it, up to two levels down
}

// SuggestFolders lists the usual project folders that exist in home, with
// how many git repositories each holds. Folders without any are left out.
func SuggestFolders(home string) []FolderSuggestion {
	out := []FolderSuggestion{}
	seen := map[string]bool{}
	for _, name := range SuggestedFolderNames {
		dir := filepath.Join(home, name)
		fi, err := os.Stat(dir)
		if err != nil || !fi.IsDir() {
			continue
		}
		real, err := filepath.EvalSymlinks(dir)
		if err != nil {
			real = dir
		}
		key := strings.ToLower(real) // case-insensitive file systems list Projects and projects once
		if seen[key] {
			continue
		}
		seen[key] = true
		if n := CountRepos(dir); n > 0 {
			out = append(out, FolderSuggestion{Path: dir, Repos: n})
		}
	}
	return out
}

// CountRepos counts the git repositories in dir: dir itself, or its
// subfolders and theirs (two levels), not looking inside a repository.
func CountRepos(dir string) int {
	if isRepo(dir) {
		return 1
	}
	n := 0
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if !e.IsDir() || skipDirs[e.Name()] || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		sub := filepath.Join(dir, e.Name())
		if isRepo(sub) {
			n++
			continue
		}
		inner, _ := os.ReadDir(sub)
		for _, s := range inner {
			if s.IsDir() && !skipDirs[s.Name()] && !strings.HasPrefix(s.Name(), ".") && isRepo(filepath.Join(sub, s.Name())) {
				n++
			}
		}
	}
	return n
}

func isRepo(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}
