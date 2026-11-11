package model

import (
	"sort"
	"strings"
)

// Group arranges apps into projects and worktrees for display. Projects with
// something running come first; otherwise everything keeps config order.
func Group(apps []App) []Project {
	type wtAcc struct {
		wt    Worktree
		order int
		tasks []string
	}
	type projAcc struct {
		p     Project
		order int
		wts   map[string]*wtAcc
		tasks []string
	}
	byKey := map[string]*projAcc{}
	var keys []string
	for _, a := range apps {
		key := a.Runner + "\x00" + a.Project
		pa, ok := byKey[key]
		if !ok {
			pa = &projAcc{p: Project{Name: a.Project, Runner: a.Runner}, order: a.Order, wts: map[string]*wtAcc{}}
			byKey[key] = pa
			keys = append(keys, key)
		}
		if a.Order < pa.order {
			pa.order = a.Order
		}
		wa, ok := pa.wts[a.Worktree]
		if !ok {
			wa = &wtAcc{wt: Worktree{Name: a.Worktree}, order: a.Order}
			pa.wts[a.Worktree] = wa
		}
		if a.Order < wa.order {
			wa.order = a.Order
		}
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
		pa.p.Prefix = CommonPrefix(pa.tasks)
		var wts []*wtAcc
		for _, wa := range pa.wts {
			wa.wt.Prefix = CommonPrefix(wa.tasks)
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
	projects := make([]Project, len(out))
	for i, pa := range out {
		projects[i] = pa.p
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
