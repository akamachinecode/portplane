package server

import (
	"context"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/remote"
)

// The machine API (ADR-0026): /api/m/{machine}/<area path> serves the
// guided setup, the dekit center and the portless center for any machine.
// For this computer it is the same as /api/<area path>; for a machine
// reached over SSH, the request travels to its agent, which serves it with
// the same handlers built for its own machine. The token and Host checks
// (ADR-0008) stay here: the agent only takes requests from its own stdin.

// MachineTunnel is a remote machine's agent as the machine API uses it
// (*remote.Agent).
type MachineTunnel interface {
	API(ctx context.Context, req remote.APIRequest) (remote.APIResponse, error)
	Reinstall()
}

// MachineAPIDeps wires the machine API.
type MachineAPIDeps struct {
	// Local is this computer's machine id.
	Local string
	// Routes serve this computer's /api paths.
	Routes http.Handler
	// Machine finds a remote machine's agent and its display name.
	Machine func(id string) (MachineTunnel, string, error)
	// Downloads is where an exported certificate goes; Reveal shows it.
	Downloads func() string
	Reveal    func(path string) error
}

// MachineAreas are the API paths that act on one machine, under /api/.
var MachineAreas = []string{"setup/", "tools/", "proxy/", "trust/", "path/", "folders/suggestions", "dekit/", "portless/"}

// IsMachineArea reports whether an /api path (without "/api/") belongs to
// an area that runs on any machine.
func IsMachineArea(path string) bool {
	for _, a := range MachineAreas {
		if path == strings.TrimSuffix(a, "/") || strings.HasPrefix(path, a) {
			return true
		}
	}
	return false
}

// AgentOutdated is the code of the answer when a machine's agent is older
// than this Portplane (501): the UI offers to update it.
const AgentOutdated = "agent-outdated"

// MachineAPIHandlers returns the /api/m/{machine}/… routes.
func MachineAPIHandlers(d MachineAPIDeps) map[string]http.HandlerFunc {
	return map[string]http.HandlerFunc{
		"/api/m/{machine}/{path...}": func(w http.ResponseWriter, r *http.Request) {
			machine, path, ok := splitMachinePath(r.URL.EscapedPath())
			if !ok {
				writeError(w, http.StatusNotFound, errors.New("not found"))
				return
			}
			if path == "agent/update" {
				d.updateAgent(w, r, machine)
				return
			}
			plain, err := url.PathUnescape(path)
			if err != nil || !IsMachineArea(plain) {
				writeError(w, http.StatusNotFound, fmt.Errorf("%s is not something Portplane does per machine", "/api/"+path))
				return
			}
			if machine == d.Local {
				local := r.Clone(r.Context())
				local.URL.Path = "/api/" + plain
				local.URL.RawPath = "/api/" + path
				d.Routes.ServeHTTP(w, local)
				return
			}
			t, name, err := d.Machine(machine)
			if err != nil {
				writeError(w, http.StatusNotFound, err)
				return
			}
			if r.Method == http.MethodPost && plain == "portless/certificates/export" {
				d.exportCA(w, r, t, machine, name)
				return
			}
			body, err := io.ReadAll(r.Body)
			if err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			res, err := t.API(r.Context(), remote.APIRequest{Method: r.Method, Path: "/api/" + path, Query: r.URL.RawQuery, Body: body})
			if err != nil {
				tunnelError(w, err, name)
				return
			}
			for k, v := range res.Header {
				w.Header().Set(k, v)
			}
			w.WriteHeader(res.Status)
			_, _ = w.Write(res.Body)
		},
	}
}

// splitMachinePath splits "/api/m/<machine>/<path>" (escaped) into the
// machine id and the escaped path.
func splitMachinePath(p string) (string, string, bool) {
	rest, ok := strings.CutPrefix(p, "/api/m/")
	if !ok {
		return "", "", false
	}
	m, path, ok := strings.Cut(rest, "/")
	if !ok || m == "" || path == "" {
		return "", "", false
	}
	machine, err := url.PathUnescape(m)
	if err != nil {
		return "", "", false
	}
	return machine, path, true
}

// tunnelError says why a remote machine did not answer.
func tunnelError(w http.ResponseWriter, err error, name string) {
	switch {
	case errors.Is(err, remote.ErrAgentTooOld):
		writeJSON(w, http.StatusNotImplemented, map[string]string{
			"error": fmt.Sprintf("Update the agent on %s: it is older than this Portplane and can't do this yet.", name),
			"code":  AgentOutdated,
		})
	case errors.Is(err, remote.ErrOffline):
		writeError(w, http.StatusServiceUnavailable, fmt.Errorf("%s is offline. Portplane reconnects on its own: try again once it's back", name))
	case errors.Is(err, context.DeadlineExceeded):
		writeError(w, http.StatusGatewayTimeout, fmt.Errorf("%s took too long to answer", name))
	case errors.Is(err, context.Canceled):
		writeError(w, http.StatusServiceUnavailable, errors.New("cancelled"))
	default:
		writeError(w, http.StatusBadGateway, fmt.Errorf("%s: %w", name, err))
	}
}

func (d MachineAPIDeps) updateAgent(w http.ResponseWriter, r *http.Request, machine string) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("use POST"))
		return
	}
	if machine == d.Local {
		writeError(w, http.StatusBadRequest, errors.New("this computer runs Portplane itself: there is no agent to update"))
		return
	}
	t, _, err := d.Machine(machine)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	t.Reinstall()
	writeJSON(w, http.StatusAccepted, struct{}{})
}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// exportCA saves a remote machine's portless CA in this computer's
// Downloads folder: the file comes through the tunnel, and only a PEM
// certificate is written.
func (d MachineAPIDeps) exportCA(w http.ResponseWriter, r *http.Request, t MachineTunnel, machine, name string) {
	res, err := t.API(r.Context(), remote.APIRequest{Method: http.MethodGet, Path: "/api/portless/certificates/ca.pem"})
	if err != nil {
		tunnelError(w, err, name)
		return
	}
	if res.Status != http.StatusOK {
		for k, v := range res.Header {
			w.Header().Set(k, v)
		}
		w.WriteHeader(res.Status)
		_, _ = w.Write(res.Body)
		return
	}
	if block, _ := pem.Decode(res.Body); block == nil || block.Type != "CERTIFICATE" {
		writeError(w, http.StatusBadGateway, fmt.Errorf("%s sent something that is not a certificate", name))
		return
	}
	dir := ""
	if d.Downloads != nil {
		dir = d.Downloads()
	}
	if dir == "" {
		writeError(w, http.StatusInternalServerError, errors.New("no folder to save the certificate in"))
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	base := "portless-ca-" + strings.Trim(unsafeName.ReplaceAllString(machine, "-"), "-")
	dest := filepath.Join(dir, base+".pem")
	for i := 2; pathExists(dest); i++ {
		dest = filepath.Join(dir, fmt.Sprintf("%s-%d.pem", base, i))
	}
	if err := os.WriteFile(dest, res.Body, 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	revealed := false
	if d.Reveal != nil {
		revealed = d.Reveal(dir) == nil
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": dest, "revealed": revealed})
}

func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// JobHandlers serve a jobs manager on its own, as a remote agent does for
// the Portplane that follows its jobs.
func JobHandlers(m *jobs.Manager) map[string]http.HandlerFunc {
	return map[string]http.HandlerFunc{
		"GET /api/jobs": func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, m.List())
		},
		"GET /api/jobs/{id}": func(w http.ResponseWriter, r *http.Request) {
			if j, ok := m.Get(r.PathValue("id")); ok {
				writeJSON(w, http.StatusOK, j)
				return
			}
			writeError(w, http.StatusNotFound, jobs.ErrNotFound)
		},
		"POST /api/jobs/{id}/cancel": func(w http.ResponseWriter, r *http.Request) {
			if m.Cancel(r.PathValue("id")) != nil {
				writeError(w, http.StatusNotFound, jobs.ErrNotFound)
				return
			}
			writeJSON(w, http.StatusAccepted, struct{}{})
		},
	}
}
