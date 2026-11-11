// Package tray shows Portplane in the menu bar (macOS) or system tray
// (Windows, Linux with a StatusNotifier host): how many servers run, and
// shortcuts (ADR-0004).
package tray

import (
	"context"
	"fmt"

	"github.com/akamachinecode/portplane/internal/model"
)

// Options configures the tray.
type Options struct {
	Updates       <-chan model.Snapshot
	Open          func()
	Quit          func()
	Autostart     func() (bool, error)
	SetAutostart  func(on bool) error
	ReportFailure func(error)
}

// Counts summarises a snapshot for the tray.
type Counts struct {
	Running, Starting, Failed int
}

// Count tallies services (not jobs) across machines.
func Count(s model.Snapshot) Counts {
	var c Counts
	for _, m := range s.Machines {
		for _, a := range m.Apps {
			if a.Kind == "job" {
				continue
			}
			switch a.State {
			case model.StateOn:
				c.Running++
			case model.StateStarting, model.StateStopping:
				c.Starting++
			case model.StateFailed:
				c.Failed++
			}
		}
	}
	return c
}

// Summary is the tooltip and status line.
func (c Counts) Summary() string {
	s := fmt.Sprintf("%d running", c.Running)
	if c.Starting > 0 {
		s += fmt.Sprintf(" · %d starting", c.Starting)
	}
	if c.Failed > 0 {
		s += fmt.Sprintf(" · %d failed", c.Failed)
	}
	return s
}

// Run shows the tray and blocks until ctx ends or the user quits. It must be
// called from the main goroutine. When no tray is available it returns
// false immediately.
func Run(ctx context.Context, o Options) bool {
	if !Available() {
		return false
	}
	run(ctx, o)
	return true
}
