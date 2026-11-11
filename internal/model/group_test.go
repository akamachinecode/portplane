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
}
