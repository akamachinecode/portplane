package main

import (
	"context"
	"net/http"

	"github.com/akamachinecode/portplane/internal/agent"
	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/hub"
	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/portless"
	"github.com/akamachinecode/portplane/internal/settings"
)

// deps is what each area of the API needs from the running Portplane.
type deps struct {
	ctx      context.Context // ends when Portplane quits
	local    *agent.Local
	hub      *hub.Hub
	jobs     *jobs.Manager
	store    *settings.Store
	dekit    *dekit.CLI
	portless *portless.Client
	// publicURL is https://portplane.localhost when portless serves the UI.
	publicURL string
	// rawURL is the loopback address of the UI.
	rawURL string
	// headless is true in a remote machine's agent (ADR-0026): no window,
	// no desktop, nobody to answer a password dialog.
	headless bool
}

// areas add their routes from their own files (wire_*.go), so work on one
// area never touches the others.
var areas []func(d deps) map[string]http.HandlerFunc

func areaHandlers(d deps, into map[string]http.HandlerFunc) {
	for _, area := range areas {
		for pattern, h := range area(d) {
			into[pattern] = h
		}
	}
	// Last: /api/m/{machine}/… serves the routes above for any machine.
	for pattern, h := range machineRoutes(d, into) {
		into[pattern] = h
	}
}
