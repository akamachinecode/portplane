// Package setup finds the dev servers in a folder and proposes dekit tasks
// for them, wrapped by portless, using the defaults from the field notes
// (docs/field-notes.md). Nothing is written without confirmation (ADR-0009).
package setup

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

// Checkout is one git checkout (the main one or a linked worktree).
type Checkout struct {
	Dir      string
	Worktree string // empty for the main checkout
	Branch   string
}

// Repo is a project found in the folder.
type Repo struct {
	Name      string // display and URL name
	Root      string // main checkout
	Checkouts []Checkout
}

// Package is a JavaScript package with a dev script.
type Package struct {
	Dir            string // absolute
	Name           string // package.json name
	DevScript      string
	Framework      string // next, vite, astro, react-router, nuxt, sveltekit, sanity, remotion, node
	PackageManager string // pnpm, npm, yarn, bun
	HardPort       string // a port written into the dev script
	Deps           map[string]bool
}

var skipDirs = map[string]bool{"node_modules": true, ".git": true, "dist": true, "build": true, "vendor": true, "target": true, ".next": true, ".turbo": true, ".cache": true, ".portplane": true, ".output": true, ".svelte-kit": true, ".astro": true}

// FindRepos lists the projects in folder: the folder itself when it is a
// repository or package, else the repositories up to two levels below.
func FindRepos(ctx context.Context, folder string) []Repo {
	if isProjectRoot(folder) {
		return []Repo{repoAt(ctx, folder, folder)}
	}
	var repos []Repo
	entries, _ := os.ReadDir(folder)
	for _, e := range entries {
		if !e.IsDir() || skipDirs[e.Name()] || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		dir := filepath.Join(folder, e.Name())
		if isProjectRoot(dir) {
			if isLinkedWorktree(dir) {
				continue // listed under its main checkout
			}
			repos = append(repos, repoAt(ctx, folder, dir))
			continue
		}
		sub, _ := os.ReadDir(dir)
		for _, s := range sub {
			if !s.IsDir() || skipDirs[s.Name()] || strings.HasPrefix(s.Name(), ".") {
				continue
			}
			d := filepath.Join(dir, s.Name())
			if isProjectRoot(d) && !isLinkedWorktree(d) {
				repos = append(repos, repoAt(ctx, folder, d))
			}
		}
	}
	sort.Slice(repos, func(i, j int) bool { return repos[i].Name < repos[j].Name })
	return repos
}

func isProjectRoot(dir string) bool {
	for _, marker := range []string{".git", "package.json"} {
		if _, err := os.Stat(filepath.Join(dir, marker)); err == nil {
			return true
		}
	}
	return false
}

func isLinkedWorktree(dir string) bool {
	fi, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil && !fi.IsDir()
}

func repoAt(ctx context.Context, folder, dir string) Repo {
	r := Repo{Name: Label(filepath.Base(dir)), Root: dir}
	r.Checkouts = worktrees(ctx, dir)
	// git reports canonical paths (/private/var on macOS, long names on
	// Windows); keep the user's spelling so generated paths stay short.
	for i := range r.Checkouts {
		r.Checkouts[i].Dir = userPath(folder, dir, r.Checkouts[i].Dir)
	}
	if len(r.Checkouts) == 0 {
		r.Checkouts = []Checkout{{Dir: dir}}
	}
	return r
}

// worktrees lists a repository's checkouts with `git worktree list --porcelain`.
// The first entry is the main checkout.
func worktrees(ctx context.Context, dir string) []Checkout {
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", dir, "worktree", "list", "--porcelain")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	return parseWorktrees(out)
}

func parseWorktrees(out []byte) []Checkout {
	var list []Checkout
	var cur *Checkout
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "worktree "):
			list = append(list, Checkout{Dir: filepath.Clean(strings.TrimPrefix(line, "worktree "))})
			cur = &list[len(list)-1]
		case strings.HasPrefix(line, "branch ") && cur != nil:
			cur.Branch = strings.TrimPrefix(strings.TrimPrefix(line, "branch "), "refs/heads/")
		case line == "bare" && cur != nil:
			list = list[:len(list)-1]
			cur = nil
		case strings.HasPrefix(line, "prunable") && cur != nil:
			list = list[:len(list)-1]
			cur = nil
		}
	}
	for i := range list {
		if i > 0 {
			list[i].Worktree = Label(filepath.Base(list[i].Dir))
		}
	}
	return list
}

// FindPackages lists the packages with a dev script in a checkout: the
// workspace packages when it is a monorepo, else the root package.
func FindPackages(checkout string) []Package {
	root, ok := readPackageJSON(checkout)
	if !ok {
		return nil
	}
	pm := packageManager(checkout, root)
	patterns := workspacePatterns(checkout, root)
	var dirs []string
	if len(patterns) == 0 {
		dirs = []string{checkout}
	} else {
		dirs = expandWorkspaces(checkout, patterns)
		if dev, ok := root.Scripts["dev"]; ok && !isWorkspaceRunner(dev) {
			// A root dev script that is not a "run every app" wrapper.
			dirs = append([]string{checkout}, dirs...)
		}
	}
	var out []Package
	for _, d := range dirs {
		pj, ok := readPackageJSON(d)
		if !ok {
			continue
		}
		dev, ok := pj.Scripts["dev"]
		if !ok || strings.TrimSpace(dev) == "" {
			continue
		}
		deps := map[string]bool{}
		for k := range pj.Dependencies {
			deps[k] = true
		}
		for k := range pj.DevDependencies {
			deps[k] = true
		}
		p := Package{Dir: d, Name: pj.Name, DevScript: dev, PackageManager: pm, Deps: deps}
		p.Framework = detectFramework(dev, deps)
		p.HardPort = hardPort(dev)
		out = append(out, p)
	}
	return out
}

type packageJSON struct {
	Name            string            `json:"name"`
	Scripts         map[string]string `json:"scripts"`
	Dependencies    map[string]string `json:"dependencies"`
	DevDependencies map[string]string `json:"devDependencies"`
	Workspaces      json.RawMessage   `json:"workspaces"`
	PackageManager  string            `json:"packageManager"`
}

func readPackageJSON(dir string) (packageJSON, bool) {
	var pj packageJSON
	b, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return pj, false
	}
	if json.Unmarshal(b, &pj) != nil {
		return pj, false
	}
	return pj, true
}

func packageManager(dir string, pj packageJSON) string {
	if pm := pj.PackageManager; pm != "" {
		name, _, _ := strings.Cut(pm, "@")
		switch name {
		case "pnpm", "yarn", "npm", "bun":
			return name
		}
	}
	for _, c := range []struct{ file, pm string }{
		{"pnpm-lock.yaml", "pnpm"}, {"pnpm-workspace.yaml", "pnpm"}, {"bun.lock", "bun"}, {"bun.lockb", "bun"},
		{"yarn.lock", "yarn"}, {"package-lock.json", "npm"},
	} {
		if _, err := os.Stat(filepath.Join(dir, c.file)); err == nil {
			return c.pm
		}
	}
	return "npm"
}

func workspacePatterns(dir string, pj packageJSON) []string {
	if b, err := os.ReadFile(filepath.Join(dir, "pnpm-workspace.yaml")); err == nil {
		var ws struct {
			Packages []string `yaml:"packages"`
		}
		if yaml.Unmarshal(b, &ws) == nil && len(ws.Packages) > 0 {
			return ws.Packages
		}
	}
	if len(pj.Workspaces) > 0 {
		var list []string
		if json.Unmarshal(pj.Workspaces, &list) == nil {
			return list
		}
		var obj struct {
			Packages []string `json:"packages"`
		}
		if json.Unmarshal(pj.Workspaces, &obj) == nil {
			return obj.Packages
		}
	}
	return nil
}

func expandWorkspaces(root string, patterns []string) []string {
	var include, exclude []*regexp.Regexp
	for _, p := range patterns {
		neg := strings.HasPrefix(p, "!")
		re := globToRegexp(strings.TrimPrefix(strings.TrimPrefix(p, "!"), "./"))
		if neg {
			exclude = append(exclude, re)
		} else {
			include = append(include, re)
		}
	}
	var out []string
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}
		if p != root && (skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
			return filepath.SkipDir
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if strings.Count(rel, "/") > 4 {
			return filepath.SkipDir
		}
		if p == root {
			return nil
		}
		if _, err := os.Stat(filepath.Join(p, "package.json")); err != nil {
			return nil
		}
		matched := false
		for _, re := range include {
			if re.MatchString(rel) {
				matched = true
			}
		}
		for _, re := range exclude {
			if re.MatchString(rel) {
				matched = false
			}
		}
		if matched {
			out = append(out, p)
		}
		return nil
	})
	sort.Strings(out)
	return out
}

func globToRegexp(pattern string) *regexp.Regexp {
	pattern = strings.TrimSuffix(pattern, "/")
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(pattern); i++ {
		switch c := pattern[i]; c {
		case '*':
			if i+1 < len(pattern) && pattern[i+1] == '*' {
				b.WriteString(".*")
				i++
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString("$")
	return regexp.MustCompile(b.String())
}

// isWorkspaceRunner spots root scripts that start every app (turbo dev,
// pnpm -r dev, nx run-many…): Portplane runs each app instead.
func isWorkspaceRunner(script string) bool {
	s := " " + script + " "
	for _, marker := range []string{" turbo ", " turbo run ", " nx ", " lerna ", " -r ", " --recursive ", " --filter", " -F ", " concurrently ", " npm-run-all", " run-p ", " workspaces ", " --parallel "} {
		if strings.Contains(s, marker) {
			return true
		}
	}
	return false
}

// detectFramework names the dev server, from the dev script first and the
// dependencies second.
func detectFramework(script string, deps map[string]bool) string {
	first := firstCommand(script)
	switch first {
	case "next":
		return "next"
	case "vite":
		return "vite"
	case "astro":
		return "astro"
	case "react-router", "remix":
		return "react-router"
	case "nuxt", "nuxi":
		return "nuxt"
	case "sanity":
		return "sanity"
	case "remotion":
		return "remotion"
	}
	switch {
	case deps["next"]:
		return "next"
	case deps["astro"]:
		return "astro"
	case deps["@react-router/dev"] || deps["@remix-run/dev"]:
		return "react-router"
	case deps["nuxt"]:
		return "nuxt"
	case deps["@sveltejs/kit"]:
		return "sveltekit"
	case deps["sanity"]:
		return "sanity"
	case deps["@remotion/cli"] || deps["remotion"]:
		return "remotion"
	case deps["vite"]:
		return "vite"
	}
	return "node"
}

// firstCommand is the program a script runs, skipping env assignments and
// package-manager prefixes.
func firstCommand(script string) string {
	fields := strings.Fields(script)
	for i := 0; i < len(fields); i++ {
		f := fields[i]
		switch {
		case strings.Contains(f, "=") && !strings.HasPrefix(f, "-"):
			continue // FOO=bar
		case f == "cross-env" || f == "dotenv" || f == "env":
			continue
		case f == "npx" || f == "bunx" || f == "pnpx":
			continue
		case (f == "pnpm" || f == "yarn" || f == "npm" || f == "bun") && i+1 < len(fields) && (fields[i+1] == "exec" || fields[i+1] == "dlx"):
			i++
			continue
		case f == "--":
			continue
		}
		return f
	}
	return ""
}

var hardPortRe = regexp.MustCompile(`(?:--port[= ]|-p[= ]|\bPORT=)(\d{2,5})\b`)

func hardPort(script string) string {
	if m := hardPortRe.FindStringSubmatch(script); m != nil {
		return m[1]
	}
	return ""
}

var labelRe = regexp.MustCompile(`[^a-z0-9-]+`)

// Label turns a name into a DNS label: lower case, a-z 0-9 and dashes.
func Label(s string) string {
	s = strings.ToLower(s)
	if i := strings.LastIndex(s, "/"); i >= 0 {
		s = s[i+1:] // @scope/name
	}
	s = labelRe.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 63 {
		s = strings.Trim(s[:63], "-")
	}
	if s == "" {
		s = "app"
	}
	return s
}

// userPath rewrites a path git reported into the same form as dir (the
// repository as found) or folder (the folder the user chose).
func userPath(folder, dir, p string) string {
	canon := func(x string) string {
		if c, err := filepath.EvalSymlinks(x); err == nil {
			return c
		}
		return filepath.Clean(x)
	}
	cp := canon(p)
	if cp == canon(dir) {
		return dir
	}
	if rel, err := filepath.Rel(canon(folder), cp); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return filepath.Join(folder, rel)
	}
	return p
}
