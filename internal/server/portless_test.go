package server

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/envpath"
	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/portless"
	"github.com/akamachinecode/portplane/internal/privileged"
)

// The portless center's handlers run against a fake portless (a shell
// script that prints portless 0.16's recorded output and logs its
// arguments), a temporary state folder and a temporary dekit project.
// Nothing here touches the real ~/.portless or runs real portless.

const fakePortless = `#!/bin/sh
echo "$@" >> "$FAKE_LOG"
case "$1" in
  --version) echo "portless 0.16.0" ;;
  doctor) cat "$FAKE_FIXTURES/doctor-warnings.txt" ;;
  service) cat "$FAKE_STATUS" ;;
  prune) cat "$FAKE_FIXTURES/prune-some.txt" ;;
  get) echo "https://feature.$2.localhost" ;;
  compose) cat "$FAKE_FIXTURES/compose-up.txt" ;;
  alias)
    if [ "$2" = "taken" ]; then
      echo 'Error: "taken.localhost" is already registered by a running process (PID 4). Use --force to override.' >&2
      exit 1
    fi
    echo "Alias registered" ;;
  *) echo "ok" ;;
esac
`

type portlessFixture struct {
	t        *testing.T
	state    string
	log      string
	unit     string
	client   *portless.Client
	jobs     *jobs.Manager
	local    model.MachineSnapshot
	elevated []privileged.Command
	elevErr  error
	reloads  []string
	restarts []string
	mu       sync.Mutex
	handler  http.Handler
	project  string
	port     int

	// M5.6: fake tools (name and arguments → output), the programs found
	// on PATH, and what ran.
	tools     map[string]string
	toolErrs  map[string]error
	toolCalls []string
	programs  map[string]string
	execs     [][]string
	starts    []string
	onRestart func(task string)
	home      string
	memory    string
	listen    []Listener
	goos      string
}

func closedPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

func newPortlessFixture(t *testing.T) *portlessFixture {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake portless is a shell script")
	}
	f := &portlessFixture{t: t, state: t.TempDir(), jobs: jobs.NewManager(), port: closedPort(t), tools: map[string]string{}, toolErrs: map[string]error{}, programs: map[string]string{}, home: t.TempDir()}
	dir := t.TempDir()
	f.log = filepath.Join(dir, "calls.log")
	bin := filepath.Join(dir, "portless")
	if err := os.WriteFile(bin, []byte(fakePortless), 0o755); err != nil {
		t.Fatal(err)
	}
	fixtures, _ := filepath.Abs(filepath.Join("..", "portless", "testdata", "0.16"))
	// The service points at a Node that is gone, as after a Node upgrade.
	f.unit = filepath.Join(dir, "portless.service")
	script := filepath.Join(dir, "cli.js")
	write(t, script, "")
	write(t, f.unit, `ExecStart="`+filepath.Join(dir, "gone", "node")+`" "`+script+`" "proxy" "start" "--foreground" "--port" "443" "--https" "--tld" "localhost" "--tld" "test" "--wildcard"`+"\n")
	status := filepath.Join(dir, "status.txt")
	write(t, status, "portless service\n  Manager state: active\n  Installed: yes\n  Proxy on 443: responding\n  HTTPS: yes\n  TLDs: .localhost, .test\n  LAN mode: no\n  Wildcard: yes\n  Unprivileged: no\n  State directory: "+f.state+"\n  Service entry: "+f.unit+"\n")
	t.Setenv("FAKE_LOG", f.log)
	t.Setenv("FAKE_FIXTURES", fixtures)
	t.Setenv("FAKE_STATUS", status)
	// The proxy port is a closed one, so no real proxy on this computer answers.
	write(t, filepath.Join(f.state, "proxy.port"), strconv.Itoa(f.port))
	write(t, filepath.Join(f.state, "proxy.tls"), "1")
	write(t, filepath.Join(f.state, "proxy.tlds"), "localhost\ntest\n")
	f.client = &portless.Client{Bin: bin, StateDir: f.state}
	f.project = t.TempDir()
	f.local = model.MachineSnapshot{Machine: model.Machine{ID: "local", Local: true, Name: "This computer"}, Folders: []string{f.project}}
	f.handler = f.serve()
	return f
}

func (f *portlessFixture) goosOr(def string) string {
	if f.goos != "" {
		return f.goos
	}
	return def
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (f *portlessFixture) serve() http.Handler {
	mux := http.NewServeMux()
	h := PortlessHandlers(PortlessDeps{
		Client: f.client,
		Jobs:   f.jobs,
		Local:  func(context.Context) model.MachineSnapshot { return f.local },
		Machines: func() []model.MachineSnapshot {
			return []model.MachineSnapshot{f.local, {
				Machine: model.Machine{ID: "box", Name: "box"},
				Apps:    []model.App{{ID: "/srv#shop/web", Label: "web", Project: "shop", RemoteURL: "https://shop.box.localhost"}},
			}}
		},
		Config: dekit.LoadConfig,
		Reload: func(_ context.Context, root string) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.reloads = append(f.reloads, root)
			return nil
		},
		Restart: func(_ context.Context, root, task string) error {
			f.mu.Lock()
			f.restarts = append(f.restarts, task)
			hook := f.onRestart
			f.mu.Unlock()
			if hook != nil {
				hook(task)
			}
			return nil
		},
		Start: func(_ context.Context, root, task string) error {
			f.mu.Lock()
			f.starts = append(f.starts, task)
			hook := f.onRestart
			f.mu.Unlock()
			if hook != nil {
				hook(task)
			}
			return nil
		},
		// No test runs the real tailscale, ngrok, cloudflared or docker.
		Tool: func(_ context.Context, name string, args ...string) ([]byte, error) {
			k := strings.TrimSpace(name + " " + strings.Join(args, " "))
			f.mu.Lock()
			defer f.mu.Unlock()
			f.toolCalls = append(f.toolCalls, k)
			if out, ok := f.tools[k]; ok {
				return []byte(out), f.toolErrs[k]
			}
			if err, ok := f.toolErrs[k]; ok {
				return nil, err
			}
			return nil, portless.ErrToolMissing
		},
		Lookup: func(name string) string {
			if p, ok := f.programs[name]; ok {
				return p
			}
			switch name {
			case "tailscale", "ngrok", "cloudflared", "docker", "avahi-publish-address", "dns-sd", "systemctl":
				return ""
			}
			return envpath.Lookup(name)
		},
		Network: func() ([]portless.Iface, string) {
			return []portless.Iface{{Name: "wlan0", Up: true, MAC: "a4:c3:f0:11:22:33", IPs: []net.IP{net.ParseIP("192.168.1.20")}}}, "192.168.1.20"
		},
		OSRelease:     func() string { return "ID=fedora\n" },
		Home:          func() string { return f.home },
		Getenv:        func(string) string { return "" },
		User:          func() string { return "dev" },
		ComposeMemory: f.memory,
		ShareWait:     3 * time.Second,
		Listeners: func(context.Context) []Listener {
			return append([]Listener{{Port: 4519, PID: 777, Process: "node"}, {Port: 5432, PID: 90, Process: "postgres"}}, f.listen...)
		},
		Elevate: func(_ context.Context, c privileged.Command, out io.Writer) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.elevated = append(f.elevated, c)
			_, _ = io.WriteString(out, "elevated ok\n")
			return f.elevErr
		},
		Method: func() string { return "pkexec" },
		Exec: func(_ context.Context, argv []string, _ map[string]string, _ io.Writer) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.execs = append(f.execs, argv)
			return nil
		},
		Downloads: func() string { return filepath.Join(f.state, "..", "downloads") },
		Reveal:    func(string) error { return nil },
		GOOS:      f.goosOr("linux"),
		Now:       func() time.Time { return time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC) },
	})
	for pattern, fn := range h {
		mux.HandleFunc(pattern, fn)
	}
	return mux
}

func (f *portlessFixture) do(method, url string, body any) *httptest.ResponseRecorder {
	f.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = strings.NewReader(string(b))
	}
	req := httptest.NewRequest(method, url, r)
	rec := httptest.NewRecorder()
	f.handler.ServeHTTP(rec, req)
	return rec
}

func decodeBody[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("%v: %s", err, rec.Body.String())
	}
	return v
}

func (f *portlessFixture) calls() string {
	b, _ := os.ReadFile(f.log)
	return string(b)
}

func (f *portlessFixture) wait(job jobs.Job) jobs.Job {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	j, err := f.jobs.Wait(ctx, job.ID)
	if err != nil {
		f.t.Fatal(err)
	}
	return j
}

func TestPortlessStatusAndDoctor(t *testing.T) {
	f := newPortlessFixture(t)
	rec := f.do("GET", "/api/portless/status", nil)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	st := decodeBody[PortlessStatus](t, rec)
	if !st.Installed || st.Version != "0.16.0" || st.Service == nil || !st.Service.Installed || st.Program == nil || !st.Program.NodeMissing {
		t.Fatalf("%+v", st)
	}
	if st.Options.Port != 443 || !st.Options.Wildcard || strings.Join(st.Options.TLDs, ",") != "localhost,test" || !st.HostsNeeded || st.Method != "pkexec" {
		t.Fatalf("options %+v", st)
	}
	if st.Proxy.Responding {
		t.Fatal("no proxy runs in the test")
	}

	rep := decodeBody[DoctorReport](t, f.do("GET", "/api/portless/doctor", nil))
	if !rep.Parsed || rep.Failures != 1 || rep.Warnings != 10 {
		t.Fatalf("%+v", rep)
	}
	last := rep.Findings[len(rep.Findings)-1]
	if last.Check != "service" || last.Fix != portless.FixReinstallService {
		t.Fatalf("the missing Node must be a finding: %+v", last)
	}

	// No client: portless isn't installed (an empty Bin would find the
	// real one on PATH).
	missing := &portlessFixture{t: t, jobs: jobs.NewManager()}
	missing.handler = missing.serve()
	if rec := missing.do("GET", "/api/portless/status", nil); rec.Code != 200 || decodeBody[PortlessStatus](t, rec).Installed {
		t.Fatalf("status without portless: %d %s", rec.Code, rec.Body.String())
	}
	if rec := missing.do("GET", "/api/portless/doctor", nil); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("doctor without portless: %d", rec.Code)
	}
}

func TestPortlessRoutesAndPrune(t *testing.T) {
	f := newPortlessFixture(t)
	write(t, filepath.Join(f.state, "routes.json"), `[
  {"hostname": "web.localhost", "port": 4512, "pid": `+strconv.Itoa(os.Getpid())+`},
  {"hostname": "portplane.localhost", "port": 39001, "pid": 0},
  {"hostname": "shop.box.localhost", "port": 40100, "pid": 0},
  {"hostname": "docs.localhost", "port": 4519, "pid": 999999999},
  {"hostname": "db.localhost", "port": 5432, "pid": 0}
]`)
	f.local.Apps = []model.App{{ID: "/code#shop/web", Label: "web", Project: "shop", PID: os.Getpid(), Hostname: "web.localhost"}}
	views := decodeBody[[]RouteView](t, f.do("GET", "/api/portless/routes", nil))
	owners := map[string]string{}
	for _, v := range views {
		kind := ""
		if v.Owner != nil {
			kind = v.Owner.Kind + ":" + v.Owner.Label
		}
		owners[v.Hostname] = v.Kind + "|" + kind
	}
	want := map[string]string{
		"web.localhost":       "app|app:shop · web",
		"portplane.localhost": "alias|portplane:Portplane",
		"shop.box.localhost":  "remote|remote:shop · web on box",
		"docs.localhost":      "app|process:node",
		"db.localhost":        "alias|process:postgres",
	}
	for h, w := range want {
		if owners[h] != w {
			t.Errorf("%s: got %q, want %q", h, owners[h], w)
		}
	}
	if views[0].URL == "" {
		t.Error("no URL")
	}

	stale := decodeBody[[]StaleRoute](t, f.do("GET", "/api/portless/prune", nil))
	if len(stale) != 1 || stale[0].Hostname != "docs.localhost" || len(stale[0].Processes) != 1 || stale[0].Processes[0].PID != 777 {
		t.Fatalf("%+v", stale)
	}

	rec := f.do("POST", "/api/portless/actions/prune-force", map[string]any{})
	if rec.Code != http.StatusAccepted {
		t.Fatal(rec.Body.String())
	}
	job := f.wait(decodeBody[jobs.Job](t, rec))
	if job.State != jobs.Succeeded || !strings.Contains(f.calls(), "prune --force") {
		t.Fatalf("%+v\n%s", job, f.calls())
	}
	b, _ := json.Marshal(job.Result)
	var res portless.PruneResult
	_ = json.Unmarshal(b, &res)
	if res.Routes != 3 || res.Killed != 2 {
		t.Fatalf("result %+v", job.Result)
	}
}

func TestPortlessAliases(t *testing.T) {
	f := newPortlessFixture(t)
	if rec := f.do("POST", "/api/portless/aliases", aliasRequest{Name: "db", Port: 5432}); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	if !strings.Contains(f.calls(), "alias db 5432\n") {
		t.Fatalf("calls: %s", f.calls())
	}
	if rec := f.do("POST", "/api/portless/aliases", aliasRequest{Name: "db", Port: 5432, Force: true}); rec.Code != 200 || !strings.Contains(f.calls(), "alias db 5432 --force") {
		t.Fatalf("force: %s", f.calls())
	}
	rec := f.do("POST", "/api/portless/aliases", aliasRequest{Name: "taken", Port: 80})
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "Replace the existing route") {
		t.Fatalf("conflict: %d %s", rec.Code, rec.Body.String())
	}
	for _, bad := range []aliasRequest{{Name: "Bad Name", Port: 1}, {Name: "x", Port: 0}, {Name: "proxy", Port: 80}, {Name: "portplane", Port: 80}} {
		if rec := f.do("POST", "/api/portless/aliases", bad); rec.Code != http.StatusBadRequest {
			t.Errorf("%+v: %d", bad, rec.Code)
		}
	}
	if rec := f.do("DELETE", "/api/portless/aliases/portplane.localhost", nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("removed Portplane's own alias: %d", rec.Code)
	}
	if rec := f.do("DELETE", "/api/portless/aliases/db.localhost", nil); rec.Code != 200 || !strings.Contains(f.calls(), "alias --remove db.localhost") {
		t.Fatalf("remove: %s", f.calls())
	}
	before := f.calls()
	if rec := f.do("PUT", "/api/portless/aliases", aliasRequest{From: "db.localhost", Name: "postgres", Port: 5433}); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	if added := strings.TrimPrefix(f.calls(), before); added != "alias postgres 5433\nalias --remove db.localhost\n" {
		t.Fatalf("replace ran %q", added)
	}
	before = f.calls()
	if rec := f.do("PUT", "/api/portless/aliases", aliasRequest{From: "postgres.localhost", Name: "postgres", Port: 5434}); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	if added := strings.TrimPrefix(f.calls(), before); added != "alias postgres 5434 --force\n" {
		t.Fatalf("same name, new port ran %q", added)
	}
}

func TestPortlessActions(t *testing.T) {
	f := newPortlessFixture(t)
	plan := decodeBody[Plan](t, f.do("POST", "/api/portless/actions/service-install/plan", portlessActionRequest{Options: &portless.ProxyOptions{Port: 443, HTTPS: true, TLDs: []string{"localhost", "test"}}}))
	if !plan.Admin || plan.Title != "Reinstall the proxy service" || len(plan.Steps) != 1 {
		t.Fatalf("%+v", plan)
	}
	s := plan.Steps[0]
	if !s.Admin || !strings.Contains(strings.Join(s.Argv, " "), "service install --port 443 --https --tld localhost --tld test") || !strings.HasPrefix(s.Terminal, "sudo ") || s.Env["HOME"] == "" {
		t.Fatalf("%+v", s)
	}
	if rec := f.do("POST", "/api/portless/actions/service-install/plan", portlessActionRequest{Options: &portless.ProxyOptions{Port: 0}}); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad options: %d", rec.Code)
	}
	if rec := f.do("POST", "/api/portless/actions/rm-rf/plan", map[string]any{}); rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown action: %d", rec.Code)
	}
	// The page sends choices, never a command.
	if rec := f.do("POST", "/api/portless/actions/trust/plan", map[string]any{"argv": []string{"/bin/sh"}}); rec.Code != http.StatusBadRequest {
		t.Fatalf("accepted an argv: %d", rec.Code)
	}

	job := f.wait(decodeBody[jobs.Job](t, f.do("POST", "/api/portless/actions/service-install", map[string]any{})))
	if job.State != jobs.Succeeded || !job.Privileged || len(f.elevated) != 1 || f.elevated[0].Argv[1] != "service" {
		t.Fatalf("%+v %+v", job, f.elevated)
	}
	if !strings.Contains(strings.Join(job.Output, "\n"), "elevated ok") {
		t.Fatalf("output: %v", job.Output)
	}

	f.elevErr = privileged.ErrDenied
	job = f.wait(decodeBody[jobs.Job](t, f.do("POST", "/api/portless/actions/hosts-sync", map[string]any{})))
	if job.State != jobs.Failed || !strings.Contains(job.Error, "password dialog was closed") {
		t.Fatalf("denied: %+v", job)
	}
	f.elevErr = privileged.ErrUnavailable
	job = f.wait(decodeBody[jobs.Job](t, f.do("POST", "/api/portless/actions/hosts-clean", map[string]any{})))
	if job.State != jobs.Failed || !strings.Contains(job.Error, "sudo ") || !strings.Contains(job.Error, " hosts clean") {
		t.Fatalf("unavailable: %+v", job)
	}
	f.elevErr = nil

	// Regenerate moves the CA aside first, then trusts a new one.
	write(t, filepath.Join(f.state, "ca.pem"), "old")
	job = f.wait(decodeBody[jobs.Job](t, f.do("POST", "/api/portless/actions/ca-regenerate", map[string]any{})))
	if job.State != jobs.Succeeded || !fileExists(filepath.Join(f.state, "ca-backup-20261112-090000", "ca.pem")) {
		t.Fatalf("regenerate: %+v", job)
	}
	if rec := f.do("POST", "/api/portless/actions/ca-fix-ownership/plan", map[string]any{}); rec.Code != http.StatusBadRequest {
		t.Fatalf("fix ownership without a problem: %d", rec.Code)
	}

	// Stop: portless itself, no password (the test proxy isn't root's).
	plan = decodeBody[Plan](t, f.do("POST", "/api/portless/actions/proxy-stop/plan", map[string]any{}))
	if plan.Admin || !strings.HasSuffix(plan.Steps[0].Terminal, "proxy stop --port "+strconv.Itoa(f.port)) || len(plan.Notes) != 1 {
		t.Fatalf("%+v", plan)
	}
	job = f.wait(decodeBody[jobs.Job](t, f.do("POST", "/api/portless/actions/proxy-stop", map[string]any{})))
	if job.State != jobs.Succeeded || !strings.Contains(f.calls(), "proxy stop --port "+strconv.Itoa(f.port)) {
		t.Fatalf("stop: %+v %s", job, f.calls())
	}

	plan = decodeBody[Plan](t, f.do("POST", "/api/portless/actions/uninstall/plan", map[string]any{}))
	if !plan.Admin || plan.Steps[0].Argv[1] != "clean" || len(plan.Notes) < 4 {
		t.Fatalf("uninstall: %+v", plan)
	}
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func (f *portlessFixture) setupProject(t *testing.T) {
	t.Helper()
	root := f.projectDir()
	write(t, filepath.Join(root, "dekit.yaml"), "load:\n  - .portplane/tasks.yaml\ntasks:\n  # hand-written\n  shop/api:\n    cwd: apps/api\n    cmd: [portless, api.shop, pnpm, run, dev]\n  shop/docs:\n    cwd: apps/docs\n    cmd: [portless, run, pnpm, run, dev]\n  shop/js:\n    cmd: !js '[\"portless\", \"js\", \"vite\"]'\n  db-url:\n    type: job\n    cmd: [portless, alias, db, \"5432\", --force]\n  shop/admin:\n    cmd: [php, -S, \"127.0.0.1:8080\"]\n    deps: [db-url]\n")
	write(t, filepath.Join(root, ".portplane", "tasks.yaml"), "# Generated by Portplane\ntasks:\n  shop/web:\n    cwd: \"../apps/web\"\n    cmd: [\"portless\", \"shop\", \"pnpm\", \"run\", \"dev\"]\n")
	write(t, filepath.Join(root, "apps", "docs", "package.json"), "{\n  \"name\": \"docs\"\n}\n")
	f.local.Runners = []model.Runner{{Root: root, Name: "code", Up: true}}
	app := func(task, label, host string, state model.State) model.App {
		return model.App{ID: root + "#" + task, Runner: root, Task: task, Label: label, Project: "shop", Hostname: host, State: state, Dir: filepath.Join(root, "apps", label)}
	}
	f.local.Apps = []model.App{
		app("shop/web", "web", "shop.localhost", model.StateOn),
		app("shop/api", "api", "api.shop.localhost", model.StateOff),
		app("shop/docs", "docs", "docs.localhost", model.StateOn),
		app("shop/js", "js", "js.localhost", model.StateOff),
		app("shop/admin", "admin", "db.localhost", model.StateOn),
	}
	f.local.Apps[2].Command = []string{"portless", "run", "pnpm", "run", "dev"}
}

func (f *portlessFixture) projectDir() string { return f.project }

func TestPortlessRename(t *testing.T) {
	f := newPortlessFixture(t)
	f.setupProject(t)
	root := f.projectDir()
	id := func(task string) string { return root + "#" + task }

	info := decodeBody[NameInfo](t, f.do("GET", "/api/portless/names?machine=local&app="+id("shop/web"), nil))
	if info.Source != portless.SourceFragment || info.Name != "shop" || !info.Editable || !info.Running {
		t.Fatalf("fragment: %+v", info)
	}
	if info := decodeBody[NameInfo](t, f.do("GET", "/api/portless/names?app="+id("shop/api"), nil)); info.Source != portless.SourceTask || info.Name != "api.shop" || !info.Editable || len(info.Notes) == 0 {
		t.Fatalf("task: %+v", info)
	}
	if info := decodeBody[NameInfo](t, f.do("GET", "/api/portless/names?app="+id("shop/js"), nil)); info.Source != portless.SourceNone || info.Editable {
		t.Fatalf("!js: %+v", info)
	}
	if info := decodeBody[NameInfo](t, f.do("GET", "/api/portless/names?app="+id("shop/admin"), nil)); info.Source != portless.SourceAliasTask || info.Name != "db" || info.Port != 5432 || !info.Editable {
		t.Fatalf("alias job: %+v", info)
	}
	docs := decodeBody[NameInfo](t, f.do("GET", "/api/portless/names?app="+id("shop/docs"), nil))
	if docs.Source != portless.SourceConfig || !docs.Inferred || docs.Target != portless.ConfigFile || !docs.RunMode {
		t.Fatalf("run: %+v", docs)
	}
	if rec := f.do("GET", "/api/portless/names?machine=box&app="+id("shop/web"), nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("remote: %d", rec.Code)
	}

	// Checks as the user types.
	for name, problem := range map[string]string{"Shop": "the name it has now", "shop": "the name it has now", "api.shop": "already used", "proxy": "own commands"} {
		pv := decodeBody[NamePreview](t, f.do("POST", "/api/portless/names/preview", nameRequest{App: id("shop/web"), Name: name}))
		if !strings.Contains(pv.Problem, problem) {
			t.Errorf("%q: %q", name, pv.Problem)
		}
	}

	pv := decodeBody[NamePreview](t, f.do("POST", "/api/portless/names/preview", nameRequest{App: id("shop/web"), Name: "store.shop"}))
	if pv.Problem != "" || pv.Hostname != "store.shop.localhost" || len(pv.Files) != 1 || !strings.Contains(pv.Files[0].After, `"portless", "store.shop", "pnpm"`) || len(pv.Warnings) != 1 {
		t.Fatalf("%+v", pv)
	}
	if strings.Join(pv.Steps, ", ") != "Write tasks.yaml, Reload dekit, Restart web" {
		t.Fatalf("steps %v", pv.Steps)
	}
	if rec := f.do("POST", "/api/portless/names/apply", nameRequest{App: id("shop/web"), Name: "store.shop", Digest: "stale"}); rec.Code != http.StatusConflict {
		t.Fatalf("stale digest: %d", rec.Code)
	}
	job := f.wait(decodeBody[jobs.Job](t, f.do("POST", "/api/portless/names/apply", nameRequest{App: id("shop/web"), Name: "store.shop", Digest: pv.Digest})))
	if job.State != jobs.Succeeded {
		t.Fatalf("%+v", job)
	}
	b, _ := os.ReadFile(filepath.Join(root, ".portplane", "tasks.yaml"))
	if !strings.Contains(string(b), `"store.shop"`) || len(f.reloads) != 1 || strings.Join(f.restarts, ",") != "shop/web" {
		t.Fatalf("%s %v %v", b, f.reloads, f.restarts)
	}

	// portless run: portless.json, with the URL from portless get.
	pv = decodeBody[NamePreview](t, f.do("POST", "/api/portless/names/preview", nameRequest{App: id("shop/docs"), Name: "handbook"}))
	if pv.Problem != "" || pv.Hostname != "feature.handbook.localhost" || !pv.Files[0].Created || pv.Files[0].After != "{\n  \"name\": \"handbook\"\n}\n" {
		t.Fatalf("config: %+v", pv)
	}
	job = f.wait(decodeBody[jobs.Job](t, f.do("POST", "/api/portless/names/apply", nameRequest{App: id("shop/docs"), Name: "handbook", Digest: pv.Digest})))
	if job.State != jobs.Succeeded || !fileExists(filepath.Join(root, "apps", "docs", "portless.json")) {
		t.Fatalf("%+v", job)
	}

	// The alias job: edit, reload, drop the old alias, restart the job.
	pv = decodeBody[NamePreview](t, f.do("POST", "/api/portless/names/preview", nameRequest{App: id("shop/admin"), Name: "postgres"}))
	job = f.wait(decodeBody[jobs.Job](t, f.do("POST", "/api/portless/names/apply", nameRequest{App: id("shop/admin"), Name: "postgres", Digest: pv.Digest})))
	if job.State != jobs.Succeeded || !strings.Contains(f.calls(), "alias --remove db.localhost") || f.restarts[len(f.restarts)-1] != "db-url" {
		t.Fatalf("%+v %s %v", job, f.calls(), f.restarts)
	}
	b, _ = os.ReadFile(filepath.Join(root, "dekit.yaml"))
	if !strings.Contains(string(b), "cmd: [portless, alias, postgres, \"5432\", --force]") || !strings.Contains(string(b), "# hand-written") {
		t.Fatalf("%s", b)
	}
}

func TestPortlessConfigEditor(t *testing.T) {
	f := newPortlessFixture(t)
	f.setupProject(t)
	root := f.projectDir()
	docs := filepath.Join(root, "apps", "docs")

	places := decodeBody[[]ConfigPlace](t, f.do("GET", "/api/portless/configs", nil))
	if len(places) != 1 || places[0].Dir != docs || !places[0].Apps[0].RunMode {
		t.Fatalf("%+v", places)
	}
	if rec := f.do("GET", "/api/portless/config?dir=/etc", nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("outside the folders: %d", rec.Code)
	}
	pc := decodeBody[portless.ProjectConfigs](t, f.do("GET", "/api/portless/config?dir="+docs, nil))
	if pc.Wins != "" || pc.PackageName != "docs" {
		t.Fatalf("%+v", pc)
	}
	pv := decodeBody[ConfigPreview](t, f.do("POST", "/api/portless/config/preview", configRequest{Dir: docs, Target: portless.ConfigFile, Text: `{"name": "docs", "appPort": "x"}`}))
	if len(pv.Problems) != 1 || pv.Edit != nil {
		t.Fatalf("%+v", pv)
	}
	pv = decodeBody[ConfigPreview](t, f.do("POST", "/api/portless/config/preview", configRequest{Dir: docs, Target: portless.ConfigFile, Text: "{\n  \"name\": \"docs\",\n  \"script\": \"start\"\n}"}))
	if len(pv.Problems) != 0 || pv.Edit == nil || !pv.Edit.Created {
		t.Fatalf("%+v", pv)
	}
	rec := f.do("PUT", "/api/portless/config", configRequest{Dir: docs, Target: portless.ConfigFile, Text: "{\n  \"name\": \"docs\"\n}"})
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	pc = decodeBody[portless.ProjectConfigs](t, rec)
	if pc.Wins != portless.ConfigFile || pc.Portless.Digest == "" {
		t.Fatalf("%+v", pc)
	}
	// Saving over a file changed since is refused.
	if rec := f.do("PUT", "/api/portless/config", configRequest{Dir: docs, Target: portless.ConfigFile, Text: `{"name": "x"}`, Digest: "old"}); rec.Code != http.StatusConflict {
		t.Fatalf("conflict: %d", rec.Code)
	}
	if rec := f.do("PUT", "/api/portless/config", configRequest{Dir: docs, Target: portless.PackageFile, Text: `{"name": "x"}`, Digest: pc.Package.Digest}); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	b, _ := os.ReadFile(filepath.Join(docs, "package.json"))
	if string(b) != "{\n  \"name\": \"docs\",\n  \"portless\": {\n    \"name\": \"x\"\n  }\n}\n" {
		t.Fatalf("%q", b)
	}
}

func TestPortlessCertificatesAndHosts(t *testing.T) {
	f := newPortlessFixture(t)
	c := decodeBody[Certificates](t, f.do("GET", "/api/portless/certificates", nil))
	if c.CA.Exists || !c.TrustNeedsAdmin || c.Browsers != nil {
		t.Fatalf("%+v", c)
	}
	if rec := f.do("POST", "/api/portless/certificates/export", map[string]any{}); rec.Code != http.StatusBadRequest {
		t.Fatalf("export without a CA: %d", rec.Code)
	}
	write(t, filepath.Join(f.state, "ca.pem"), "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n")
	rec := f.do("POST", "/api/portless/certificates/export", map[string]any{})
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "portless-ca.pem") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	h := decodeBody[HostsView](t, f.do("GET", "/api/portless/hosts", nil))
	if h.Path == "" || !h.Needed || strings.Join(h.TLDs, ",") != "localhost,test" {
		t.Fatalf("%+v", h)
	}
}
