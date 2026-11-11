package server

import "net/http"

type autostartBody struct {
	Enabled bool `json:"enabled"`
}

// AutostartHandlers returns GET and PUT /api/autostart (start at login).
func AutostartHandlers(get func() (bool, error), set func(bool) error) map[string]http.HandlerFunc {
	return map[string]http.HandlerFunc{
		"GET /api/autostart": func(w http.ResponseWriter, _ *http.Request) {
			on, err := get()
			if err != nil {
				writeError(w, http.StatusInternalServerError, err)
				return
			}
			writeJSON(w, http.StatusOK, autostartBody{Enabled: on})
		},
		"PUT /api/autostart": func(w http.ResponseWriter, r *http.Request) {
			var req autostartBody
			if err := decode(r, &req); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			if err := set(req.Enabled); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			on, _ := get()
			writeJSON(w, http.StatusOK, autostartBody{Enabled: on})
		},
	}
}
