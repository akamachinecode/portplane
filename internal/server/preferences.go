package server

import (
	"net/http"

	"github.com/akamachinecode/portplane/internal/settings"
)

// PreferencesHandlers serves GET and PUT /api/preferences.
func PreferencesHandlers(store *settings.Store) map[string]http.HandlerFunc {
	return map[string]http.HandlerFunc{
		"GET /api/preferences": func(w http.ResponseWriter, _ *http.Request) {
			st, err := store.Load()
			if err != nil {
				writeError(w, http.StatusInternalServerError, err)
				return
			}
			writeJSON(w, http.StatusOK, st.Prefs())
		},
		"PUT /api/preferences": func(w http.ResponseWriter, r *http.Request) {
			var p settings.Preferences
			if err := decode(r, &p); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			p.Normalize()
			if err := p.Validate(); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			st, err := store.Update(func(s *settings.Settings) error {
				s.Preferences = &p
				return nil
			})
			if err != nil {
				writeError(w, http.StatusInternalServerError, err)
				return
			}
			writeJSON(w, http.StatusOK, st.Prefs())
		},
	}
}

// WriteJSON, WriteError and Decode are the handlers' helpers, for handler
// sets built outside this package.
func WriteJSON(w http.ResponseWriter, status int, v any) { writeJSON(w, status, v) }

// WriteError answers {"error": "..."} with status.
func WriteError(w http.ResponseWriter, status int, err error) { writeError(w, status, err) }

// Decode reads a JSON body, rejecting unknown fields.
func Decode(r *http.Request, v any) error { return decode(r, v) }
