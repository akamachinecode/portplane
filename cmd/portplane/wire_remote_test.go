package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/akamachinecode/portplane/internal/agent"
	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/portless"
)

// A remote machine's agent serves the areas that act on one machine, and
// nothing that belongs to the Portplane that reaches it (ADR-0026).
func TestAgentAPIRoutes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dk := &dekit.CLI{Bin: "/nonexistent/dekit"}
	pl := &portless.Client{Bin: "/nonexistent/portless", StateDir: t.TempDir()}
	local := agent.NewLocal(agent.Options{Dekit: dk, Portless: pl})
	defer func() { _ = local.Close() }()
	h := agentAPI(deps{ctx: ctx, local: local, jobs: jobs.NewManager(), dekit: dk, portless: pl, headless: true})
	mux, ok := h.(*http.ServeMux)
	if !ok {
		t.Fatalf("%T", h)
	}
	served := []string{
		"GET /api/setup/check", "POST /api/setup/scan", "POST /api/setup/apply",
		"POST /api/tools/install", "POST /api/proxy/start", "GET /api/trust/system",
		"GET /api/dekit/runners", "POST /api/dekit/config/edit", "GET /api/dekit/about",
		"GET /api/portless/routes", "GET /api/portless/certificates/ca.pem", "POST /api/portless/actions/proxy-stop",
		"GET /api/jobs/box:1", "POST /api/jobs/box:1/cancel",
	}
	for _, r := range served {
		method, path, _ := strings.Cut(r, " ")
		if _, pattern := mux.Handler(httptest.NewRequest(method, path, nil)); pattern == "" {
			t.Errorf("%s is not served", r)
		}
	}
	for _, r := range []string{"GET /api/events", "GET /api/snapshot", "GET /api/settings", "GET /api/preferences", "GET /api/machines", "POST /api/actions", "POST /api/open", "POST /api/folders/pick", "GET /api/m/box/portless/routes"} {
		method, path, _ := strings.Cut(r, " ")
		if _, pattern := mux.Handler(httptest.NewRequest(method, path, nil)); pattern != "" {
			t.Errorf("%s must not be served by an agent (%s)", r, pattern)
		}
	}
}
