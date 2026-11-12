package main

import (
	"net/http"

	"github.com/akamachinecode/portplane/internal/desktop"
	"github.com/akamachinecode/portplane/internal/server"
)

// iconHandlers serves app and project icons from their folders (ADR-0030).
// A remote machine's agent serves the same routes for its own folders,
// without a file picker.
func iconHandlers(d deps) map[string]http.HandlerFunc {
	deps := server.IconDeps{}
	if !d.headless {
		deps.Pick = desktop.PickImage
	}
	return server.IconHandlers(deps)
}

func init() { areas = append(areas, iconHandlers) }
