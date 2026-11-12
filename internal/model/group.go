package model

import (
	"path/filepath"
	"slices"
	"sort"
	"strings"
)

// JoinRepos gives every app in a git repository the same project, wherever
// its task is declared: a "worktrees/" folder of a dekit.yaml that covers
// many repositories, another runner, the repository's own dekit.yaml. The
// name is the task folder its main checkout's apps share, or the
// repository's folder name when they name it differently or there are none
// (only linked worktrees). Group keeps such apps in one project.
func JoinRepos(apps []App) {
	names := repoNames(apps)
	for i := range apps {
		if apps[i].Repo != "" {
			apps[i].Project = names[apps[i].Repo]
		}
	}
}

// repoNames maps each repository to its project's name.
func repoNames(apps []App) map[string]string {
	seen := map[string]map[string]bool{}
	first := map[string]string{}
	for _, a := range apps {
		if a.Repo == "" {
			continue
		}
		if _, ok := seen[a.Repo]; !ok {
			seen[a.Repo] = map[string]bool{}
		}
		if a.Worktree != "" {
			continue
		}
		seen[a.Repo][a.Project] = true
		if _, ok := first[a.Repo]; !ok {
			first[a.Repo] = a.Project
		}
	}
	names := map[string]string{}
	for repo, ps := range seen {
		if len(ps) == 1 {
			names[repo] = first[repo]
		} else {
			names[repo] = filepath.Base(repo)
		}
	}
	return names
}

// Group arranges apps into projects and worktrees for display. Projects with
// something running come first; otherwise everything keeps config order.
// Apps in a git repository form one project (JoinRepos names it), even from
// several runners; the others group by runner and task folder.
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
		home    bool // the runner was set by a main checkout app
	}
	keyOf := func(a App) string {
		if a.Repo != "" {
			return "\x01" + a.Repo
		}
		return a.Runner + "\x00" + a.Project
	}
	byKey := map[string]*projAcc{}
	var keys []string
	for _, a := range apps {
		key := keyOf(a)
		pa, ok := byKey[key]
		if !ok {
			pa = &projAcc{p: Project{Name: a.Project, Runner: a.Runner}, order: a.Order, wts: map[string]*wtAcc{}}
			byKey[key] = pa
			keys = append(keys, key)
		}
		if a.Worktree == "" && !pa.home {
			pa.p.Runner, pa.home = a.Runner, true
		}
		if pa.p.Repo == "" {
			pa.p.Repo = a.Repo
		}
		if !slices.Contains(pa.runners, a.Runner) {
			pa.runners = append(pa.runners, a.Runner)
		}
		if a.Order < pa.order {
			pa.order = a.Order
		}
		wa, ok := pa.wts[a.Worktree]
		if !ok {
			wa = &wtAcc{wt: Worktree{Name: a.Worktree, Path: a.Checkout, Branch: a.Branch}, order: a.Order, runners: map[string]bool{}}
			pa.wts[a.Worktree] = wa
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
