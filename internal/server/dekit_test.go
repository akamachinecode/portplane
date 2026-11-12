package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/jobs"
)

// fakeDekit answers dekit commands from canned output and records them.
type fakeDekit struct {
	mu    sync.Mutex
	root  string
	calls [][]string
	reply func(root string, args []string) (string, string, error)
}

func (f *fakeDekit) exec(_ context.Context, _ []string, _ string, args ...string) ([]byte, []byte, error) {
	f.mu.Lock()
	f.calls = append(f.calls, args)
	f.mu.Unlock()
	out, errOut, err := f.reply(f.root, args)
	return []byte(out), []byte(errOut), err
}

func (f *fakeDekit) called(prefix ...string) [][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out [][]string
	for _, c := range f.calls {
		s := strings.Join(c, " ")
		if strings.Contains(s, strings.Join(prefix, " ")) {
			out = append(out, c)
		}
	}
	return out
}

func readFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "dekit", "testdata", "0.10.3", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

type dekitEnv struct {
	root string
	fake *fakeDekit
	jobs *jobs.Manager
	h    http.Handler
	deps *DekitDeps
}

func newDekitEnv(t *testing.T, goos string, reply func(root string, args []string) (string, string, error)) *dekitEnv {
	t.Helper()
	folder := t.TempDir()
	root := filepath.Join(folder, "my-monorepo")
	if err := os.MkdirAll(filepath.Join(root, "apps", "web"), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("dekit.yaml", "# my project\ntasks:\n  web:\n    cwd: apps/web\n    cmd: [pnpm, run, dev]\n\n  api:\n    cmd: [node, api.js]\n")
	f := &fakeDekit{root: root, reply: reply}
	m := jobs.NewManager()
	d := DekitDeps{
		CLI:        &dekit.CLI{Bin: "/fake/dekit", Exec: f.exec},
		Jobs:       m,
		Folders:    func() []string { return []string{folder} },
		GOOS:       goos,
		HostConfig: filepath.Join(folder, "host", "dekit.yaml"),
		RunCommand: func(_ context.Context, w io.Writer, argv []string) error {
			_, _ = io.WriteString(w, "ran "+strings.Join(argv, " ")+"\n")
			return nil
		},
	}
	mux := http.NewServeMux()
	for p, h := range DekitHandlers(d) {
		mux.HandleFunc(p, h)
	}
	return &dekitEnv{root: root, fake: f, jobs: m, h: mux, deps: &d}
}

func (e *dekitEnv) do(t *testing.T, method, url string, body any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = strings.NewReader(string(b))
	}
	req := httptest.NewRequest(method, url, r)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

func (e *dekitEnv) waitJob(t *testing.T, id string) jobs.Job {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	j, err := e.jobs.Wait(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func TestDekitRunners(t *testing.T) {
	e := newDekitEnv(t, "linux", func(root string, args []string) (string, string, error) {
		s := strings.Join(args, " ")
		switch {
		case s == "--version":
			return "dekit 0.10.3", "", nil
		case s == "runner list --json":
			list := strings.ReplaceAll(readFixture(t, "runner-list.json"), "/home/dev/code/my-monorepo", root)
			return list, "", nil
		case strings.Contains(s, "runner status --json host"):
			return readFixture(t, "runner-status-absent.json"), "", nil
		case strings.HasSuffix(s, "runner status --json") && strings.Contains(s, root):
			return strings.ReplaceAll(readFixture(t, "runner-status-running.json"), "/home/dev/code/my-monorepo", root), "", nil
		case strings.HasSuffix(s, "runner status --json"):
			return readFixture(t, "runner-status-stale.json"), "", nil
		}
		return "", "", errors.New("unexpected " + s)
	})
	rec, _ := e.do(t, "GET", "/api/dekit/runners", nil)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	var resp RunnersResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if !resp.Available || resp.Stale != 1 || !resp.Live || len(resp.Runners) != 2 {
		t.Fatalf("runners %+v", resp)
	}
	byRoot := map[string]RunnerInfo{}
	for _, r := range resp.Runners {
		byRoot[r.Root] = r
	}
	mine := byRoot[e.root]
	if mine.State != "running" || !mine.Watched || mine.PID == 0 || mine.Since == "" || !mine.ConfigExists || mine.Version != "0.10.3" {
		t.Fatalf("watched runner %+v", mine)
	}
	if other := byRoot["/home/dev/code"]; other.State != "stale" || other.Watched {
		t.Fatalf("stale runner %+v", other)
	}
	if resp.Host.Kind != "host" || resp.Host.State != "absent" || resp.Host.Name != "This computer" {
		t.Fatalf("host %+v", resp.Host)
	}
}

func TestDekitRunnerActions(t *testing.T) {
	e := newDekitEnv(t, "linux", func(root string, args []string) (string, string, error) {
		s := strings.Join(args, " ")
		switch {
		case strings.Contains(s, " up --wait"):
			return readFixture(t, "up-wait.json"), "", errors.New("exit status 1")
		case strings.Contains(s, " down --json"):
			return readFixture(t, "down.json"), "", nil
		}
		return "", "", errors.New("unexpected " + s)
	})
	rec, out := e.do(t, "POST", "/api/dekit/runners/action", map[string]any{"root": e.root, "action": "up"})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	j := e.waitJob(t, out["id"].(string))
	if j.State != jobs.Failed || !strings.Contains(j.Error, "fail: exited (code 3)") || j.Result == nil {
		t.Fatalf("up job %+v", j)
	}
	rec, out = e.do(t, "POST", "/api/dekit/runners/action", map[string]any{"root": e.root, "action": "down"})
	if j := e.waitJob(t, out["id"].(string)); rec.Code != 202 || j.State != jobs.Succeeded {
		t.Fatalf("down %+v", j)
	}
	if rec, _ := e.do(t, "POST", "/api/dekit/runners/action", map[string]any{"root": "/not/a/project", "action": "down"}); rec.Code != 400 {
		t.Fatalf("unknown root: %d", rec.Code)
	}
	if rec, _ := e.do(t, "POST", "/api/dekit/runners/action", map[string]any{"root": e.root, "action": "explode"}); rec.Code != 400 {
		t.Fatalf("unknown action: %d", rec.Code)
	}
	win := newDekitEnv(t, "windows", func(string, []string) (string, string, error) { return "", "", nil })
	if rec, out := win.do(t, "POST", "/api/dekit/runners/action", map[string]any{"root": win.root, "action": "restart"}); rec.Code != 400 || !strings.Contains(out["error"].(string), "Windows") {
		t.Fatalf("windows restart: %d %v", rec.Code, out)
	}
	if rec, _ := win.do(t, "POST", "/api/dekit/runners/upgrade-all", map[string]any{}); rec.Code != 400 {
		t.Fatalf("windows upgrade all: %d", rec.Code)
	}
}

func TestDekitConfigEditFlow(t *testing.T) {
	e := newDekitEnv(t, "linux", func(root string, args []string) (string, string, error) {
		s := strings.Join(args, " ")
		switch {
		case strings.HasSuffix(s, "reload --json"):
			return readFixture(t, "reload-plan.json"), "", nil
		case strings.HasSuffix(s, "reload --yes --json"):
			return readFixture(t, "reload-yes.json"), "", nil
		case strings.HasSuffix(s, "ls --json"):
			return readFixture(t, "ls-backoff.json"), "", nil
		case strings.Contains(s, " restart "):
			return `{"matched":1}`, "", nil
		}
		return "", "", errors.New("unexpected " + s)
	})
	rec, cfg := e.do(t, "GET", "/api/dekit/config?runner="+e.root, nil)
	if rec.Code != 200 || len(cfg["tasks"].([]any)) != 2 {
		t.Fatalf("config %d %s", rec.Code, rec.Body)
	}
	main := filepath.Join(e.root, "dekit.yaml")
	files := cfg["files"].([]any)
	digest := files[0].(map[string]any)["digest"].(string)

	// Preview: nothing is written.
	edit := map[string]any{
		"runner":  e.root,
		"file":    main,
		"digests": map[string]string{main: digest},
		"ops":     []map[string]any{{"op": "set", "path": []string{"tasks", "api"}, "key": "cmd", "value": []string{"node", "server.js"}}},
	}
	rec, res := e.do(t, "POST", "/api/dekit/config/edit", edit)
	if rec.Code != 200 || res["written"] != false {
		t.Fatalf("preview %d %s", rec.Code, rec.Body)
	}
	if b, _ := os.ReadFile(main); strings.Contains(string(b), "server.js") {
		t.Fatal("a preview must not write")
	}
	// Write: the file changes and the reload plan comes back.
	edit["write"] = true
	rec, res = e.do(t, "POST", "/api/dekit/config/edit", edit)
	if rec.Code != 200 || res["written"] != true || res["up"] != true || res["reload"] == nil {
		t.Fatalf("write %d %s", rec.Code, rec.Body)
	}
	b, _ := os.ReadFile(main)
	if string(b) != "# my project\ntasks:\n  web:\n    cwd: apps/web\n    cmd: [pnpm, run, dev]\n\n  api:\n    cmd: [node, server.js]\n" {
		t.Fatalf("written:\n%s", b)
	}
	// The same digest again is stale now.
	if rec, _ := e.do(t, "POST", "/api/dekit/config/edit", edit); rec.Code != http.StatusConflict {
		t.Fatalf("stale digest: %d", rec.Code)
	}
	// Invalid results are not written.
	delete(edit, "digests")
	edit["ops"] = []map[string]any{{"op": "set", "path": []string{"tasks", "api"}, "key": "autostart", "value": "maybe"}}
	rec, res = e.do(t, "POST", "/api/dekit/config/edit", edit)
	if rec.Code != 200 || res["written"] != false || len(res["problems"].([]any)) == 0 {
		t.Fatalf("invalid edit %d %s", rec.Code, rec.Body)
	}
	// A file that is not the project's is refused.
	edit["file"] = "/etc/passwd"
	if rec, _ := e.do(t, "POST", "/api/dekit/config/edit", edit); rec.Code != 400 {
		t.Fatalf("foreign file: %d", rec.Code)
	}
	// Apply and restart the running tasks the reload changed: in the
	// fixture, web changed and is in backoff (not running) and fail changed
	// and exited, so nothing restarts.
	rec, res = e.do(t, "POST", "/api/dekit/reload", map[string]any{"runner": e.root, "restart": true})
	if rec.Code != 200 || len(res["restarted"].([]any)) != 0 {
		t.Fatalf("reload %d %s", rec.Code, rec.Body)
	}
	if len(e.fake.called("reload", "--yes")) != 1 || len(e.fake.called(" restart ")) != 0 {
		t.Fatalf("calls %v", e.fake.calls)
	}
}

func TestDekitFragmentIsCreatedAndLoaded(t *testing.T) {
	e := newDekitEnv(t, "linux", func(_ string, args []string) (string, string, error) {
		return "", "Error: Runner is not running. Start it with `dekit up`.", errors.New("exit status 1")
	})
	app := map[string]any{"path": "site", "folder": filepath.Join(e.root, "apps", "web"), "cmd": []string{"php", "-S", "127.0.0.1:8000"}, "name": "site", "port": 8000}
	rec, res := e.do(t, "POST", "/api/dekit/apps", map[string]any{"runner": e.root, "app": app, "write": true})
	if rec.Code != 200 || res["written"] != true || res["up"] != false {
		t.Fatalf("add app %d %s", rec.Code, rec.Body)
	}
	files := res["files"].([]any)
	if len(files) != 2 || files[0].(map[string]any)["created"] != true {
		t.Fatalf("files %v", files)
	}
	frag, _ := os.ReadFile(filepath.Join(e.root, ".portplane", "tasks.yaml"))
	want := fragmentHeader + "tasks:\n  site-url:\n    label: site URL\n    type: job\n    cmd: [portless, alias, site, \"8000\", --force]\n  site:\n    cwd: ../apps/web\n    cmd: [php, -S, '127.0.0.1:8000']\n    deps: [site-url]\n"
	if string(frag) != want {
		t.Fatalf("fragment:\n%s\nwant:\n%s", frag, want)
	}
	main, _ := os.ReadFile(filepath.Join(e.root, "dekit.yaml"))
	if !strings.HasSuffix(string(main), "load:\n  - .portplane/tasks.yaml\n") {
		t.Fatalf("main:\n%s", main)
	}
	// The same path again is refused.
	if rec, _ := e.do(t, "POST", "/api/dekit/apps", map[string]any{"runner": e.root, "app": app}); rec.Code != 400 {
		t.Fatalf("duplicate path: %d", rec.Code)
	}
	app["folder"] = "/somewhere/else"
	app["path"] = "other"
	if rec, _ := e.do(t, "POST", "/api/dekit/apps", map[string]any{"runner": e.root, "app": app}); rec.Code != 400 {
		t.Fatalf("folder outside the project: %d", rec.Code)
	}
}

func TestDekitWhySpawnSuggestValidate(t *testing.T) {
	e := newDekitEnv(t, "linux", func(root string, args []string) (string, string, error) {
		s := strings.Join(args, " ")
		switch {
		case strings.Contains(s, " why --json web"):
			return readFixture(t, "why-backoff.json"), "", nil
		case strings.Contains(s, " spawn "):
			return `{"matched":1}`, "", nil
		}
		return "", "", errors.New("unexpected " + s)
	})
	rec, why := e.do(t, "GET", "/api/dekit/why?runner="+e.root+"&task=web", nil)
	if rec.Code != 200 || why["attempts"].(float64) != 5 {
		t.Fatalf("why %d %s", rec.Code, rec.Body)
	}
	rec, _ = e.do(t, "POST", "/api/dekit/spawn", map[string]any{"runner": e.root, "spec": map[string]any{"path": "tmp/migrate", "cmd": []string{"pnpm", "run", "migrate"}, "cwd": "apps/web", "env": map[string]string{"A": "1"}}})
	if rec.Code != 200 {
		t.Fatalf("spawn %d %s", rec.Code, rec.Body)
	}
	got := e.fake.called("spawn")[0]
	want := []string{"-C", e.root, "spawn", "tmp/migrate", "--cwd", filepath.Join(e.root, "apps", "web"), "--env", "A=1", "--json", "--", "pnpm", "run", "migrate"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("spawn args\n got %v\nwant %v", got, want)
	}
	if rec, _ := e.do(t, "POST", "/api/dekit/spawn", map[string]any{"runner": e.root, "spec": map[string]any{"path": "x", "cmd": []string{"a"}, "cwd": "missing"}}); rec.Code != 400 {
		t.Fatalf("missing cwd: %d", rec.Code)
	}
	if err := os.WriteFile(filepath.Join(e.root, "apps", "web", "package.json"), []byte(`{"scripts":{"dev":"vite"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	rec, sug := e.do(t, "POST", "/api/dekit/suggest", map[string]any{"folder": filepath.Join(e.root, "apps", "web")})
	if rec.Code != 200 || sug["project"] != e.root || len(sug["suggestions"].([]any)) == 0 {
		t.Fatalf("suggest %d %s", rec.Code, rec.Body)
	}
	rec, val := e.do(t, "POST", "/api/dekit/config/validate", map[string]any{"content": "tasks:\n  a:\n    label: x\n"})
	if rec.Code != 200 || len(val["problems"].([]any)) != 1 {
		t.Fatalf("validate %d %s", rec.Code, rec.Body)
	}
}

func TestDekitUpdateJob(t *testing.T) {
	data := t.TempDir()
	t.Setenv("XDG_DATA_HOME", data)
	if err := os.MkdirAll(filepath.Join(data, "dekit"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "dekit", "install"), []byte("/fake/dekit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	e := newDekitEnv(t, "linux", func(_ string, args []string) (string, string, error) {
		return "", "dekit 0.11.0 installed\n", nil
	})
	if rec, _ := e.do(t, "POST", "/api/dekit/update", map[string]any{"version": "1.2"}); rec.Code != 400 {
		t.Fatalf("bad version: %d", rec.Code)
	}
	rec, out := e.do(t, "POST", "/api/dekit/update", map[string]any{"version": "canary"})
	if rec.Code != 202 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	j := e.waitJob(t, out["id"].(string))
	if j.State != jobs.Succeeded || j.Steps[1].State != jobs.Skipped || !strings.Contains(strings.Join(j.Output, "\n"), "installed") {
		t.Fatalf("update job %+v", j)
	}
	if got := e.fake.called("update"); len(got) != 1 || !reflect.DeepEqual(got[0], []string{"update", "canary"}) {
		t.Fatalf("calls %v", e.fake.calls)
	}
}
