// Package agent defines what every machine offers the hub (ADR-0005) and
// implements it for the machine Portplane runs on.
package agent

import (
	"context"
	"net"

	"github.com/akamachinecode/portplane/internal/model"
)

// Agent is one machine as the hub sees it. The local agent implements it
// in-process; a remote agent implements it over SSH.
type Agent interface {
	// Snapshot returns the machine's current state, collecting it if needed.
	Snapshot(ctx context.Context) (model.MachineSnapshot, error)
	// Watch delivers a snapshot whenever something changes, until ctx ends.
	Watch(ctx context.Context) <-chan model.MachineSnapshot
	// Act starts, stops or restarts an app or a group of apps.
	Act(ctx context.Context, target model.Target, verb model.Verb) error
	// Up starts a dekit runner that is down.
	Up(ctx context.Context, runner string) error
	// Excerpt returns the last lines of an app's terminal.
	Excerpt(ctx context.Context, runner, task string) (model.Excerpt, error)
	// Output returns an app's whole terminal screen, with its colours.
	Output(ctx context.Context, runner, task string) (model.Output, error)
	// SetFolders replaces the folders the agent watches.
	SetFolders(ctx context.Context, folders []string) error
	// Dial opens a TCP connection to a port on the agent's machine.
	Dial(ctx context.Context, port int) (net.Conn, error)
	// Close stops the agent.
	Close() error
}
