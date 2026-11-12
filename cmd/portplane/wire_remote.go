package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/akamachinecode/portplane/internal/agent"
	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/desktop"
	"github.com/akamachinecode/portplane/internal/remote"
	"github.com/akamachinecode/portplane/internal/server"
	"github.com/akamachinecode/portplane/internal/setup"
)

// Remote parity (M5.6, ADR-0026): the guided setup, the dekit center and
// the portless center work on every machine. Portplane serves them at
// /api/m/{machine}/…; a remote machine's agent serves the same areas, built
// for its own machine, through the agent protocol.

// remoteAreas are the areas a remote machine's agent serves. An area joins
// once it works on a machine without a desktop (deps.headless).
var remoteAreas = []func(d deps) map[string]http.HandlerFunc{toolsHandlers, dekitHandlers, portlessHandlers}

// machineRoutes serves /api/m/{machine}/…: this computer's routes for the
// local machine, the machine's agent for the others. routes are this
// computer's routes, registered before.
func machineRoutes(d deps, routes map[string]http.HandlerFunc) map[string]http.HandlerFunc {
	local := http.NewServeMux()
	for pattern, h := range routes {
		local.HandleFunc(pattern, h)
	}
	return server.MachineAPIHandlers(server.MachineAPIDeps{
		Local:  "local",
		Routes: local,
		Machine: func(id string) (server.MachineTunnel, string, error) {
			return remoteMachine(d, id)
		},
		Downloads: downloadsDir,
		Reveal:    desktop.Reveal,
	})
}

// remoteMachine finds a remote machine's agent, and starts mirroring its
// jobs here: a job there only starts from a request through this tunnel.
func remoteMachine(d deps, id string) (*remote.Agent, string, error) {
	if d.hub == nil {
		return nil, "", fmt.Errorf("unknown machine %q", id)
	}
	a, err := d.hub.Agent(id)
	if err != nil {
		return nil, "", err
	}
	if u, ok := a.(interface{ Unwrap() agent.Agent }); ok {
		a = u.Unwrap()
	}
	ra, ok := a.(*remote.Agent)
	if !ok {
		return nil, "", fmt.Errorf("%s is not a machine reached over SSH", id)
	}
	ra.MirrorJobs(d.jobs)
	name := id
	for _, ms := range d.hub.Snapshot().Machines {
		if ms.Machine.ID == id && ms.Machine.Name != "" {
			name = ms.Machine.Name
		}
	}
	return ra, name, nil
}

// agentAPI is what a remote machine's agent serves to the Portplane that
// started it: setup, the dekit and portless centers, and its jobs.
func agentAPI(d deps) http.Handler {
	routes := setupHandlers(d)
	for _, area := range remoteAreas {
		for pattern, h := range area(d) {
			routes[pattern] = h
		}
	}
	for pattern, h := range server.JobHandlers(d.jobs) {
		routes[pattern] = h
	}
	mux := http.NewServeMux()
	for pattern, h := range routes {
		mux.HandleFunc(pattern, h)
	}
	return mux
}

// setupHandlers are the folder scan and write of setup (M2), for the
// machine d describes.
func setupHandlers(d deps) map[string]http.HandlerFunc {
	return server.SetupHandlers(server.SetupDeps{
		Folders: d.local.Folders,
		Facts: func(c context.Context) setup.Facts {
			snap, _ := d.local.Snapshot(c)
			return setup.GatherFacts(c, snap.Tools.Dekit, snap.Tools.Portless, snap.Tools.ProxyRunning)
		},
		Reload: func(c context.Context, root string) (bool, error) {
			err := d.dekit.Reload(c, root)
			if errors.Is(err, dekit.ErrRunnerDown) {
				return false, nil
			}
			return err == nil, err
		},
	})
}
