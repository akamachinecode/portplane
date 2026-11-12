package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/akamachinecode/portplane/internal/hub"
)

// outputTimeout bounds one screen read, over SSH included. The UI asks again
// a second later anyway.
const outputTimeout = 10 * time.Second

// OutputHandlers serves GET /api/output?machine=&runner=&task=: an app's
// whole terminal screen with its colour codes, for the Output panel
// (ADR-0021). The UI asks once a second while the panel is open; the agent
// shares answers for half a second and caps their size.
func OutputHandlers(h *hub.Hub) map[string]http.HandlerFunc {
	return map[string]http.HandlerFunc{
		"GET /api/output": func(w http.ResponseWriter, r *http.Request) {
			q := r.URL.Query()
			runner, task := q.Get("runner"), q.Get("task")
			if runner == "" || task == "" {
				writeError(w, http.StatusBadRequest, errors.New("say which app: runner and task are required"))
				return
			}
			a, err := h.Agent(q.Get("machine"))
			if err != nil {
				writeError(w, http.StatusNotFound, err)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), outputTimeout)
			defer cancel()
			out, err := a.Output(ctx, runner, task)
			if err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			writeJSON(w, http.StatusOK, out)
		},
	}
}
