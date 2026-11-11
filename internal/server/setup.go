package server

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"

	"github.com/akamachinecode/portplane/internal/setup"
)

// SetupDeps wires the setup endpoints to the local machine.
type SetupDeps struct {
	Facts   func(ctx context.Context) setup.Facts
	Folders func() []string
	// Reload applies new config to a running dekit runner; it reports
	// whether the runner was up.
	Reload func(ctx context.Context, root string) (bool, error)
}

type scanRequest struct {
	Folder    string          `json:"folder"`
	Overrides setup.Overrides `json:"overrides"`
}

type applyRequest struct {
	Folder    string          `json:"folder"`
	Digest    string          `json:"digest"`
	Overrides setup.Overrides `json:"overrides"`
}

type applyResponse struct {
	Written     []string `json:"written"`
	Reloaded    bool     `json:"reloaded"`
	ReloadError string   `json:"reloadError,omitempty"`
}

// SetupHandlers returns the /api/setup endpoints (M2).
func SetupHandlers(d SetupDeps) map[string]http.HandlerFunc {
	watched := func(folder string) (string, error) {
		abs, err := filepath.Abs(folder)
		if err != nil {
			return "", err
		}
		for _, f := range d.Folders() {
			if f == abs {
				return abs, nil
			}
		}
		return "", errors.New("set up only folders Portplane watches: add it in Settings first")
	}
	return map[string]http.HandlerFunc{
		"GET /api/setup/check": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, setup.Evaluate(d.Facts(r.Context())))
		},
		"POST /api/setup/scan": func(w http.ResponseWriter, r *http.Request) {
			var req scanRequest
			if err := decode(r, &req); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			folder, err := watched(req.Folder)
			if err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			p, err := setup.Propose(r.Context(), folder, req.Overrides, setup.Options{})
			if err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			writeJSON(w, http.StatusOK, p)
		},
		"POST /api/setup/apply": func(w http.ResponseWriter, r *http.Request) {
			var req applyRequest
			if err := decode(r, &req); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			folder, err := watched(req.Folder)
			if err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			res, err := setup.Apply(r.Context(), folder, req.Digest, req.Overrides, setup.Options{})
			if errors.Is(err, setup.ErrStale) {
				writeError(w, http.StatusConflict, err)
				return
			}
			if err != nil {
				writeError(w, http.StatusInternalServerError, err)
				return
			}
			out := applyResponse{Written: res.Written}
			if len(res.Written) > 0 && d.Reload != nil {
				up, err := d.Reload(r.Context(), folder)
				out.Reloaded = up && err == nil
				if err != nil {
					out.ReloadError = err.Error()
				}
			}
			writeJSON(w, http.StatusOK, out)
		},
	}
}
