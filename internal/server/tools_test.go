package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/akamachinecode/portplane/internal/browsertrust"
	"github.com/akamachinecode/portplane/internal/installer"
	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/portless"
	"github.com/akamachinecode/portplane/internal/privileged"
	"github.com/akamachinecode/portplane/internal/setup"
)

type toolsFake struct {
	installed  []string
	privErr    error
	privRan    []privileged.Command
	started    []portless.ProxyOptions
	refreshed  int
	pathAdded  int
	asUser     [][]string
	trustAdmin bool
	only       []string
}

func newToolsServer(t *testing.T, f *toolsFake) (*jobs.Manager, http.Handler) {
	t.Helper()
	s, _, _ := newTestServer(t)
	m := jobs.NewManager()
	s.Jobs = m
	cmd := privileged.Command{Argv: []string{"/home/dev/.local/bin/portless", "service", "install", "--port", "443", "--https"}, Env: map[string]string{"HOME": "/home/dev"}}
	s.Extra = ToolsHandlers(ToolsDeps{
		Jobs: m, GOOS: "linux",
		Check: func(_ context.Context, only []string) setup.Check {
			f.only = only
			return setup.Check{Requirements: []setup.Requirement{{ID: "dekit", OK: true, Status: "ok"}}, Ready: true}
		},
		Steps: func(tool, method string) ([]string, error) {
			if tool == installer.Node && method != "" && method != "private" && method != "mise" {
				return nil, errors.New("unknown way to install Node.js")
			}
			return []string{"Download", "Check"}, nil
		},
		Install: func(_ context.Context, tool, _ string, p installer.Progress) (any, error) {
			p.Step("Download")
			p.Logf("downloading %s", tool)
			if tool == installer.Portless {
				return nil, errors.New("npm could not install portless: npm exited with status 1")
			}
			f.installed = append(f.installed, tool)
			return map[string]string{"version": "1.0.0"}, nil
		},
		Refresh: func() { f.refreshed++ },
		ServiceCommand: func(o portless.ProxyOptions) (privileged.Command, error) {
			c := cmd
			c.Argv = append([]string{c.Argv[0], "service", "install"}, o.Args()...)
			return c, nil
		},
		RunPrivileged: func(_ context.Context, c privileged.Command, out io.Writer) error {
			f.privRan = append(f.privRan, c)
			if f.privErr != nil {
				return f.privErr
			}
			_, _ = io.WriteString(out, "Portless service installed.\n")
			return nil
		},
		AdminMethod: func() string { return "pkexec" },
		ProxyStart: func(_ context.Context, o portless.ProxyOptions) (string, error) {
			f.started = append(f.started, o)
			return "Proxy started on port 1355\n", nil
		},
		VerifyProxy: func(_ context.Context, o portless.ProxyOptions, p installer.Progress) (ProxyResult, error) {
			p.Step("Check that the proxy answers")
			return ProxyResult{URL: "https://portplane.localhost", Answers: true, CATrusted: true, Loads: true}, nil
		},
		Browsers: func(context.Context) browsertrust.Report {
			return browsertrust.Report{CAExists: true, Browsers: []browsertrust.Browser{{ID: "firefox", Name: "Firefox", Profiles: []browsertrust.Profile{{ID: "firefox:abc", Status: browsertrust.Missing, CanAdd: true}}}}}
		},
		TrustBrowser: func(_ context.Context, browser, profile string, out io.Writer) (browsertrust.Profile, error) {
			if profile != "firefox:abc" {
				return browsertrust.Profile{}, browsertrust.ErrNotFound
			}
			return browsertrust.Profile{ID: profile, Status: browsertrust.Trusted}, nil
		},
		TrustCommand: func() (privileged.Command, bool, error) {
			return privileged.Command{Argv: []string{"/home/dev/.local/bin/portless", "trust"}, Env: map[string]string{"HOME": "/home/dev"}}, f.trustAdmin, nil
		},
		RunAsUser: func(_ context.Context, argv []string, _ map[string]string, out io.Writer) error {
			f.asUser = append(f.asUser, argv)
			return nil
		},
		PathStatus: func(context.Context) installer.PathStatus {
			return installer.PathStatus{Dir: "/home/dev/.local/bin", Shell: "zsh", File: "/home/dev/.zshrc", Line: `export PATH="$HOME/.local/bin:$PATH"`}
		},
		AddToPath: func(context.Context) (installer.PathStatus, error) {
			f.pathAdded++
			return installer.PathStatus{Dir: "/home/dev/.local/bin", OnPath: true, Present: true}, nil
		},
		Suggestions: func() []setup.FolderSuggestion {
			return []setup.FolderSuggestion{{Path: "/home/dev/code", Repos: 4}}
		},
	})
	return m, s.Handler()
}

func call(h http.Handler, method, url, body string) *httpResult {
	rec := do(h, method, url, "127.0.0.1:4799", "secret", body)
	return &httpResult{code: rec.Code, body: rec.Body.String()}
}

type httpResult struct {
	code int
	body string
}

func (r *httpResult) job(t *testing.T) jobs.Job {
	t.Helper()
	if r.code != http.StatusAccepted {
		t.Fatalf("want 202, got %d: %s", r.code, r.body)
	}
	var j jobs.Job
	if err := json.Unmarshal([]byte(r.body), &j); err != nil {
		t.Fatal(err)
	}
	return j
}

func wait(t *testing.T, m *jobs.Manager, id string) jobs.Job {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	j, err := m.Wait(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func TestSetupCheckOnly(t *testing.T) {
	f := &toolsFake{}
	_, h := newToolsServer(t, f)
	r := call(h, "GET", "/api/setup/check?only=port,%20ca,", "")
	if r.code != 200 || !strings.Contains(r.body, `"ready":true`) {
		t.Fatalf("%d %s", r.code, r.body)
	}
	if strings.Join(f.only, ",") != "port,ca" {
		t.Errorf("only: %v", f.only)
	}
}

func TestInstallTool(t *testing.T) {
	f := &toolsFake{}
	m, h := newToolsServer(t, f)
	j := call(h, "POST", "/api/tools/install", `{"tool":"dekit"}`).job(t)
	if j.Kind != "install" || j.Title != "Install dekit" || len(j.Steps) != 2 {
		t.Errorf("job: %+v", j)
	}
	done := wait(t, m, j.ID)
	if done.State != jobs.Succeeded || len(f.installed) != 1 || f.refreshed != 1 {
		t.Errorf("done: %+v %v %d", done, f.installed, f.refreshed)
	}
	if !strings.Contains(strings.Join(done.Output, "\n"), "downloading dekit") {
		t.Errorf("output: %v", done.Output)
	}

	failed := wait(t, m, call(h, "POST", "/api/tools/install", `{"tool":"portless","method":"private"}`).job(t).ID)
	if failed.State != jobs.Failed || !strings.Contains(failed.Error, "npm could not install portless") || f.refreshed != 2 {
		t.Errorf("failed install: %+v", failed)
	}

	for body, want := range map[string]int{
		`{"tool":"docker"}`:             400,
		`{"tool":"node","method":"x"}`:  400,
		`{"tool":"node","argv":["sh"]}`: 400, // a command is never accepted
		`not json`:                      400,
	} {
		if r := call(h, "POST", "/api/tools/install", body); r.code != want {
			t.Errorf("%s: %d %s", body, r.code, r.body)
		}
	}
}

func TestProxyServicePreviewAndInstall(t *testing.T) {
	f := &toolsFake{}
	m, h := newToolsServer(t, f)
	r := call(h, "POST", "/api/proxy/service/preview", `{"options":{"port":443,"https":true,"tlds":["localhost","test"],"wildcard":true}}`)
	var pv CommandPreview
	if err := json.Unmarshal([]byte(r.body), &pv); err != nil || r.code != 200 {
		t.Fatalf("%d %s", r.code, r.body)
	}
	if !pv.NeedsAdmin || pv.Admin != "pkexec" || !strings.HasPrefix(pv.Terminal, "sudo env HOME=/home/dev ") || !strings.Contains(strings.Join(pv.Argv, " "), "--tld localhost --tld test --wildcard") {
		t.Errorf("preview: %+v", pv)
	}
	if r := call(h, "POST", "/api/proxy/service/preview", `{"options":{"port":70000,"https":true}}`); r.code != 400 {
		t.Errorf("bad port: %d", r.code)
	}
	if r := call(h, "POST", "/api/proxy/service/preview", `{"options":{"port":443,"https":true,"certPath":"cert.pem","keyPath":"key.pem"}}`); r.code != 400 {
		t.Errorf("relative certificate paths: %d", r.code)
	}

	j := call(h, "POST", "/api/proxy/service/install", `{}`).job(t)
	if !j.Privileged || j.Kind != "proxy-service" {
		t.Errorf("job: %+v", j)
	}
	done := wait(t, m, j.ID)
	if done.State != jobs.Succeeded || len(f.privRan) != 1 || strings.Join(f.privRan[0].Argv[1:], " ") != "service install --port 443 --https" {
		t.Errorf("default options: %+v %v", done, f.privRan)
	}
	res, _ := json.Marshal(done.Result)
	if !strings.Contains(string(res), `"loads":true`) || !strings.Contains(string(res), `"terminal":"sudo env HOME=/home/dev`) {
		t.Errorf("result: %s", res)
	}
}

func TestProxyServiceWithoutDialog(t *testing.T) {
	for err, want := range map[error]string{
		privileged.ErrUnavailable: "Run this in a terminal, then check again: sudo env HOME=/home/dev /home/dev/.local/bin/portless service install --port 443 --https",
		privileged.ErrDenied:      "the password dialog was closed, so nothing changed",
	} {
		f := &toolsFake{privErr: err}
		m, h := newToolsServer(t, f)
		done := wait(t, m, call(h, "POST", "/api/proxy/service/install", `{}`).job(t).ID)
		if done.State != jobs.Failed || !strings.Contains(done.Error, want) {
			t.Errorf("%v: %+v", err, done)
		}
		res, _ := json.Marshal(done.Result)
		if !strings.Contains(string(res), `"terminal":"sudo env`) {
			t.Errorf("the command to copy is in the result: %s", res)
		}
	}
}

func TestProxyStartWithoutPassword(t *testing.T) {
	f := &toolsFake{}
	m, h := newToolsServer(t, f)
	done := wait(t, m, call(h, "POST", "/api/proxy/start", `{}`).job(t).ID)
	if done.State != jobs.Succeeded || len(f.started) != 1 || f.started[0].Port != portless.UnprivilegedPort || done.Privileged {
		t.Errorf("1355: %+v %v", done, f.started)
	}
	res, _ := json.Marshal(done.Result)
	if !strings.Contains(string(res), `"unprivileged":true`) {
		t.Errorf("result: %s", res)
	}
}

func TestTrustEndpoints(t *testing.T) {
	f := &toolsFake{}
	m, h := newToolsServer(t, f)
	if r := call(h, "GET", "/api/trust/browsers", ""); r.code != 200 || !strings.Contains(r.body, `"firefox:abc"`) {
		t.Errorf("browsers: %d %s", r.code, r.body)
	}
	if r := call(h, "POST", "/api/trust/browser", `{"browser":"firefox","profile":"firefox:abc"}`); r.code != 200 || !strings.Contains(r.body, `"trusted"`) {
		t.Errorf("trust: %d %s", r.code, r.body)
	}
	if r := call(h, "POST", "/api/trust/browser", `{"browser":"firefox","profile":"/etc"}`); r.code != 404 {
		t.Errorf("unknown profile: %d", r.code)
	}
	if r := call(h, "POST", "/api/trust/browser", `{"browser":"firefox","profile":"x","dir":"/etc"}`); r.code != 400 {
		t.Errorf("a path is never accepted: %d", r.code)
	}

	// macOS and Windows: portless trust runs as the user.
	r := call(h, "GET", "/api/trust/system", "")
	if r.code != 200 || !strings.Contains(r.body, `"needsAdmin":false`) {
		t.Errorf("preview: %s", r.body)
	}
	done := wait(t, m, call(h, "POST", "/api/trust/system", `{}`).job(t).ID)
	if done.State != jobs.Succeeded || len(f.asUser) != 1 || done.Privileged {
		t.Errorf("as user: %+v", done)
	}
	// Linux: through the password dialog.
	f.trustAdmin = true
	done = wait(t, m, call(h, "POST", "/api/trust/system", `{}`).job(t).ID)
	if done.State != jobs.Succeeded || len(f.privRan) != 1 || !done.Privileged {
		t.Errorf("as admin: %+v", done)
	}
}

func TestPathAndSuggestions(t *testing.T) {
	f := &toolsFake{}
	_, h := newToolsServer(t, f)
	if r := call(h, "GET", "/api/path/profile", ""); r.code != 200 || !strings.Contains(r.body, `"file":"/home/dev/.zshrc"`) {
		t.Errorf("status: %s", r.body)
	}
	if r := call(h, "POST", "/api/path/profile", `{}`); r.code != 200 || f.pathAdded != 1 || !strings.Contains(r.body, `"onPath":true`) {
		t.Errorf("add: %d %s", r.code, r.body)
	}
	if r := call(h, "POST", "/api/path/profile", `{"line":"rm -rf ~"}`); r.code != 400 || f.pathAdded != 1 {
		t.Errorf("the line is never taken from the page: %d", r.code)
	}
	if r := call(h, "GET", "/api/folders/suggestions", ""); r.code != 200 || !strings.Contains(r.body, `"repos":4`) {
		t.Errorf("suggestions: %s", r.body)
	}
}
