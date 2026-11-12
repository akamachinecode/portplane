package main

import (
	"net/http"

	"github.com/akamachinecode/portplane/internal/server"
)

// outputHandlers serves the Output panel: an app's whole terminal screen, local or remote (M5.4, ADR-0021).
func outputHandlers(d deps) map[string]http.HandlerFunc {
	return server.OutputHandlers(d.hub)
}

func init() { areas = append(areas, outputHandlers) }
