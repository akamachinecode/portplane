package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/osinfo"
	"github.com/akamachinecode/portplane/internal/portless"
)

func TestCmdScore(t *testing.T) {
	task := []string{"portless", "web", "node", "-e", "x"}
	// A node shim: "node /path/bin/portless web node -e x".
	proc := []string{"/usr/bin/node", "/usr/local/bin/portless", "web", "node", "-e", "x"}
	if cmdScore(proc, task) < 10 {
		t.Fatalf("shim should match: %d", cmdScore(proc, task))
	}
	if cmdScore([]string{"node", "-e", "y"}, []string{"node", "-e", "x"}) != 0 {
		t.Fatal("different args must not match")
	}
	if cmdScore([]string{"/usr/bin/postgres"}, []string{"postgres"}) == 0 {
		t.Fatal("a bare program should match by name")
	}
	if cmdScore([]string{`C:\Windows\system32\cmd.exe`, "/c", "pnpm run dev"}, []string{"cmd", "/c", "pnpm run dev"}) < 10 {
		t.Fatal("windows cmd /c should match")
	}
}

func intp(i int) *int { return &i }

func TestDeriveState(t *testing.T) {
	listening := map[int]bool{4514: true}
	cases := []struct {
		name   string
		t      *task
		state  model.State
		detail string
	}{
		{"ready with listening port", &task{state: &dekit.TaskState{State: "ready"}, app: model.App{Kind: "service", Port: 4514}}, model.StateOn, ""},
		{"ready, port not up yet", &task{state: &dekit.TaskState{State: "ready"}, app: model.App{Kind: "service", Port: 4600}}, model.StateStarting, "waiting for port 4600"},
		{"wrapped, no route yet", &task{state: &dekit.TaskState{State: "running"}, app: model.App{Kind: "service", Hostname: "web.localhost"}}, model.StateStarting, "waiting for its port"},
		{"worker without ports", &task{state: &dekit.TaskState{State: "running"}, app: model.App{Kind: "service"}}, model.StateOn, ""},
		{"job running", &task{state: &dekit.TaskState{State: "running"}, app: model.App{Kind: "job"}}, model.StateStarting, "running"},
		{"crash", &task{state: &dekit.TaskState{State: "exited", ExitCode: intp(3)}, app: model.App{Kind: "service"}}, model.StateFailed, "exit code 3"},
		{"clean exit", &task{state: &dekit.TaskState{State: "exited", ExitCode: intp(0)}, app: model.App{Kind: "service"}}, model.StateOff, "exited"},
		{"ready timeout", &task{state: &dekit.TaskState{State: "exited", ExitCode: intp(0), Reason: "ready_timeout"}, app: model.App{Kind: "service"}}, model.StateFailed, "not ready in time"},
		{"backoff", &task{state: &dekit.TaskState{State: "backoff", ExitCode: intp(1)}, app: model.App{Kind: "service"}}, model.StateFailed, "restarting after failure (exit code 1)"},
		{"done job", &task{state: &dekit.TaskState{State: "done"}, app: model.App{Kind: "job"}}, model.StateDone, ""},
		{"idle", &task{state: &dekit.TaskState{State: "idle"}, app: model.App{Kind: "service"}}, model.StateOff, ""},
		{"runner down", &task{app: model.App{Kind: "service"}}, model.StateOff, ""},
	}
	for _, c := range cases {
		s, d := deriveState(c.t, nil, listening)
		if s != c.state || d != c.detail {
			t.Errorf("%s: got %s %q, want %s %q", c.name, s, d, c.state, c.detail)
		}
	}
	// Waiting on a dependency job.
	install := &task{root: "/r", state: &dekit.TaskState{State: "running"}, app: model.App{Task: "shop/install", Kind: "job"}}
	web := &task{root: "/r", state: &dekit.TaskState{State: "starting"}, app: model.App{Task: "shop/web", Kind: "service", Deps: []string{"shop/install"}}}
	if s, d := deriveState(web, []*task{install, web}, listening); s != model.StateStarting || d != "waiting for shop/install" {
		t.Errorf("dep wait: %s %q", s, d)
	}
}

func TestDeclaredPorts(t *testing.T) {
	tk := &dekit.Task{
		ReadyTCP:  "127.0.0.1:3001",
		ReadyHTTP: "http://localhost:3002/health",
		Cmd:       []string{"vite", "--port", "5173", "--port=5174"},
		Env:       map[string]string{"PORT": "8080"},
	}
	if got := declaredPorts(tk); !reflect.DeepEqual(got, []int{3001, 3002, 5173, 5174, 8080}) {
		t.Fatalf("got %v", got)
	}
}

func TestGroupTargets(t *testing.T) {
	group := []model.App{
		{Task: "shop/install", Kind: "job", State: model.StateDone},
		{Task: "shop/web", Kind: "service", State: model.StateOn},
		{Task: "shop/api", Kind: "service", State: model.StateOff},
		{Task: "shop/prod", Kind: "service", State: model.StateOff},
	}
	if got := groupTargets(group, "shop/", model.VerbStop, nil); !reflect.DeepEqual(got, []string{"shop/**"}) {
		t.Errorf("stop: %v", got)
	}
	if got := groupTargets(group, "shop/", model.VerbStart, nil); !reflect.DeepEqual(got, []string{"shop/web", "shop/api", "shop/prod"}) {
		t.Errorf("start all services: %v", got)
	}
	if got := groupTargets(group, "shop/", model.VerbStart, map[string]bool{"shop/web": true, "shop/api": true}); !reflect.DeepEqual(got, []string{"shop/web", "shop/api"}) {
		t.Errorf("start autostart only: %v", got)
	}
	if got := groupTargets(group, "", model.VerbRestart, nil); !reflect.DeepEqual(got, []string{"shop/web"}) {
		t.Errorf("restart running: %v", got)
	}
}

func TestLastLines(t *testing.T) {
	screen := "\x1b[31mError:\x1b[0m boom\r\n\r\n  at main.js:3\r\n\r\n\r\n"
	if got := lastLines(screen, 15); !reflect.DeepEqual(got, []string{"Error: boom", "  at main.js:3"}) {
		t.Fatalf("got %q", got)
	}
	if got := lastLines("a\nb\nc", 2); !reflect.DeepEqual(got, []string{"b", "c"}) {
		t.Fatalf("got %q", got)
	}
}

// fakes for a full collect run.

type fakeDekit struct {
	runners []dekit.RunnerRecord
	states  map[string][]dekit.TaskState
	acted   []string
}

func (f *fakeDekit) Available() bool                                       { return true }
func (f *fakeDekit) Version(context.Context) (string, error)               { return "0.10.3", nil }
func (f *fakeDekit) Runners(context.Context) ([]dekit.RunnerRecord, error) { return f.runners, nil }
func (f *fakeDekit) List(_ context.Context, root string) ([]dekit.TaskState, error) {
	s, ok := f.states[root]
	if !ok {
		return nil, dekit.ErrRunnerDown
	}
	return s, nil
}
func (f *fakeDekit) Act(_ context.Context, root, verb, target string) error {
	f.acted = append(f.acted, verb+" "+target)
	return nil
}
func (f *fakeDekit) Up(context.Context, string) error { return nil }
func (f *fakeDekit) Screen(context.Context, string, string) (string, error) {
	return "boom\n", nil
}

type fakeRouter struct{ routes []portless.Route }

func (f fakeRouter) Available() bool                         { return true }
func (f fakeRouter) Version(context.Context) (string, error) { return "0.16.0", nil }
func (f fakeRouter) Routes() []portless.Route                { return f.routes }
func (f fakeRouter) Proxy() portless.Proxy {
	return portless.Proxy{Running: true, Port: 443, HTTPS: true}
}

type fakeOS struct {
	listeners []osinfo.Listener
	procs     map[int]osinfo.Proc
	cwds      map[int]string
}

func (f fakeOS) Listeners(context.Context) ([]osinfo.Listener, error) { return f.listeners, nil }
func (f fakeOS) Proc(_ context.Context, pid int) (osinfo.Proc, bool) {
	p, ok := f.procs[pid]
	return p, ok
}
func (f fakeOS) Cwd(_ context.Context, pid int) string { return f.cwds[pid] }

func TestCollectAssignsPortsThroughTheProcessTree(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root+"/dekit.yaml", `tasks:
  shop/web:
    cwd: apps/web
    cmd: ["portless", "web.shop", "pnpm", "run", "dev"]
  shop/api:
    cmd: ["node", "api.js"]
    ready: {tcp: 4100}
  shop/broken:
    cmd: ["node", "-e", "process.exit(2)"]
`)
	dk := &fakeDekit{
		runners: []dekit.RunnerRecord{{PID: 100, Root: root, Running: true}},
		states: map[string][]dekit.TaskState{root: {
			{Path: "shop/web", Kind: "service", State: "ready"},
			{Path: "shop/api", Kind: "service", State: "ready"},
			{Path: "shop/broken", Kind: "service", State: "exited", ExitCode: intp(2)},
		}},
	}
	osf := fakeOS{
		listeners: []osinfo.Listener{
			{Port: 4514, Address: "127.0.0.1", PID: 120}, // vite, grandchild of the portless wrapper
			{Port: 4100, Address: "127.0.0.1", PID: 130}, // api
			{Port: 9000, Address: "127.0.0.1", PID: 200}, // something else
		},
		procs: map[int]osinfo.Proc{
			110: {PID: 110, PPID: 100, Cmdline: []string{"node", "/bin/portless", "web.shop", "pnpm", "run", "dev"}},
			115: {PID: 115, PPID: 110, Cmdline: []string{"pnpm", "run", "dev"}},
			120: {PID: 120, PPID: 115, Cmdline: []string{"node", "/repo/node_modules/vite/bin/vite.js"}},
			130: {PID: 130, PPID: 100, Cmdline: []string{"/usr/bin/node", "api.js"}},
			200: {PID: 200, PPID: 1, Cmdline: []string{"python3", "-m", "http.server"}},
			100: {PID: 100, PPID: 1, Cmdline: []string{"dekit", "runner", "run"}},
		},
		cwds: map[int]string{200: root + "/scratch"},
	}
	l := NewLocal(Options{
		Folders:  []string{root},
		Dekit:    dk,
		Portless: fakeRouter{routes: []portless.Route{{Hostname: "web.shop.localhost", Port: 4514, PID: 110}}},
		OS:       osf,
	})
	snap := l.collect(context.Background())
	apps := map[string]model.App{}
	for _, a := range snap.Apps {
		apps[a.Task] = a
	}
	web := apps["shop/web"]
	if web.State != model.StateOn || web.URL != "https://web.shop.localhost" || web.Port != 4514 || web.PID != 110 {
		t.Errorf("web: %+v", web)
	}
	api := apps["shop/api"]
	if api.State != model.StateOn || api.Port != 4100 || api.URL != "http://localhost:4100" {
		t.Errorf("api: %+v", api)
	}
	if b := apps["shop/broken"]; b.State != model.StateFailed || b.Detail != "exit code 2" {
		t.Errorf("broken: %+v", b)
	}
	if len(snap.OtherPorts) != 1 || snap.OtherPorts[0].Port != 9000 || !snap.OtherPorts[0].InFolder || snap.OtherPorts[0].Process != "python3 http" {
		t.Errorf("other ports: %+v", snap.OtherPorts)
	}
	if len(snap.Projects) != 1 || snap.Projects[0].Name != "shop" || snap.Projects[0].Running != 2 {
		t.Errorf("projects: %+v", snap.Projects)
	}

	// Actions validate the target and go to dekit.
	if err := l.Act(context.Background(), model.Target{Machine: "local", Runner: root, Task: "shop/nope"}, model.VerbStart); err == nil {
		t.Error("unknown task must be refused")
	}
	if err := l.Act(context.Background(), model.Target{Machine: "local", Runner: "/elsewhere", Task: "shop/web"}, model.VerbStart); err == nil {
		t.Error("unknown runner must be refused")
	}
	if err := l.Act(context.Background(), model.Target{Machine: "local", Runner: root, Prefix: "shop/"}, model.VerbStop); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(dk.acted, []string{"stop shop/**"}) {
		t.Errorf("acted %v", dk.acted)
	}
}

func TestCollectRunnerDown(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root+"/dekit.yaml", "tasks:\n  web:\n    cmd: [\"portless\", \"blog\", \"pnpm\", \"run\", \"dev\"]\n")
	l := NewLocal(Options{Folders: []string{root}, Dekit: &fakeDekit{}, Portless: fakeRouter{}, OS: fakeOS{}})
	snap := l.collect(context.Background())
	if len(snap.Runners) != 1 || snap.Runners[0].Up {
		t.Fatalf("runners: %+v", snap.Runners)
	}
	if len(snap.Apps) != 1 || snap.Apps[0].State != model.StateOff || snap.Apps[0].URL != "https://blog.localhost" {
		t.Fatalf("apps: %+v", snap.Apps)
	}
}

func writeFile(t *testing.T, p, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestFoldersAreNeverNull(t *testing.T) {
	l := NewLocal(Options{Dekit: &fakeDekit{}, Portless: fakeRouter{}, OS: fakeOS{}})
	snap := l.collect(context.Background())
	b, _ := json.Marshal(snap)
	if !strings.Contains(string(b), `"folders":[]`) {
		t.Fatalf("folders must be [] for the UI: %s", b)
	}
	if l.Folders() == nil {
		t.Fatal("Folders() must not be nil")
	}
	if err := l.SetFolders(context.Background(), []string{"relative/dir"}); err == nil {
		t.Fatal("relative folders must be refused")
	}
}

func TestSameCommandInSeveralFoldersUsesTheCwd(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root+"/dekit.yaml", `tasks:
  shop/web:
    cwd: apps/web
    cmd: pnpm dev
  shop/api:
    cwd: apps/api
    cmd: pnpm dev
`)
	dk := &fakeDekit{
		runners: []dekit.RunnerRecord{{PID: 100, Root: root, Running: true}},
		states: map[string][]dekit.TaskState{root: {
			{Path: "shop/web", Kind: "service", State: "ready"},
			{Path: "shop/api", Kind: "service", State: "ready"},
		}},
	}
	osf := fakeOS{
		listeners: []osinfo.Listener{{Port: 3000, PID: 111}, {Port: 3001, PID: 121}},
		procs: map[int]osinfo.Proc{
			110: {PID: 110, PPID: 100, Cmdline: []string{"pnpm", "dev"}},
			111: {PID: 111, PPID: 110, Cmdline: []string{"node", "web.js"}},
			120: {PID: 120, PPID: 100, Cmdline: []string{"pnpm", "dev"}},
			121: {PID: 121, PPID: 120, Cmdline: []string{"node", "api.js"}},
		},
		cwds: map[int]string{110: root + "/apps/web", 120: root + "/apps/api/"},
	}
	l := NewLocal(Options{Folders: []string{root}, Dekit: dk, Portless: fakeRouter{}, OS: osf})
	snap := l.collect(context.Background())
	ports := map[string]int{}
	for _, a := range snap.Apps {
		ports[a.Task] = a.Port
	}
	if ports["shop/web"] != 3000 || ports["shop/api"] != 3001 {
		t.Fatalf("ports by cwd: %v", ports)
	}
	if err := l.Act(context.Background(), model.Target{Runner: root, Prefix: "sho"}, model.VerbStop); err == nil {
		t.Fatal("a prefix that is not a folder must be refused")
	}
}

func TestHiddenTaskKeepsItsPorts(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root+"/dekit.yaml", `tasks:
  shop/web:
    cwd: apps/web
    cmd: pnpm dev
  shop/api:
    cwd: apps/api
    cmd: pnpm dev
`)
	for _, d := range []string{"apps/web", "apps/api"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	dk := &fakeDekit{
		runners: []dekit.RunnerRecord{{PID: 100, Root: root, Running: true}},
		states: map[string][]dekit.TaskState{root: {
			{Path: "shop/web", Kind: "service", State: "ready"},
			{Path: "shop/api", Kind: "service", State: "ready"},
		}},
	}
	osf := fakeOS{
		listeners: []osinfo.Listener{{Port: 3000, PID: 111}, {Port: 3001, PID: 121}},
		procs: map[int]osinfo.Proc{
			110: {PID: 110, PPID: 100, Cmdline: []string{"pnpm", "dev"}},
			111: {PID: 111, PPID: 110, Cmdline: []string{"node", "web.js"}},
			120: {PID: 120, PPID: 100, Cmdline: []string{"pnpm", "dev"}},
			121: {PID: 121, PPID: 120, Cmdline: []string{"node", "api.js"}},
		},
		cwds: map[int]string{110: root + "/apps/web", 120: root + "/apps/api"},
	}
	// Only apps/web is chosen: shop/api is hidden but still owns :3001.
	l := NewLocal(Options{Folders: []string{root + "/apps/web"}, Dekit: dk, Portless: fakeRouter{}, OS: osf})
	snap := l.collect(context.Background())
	if len(snap.Apps) != 1 || snap.Apps[0].Task != "shop/web" || !reflect.DeepEqual(snap.Apps[0].Ports, []int{3000}) {
		t.Fatalf("apps: %+v", snap.Apps)
	}
	for _, p := range snap.OtherPorts {
		if p.Port == 3001 {
			t.Fatal("a hidden task's port is not an other port")
		}
	}
}
