package model

import (
	"path/filepath"
	"slices"
	"sort"
	"strings"
)

// A project is a task folder of a dekit.yaml together with every git
// repository whose main checkout has tasks in it, plus every linked worktree
// of those repositories, wherever the worktree's tasks are declared (a
// "worktrees/" folder of a dekit.yaml that covers many repositories, another
// runner). So a folder that names a product made of several repositories is
// one project, a repository whose tasks sit in two dekit.yaml files is one
// project, and a worktree always shows under its repository.
type grouping struct {
	key    []string          // per app: its project's key
	name   map[string]string // per key
	runner map[string]string // per key: the runner of its first main checkout or non-git app
	repos  map[string][]string
}

func groupApps(apps []App) grouping {
	parent := map[string]string{}
	var find func(string) string
	find = func(x string) string {
		p, ok := parent[x]
		if !ok {
			parent[x] = x
			return x
		}
		if p == x {
			return x
		}
		r := find(p)
		parent[x] = r
		return r
	}
	union := func(a, b string) {
		if ra, rb := find(a), find(b); ra != rb {
			parent[rb] = ra
		}
	}
	folderNode := func(a App) string { return "f\x00" + a.Runner + "\x00" + a.Project }
	repoNode := func(r string) string { return "r\x00" + r }

	node := make([]string, len(apps))
	for i, a := range apps {
		switch {
		case a.Repo == "":
			node[i] = folderNode(a)
			find(node[i])
		case a.Worktree != "":
			node[i] = repoNode(a.Repo)
			find(node[i])
		default:
			node[i] = repoNode(a.Repo)
			union(folderNode(a), node[i])
		}
	}

	name := func() (map[string]string, map[string][]string) {
		folders := map[string][]string{}
		repos := map[string][]string{}
		for _, a := range apps {
			if a.Repo != "" {
				root := find(repoNode(a.Repo))
				if !slices.Contains(repos[root], a.Repo) {
					repos[root] = append(repos[root], a.Repo)
				}
			}
			if a.Repo != "" && a.Worktree != "" {
				continue // a worktree's task folder ("worktrees/…") names nothing
			}
			root := find(folderNode(a))
			if !slices.Contains(folders[root], a.Project) {
				folders[root] = append(folders[root], a.Project)
			}
		}
		names := map[string]string{}
		for _, n := range node {
			root := find(n)
			if _, ok := names[root]; ok {
				continue
			}
			f, r := folders[root], repos[root]
			switch {
			case len(f) == 1:
				names[root] = f[0]
			case len(r) == 1 || (len(f) == 0 && len(r) > 0):
				names[root] = filepath.Base(r[0])
			default:
				names[root] = f[0]
			}
		}
		return names, repos
	}
	names, repos := name()

	// Tasks outside git in a folder named like a repository's project (its
	// main checkout isn't configured, or isn't there) belong to it.
	byName := map[string][]string{}
	for root, n := range names {
		if len(repos[root]) > 0 {
			byName[n] = append(byName[n], root)
		}
	}
	merged := false
	for root, n := range names {
		if len(repos[root]) == 0 && len(byName[n]) == 1 {
			union(byName[n][0], root)
			merged = true
		}
	}
	if merged {
		names, repos = name()
	}

	g := grouping{key: make([]string, len(apps)), name: map[string]string{}, runner: map[string]string{}, repos: map[string][]string{}}
	for i, a := range apps {
		root := find(node[i])
		g.key[i] = root
		g.name[root] = names[root]
		g.repos[root] = repos[root]
		if _, ok := g.runner[root]; !ok && (a.Repo == "" || a.Worktree == "") {
			g.runner[root] = a.Runner
		}
	}
	for i, a := range apps {
		if _, ok := g.runner[g.key[i]]; !ok {
			g.runner[g.key[i]] = a.Runner
		}
	}
	return g
}

// Group arranges apps into projects (see groupApps) and checkouts for
// display, and sets each app's Project to its project's name. Projects with
// something running come first; otherwise everything keeps config order.
func Group(apps []App) []Project {
	type wtAcc struct {
		wt      Worktree
		order   int
		tasks   []string
		runners map[string]bool
	}
	type projAcc struct {
		p       Project
		order   int
		wts     map[string]*wtAcc
		tasks   []string
		runners []string
	}
	g := groupApps(apps)
	for i := range apps {
		apps[i].Project = g.name[g.key[i]]
	}
	byKey := map[string]*projAcc{}
	var keys []string
	for i, a := range apps {
		key := g.key[i]
		pa, ok := byKey[key]
		if !ok {
			pa = &projAcc{p: Project{Name: g.name[key], Runner: g.runner[key]}, order: a.Order, wts: map[string]*wtAcc{}}
			switch rs := g.repos[key]; len(rs) {
			case 0:
			case 1:
				pa.p.Repo = rs[0]
			default:
				pa.p.Repos = rs
			}
			byKey[key] = pa
			keys = append(keys, key)
		}
		if !slices.Contains(pa.runners, a.Runner) {
			pa.runners = append(pa.runners, a.Runner)
		}
		if a.Order < pa.order {
			pa.order = a.Order
		}
		// One group per checkout: a product's repositories each have a main one.
		wkey := "\x00" + a.Worktree
		if a.Checkout != "" {
			wkey = a.Checkout
		}
		wa, ok := pa.wts[wkey]
		if !ok {
			wa = &wtAcc{wt: Worktree{Name: a.Worktree, Path: a.Checkout, Branch: a.Branch, Repo: a.Repo}, order: a.Order, runners: map[string]bool{}}
			pa.wts[wkey] = wa
		}
		if a.Order < wa.order {
			wa.order = a.Order
		}
		wa.runners[a.Runner] = true
		wa.wt.Apps = append(wa.wt.Apps, a.ID)
		wa.tasks = append(wa.tasks, a.Task)
		pa.tasks = append(pa.tasks, a.Task)
		if a.Kind != "job" {
			pa.p.Total++ // jobs are steps, not apps
		}
		if a.Kind != "job" && a.State.Alive() {
			pa.p.Running++
			wa.wt.Running++
		}
	}

	var out []*projAcc
	for _, k := range keys {
		pa := byKey[k]
		if len(pa.runners) > 1 {
			// Task paths of two runners share no folder that an action could use.
			pa.p.Runners = pa.runners
		} else {
			pa.p.Prefix = CommonPrefix(pa.tasks)
		}
		var wts []*wtAcc
		for _, wa := range pa.wts {
			if len(wa.runners) == 1 {
				for r := range wa.runners {
					wa.wt.Runner = r
				}
				wa.wt.Prefix = CommonPrefix(wa.tasks)
			}
			wts = append(wts, wa)
		}
		sort.SliceStable(wts, func(i, j int) bool {
			if (wts[i].wt.Name == "") != (wts[j].wt.Name == "") {
				return wts[i].wt.Name == ""
			}
			return wts[i].order < wts[j].order
		})
		for _, wa := range wts {
			pa.p.Worktrees = append(pa.p.Worktrees, wa.wt)
		}
		out = append(out, pa)
	}
	sort.SliceStable(out, func(i, j int) bool {
		ri, rj := out[i].p.Running > 0, out[j].p.Running > 0
		if ri != rj {
			return ri
		}
		return out[i].order < out[j].order
	})
	// A prefix is only usable for group actions when it does not also match
	// apps outside the group (a main checkout "shop/" also covers its linked
	// worktrees under "shop/feature/"). Without one, the UI lists the tasks.
	byRunner := map[string][]App{}
	for _, a := range apps {
		byRunner[a.Runner] = append(byRunner[a.Runner], a)
	}
	clash := func(runner, prefix string, members []string) bool {
		in := map[string]bool{}
		for _, id := range members {
			in[id] = true
		}
		for _, a := range byRunner[runner] {
			if strings.HasPrefix(a.Task, prefix) && !in[a.ID] {
				return true
			}
		}
		return false
	}
	projects := make([]Project, len(out))
	for i, pa := range out {
		p := pa.p
		var all []string
		for j := range p.Worktrees {
			wt := &p.Worktrees[j]
			all = append(all, wt.Apps...)
			if wt.Prefix != "" && clash(wt.Runner, wt.Prefix, wt.Apps) {
				wt.Prefix = ""
			}
		}
		if p.Prefix != "" && clash(p.Runner, p.Prefix, all) {
			p.Prefix = ""
		}
		projects[i] = p
	}
	return projects
}

// CommonPrefix returns the longest folder prefix ("a/b/") shared by every
// task path, or "" when the tasks share no folder.
func CommonPrefix(tasks []string) string {
	if len(tasks) == 0 {
		return ""
	}
	dir := func(t string) []string {
		i := strings.LastIndex(t, "/")
		if i < 0 {
			return nil
		}
		return strings.Split(t[:i], "/")
	}
	common := dir(tasks[0])
	for _, t := range tasks[1:] {
		d := dir(t)
		n := 0
		for n < len(common) && n < len(d) && common[n] == d[n] {
			n++
		}
		common = common[:n]
	}
	if len(common) == 0 {
		return ""
	}
	return strings.Join(common, "/") + "/"
}
