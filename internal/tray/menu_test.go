package tray

import (
	"reflect"
	"testing"

	"github.com/akamachinecode/portplane/internal/model"
)

func menuSnapshot() model.Snapshot {
	return model.Snapshot{Machines: []model.MachineSnapshot{
		{
			Machine: model.Machine{ID: "local", Local: true, Status: "online"},
			Tools:   model.Tools{Dekit: "0.10.3", Portless: "0.16.0", ProxyRunning: true},
			Runners: []model.Runner{{Root: "/code", Up: true}},
			Apps: []model.App{
				{ID: "/code#web", Label: "web", Project: "my-monorepo", State: model.StateOn, URL: "https://my-monorepo.localhost"},
				{ID: "/code#api", Label: "api", Project: "my-monorepo", State: model.StateOff},
				{ID: "/code#admin", Label: "admin", Project: "my-monorepo", State: model.StateFailed},
			},
		},
		{
			Machine: model.Machine{ID: "box", Name: "box", Status: "online"},
			Tools:   model.Tools{Dekit: "0.10.3"},
			Apps: []model.App{
				{ID: "/srv#shop", Label: "shop", Project: "shop", State: model.StateOn, URL: "https://shop.localhost", RemoteURL: "https://shop.box.localhost"},
			},
		},
		{Machine: model.Machine{ID: "mini", Name: "mac-mini", Status: "offline", Error: "timed out"}},
	}}
}

func TestBuildMenu(t *testing.T) {
	s := menuSnapshot()
	m := BuildMenu(s, []string{"box|/srv#shop", "local|/code#api", "local|/gone#x", "local|/code#web", "box|/srv#shop"}, 3)
	var titles []string
	for _, f := range m.Favorites {
		titles = append(titles, f.Title)
	}
	want := []string{"shop · box — Running", "api · my-monorepo — Stopped", "web · my-monorepo — Running"}
	if !reflect.DeepEqual(titles, want) {
		t.Fatalf("titles %q, want %q", titles, want)
	}
	if m.Favorites[0].URL != "https://shop.box.localhost" || m.Favorites[2].URL != "https://my-monorepo.localhost" || m.Favorites[1].URL != "" {
		t.Fatalf("urls %+v", m.Favorites)
	}
	if !m.CanStartPinned || m.Problems != 3 || m.Summary != "2 running · 1 failed" {
		t.Fatalf("menu %+v", m)
	}
	// Everything pinned runs: nothing to start.
	if m := BuildMenu(s, []string{"local|/code#web"}, 0); m.CanStartPinned {
		t.Fatal("CanStartPinned with every favourite running")
	}
	// Without dekit nothing can start.
	s.Machines[0].Tools.Dekit = ""
	if m := BuildMenu(s, []string{"local|/code#api"}, 0); m.CanStartPinned || m.Favorites[0].CanAct {
		t.Fatal("acting without dekit")
	}
}

func TestBuildMenuLimit(t *testing.T) {
	s := model.Snapshot{Machines: []model.MachineSnapshot{{Machine: model.Machine{ID: "local", Local: true}}}}
	var favs []string
	for i := 0; i < MaxFavorites+3; i++ {
		id := string(rune('a' + i))
		s.Machines[0].Apps = append(s.Machines[0].Apps, model.App{ID: id, Label: id, State: model.StateOff})
		favs = append(favs, "local|"+id)
	}
	m := BuildMenu(s, favs, 0)
	if len(m.Favorites) != MaxFavorites || m.More != 3 {
		t.Fatalf("%d favourites, %d more", len(m.Favorites), m.More)
	}
}

func TestProblems(t *testing.T) {
	s := menuSnapshot()
	// admin failed, mac-mini offline.
	if n := Problems(s); n != 2 {
		t.Fatalf("problems %d, want 2", n)
	}
	s.Machines[0].Tools.ProxyRunning = false
	s.Machines[0].Runners = append(s.Machines[0].Runners, model.Runner{Root: "/legacy"})
	s.Machines[1].Tools.Dekit = "" // box: dekit missing
	if n := Problems(s); n != 5 {
		t.Fatalf("problems %d, want 5", n)
	}
	if ProblemsTitle(1) != "1 problem…" || ProblemsTitle(4) != "4 problems…" {
		t.Fatal(ProblemsTitle(1), ProblemsTitle(4))
	}
}
