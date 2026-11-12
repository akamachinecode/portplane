package setup

import (
	"os"
	"path/filepath"
	"sort"
)

// Unsupported is a project setup found but cannot write tasks for yet: not
// JavaScript or TypeScript (ADR-0014 P3). The user adds it by hand.
type Unsupported struct {
	Project string   `json:"project"`
	Dir     string   `json:"dir"` // relative to the folder
	Kinds   []string `json:"kinds"`
}

// otherStacks are files that say what kind of project a folder is.
var otherStacks = []struct{ file, kind string }{
	{"manage.py", "Python"},
	{"pyproject.toml", "Python"},
	{"requirements.txt", "Python"},
	{"go.mod", "Go"},
	{"Gemfile", "Ruby"},
	{"composer.json", "PHP"},
	{"Cargo.toml", "Rust"},
	{"mix.exs", "Elixir"},
	{"docker-compose.yml", "Docker Compose"},
	{"docker-compose.yaml", "Docker Compose"},
	{"compose.yml", "Docker Compose"},
	{"compose.yaml", "Docker Compose"},
	{"Procfile", "Procfile"},
}

// OtherStacks names the kinds of project dir is, by its marker files.
func OtherStacks(dir string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range otherStacks {
		if _, err := os.Stat(filepath.Join(dir, s.file)); err == nil && !seen[s.kind] {
			seen[s.kind] = true
			out = append(out, s.kind)
		}
	}
	sort.Strings(out)
	return out
}
