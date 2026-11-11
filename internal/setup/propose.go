package setup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/portless"
)

// FragmentRel is the generated fragment, relative to the folder (ADR-0009).
const FragmentRel = ".portplane/tasks.yaml"

// AppProposal is one dev server Portplane would run.
type AppProposal struct {
	Task           string   `json:"task"` // dekit task path
	Project        string   `json:"project"`
	Worktree       string   `json:"worktree,omitempty"`
	Name           string   `json:"name"` // the portless name (hostname without .localhost)
	Hostname       string   `json:"hostname"`
	Dir            string   `json:"dir"` // relative to the folder
	Package        string   `json:"package,omitempty"`
	Framework      string   `json:"framework"`
	PackageManager string   `json:"packageManager"`
	Command        []string `json:"command"`
	Status         string   `json:"status"` // new, unchanged, changed, manual (configured by hand: skipped)
	Skipped        bool     `json:"skipped"`
	Notes          []string `json:"notes,omitempty"`
}

// Change lists task paths that differ from the current fragment.
type Change struct {
	Added   []string `json:"added"`
	Changed []string `json:"changed"`
	Removed []string `json:"removed"`
}

// FileChange is a file the setup would write.
type FileChange struct {
	Path    string `json:"path"` // absolute
	Before  string `json:"before"`
	After   string `json:"after"`
	Created bool   `json:"created"`
	Changed bool   `json:"changed"`
}

// Proposal is everything a scan found and would write.
type Proposal struct {
	Folder string `json:"folder"`
	// Root is the dekit project the tasks join: the folder itself, or the
	// project above it when the folder has no dekit.yaml of its own.
	Root     string        `json:"root"`
	Apps     []AppProposal `json:"apps"`
	Warnings []string      `json:"warnings"`
	Change   Change        `json:"change"`
	Files    []FileChange  `json:"files"`
	Digest   string        `json:"digest"` // apply only what was reviewed
}

// Overrides are the user's edits to a proposal, keyed by task path.
type Overrides struct {
	Names map[string]string `json:"names,omitempty"` // task -> portless name
	Skip  map[string]bool   `json:"skip,omitempty"`
}

// Options tunes generation (tests set GOOS).
type Options struct {
	GOOS string
}

// Propose scans folder and builds the tasks it would write.
func Propose(ctx context.Context, folder string, ov Overrides, opt Options) (*Proposal, error) {
	folder, err := filepath.Abs(folder)
	if err != nil {
		return nil, err
	}
	if fi, err := os.Stat(folder); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("%s is not a folder", folder)
	}
	if opt.GOOS == "" {
		opt.GOOS = runtime.GOOS
	}
	// The tasks join the dekit project the folder belongs to: its own
	// dekit.yaml, or the nearest one above (a nested dekit.yaml would hide
	// the parent's tasks), or a new one in the folder.
	root := folder
	if _, err := os.Stat(filepath.Join(folder, dekit.ConfigFile)); err != nil {
		if up := dekit.FindAbove(filepath.Dir(folder)); up != "" {
			root = up
		}
	}
	p := &Proposal{Folder: folder, Root: root, Apps: []AppProposal{}, Warnings: []string{}, Change: Change{Added: []string{}, Changed: []string{}, Removed: []string{}}}

	fragPath := filepath.Join(folder, filepath.FromSlash(FragmentRel))
	previous, _ := os.ReadFile(fragPath)
	oldFrag := parseFragment(previous)
	pl := newPlanner(root, fragPath)

	var tasks []genTask
	for _, repo := range FindRepos(ctx, folder) {
		tasks = append(tasks, pl.repo(folder, repo, oldFrag, ov, opt, p)...)
	}

	content := renderFragment(tasks, opt)
	p.Files = append(p.Files, FileChange{Path: fragPath, Before: string(previous), After: content, Created: len(previous) == 0, Changed: string(previous) != content})

	dekitPath := filepath.Join(root, dekit.ConfigFile)
	before, _ := os.ReadFile(dekitPath)
	loadRel := filepath.ToSlash(mustRel(root, fragPath))
	after, err := ensureLoad(string(before), loadRel)
	if err != nil {
		return nil, err
	}
	p.Files = append(p.Files, FileChange{Path: dekitPath, Before: string(before), After: after, Created: len(before) == 0, Changed: string(before) != after})

	// Change summary against the current fragment.
	newTasks := map[string]genTask{}
	for _, t := range tasks {
		if !t.Folder {
			newTasks[t.Path] = t
		}
	}
	for _, t := range tasks {
		if t.Folder {
			continue
		}
		old, ok := oldFrag[t.Path]
		switch {
		case !ok:
			p.Change.Added = append(p.Change.Added, t.Path)
		case old.Sig != t.signature():
			p.Change.Changed = append(p.Change.Changed, t.Path)
		}
	}
	for path := range oldFrag {
		if _, ok := newTasks[path]; !ok {
			p.Change.Removed = append(p.Change.Removed, path)
		}
	}
	sort.Strings(p.Change.Removed)
	for i := range p.Apps {
		a := &p.Apps[i]
		if a.Status == "manual" || a.Skipped {
			continue
		}
		old, ok := oldFrag[a.Task]
		switch {
		case !ok:
			a.Status = "new"
		case old.Sig != newTasks[a.Task].signature():
			a.Status = "changed"
		default:
			a.Status = "unchanged"
		}
	}

	h := sha256.New()
	for _, f := range p.Files {
		fmt.Fprintf(h, "%s\x00%s\x00%s\x00", f.Path, f.Before, f.After)
	}
	p.Digest = hex.EncodeToString(h.Sum(nil))
	return p, nil
}

func mustRel(base, target string) string {
	r, err := filepath.Rel(base, target)
	if err != nil {
		return target
	}
	return r
}

// genTask is a task to write.
type genTask struct {
	Path    string
	Label   string
	Job     bool
	Dir     string // relative to the folder
	Cmd     []string
	Deps    []string
	Comment string
	Folder  bool // a folder entry ("shop/")
}

// signature is what decides "changed" between runs.
func (t genTask) signature() string {
	return strings.Join([]string{t.Dir, strings.Join(t.Cmd, "\x1f"), strings.Join(t.Deps, ","), fmt.Sprint(t.Job)}, "\x1e")
}

// agentEnv are unset in every generated task (field notes: some tools change
// behaviour under a coding agent).
var agentEnv = []string{"AI_AGENT", "AGENT", "CLAUDECODE", "CODEX_THREAD_ID", "CURSOR_TRACE_ID"}

// planner hands out task paths and portless names that collide with nothing:
// not with hand-written tasks or folders, not with each other, and never a
// task under a task (dekit rejects all of these).
type planner struct {
	handTasks   map[string]string // task paths written by hand -> their folder
	handFolders map[string]bool   // folder entries written by hand (no slash)
	handDirs    map[string]string // folder a hand-written portless task serves -> its path
	tasks       map[string]bool   // every task path in use
	folders     map[string]bool   // every folder path in use (no slash)
	names       map[string]bool   // every portless name in use
}

func newPlanner(root, fragPath string) *planner {
	pl := &planner{handTasks: map[string]string{}, handFolders: map[string]bool{}, handDirs: map[string]string{}, tasks: map[string]bool{}, folders: map[string]bool{}, names: map[string]bool{}}
	cfg, err := dekit.LoadConfig(root)
	if err != nil || cfg == nil {
		return pl
	}
	for _, t := range cfg.Tasks {
		if t.File == fragPath {
			continue
		}
		pl.handTasks[t.Path] = filepath.Clean(t.Dir)
		pl.tasks[t.Path] = true
		if w := portless.ParseCommand(t.Cmd); w != nil {
			if t.Dir != "" {
				pl.handDirs[filepath.Clean(t.Dir)] = t.Path
			}
			if w.Name != "" {
				pl.names[strings.TrimSuffix(w.Name, ".localhost")] = true
			}
		}
	}
	for _, f := range cfg.Folders {
		// A folder only the fragment declares is ours to redeclare; one
		// declared anywhere else is the user's.
		mine := true
		for _, file := range cfg.FolderFiles[f] {
			if file != fragPath {
				mine = false
			}
		}
		if !mine {
			pl.handFolders[f] = true
			pl.folders[f] = true
		}
	}
	return pl
}

// free reports whether a task can live at path.
func (pl *planner) freeTask(path string) bool {
	if pl.tasks[path] || pl.folders[path] {
		return false
	}
	// No task above it, and nothing below it.
	for i := range path {
		if path[i] == '/' && pl.tasks[path[:i]] {
			return false
		}
	}
	for t := range pl.tasks {
		if strings.HasPrefix(t, path+"/") {
			return false
		}
	}
	for f := range pl.folders {
		if strings.HasPrefix(f, path+"/") {
			return false
		}
	}
	return true
}

// freeFolder reports whether a new folder entry can live at path.
func (pl *planner) freeFolder(path string) bool {
	if pl.tasks[path] || pl.folders[path] {
		return false
	}
	for i := range path {
		if path[i] == '/' && pl.tasks[path[:i]] {
			return false
		}
	}
	return true
}

// unique returns base, or base-2, base-3… when taken.
func unique(base string, free func(string) bool) string {
	if free(base) {
		return base
	}
	for i := 2; ; i++ {
		if c := fmt.Sprintf("%s-%d", base, i); free(c) {
			return c
		}
	}
}

// uniqueName makes a portless name unique by suffixing its first label.
func (pl *planner) uniqueName(name string) string {
	if !pl.names[name] {
		pl.names[name] = true
		return name
	}
	first, rest, _ := strings.Cut(name, ".")
	for i := 2; ; i++ {
		c := fmt.Sprintf("%s-%d", first, i)
		if rest != "" {
			c += "." + rest
		}
		if !pl.names[c] {
			pl.names[c] = true
			return c
		}
	}
}

func (pl *planner) repo(folder string, repo Repo, oldFrag map[string]fragEntry, ov Overrides, opt Options, p *Proposal) []genTask {
	var out []genTask
	// The project folder: reuse a folder written by hand (its tasks are
	// checked one by one), otherwise a free one.
	project := repo.Name
	projectNew := true
	if pl.handFolders[project] {
		projectNew = false
	} else {
		project = unique(project, pl.freeFolder)
		pl.folders[project] = true
	}
	projectEmitted := false
	label := strings.ReplaceAll(project, "/", "-") // the project's part of URLs

	for _, co := range repo.Checkouts {
		pkgs := FindPackages(co.Dir)
		if len(pkgs) == 0 {
			continue
		}
		prefix := project + "/"
		wt := ""
		wtFolder := ""
		if co.Worktree != "" {
			wt = unique(project+"/"+co.Worktree, pl.freeFolder)
			pl.folders[wt] = true
			wtFolder = wt
			prefix = wt + "/"
			wt = strings.TrimPrefix(wt, project+"/")
		}

		// One install job per checkout; a hand-written one is reused.
		installPath := prefix + "install"
		handDir, handInstall := pl.handTasks[installPath]
		reuseInstall := handInstall && handDir == filepath.Clean(co.Dir)
		if !reuseInstall {
			installPath = unique(installPath, pl.freeTask)
			pl.tasks[installPath] = true
		}
		install := genTask{
			Path: installPath, Label: "install", Job: true, Dir: rel(folder, co.Dir),
			Cmd:     command(opt, installCommand(pkgs[0].PackageManager, co.Dir)),
			Comment: "One install per checkout before any app starts (field notes: parallel installs fail).",
		}

		var appTasks []genTask
		mainTaken := false
		for _, pkg := range pkgs {
			appName := Label(pkg.Name)
			if pkg.Name == "" {
				appName = Label(filepath.Base(pkg.Dir))
			}
			if pkg.Dir == co.Dir {
				appName = "web"
			}
			candidate := prefix + appName
			ap := AppProposal{
				Project: project, Worktree: wt, Dir: rel(folder, pkg.Dir), Package: pkg.Name,
				Framework: pkg.Framework, PackageManager: pkg.PackageManager,
			}
			_, handAtPath := pl.handTasks[candidate]
			handPath, handHere := pl.handDirs[filepath.Clean(pkg.Dir)]
			if handAtPath || handHere {
				ap.Task = candidate
				if handHere {
					ap.Task = handPath // the task that already serves this folder
				}
				ap.Status, ap.Skipped = "manual", true
				ap.Notes = append(ap.Notes, "Already configured by hand in dekit.yaml; Portplane leaves it alone.")
				p.Apps = append(p.Apps, ap)
				continue
			}
			task := unique(candidate, pl.freeTask)
			pl.tasks[task] = true
			ap.Task = task
			leaf := task[strings.LastIndex(task, "/")+1:]

			isMain := !mainTaken && (pkg.Dir == co.Dir || mainNames[appName])
			if isMain {
				mainTaken = true
			}
			name := leaf + "." + label
			switch {
			case wt != "" && isMain:
				name = wt + "." + label
			case wt != "":
				name = leaf + "." + wt + "." + label
			case isMain:
				name = label
			}
			if old := oldName(oldFrag, task); old != "" {
				name = old // keep a name the user edited in the fragment
			}
			if n, ok := ov.Names[task]; ok {
				if c := cleanName(n); c != "" {
					name = c
				}
			}
			if final := pl.uniqueName(name); final != name {
				ap.Notes = append(ap.Notes, fmt.Sprintf("%s.localhost is already used, so this app gets %s.localhost.", name, final))
				name = final
			}
			ap.Name, ap.Hostname = name, name+".localhost"
			argv, notes := devCommand(pkg, name)
			ap.Command = command(opt, argv)
			ap.Notes = append(ap.Notes, notes...)
			if ov.Skip[task] {
				ap.Skipped, ap.Status = true, "skipped"
				p.Apps = append(p.Apps, ap)
				continue
			}
			p.Apps = append(p.Apps, ap)
			appTasks = append(appTasks, genTask{
				Path: task, Dir: rel(folder, pkg.Dir), Cmd: ap.Command, Deps: []string{installPath},
				Comment: fmt.Sprintf("%s (%s) at https://%s", displayPackage(pkg), pkg.Framework, ap.Hostname),
			})
		}
		if len(appTasks) == 0 {
			continue
		}
		// Folder entries only for folders that get tasks, declared once.
		if projectNew && !projectEmitted {
			out = append(out, genTask{Path: project + "/", Folder: true})
			projectEmitted = true
		}
		if wtFolder != "" {
			out = append(out, genTask{Path: wtFolder + "/", Folder: true})
		}
		if !reuseInstall {
			out = append(out, install)
		}
		out = append(out, appTasks...)
	}
	// Warnings that apply to the whole project.
	auth, cms := false, false
	if len(repo.Checkouts) > 0 {
		for _, pkg := range FindPackages(repo.Checkouts[0].Dir) {
			for _, d := range []string{"better-auth", "next-auth", "@auth/core", "lucia", "@clerk/nextjs"} {
				if pkg.Deps[d] {
					auth = true
				}
			}
			if pkg.Framework == "sanity" || pkg.Deps["@sanity/client"] || pkg.Deps["next-sanity"] {
				cms = true
			}
		}
	}
	if auth && countApps(p.Apps, project) > 1 {
		p.Warnings = append(p.Warnings, fmt.Sprintf("%s: apps on sibling subdomains share a login only with a parent cookie domain (%s.localhost). Check your auth library's cross-subdomain cookie setting.", project, label))
	}
	if cms {
		p.Warnings = append(p.Warnings, fmt.Sprintf("%s: add the new https://*.%s.localhost origins to your CMS's CORS settings, or its API calls will fail.", project, label))
	}
	return out
}

var mainNames = map[string]bool{"web": true, "app": true, "site": true, "www": true, "frontend": true, "website": true}

func countApps(apps []AppProposal, project string) int {
	n := 0
	for _, a := range apps {
		if a.Project == project {
			n++
		}
	}
	return n
}

func displayPackage(pkg Package) string {
	if pkg.Name != "" {
		return pkg.Name
	}
	return filepath.Base(pkg.Dir)
}

func cleanName(n string) string {
	n = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(n)), ".localhost")
	parts := strings.Split(n, ".")
	out := parts[:0]
	for _, p := range parts {
		if l := Label(p); p != "" && l != "" {
			out = append(out, l)
		}
	}
	return strings.Join(out, ".")
}

func rel(folder, dir string) string {
	r, err := filepath.Rel(folder, dir)
	if err != nil {
		return dir
	}
	return filepath.ToSlash(r)
}

func installCommand(pm, dir string) []string {
	switch pm {
	case "pnpm":
		return []string{"pnpm", "install", "--frozen-lockfile"}
	case "yarn":
		if _, err := os.Stat(filepath.Join(dir, ".yarnrc.yml")); err == nil {
			return []string{"yarn", "install", "--immutable"}
		}
		return []string{"yarn", "install", "--frozen-lockfile"}
	case "bun":
		return []string{"bun", "install", "--frozen-lockfile"}
	}
	return []string{"npm", "install", "--no-audit", "--no-fund"}
}

// devCommand is the argv that starts a package's dev server through
// portless, following the field notes.
func devCommand(pkg Package, name string) ([]string, []string) {
	pm := pkg.PackageManager
	run := []string{pm, "run", "dev"} // spelled out: portless reads the script name from it
	exec := func(args ...string) []string {
		switch pm {
		case "npm":
			return append([]string{"npx", "--no-install"}, args...)
		case "bun":
			return append([]string{"bunx"}, args...)
		}
		return append([]string{pm, "exec"}, args...)
	}
	var notes []string
	var inner []string
	switch pkg.Framework {
	case "sanity":
		inner = append([]string{"portplane", "port-exec", "--"}, exec("sanity", "dev", "--host", "{HOST}", "--port", "{PORT}")...)
		notes = append(notes, "Sanity ignores PORT, so the port is passed explicitly with portplane port-exec.")
	case "remotion":
		inner = append([]string{"portplane", "port-exec", "--"}, exec("remotion", "studio", "--port", "{PORT}")...)
		notes = append(notes, "Remotion ignores PORT, so the port is passed explicitly with portplane port-exec.")
	default:
		inner = run
		if pkg.HardPort != "" {
			switch pkg.Framework {
			case "next":
				inner = exec("next", "dev")
			case "vite", "sveltekit":
				inner = exec("vite", "dev")
			case "astro":
				inner = exec("astro", "dev")
			case "nuxt":
				inner = exec("nuxt", "dev")
			case "react-router":
				inner = exec("react-router", "dev")
			}
			if pkg.Framework == "node" {
				notes = append(notes, fmt.Sprintf("The dev script pins port %s, but portless routes to the PORT it sets: remove the fixed port from the script (or read process.env.PORT) for the URL to work.", pkg.HardPort))
			} else {
				notes = append(notes, fmt.Sprintf("The dev script pins port %s, which would win over portless; Portplane calls the framework directly instead.", pkg.HardPort))
			}
		}
		if pkg.Framework == "node" && pkg.HardPort == "" {
			notes = append(notes, "Unknown dev server: it must listen on the PORT variable for its URL to work.")
		}
	}
	return append([]string{"portless", name}, inner...), notes
}

// command adapts argv to the OS: on Windows dekit only starts .exe files,
// so shims run through cmd /c (ADR-0010).
func command(opt Options, argv []string) []string {
	if opt.GOOS != "windows" {
		return argv
	}
	quoted := make([]string, len(argv))
	for i, a := range argv {
		if strings.ContainsAny(a, " \t\"&|<>^") {
			a = `"` + strings.ReplaceAll(a, `"`, `\"`) + `"`
		}
		quoted[i] = a
	}
	return []string{"cmd", "/c", strings.Join(quoted, " ")}
}
