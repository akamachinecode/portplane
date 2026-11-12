package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/akamachinecode/portplane/internal/browsertrust"
	"github.com/akamachinecode/portplane/internal/installer"
	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/portless"
	"github.com/akamachinecode/portplane/internal/privileged"
	"github.com/akamachinecode/portplane/internal/setup"
)

// ToolsDeps wires the guided setup's endpoints (M5.1): the system check,
// installs, the proxy, browser trust, PATH and folder suggestions. Every
// endpoint takes the user's choices, never a command (ADR-0020).
type ToolsDeps struct {
	Jobs *jobs.Manager
	GOOS string
	// Check runs the system check; only limits it to some checks.
	Check func(ctx context.Context, only []string) setup.Check
	// Install installs a tool; Steps lists its stages for a method and
	// refuses a method it does not know.
	Install func(ctx context.Context, tool, method string, p installer.Progress) (any, error)
	Steps   func(tool, method string) ([]string, error)
	// Refresh runs after an install: PATH lookups and the snapshot's tools.
	Refresh func()

	// ServiceCommand is `portless service install` for options.
	ServiceCommand func(o portless.ProxyOptions) (privileged.Command, error)
	// RunPrivileged runs a command through the system's password dialog
	// (privileged.Run).
	RunPrivileged func(ctx context.Context, c privileged.Command, out io.Writer) error
	// AdminMethod is how this system asks (privileged.Method).
	AdminMethod func() string
	// ProxyStart starts the proxy as the user.
	ProxyStart func(ctx context.Context, o portless.ProxyOptions) (string, error)
	// VerifyProxy checks after the proxy changed: it answers, the CA is
	// trusted, https://portplane.localhost loads. It logs to p and
	// returns what it found.
	VerifyProxy func(ctx context.Context, o portless.ProxyOptions, p installer.Progress) (ProxyResult, error)

	// Browsers reports the browsers' trust; TrustBrowser adds the CA to
	// one profile.
	Browsers     func(ctx context.Context) browsertrust.Report
	TrustBrowser func(ctx context.Context, browser, profile string, out io.Writer) (browsertrust.Profile, error)
	// TrustCommand is `portless trust`, and whether it needs an
	// administrator here (Linux); RunAsUser runs it otherwise.
	TrustCommand func() (privileged.Command, bool, error)
	RunAsUser    func(ctx context.Context, argv []string, env map[string]string, out io.Writer) error

	PathStatus  func(ctx context.Context) installer.PathStatus
	AddToPath   func(ctx context.Context) (installer.PathStatus, error)
	Suggestions func() []setup.FolderSuggestion
}

// ProxyResult is what a proxy job found when it ended.
type ProxyResult struct {
	URL          string `json:"url"`       // https://portplane.localhost[:port]
	Answers      bool   `json:"answers"`   // the proxy answers like portless
	CATrusted    bool   `json:"caTrusted"` // the system trusts the CA
	Loads        bool   `json:"loads"`     // the URL loads with a trusted certificate
	Terminal     string `json:"terminal"`  // the command, to run by hand
	Unprivileged bool   `json:"unprivileged"`
}

// CommandPreview is a privileged command as the UI shows it before the
// click: one argument per line, the environment, and the same for a
// terminal.
type CommandPreview struct {
	Argv []string          `json:"argv"`
	Env  map[string]string `json:"env"`
	// Terminal is what to paste in a terminal to do it by hand.
	Terminal string `json:"terminal"`
	// Admin is how the system will ask: pkexec, osascript, uac, or ""
	// when it cannot and the user runs Terminal instead.
	Admin string `json:"admin"`
	// NeedsAdmin is false when the step runs as the user.
	NeedsAdmin bool `json:"needsAdmin"`
}

type installRequest struct {
	Tool   string `json:"tool"`
	Method string `json:"method,omitempty"`
}

type proxyRequest struct {
	Options *portless.ProxyOptions `json:"options,omitempty"`
}

type trustBrowserRequest struct {
	Browser string `json:"browser"`
	Profile string `json:"profile"`
}

var toolNames = map[string]string{installer.Dekit: "dekit", installer.Node: "Node.js 24", installer.Portless: "portless"}

func (d ToolsDeps) preview(c privileged.Command, needsAdmin bool) CommandPreview {
	env := map[string]string{}
	for k, v := range c.Env {
		env[k] = v
	}
	p := CommandPreview{Argv: c.Argv, Env: env, NeedsAdmin: needsAdmin}
	if needsAdmin {
		p.Terminal = privileged.Terminal(c, d.GOOS)
		if d.AdminMethod != nil {
			p.Admin = d.AdminMethod()
		}
	} else {
		parts := make([]string, len(c.Argv))
		for i, a := range c.Argv {
			parts[i] = privileged.ShellQuote(a)
		}
		p.Terminal = strings.Join(parts, " ")
	}
	return p
}

// proxyOptions reads the options of a proxy request, with def for the
// ones left out, and refuses what portless would.
func proxyOptions(req proxyRequest, def portless.ProxyOptions) (portless.ProxyOptions, error) {
	o := def
	if req.Options != nil {
		o = *req.Options
		if o.Port == 0 {
			o.Port = def.Port
		}
	}
	for _, p := range []string{o.CertPath, o.KeyPath} {
		if p != "" && !filepath.IsAbs(p) {
			return o, fmt.Errorf("give the certificate and its key as full paths, not %q", p)
		}
	}
	return o, o.Validate()
}

// privilegedError turns a privileged run's error into what the user reads.
func privilegedError(err error, terminal string) error {
	switch {
	case errors.Is(err, privileged.ErrUnavailable):
		return fmt.Errorf("this computer can't show a password dialog here. Run this in a terminal, then check again: %s", terminal)
	case errors.Is(err, privileged.ErrDenied):
		return errors.New("the password dialog was closed, so nothing changed")
	}
	return err
}

// ToolsHandlers returns the guided setup's endpoints.
func ToolsHandlers(d ToolsDeps) map[string]http.HandlerFunc {
	refresh := func() {
		if d.Refresh != nil {
			d.Refresh()
		}
	}
	h := map[string]http.HandlerFunc{
		"GET /api/setup/check": func(w http.ResponseWriter, r *http.Request) {
			var only []string
			if q := r.URL.Query().Get("only"); q != "" {
				for _, id := range strings.Split(q, ",") {
					if id = strings.TrimSpace(id); id != "" {
						only = append(only, id)
					}
				}
			}
			writeJSON(w, http.StatusOK, d.Check(r.Context(), only))
		},

		"POST /api/tools/install": func(w http.ResponseWriter, r *http.Request) {
			var req installRequest
			if err := decode(r, &req); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			name, ok := toolNames[req.Tool]
			if !ok {
				writeError(w, http.StatusBadRequest, fmt.Errorf("unknown tool %q: dekit, node or portless", req.Tool))
				return
			}
			steps, err := d.Steps(req.Tool, req.Method)
			if err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			job := d.Jobs.Start(jobs.Spec{Kind: "install", Title: "Install " + name, Key: "install:" + req.Tool, Steps: steps}, func(ctx context.Context, run *jobs.Run) error {
				defer refresh()
				res, err := d.Install(ctx, req.Tool, req.Method, run)
				if err != nil {
					return err
				}
				run.SetResult(res)
				return nil
			})
			StartJob(w, job)
		},

		"POST /api/proxy/service/preview": func(w http.ResponseWriter, r *http.Request) {
			var req proxyRequest
			if err := decode(r, &req); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			o, err := proxyOptions(req, portless.DefaultProxyOptions())
			if err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			cmd, err := d.ServiceCommand(o)
			if err != nil {
				writeError(w, http.StatusConflict, err)
				return
			}
			writeJSON(w, http.StatusOK, d.preview(cmd, true))
		},

		"POST /api/proxy/service/install": func(w http.ResponseWriter, r *http.Request) {
			var req proxyRequest
			if err := decode(r, &req); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			o, err := proxyOptions(req, portless.DefaultProxyOptions())
			if err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			cmd, err := d.ServiceCommand(o)
			if err != nil {
				writeError(w, http.StatusConflict, err)
				return
			}
			terminal := privileged.Terminal(cmd, d.GOOS)
			steps := []string{"Ask for your password", "Install the proxy service", "Check that the proxy answers", "Check the certificate", "Open https://portplane.localhost"}
			job := d.Jobs.Start(jobs.Spec{Kind: "proxy-service", Title: "Install the proxy service", Key: "proxy", Steps: steps, Privileged: true}, func(ctx context.Context, run *jobs.Run) error {
				defer refresh()
				run.Step(steps[0])
				run.Logf("$ %s", terminal)
				err := d.RunPrivileged(ctx, cmd, &stepOnOutput{w: run, step: func() { run.Step(steps[1]) }})
				if err != nil {
					run.SetResult(ProxyResult{Terminal: terminal})
					return privilegedError(err, terminal)
				}
				run.Step(steps[1])
				res, err := d.VerifyProxy(ctx, o, run)
				res.Terminal = terminal
				run.SetResult(res)
				return err
			})
			StartJob(w, job)
		},

		"POST /api/proxy/start": func(w http.ResponseWriter, r *http.Request) {
			var req proxyRequest
			if err := decode(r, &req); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			o, err := proxyOptions(req, portless.UnprivilegedProxyOptions())
			if err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			if o.NeedsAdmin() {
				writeError(w, http.StatusBadRequest, fmt.Errorf("port %d needs your password on this computer: install the proxy service instead, or use port %d", o.Port, portless.UnprivilegedPort))
				return
			}
			title := "Start the proxy on port " + strconv.Itoa(o.Port)
			steps := []string{title, "Check that the proxy answers", "Check the certificate", "Open https://portplane.localhost"}
			job := d.Jobs.Start(jobs.Spec{Kind: "proxy-start", Title: title, Key: "proxy", Steps: steps}, func(ctx context.Context, run *jobs.Run) error {
				defer refresh()
				run.Step(steps[0])
				run.Logf("$ portless %s", strings.Join(portless.ProxyStartArgs(o), " "))
				out, err := d.ProxyStart(ctx, o)
				if out != "" {
					_, _ = io.WriteString(run, strings.TrimRight(out, "\n")+"\n")
				}
				if err != nil {
					return err
				}
				res, err := d.VerifyProxy(ctx, o, run)
				res.Unprivileged = true
				run.SetResult(res)
				return err
			})
			StartJob(w, job)
		},

		"GET /api/trust/browsers": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, d.Browsers(r.Context()))
		},

		"POST /api/trust/browser": func(w http.ResponseWriter, r *http.Request) {
			var req trustBrowserRequest
			if err := decode(r, &req); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			var out strings.Builder
			p, err := d.TrustBrowser(r.Context(), req.Browser, req.Profile, &out)
			switch {
			case errors.Is(err, browsertrust.ErrNotFound):
				writeError(w, http.StatusNotFound, err)
			case err != nil:
				writeError(w, http.StatusUnprocessableEntity, err)
			default:
				writeJSON(w, http.StatusOK, p)
			}
		},

		"GET /api/trust/system": func(w http.ResponseWriter, _ *http.Request) {
			cmd, admin, err := d.TrustCommand()
			if err != nil {
				writeError(w, http.StatusConflict, err)
				return
			}
			writeJSON(w, http.StatusOK, d.preview(cmd, admin))
		},

		"POST /api/trust/system": func(w http.ResponseWriter, r *http.Request) {
			var body struct{}
			if err := decode(r, &body); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			cmd, admin, err := d.TrustCommand()
			if err != nil {
				writeError(w, http.StatusConflict, err)
				return
			}
			pv := d.preview(cmd, admin)
			steps := []string{"Trust the certificate", "Check the certificate"}
			if admin {
				steps = append([]string{"Ask for your password"}, steps...)
			}
			job := d.Jobs.Start(jobs.Spec{Kind: "trust", Title: "Trust the local certificate", Key: "trust", Steps: steps, Privileged: admin}, func(ctx context.Context, run *jobs.Run) error {
				defer refresh()
				run.Logf("$ %s", pv.Terminal)
				if admin {
					run.Step(steps[0])
					if err := d.RunPrivileged(ctx, cmd, &stepOnOutput{w: run, step: func() { run.Step(steps[1]) }}); err != nil {
						run.SetResult(ProxyResult{Terminal: pv.Terminal})
						return privilegedError(err, pv.Terminal)
					}
				} else {
					run.Step(steps[0])
					if err := d.RunAsUser(ctx, cmd.Argv, cmd.Env, run); err != nil {
						return err
					}
				}
				run.Step(steps[len(steps)-1])
				return nil
			})
			StartJob(w, job)
		},

		"GET /api/path/profile": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, d.PathStatus(r.Context()))
		},

		"POST /api/path/profile": func(w http.ResponseWriter, r *http.Request) {
			var body struct{}
			if err := decode(r, &body); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			st, err := d.AddToPath(r.Context())
			if err != nil {
				writeError(w, http.StatusInternalServerError, fmt.Errorf("could not change %s: %w", st.File, err))
				return
			}
			writeJSON(w, http.StatusOK, st)
		},

		"GET /api/folders/suggestions": func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, d.Suggestions())
		},
	}
	return h
}

// stepOnOutput moves a job to its next step at the first output, which
// is when the password dialog was answered.
type stepOnOutput struct {
	w     io.Writer
	step  func()
	moved bool
}

func (s *stepOnOutput) Write(p []byte) (int, error) {
	if !s.moved && len(p) > 0 {
		s.moved = true
		s.step()
	}
	return s.w.Write(p)
}
