package main

import (
	"context"
	"net/http"
	"os"
	"path/filepath"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/desktop"
	"github.com/akamachinecode/portplane/internal/envpath"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/osinfo"
	"github.com/akamachinecode/portplane/internal/server"
)

// portlessHandlers serves the portless center: proxy, routes, aliases, names, certificates, hosts, doctor (M5.2, ADR-0023),
// and sharing, compose projects and LAN mode (M5.6).
func portlessHandlers(d deps) map[string]http.HandlerFunc {
	return server.PortlessHandlers(server.PortlessDeps{
		Client: d.portless,
		Jobs:   d.jobs,
		Local: func(ctx context.Context) model.MachineSnapshot {
			s, _ := d.local.Snapshot(ctx)
			return s
		},
		Machines: func() []model.MachineSnapshot { return d.hub.Snapshot().Machines },
		Config:   dekit.LoadConfig,
		Reload:   d.dekit.Reload,
		Restart: func(ctx context.Context, root, task string) error {
			return d.dekit.Act(ctx, root, "restart", task)
		},
		Start: func(ctx context.Context, root, task string) error {
			return d.dekit.Act(ctx, root, "start", task)
		},
		ComposeMemory: composeMemoryPath(d),
		Listeners:     listeners,
		Refresh: func() {
			envpath.Refresh()
			d.local.RefreshTools()
		},
		Reveal:    desktop.Reveal,
		Downloads: downloadsDir,
	})
}

// listeners are the ports listening on this computer, with their programs.
func listeners(ctx context.Context) []server.Listener {
	var sys osinfo.System
	lns, err := sys.Listeners(ctx)
	if err != nil {
		return nil
	}
	cache := osinfo.NewCache(sys)
	out := make([]server.Listener, 0, len(lns))
	for _, l := range lns {
		v := server.Listener{Port: l.Port, PID: l.PID}
		if p := cache.Proc(ctx, l.PID); p != nil && l.PID > 0 {
			v.Process = osinfo.DisplayName(p.Cmdline)
		}
		out = append(out, v)
	}
	return out
}

// composeMemoryPath is where Portplane remembers the compose files it
// started: next to its settings.
func composeMemoryPath(d deps) string {
	if d.store == nil || d.store.Path() == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(d.store.Path()), "compose-files.json")
}

// downloadsDir is where exported files go: ~/Downloads, else the home folder.
func downloadsDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	if fi, err := os.Stat(filepath.Join(home, "Downloads")); err == nil && fi.IsDir() {
		return filepath.Join(home, "Downloads")
	}
	return home
}

func init() { areas = append(areas, portlessHandlers) }
