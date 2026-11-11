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
	// Within, when set, limits the view to tasks whose folder is inside one
	// of these: the user chose folders that have no dekit.yaml of their own
	// but sit inside a project.
	Within []string
}

// Shows reports whether a task in dir belongs in the view.
func (p Project) Shows(dir string) bool {
	if len(p.Within) == 0 {
		return true
	}
	for _, w := range p.Within {
		if Inside(dir, w) {
			return true
		}
	}
	return false
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
	full := map[string]bool{} // roots chosen directly: no filter
	add := func(p Project) {
		if i, ok := seen[p.Root]; ok {
			switch {
			case len(p.Within) == 0:
				full[p.Root] = true
				out[i].Within = nil
			case !full[p.Root]:
				out[i].Within = append(out[i].Within, p.Within...)
			}
			return
		}
		if len(p.Within) == 0 {
			full[p.Root] = true
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
			add(Project{Root: up, Within: []string{f}})
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
