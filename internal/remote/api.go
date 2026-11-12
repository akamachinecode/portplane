package remote

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/jobs"
)

// The machine API over the agent protocol (ADR-0026). Portplane sends an
// area request (setup, dekit, portless) to a remote machine's agent, which
// serves it with the handlers Portplane uses for this computer, built for
// its own machine. The agent never listens on a port: requests arrive only
// on its own stdin, from the Portplane that started it.

// APIRequest is one HTTP request, as the `http` method carries it.
type APIRequest struct {
	Method string `json:"method"`
	Path   string `json:"path"`            // /api/…
	Query  string `json:"query,omitempty"` // without the "?"
	Body   []byte `json:"body,omitempty"`  // JSON
}

// APIResponse is the agent's answer to an APIRequest.
type APIResponse struct {
	Status int               `json:"status"`
	Header map[string]string `json:"header,omitempty"`
	Body   []byte            `json:"body,omitempty"`
}

// Body limits: requests are as small as the local API takes (1 MiB);
// answers can carry a dekit help index or a certificate.
const (
	MaxAPIRequest  = 1 << 20
	MaxAPIResponse = 16 << 20
)

// ErrAgentTooOld means the machine's agent predates the machine API: it
// answers "unknown method". Reinstalling it brings this Portplane's.
var ErrAgentTooOld = errors.New("the agent on that machine is older than this Portplane")

// ServeOptions is what an agent serves besides its snapshots.
type ServeOptions struct {
	// API serves Portplane's area requests for this machine. Nil answers
	// like an agent from before ADR-0026: "unknown method".
	API http.Handler
	// Jobs are this machine's long operations; their changes are pushed
	// as `job` notifications once Portplane asks with `watchJobs`.
	Jobs *jobs.Manager
	// OnHello runs when Portplane says hello with the machine's id.
	OnHello func(Hello)
}

// apiTimeout caps one tunnelled request (a dekit reload that restarts
// tasks is the slowest).
const apiTimeout = 5 * time.Minute

// answerHeaders are the response headers that travel back.
var answerHeaders = []string{"Content-Type", "Content-Disposition", "Cache-Control"}

func serveAPI(ctx context.Context, h http.Handler, req APIRequest) (APIResponse, error) {
	if !strings.HasPrefix(req.Path, "/api/") || strings.Contains(req.Path, "..") {
		return APIResponse{}, fmt.Errorf("not an API path: %q", req.Path)
	}
	if len(req.Body) > MaxAPIRequest {
		return APIResponse{}, errors.New("request too large")
	}
	switch req.Method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete:
	default:
		return APIResponse{}, fmt.Errorf("method %q not allowed", req.Method)
	}
	ctx, cancel := context.WithTimeout(ctx, apiTimeout)
	defer cancel()
	target := req.Path
	if req.Query != "" {
		target += "?" + req.Query
	}
	r, err := http.NewRequestWithContext(ctx, req.Method, target, bytes.NewReader(req.Body))
	if err != nil {
		return APIResponse{}, err
	}
	if req.Method != http.MethodGet {
		r.Header.Set("Content-Type", "application/json")
	}
	rec := &recorder{header: http.Header{}}
	h.ServeHTTP(rec, r)
	if rec.over {
		return APIResponse{}, errors.New("the answer is too large to send")
	}
	res := APIResponse{Status: rec.status, Body: rec.body.Bytes(), Header: map[string]string{}}
	if res.Status == 0 {
		res.Status = http.StatusOK
	}
	for _, k := range answerHeaders {
		if v := rec.header.Get(k); v != "" {
			res.Header[k] = v
		}
	}
	return res, nil
}

// recorder keeps a handler's answer in memory.
type recorder struct {
	header http.Header
	status int
	body   bytes.Buffer
	over   bool
}

func (r *recorder) Header() http.Header { return r.header }

func (r *recorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
}

func (r *recorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	if r.body.Len()+len(b) > MaxAPIResponse {
		r.over = true
		return 0, errors.New("answer too large")
	}
	return r.body.Write(b)
}

// Flush is a no-op: the answer travels whole.
func (r *recorder) Flush() {}

// API sends an area request to the machine's agent and returns its answer.
// It returns ErrOffline while the machine is not connected and
// ErrAgentTooOld when its agent cannot serve requests.
func (a *Agent) API(ctx context.Context, req APIRequest) (APIResponse, error) {
	var res APIResponse
	err := a.call(ctx, "http", req, &res)
	if err != nil && isUnknownMethod(err, "http") {
		return res, ErrAgentTooOld
	}
	return res, err
}

func isUnknownMethod(err error, method string) bool {
	return err != nil && strings.HasPrefix(err.Error(), "unknown method \""+method+"\"")
}

// MirrorJobs follows the machine's jobs in m: every change reaches m (and
// so the event stream) as it happens, and the ones still running when the
// connection drops end as failed. Each one is "<machine>:<id>" there.
func (a *Agent) MirrorJobs(m *jobs.Manager) {
	a.mu.Lock()
	a.jobs = m
	a.mu.Unlock()
}

func (a *Agent) mirrorJob(j jobs.Job) {
	a.mu.Lock()
	sink, id := a.jobs, a.id
	a.mu.Unlock()
	if sink == nil || j.ID == "" {
		return
	}
	remoteID := j.ID
	// The agent names its jobs after the machine; anything else is
	// renamed, so a remote job can never stand in for a local one.
	if !strings.HasPrefix(j.ID, id+":") {
		j.ID = id + ":" + j.ID
	}
	j.Machine = id
	sink.Mirror(j, func() {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			_, _ = a.API(ctx, APIRequest{Method: http.MethodPost, Path: "/api/jobs/" + url.PathEscape(remoteID) + "/cancel", Body: []byte("{}")})
		}()
	})
}

// abandonJobs ends the mirrored jobs that were running when the
// connection dropped.
func (a *Agent) abandonJobs() {
	a.mu.Lock()
	sink, id, name := a.jobs, a.id, a.name
	a.mu.Unlock()
	if sink != nil {
		sink.Abandon(id, fmt.Sprintf("The connection to %s dropped before this finished. Check %s once it is back: it may have finished there.", name, name))
	}
}

// AgentVersion is the version the agent reported when it connected.
func (a *Agent) AgentVersion() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.hello.Version
}

// Reinstall uploads the agent again and reconnects. It is how an agent
// older than this Portplane gets updated.
func (a *Agent) Reinstall() {
	if r, ok := a.conn.(interface{ Reset() }); ok {
		r.Reset()
	}
	a.mu.Lock()
	sess := a.sess
	a.mu.Unlock()
	if sess != nil {
		_ = sess.Close()
	}
}
