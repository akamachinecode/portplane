package server

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"

	"github.com/akamachinecode/portplane/internal/appicon"
	"github.com/akamachinecode/portplane/internal/desktop"
)

// IconDeps wires the icon routes (ADR-0030).
type IconDeps struct {
	// Pick shows this computer's file picker for an image; nil on a
	// machine without a desktop (a remote agent).
	Pick func(context.Context) (string, error)
}

type iconBody struct {
	Icon *appicon.Image `json:"icon"`
}

// IconHandlers serves the images that stand for apps and projects. They sit
// in the icons/ machine area, so the same routes read a remote machine's
// folders through its agent (ADR-0026). Only image files are ever read.
//
//	GET  /api/icons/find?dir=&root=   the best icon from dir up to root
//	GET  /api/icons/candidates?root=  images in a project that could be its icon
//	GET  /api/icons/file?path=        one image file
//	POST /api/icons/pick              this computer's file picker
func IconHandlers(d IconDeps) map[string]http.HandlerFunc {
	return map[string]http.HandlerFunc{
		"GET /api/icons/find": func(w http.ResponseWriter, r *http.Request) {
			dir, root := r.URL.Query().Get("dir"), r.URL.Query().Get("root")
			if !filepath.IsAbs(dir) || (root != "" && !filepath.IsAbs(root)) {
				writeError(w, http.StatusBadRequest, errors.New("dir and root must be absolute paths"))
				return
			}
			img, ok := appicon.Find(dir, root)
			if !ok {
				writeJSON(w, http.StatusOK, iconBody{})
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			writeJSON(w, http.StatusOK, iconBody{Icon: &img})
		},
		"GET /api/icons/candidates": func(w http.ResponseWriter, r *http.Request) {
			root := r.URL.Query().Get("root")
			if !filepath.IsAbs(root) {
				writeError(w, http.StatusBadRequest, errors.New("root must be an absolute path"))
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"icons": appicon.Candidates(root, 24)})
		},
		"GET /api/icons/file": func(w http.ResponseWriter, r *http.Request) {
			img, err := appicon.Read(r.URL.Query().Get("path"))
			if err != nil {
				writeError(w, http.StatusUnprocessableEntity, err)
				return
			}
			writeJSON(w, http.StatusOK, iconBody{Icon: &img})
		},
		"POST /api/icons/pick": func(w http.ResponseWriter, r *http.Request) {
			if d.Pick == nil {
				writeError(w, http.StatusNotImplemented, desktop.ErrUnsupported)
				return
			}
			p, err := d.Pick(r.Context())
			switch {
			case errors.Is(err, desktop.ErrUnsupported):
				writeError(w, http.StatusNotImplemented, err)
			case errors.Is(err, desktop.ErrCancelled):
				w.WriteHeader(http.StatusNoContent)
			case err != nil:
				writeError(w, http.StatusInternalServerError, err)
			default:
				img, err := appicon.Read(p)
				if err != nil {
					writeError(w, http.StatusUnprocessableEntity, err)
					return
				}
				writeJSON(w, http.StatusOK, iconBody{Icon: &img})
			}
		},
	}
}
