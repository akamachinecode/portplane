// Package server serves the UI and the JSON API on loopback, protected as
// described in ADR-0008.
package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"path"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/buildinfo"
	"github.com/akamachinecode/portplane/internal/desktop"
	"github.com/akamachinecode/portplane/internal/hub"
	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/model"
)

// TokenPlaceholder is replaced in index.html with the per-run token.
const TokenPlaceholder = "__PORTPLANE_TOKEN__"

// StableHost is the portless name of the UI.
const StableHost = "portplane.localhost"

// Server holds what the handlers need.
type Server struct {
	Hub   *hub.Hub
	UI    fs.FS
	Token string
	// Port is the loopback port the server listens on (for the Host check).
	Port int
	// PublicURL is https://portplane.localhost when portless serves it.
	PublicURL string
	// Dev allows any *.localhost Host and requests without a token, so the
	// Vite dev server can proxy to it. Never use it outside development.
	Dev bool
	// Folders reads and replaces the local machine's folders (and saves them).
	GetFolders func() []string
	SetFolders func(ctx context.Context, folders []string) error
	// Desktop actions; replaceable in tests.
	OpenURL    func(string) error
	Reveal     func(string) error
	PickFolder func(context.Context) (string, error)
	CanPick    func() bool
	// ShowWindow brings up the Portplane window (a second start asks the
	// running one through POST /api/window), with the second start's XDG
	// activation token when it has one. Nil: the route answers 404.
	ShowWindow func(activationToken string)
	// Jobs are the long operations the UI follows (installs, the proxy
	// service). Nil: the job routes answer 404 and the stream sends none.
	Jobs *jobs.Manager
	// Extra handlers registered by later milestones (setup, machines).
	Extra map[string]http.HandlerFunc
}

// NewToken returns a random 256-bit token.
func NewToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// Handler returns the full HTTP handler.
func (s *Server) Handler() http.Handler {
	if s.OpenURL == nil {
		s.OpenURL = desktop.OpenURL
	}
	if s.Reveal == nil {
		s.Reveal = desktop.Reveal
	}
	if s.PickFolder == nil {
		s.PickFolder = desktop.PickFolder
	}
	if s.CanPick == nil {
		s.CanPick = desktop.CanPickFolder
	}
	api := http.NewServeMux()
	api.HandleFunc("GET /api/info", s.info)
	api.HandleFunc("GET /api/snapshot", s.snapshot)
	api.HandleFunc("GET /api/events", s.events)
	api.HandleFunc("POST /api/actions", s.action)
	api.HandleFunc("POST /api/runners/up", s.runnerUp)
	api.HandleFunc("GET /api/excerpt", s.excerpt)
	api.HandleFunc("POST /api/open", s.open)
	api.HandleFunc("POST /api/reveal", s.reveal)
	api.HandleFunc("GET /api/settings", s.getSettings)
	api.HandleFunc("PUT /api/settings", s.putSettings)
	api.HandleFunc("POST /api/folders/pick", s.pickFolder)
	api.HandleFunc("POST /api/window", s.showWindow)
	api.HandleFunc("GET /api/jobs", s.listJobs)
	api.HandleFunc("GET /api/jobs/{id}", s.getJob)
	api.HandleFunc("POST /api/jobs/{id}/cancel", s.cancelJob)
	for pattern, h := range s.Extra {
		api.HandleFunc(pattern, h)
	}

	mux := http.NewServeMux()
	mux.Handle("/api/", s.requireToken(api))
	mux.HandleFunc("/", s.static)
	return s.guard(mux)
}

// guard enforces the Host allowlist and sets security headers.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.allowedHost(r.Host) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if o := r.Header.Get("Origin"); o != "" && !s.allowedOrigin(o) {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) allowedHost(host string) bool {
	h, port, err := net.SplitHostPort(host)
	if err != nil {
		h, port = host, ""
	}
	h = strings.ToLower(strings.TrimSuffix(h, "."))
	switch h {
	case StableHost:
		return true
	case "127.0.0.1", "localhost", "::1":
		return port == strconv.Itoa(s.Port) || (s.Dev && port != "")
	}
	return s.Dev && strings.HasSuffix(h, ".localhost")
}

func (s *Server) allowedOrigin(origin string) bool {
	o := strings.TrimPrefix(strings.TrimPrefix(origin, "https://"), "http://")
	if o == origin { // not http(s)
		return false
	}
	return s.allowedHost(o)
}

func (s *Server) requireToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.Dev {
			got := r.Header.Get("X-Portplane-Token")
			if got == "" && r.URL.Path == "/api/events" {
				got = r.URL.Query().Get("token")
			}
			if subtle.ConstantTimeCompare([]byte(got), []byte(s.Token)) != 1 {
				writeError(w, http.StatusUnauthorized, errors.New("missing or wrong token: reload the page"))
				return
			}
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); ct != "application/json" {
				writeError(w, http.StatusUnsupportedMediaType, errors.New("send JSON"))
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return errors.New("invalid request: " + err.Error())
	}
	return nil
}

// Info is GET /api/info.
type Info struct {
	Version string `json:"version"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
	URL     string `json:"url"`
	Picker  bool   `json:"picker"`
}

func (s *Server) info(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, Info{Version: buildinfo.Version(), OS: runtime.GOOS, Arch: runtime.GOARCH, URL: s.PublicURL, Picker: s.CanPick()})
}

func (s *Server) snapshot(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Hub.Snapshot())
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, errors.New("streaming unsupported"))
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	ctx := r.Context()
	updates := s.Hub.Subscribe(ctx)
	var jobUpdates <-chan jobs.Job
	if s.Jobs != nil {
		jobUpdates = s.Jobs.Subscribe(ctx)
	}
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	send := func(event string, v any) bool {
		b, err := json.Marshal(v)
		if err != nil {
			return false
		}
		if _, err := io.WriteString(w, "event: "+event+"\ndata: "); err != nil {
			return false
		}
		if _, err := w.Write(b); err != nil {
			return false
		}
		if _, err := io.WriteString(w, "\n\n"); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	for {
		select {
		case <-ctx.Done():
			return
		case snap := <-updates:
			if !send("snapshot", snap) {
				return
			}
		case j := <-jobUpdates:
			if !send("job", j) {
				return
			}
		case <-ping.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

type actionRequest struct {
	Target model.Target `json:"target"`
	Verb   model.Verb   `json:"verb"`
}

func (s *Server) action(w http.ResponseWriter, r *http.Request) {
	var req actionRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	a, err := s.Hub.Agent(req.Target.Machine)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	if err := a.Act(r.Context(), req.Target, req.Verb); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusAccepted, struct{}{})
}

type runnerRequest struct {
	Machine string `json:"machine"`
	Runner  string `json:"runner"`
}

func (s *Server) runnerUp(w http.ResponseWriter, r *http.Request) {
	var req runnerRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	a, err := s.Hub.Agent(req.Machine)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	if err := a.Up(r.Context(), req.Runner); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusAccepted, struct{}{})
}

func (s *Server) excerpt(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	a, err := s.Hub.Agent(q.Get("machine"))
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	ex, err := a.Excerpt(r.Context(), q.Get("runner"), q.Get("task"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, ex)
}

type openRequest struct {
	Machine string   `json:"machine"`
	URLs    []string `json:"urls"`
}

func (s *Server) open(w http.ResponseWriter, r *http.Request) {
	var req openRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if len(req.URLs) > 50 {
		writeError(w, http.StatusBadRequest, errors.New("too many URLs"))
		return
	}
	for _, u := range req.URLs {
		if err := s.OpenURL(u); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listJobs(w http.ResponseWriter, _ *http.Request) {
	if s.Jobs == nil {
		writeJSON(w, http.StatusOK, []jobs.Job{})
		return
	}
	writeJSON(w, http.StatusOK, s.Jobs.List())
}

func (s *Server) getJob(w http.ResponseWriter, r *http.Request) {
	if s.Jobs != nil {
		if j, ok := s.Jobs.Get(r.PathValue("id")); ok {
			writeJSON(w, http.StatusOK, j)
			return
		}
	}
	writeError(w, http.StatusNotFound, jobs.ErrNotFound)
}

func (s *Server) cancelJob(w http.ResponseWriter, r *http.Request) {
	if s.Jobs == nil || s.Jobs.Cancel(r.PathValue("id")) != nil {
		writeError(w, http.StatusNotFound, jobs.ErrNotFound)
		return
	}
	writeJSON(w, http.StatusAccepted, struct{}{})
}

// StartJob answers a request that starts a job: 202 with the job.
func StartJob(w http.ResponseWriter, j jobs.Job) {
	writeJSON(w, http.StatusAccepted, j)
}

// WindowRequest is POST /api/window. Token is an XDG activation token, so
// Wayland lets the window take focus.
type WindowRequest struct {
	Token string `json:"token,omitempty"`
}

func (s *Server) showWindow(w http.ResponseWriter, r *http.Request) {
	if s.ShowWindow == nil {
		writeError(w, http.StatusNotFound, errors.New("no window to show"))
		return
	}
	var req WindowRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	s.ShowWindow(req.Token)
	w.WriteHeader(http.StatusNoContent)
}

type revealRequest struct {
	Machine string `json:"machine"`
	Path    string `json:"path"`
}

func (s *Server) reveal(w http.ResponseWriter, r *http.Request) {
	var req revealRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	snap := s.Hub.Snapshot()
	var local *model.MachineSnapshot
	for i, m := range snap.Machines {
		if m.Machine.ID == req.Machine && m.Machine.Local {
			local = &snap.Machines[i]
		}
	}
	if local == nil {
		writeError(w, http.StatusBadRequest, errors.New("folders can only be revealed on this machine"))
		return
	}
	// Only folders Portplane shows: chosen folders, projects, apps and ports.
	known := map[string]bool{}
	for _, f := range local.Folders {
		known[f] = true
	}
	for _, r := range local.Runners {
		known[r.Root] = true
	}
	for _, a := range local.Apps {
		known[a.Dir] = true
	}
	for _, p := range local.OtherPorts {
		known[p.Dir] = true
	}
	if req.Path == "" || !known[req.Path] {
		writeError(w, http.StatusBadRequest, errors.New("unknown folder"))
		return
	}
	if err := s.Reveal(req.Path); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type settingsBody struct {
	Folders []string `json:"folders"`
}

func (s *Server) getSettings(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, settingsBody{Folders: s.GetFolders()})
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	var req settingsBody
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if req.Folders == nil {
		req.Folders = []string{}
	}
	if err := s.SetFolders(r.Context(), req.Folders); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, settingsBody{Folders: s.GetFolders()})
}

func (s *Server) pickFolder(w http.ResponseWriter, r *http.Request) {
	p, err := s.PickFolder(r.Context())
	switch {
	case errors.Is(err, desktop.ErrUnsupported):
		writeError(w, http.StatusNotImplemented, err)
	case errors.Is(err, desktop.ErrCancelled):
		w.WriteHeader(http.StatusNoContent)
	case err != nil:
		writeError(w, http.StatusInternalServerError, err)
	default:
		writeJSON(w, http.StatusOK, map[string]string{"path": p})
	}
}

// static serves the embedded UI, with the token written into index.html.
func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	if name != "index.html" {
		if f, err := s.UI.Open(name); err == nil {
			fi, err := f.Stat()
			_ = f.Close()
			if err == nil && !fi.IsDir() {
				if strings.HasPrefix(name, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				http.ServeFileFS(w, r, s.UI, name)
				return
			}
		}
	}
	b, err := fs.ReadFile(s.UI, "index.html")
	if err != nil {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, "The Portplane UI was not built into this binary. Run `mise run build`.\n")
		return
	}
	b = bytes.ReplaceAll(b, []byte(TokenPlaceholder), []byte(s.Token))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(b)
}

// Listen opens a loopback listener on addr ("127.0.0.1:0" for a free port).
// It refuses non-loopback addresses (ADR-0008).
func Listen(ctx context.Context, addr string) (net.Listener, int, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, 0, err
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return nil, 0, errors.New("portplane only listens on loopback (127.0.0.1 or ::1)")
	}
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", addr)
	if err != nil {
		return nil, 0, err
	}
	return ln, ln.Addr().(*net.TCPAddr).Port, nil
}
