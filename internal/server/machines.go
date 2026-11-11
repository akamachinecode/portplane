package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/akamachinecode/portplane/internal/remote"
	"github.com/akamachinecode/portplane/internal/settings"
)

// Machines is what the machine endpoints need (remote.Manager).
type Machines interface {
	List() ([]settings.Machine, error)
	Add(ctx context.Context, host, name string, folders []string) (settings.Machine, error)
	Update(ctx context.Context, id, name string, folders []string) (settings.Machine, error)
	Remove(id string) error
	OpenPort(ctx context.Context, id string, port int) (string, error)
}

type machineRequest struct {
	Host    string   `json:"host"`
	Name    string   `json:"name"`
	Folders []string `json:"folders"`
}

type openPortRequest struct {
	Machine string `json:"machine"`
	Port    int    `json:"port"`
}

// MachineHandlers returns the /api/machines endpoints (M3).
func MachineHandlers(m Machines, candidates func(context.Context) []remote.Candidate) map[string]http.HandlerFunc {
	return map[string]http.HandlerFunc{
		"GET /api/machines": func(w http.ResponseWriter, _ *http.Request) {
			list, err := m.List()
			if err != nil {
				writeError(w, http.StatusInternalServerError, err)
				return
			}
			writeJSON(w, http.StatusOK, list)
		},
		"GET /api/machines/candidates": func(w http.ResponseWriter, r *http.Request) {
			c := candidates(r.Context())
			if c == nil {
				c = []remote.Candidate{}
			}
			writeJSON(w, http.StatusOK, c)
		},
		"POST /api/machines": func(w http.ResponseWriter, r *http.Request) {
			var req machineRequest
			if err := decode(r, &req); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			// Installing the agent can take a while on a slow link.
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
			defer cancel()
			mc, err := m.Add(ctx, req.Host, req.Name, req.Folders)
			if err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			writeJSON(w, http.StatusCreated, mc)
		},
		"PUT /api/machines/{id}": func(w http.ResponseWriter, r *http.Request) {
			var req machineRequest
			if err := decode(r, &req); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			mc, err := m.Update(r.Context(), r.PathValue("id"), req.Name, req.Folders)
			if err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			writeJSON(w, http.StatusOK, mc)
		},
		"DELETE /api/machines/{id}": func(w http.ResponseWriter, r *http.Request) {
			if err := m.Remove(r.PathValue("id")); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		},
		"POST /api/ports/open": func(w http.ResponseWriter, r *http.Request) {
			var req openPortRequest
			if err := decode(r, &req); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			if req.Port <= 0 || req.Port > 65535 {
				writeError(w, http.StatusBadRequest, errors.New("invalid port"))
				return
			}
			if req.Machine == "local" {
				writeJSON(w, http.StatusOK, map[string]string{"url": "http://localhost:" + strconv.Itoa(req.Port)})
				return
			}
			url, err := m.OpenPort(r.Context(), req.Machine, req.Port)
			if err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"url": url})
		},
	}
}
