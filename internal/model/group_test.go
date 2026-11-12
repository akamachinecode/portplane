package model

import (
	"reflect"
	"testing"
)

func TestCommonPrefix(t *testing.T) {
	cases := []struct {
		tasks []string
		want  string
	}{
		{[]string{"demo/web", "demo/api"}, "demo/"},
		{[]string{"shop/main/web", "shop/main/api", "shop/feat-x/web"}, "shop/"},
		{[]string{"shop/main/web", "shop/main/api"}, "shop/main/"},
		{[]string{"web", "api"}, ""},
		{[]string{"demo/web", "other/api"}, ""},
		{[]string{"demo/web"}, "demo/"},
		{nil, ""},
	}
	for _, c := range cases {
		if got := CommonPrefix(c.tasks); got != c.want {
			t.Errorf("CommonPrefix(%v) = %q, want %q", c.tasks, got, c.want)
		}
	}
}

func TestGroupOrdersRunningProjectsFirst(t *testing.T) {
	apps := []App{
		{ID: "r#a/web", Runner: "r", Task: "a/web", Project: "a", Kind: "service", State: StateOff, Order: 0},
		{ID: "r#b/web", Runner: "r", Task: "b/web", Project: "b", Kind: "service", State: StateOn, Order: 1},
		{ID: "r#b/wt/web", Runner: "r", Task: "b/wt/web", Project: "b", Worktree: "wt", Kind: "service", State: StateOff, Order: 2},
		{ID: "r#b/install", Runner: "r", Task: "b/install", Project: "b", Kind: "job", State: StateStarting, Order: 3},
	}
	got := Group(apps)
	if len(got) != 2 || got[0].Name != "b" || got[1].Name != "a" {
		t.Fatalf("order: %+v", got)
	}
	b := got[0]
	if b.Running != 1 || b.Total != 2 || b.Prefix != "b/" {
		t.Fatalf("project b: %+v", b)
	}
	if len(b.Worktrees) != 2 || b.Worktrees[0].Name != "" || b.Worktrees[1].Name != "wt" {
		t.Fatalf("worktrees: %+v", b.Worktrees)
	}
	if !reflect.DeepEqual(b.Worktrees[0].Apps, []string{"r#b/web", "r#b/install"}) {
		t.Fatalf("main apps: %v", b.Worktrees[0].Apps)
	}
	if b.Worktrees[1].Prefix != "b/wt/" {
		t.Fatalf("worktree prefix: %q", b.Worktrees[1].Prefix)
	}
	// "b/" would also reach b/wt/web: the main checkout gets no prefix.
	if b.Worktrees[0].Prefix != "" {
		t.Fatalf("main checkout prefix must not cover the linked worktree: %q", b.Worktrees[0].Prefix)
	}
}

// The owner's layout: one dekit.yaml for every repository, with the linked
// worktrees' tasks in a "worktrees/" folder, and a repository that also has
// its own dekit.yaml. Each worktree shows under its repository.
func TestGroupJoinsWorktreesToTheirRepository(t *testing.T) {
	const (
		all   = "/r"              // ~/Repos/dekit.yaml
		shopR = "/r/shop"         // shop's own dekit.yaml
		shop  = "/r/shop"         // shop's main checkout
		blog  = "/r/blog"         // blog has no task in its main checkout
		other = "/r/other-folder" // not in git
	)
	apps := []App{
		{ID: shopR + "#shop/web", Runner: shopR, Task: "shop/web", Project: "shop", Repo: shop, Checkout: shop, Branch: "main", Kind: "service", State: StateOn, Order: 0},
		{ID: all + "#worktrees/feat-x/web", Runner: all, Task: "worktrees/feat-x/web", Project: "worktrees", Worktree: "feat-x", Repo: shop, Checkout: "/r/worktrees/feat-x", Branch: "feat/x", Kind: "service", State: StateOff, Order: 1},
		{ID: all + "#worktrees/feat-x/api", Runner: all, Task: "worktrees/feat-x/api", Project: "worktrees", Worktree: "feat-x", Repo: shop, Checkout: "/r/worktrees/feat-x", Branch: "feat/x", Kind: "service", State: StateOff, Order: 2},
		{ID: all + "#worktrees/redesign/site", Runner: all, Task: "worktrees/redesign/site", Project: "worktrees", Worktree: "redesign", Repo: blog, Checkout: "/r/worktrees/redesign", Branch: "design/new", Kind: "service", State: StateOff, Order: 3},
		{ID: all + "#tools/panel", Runner: all, Task: "tools/panel", Project: "tools", Dir: other, Kind: "service", State: StateOff, Order: 4},
	}
	JoinRepos(apps)
	if apps[1].Project != "shop" || apps[3].Project != "blog" || apps[4].Project != "tools" {
		t.Fatalf("projects after JoinRepos: %q %q %q", apps[1].Project, apps[3].Project, apps[4].Project)
	}
	got := Group(apps)
	if len(got) != 3 {
		t.Fatalf("want shop, blog and tools, got %+v", got)
	}
	s := got[0]
	if s.Name != "shop" || s.Runner != shopR || s.Repo != shop || !reflect.DeepEqual(s.Runners, []string{shopR, all}) {
		t.Fatalf("shop: %+v", s)
	}
	if s.Prefix != "" {
		t.Fatalf("a project over two runners has no prefix: %q", s.Prefix)
	}
	if len(s.Worktrees) != 2 || s.Worktrees[0].Name != "" || s.Worktrees[0].Branch != "main" || s.Worktrees[0].Path != shop {
		t.Fatalf("shop main checkout: %+v", s.Worktrees)
	}
	wt := s.Worktrees[1]
	if wt.Name != "feat-x" || wt.Branch != "feat/x" || wt.Path != "/r/worktrees/feat-x" || wt.Runner != all || wt.Prefix != "worktrees/feat-x/" {
		t.Fatalf("shop worktree: %+v", wt)
	}
	if s.Running != 1 || s.Total != 3 {
		t.Fatalf("shop counts: %+v", s)
	}
	b := got[1]
	if b.Name != "blog" || b.Repo != blog || b.Runner != all || len(b.Runners) != 0 || len(b.Worktrees) != 1 || b.Worktrees[0].Name != "redesign" {
		t.Fatalf("blog: %+v", b)
	}
	// "worktrees/" would reach the shop worktree's tasks too.
	if b.Prefix != "worktrees/redesign/" && b.Prefix != "" {
		t.Fatalf("blog prefix: %q", b.Prefix)
	}
	if got[2].Name != "tools" || got[2].Repo != "" {
		t.Fatalf("tools: %+v", got[2])
	}
}

// A repository with tasks in two dekit.yaml files under two names (its own
// "web", and "portplane/web" in a file for every repository) is one
// project, named after the repository's folder.
func TestGroupOneProjectPerRepository(t *testing.T) {
	const repo = "/r/akamachinecode/localhost-control-plane"
	apps := []App{
		{ID: "/r#portplane/web", Runner: "/r", Task: "portplane/web", Project: "portplane", Repo: repo, Checkout: repo, Kind: "service", State: StateOn, Order: 0},
		{ID: repo + "#web", Runner: repo, Task: "web", Project: "localhost-control-plane", Repo: repo, Checkout: repo, Kind: "service", State: StateOff, Order: 0},
		{ID: "/r#other/web", Runner: "/r", Task: "other/web", Project: "other", Repo: "/r/other", Checkout: "/r/other", Kind: "service", State: StateOff, Order: 1},
	}
	JoinRepos(apps)
	got := Group(apps)
	if len(got) != 2 {
		t.Fatalf("want two projects, got %+v", got)
	}
	p := got[0]
	if p.Name != "localhost-control-plane" || len(p.Worktrees) != 1 || len(p.Worktrees[0].Apps) != 2 || !reflect.DeepEqual(p.Runners, []string{"/r", repo}) {
		t.Fatalf("project: %+v", p)
	}
	// one runner, one name: the task folder wins over the repository's folder
	if got[1].Name != "other" {
		t.Fatalf("other: %+v", got[1])
	}
}
