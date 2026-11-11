package dekit

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Project is a dekit project Portplane watches.
type Project struct {
	Root string // folder that holds dekit.yaml
	// Within, when set, limits the view to tasks whose folder is inside it:
	// the user chose a folder that has no dekit.yaml of its own but sits
	// inside a project.
	Within string
}

// skipDirs are never searched for dekit.yaml.
var skipDirs = map[string]bool{"node_modules": true, ".git": true, "dist": true, "build": true, "vendor": true, "target": true, ".next": true, ".turbo": true, ".cache": true}

// maxDepth is how deep below a chosen folder dekit.yaml files are looked for.
const maxDepth = 3

// Discover finds the dekit projects for the chosen folders. Each folder
// contributes the dekit.yaml files at its root and up to three levels below,
// or, when it has none, the nearest dekit.yaml above it.
func Discover(folders []string) []Project {
	seen := map[string]int{}
	var out []Project
	add := func(p Project) {
		if i, ok := seen[p.Root]; ok {
			if p.Within == "" {
				out[i].Within = ""
			}
			return
		}
		seen[p.Root] = len(out)
		out = append(out, p)
	}
	for _, f := range folders {
		f = filepath.Clean(f)
		found := findBelow(f)
		for _, r := range found {
			add(Project{Root: r})
		}
		if len(found) > 0 {
			continue
		}
		if up := findAbove(filepath.Dir(f)); up != "" {
			add(Project{Root: up, Within: f})
		}
	}
	return out
}

func findBelow(folder string) []string {
	var roots []string
	base := strings.Count(folder, string(filepath.Separator))
	_ = filepath.WalkDir(folder, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == folder {
				return err
			}
			return filepath.SkipDir
		}
		if !d.IsDir() {
			return nil
		}
		if p != folder {
			name := d.Name()
			if skipDirs[name] || strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}
			if strings.Count(p, string(filepath.Separator))-base > maxDepth {
				return filepath.SkipDir
			}
		}
		if fi, err := os.Stat(filepath.Join(p, ConfigFile)); err == nil && !fi.IsDir() {
			roots = append(roots, p)
		}
		return nil
	})
	sort.Strings(roots)
	return roots
}

func findAbove(dir string) string {
	for d := dir; ; {
		if fi, err := os.Stat(filepath.Join(d, ConfigFile)); err == nil && !fi.IsDir() {
			return d
		}
		parent := filepath.Dir(d)
		if parent == d {
			return ""
		}
		d = parent
	}
}

// Inside reports whether path is dir or below it.
func Inside(path, dir string) bool {
	if dir == "" || path == "" {
		return false
	}
	rel, err := filepath.Rel(dir, path)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}
