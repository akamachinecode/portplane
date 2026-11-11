package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/osinfo"
	"github.com/akamachinecode/portplane/internal/portless"
)

// Runner is the subset of the dekit CLI the agent uses (a fake in tests).
type Runner interface {
	Available() bool
	Version(ctx context.Context) (string, error)
	Runners(ctx context.Context) ([]dekit.RunnerRecord, error)
	List(ctx context.Context, root string) ([]dekit.TaskState, error)
	Act(ctx context.Context, root, verb, target string) error
	Up(ctx context.Context, root string) error
	Screen(ctx context.Context, root, task string) (string, error)
}

// Router is the subset of portless the agent uses.
type Router interface {
	Available() bool
	Version(ctx context.Context) (string, error)
	Routes() []portless.Route
	Proxy() portless.Proxy
}

// task is a dekit task joined with its live state while collecting.
type task struct {
	root   string
	cfg    *dekit.Task // nil for tasks only the runner knows (spawned)
	state  *dekit.TaskState
	order  int
	app    model.App
	rootPI int // pid of the process dekit started for it
}

// collect builds one machine snapshot. It never fails as a whole: problems
// are reported on the runner or machine they belong to.
func (l *Local) collect(ctx context.Context) model.MachineSnapshot {
	folders := l.Folders()
	snap := model.MachineSnapshot{
		Machine:    l.machine(),
		Tools:      l.tools(ctx),
		Folders:    folders,
		Runners:    []model.Runner{},
		Apps:       []model.App{},
		OtherPorts: []model.Port{},
	}

	projects := dekit.Discover(folders)
	runnerPIDs := map[string]int{}
	if l.dekit.Available() {
		if recs, err := l.dekit.Runners(ctx); err == nil {
			for _, r := range recs {
				if r.Running && r.PID > 0 {
					runnerPIDs[filepath.Clean(r.Root)] = r.PID
				}
			}
		}
	}

	var tasks []*task
	byRoot := map[string][]*task{}
	order := 0
	for _, p := range projects {
		run := model.Runner{Root: p.Root, Name: l.shortPath(p.Root)}
		cfg, err := l.configs.load(p.Root)
		if err != nil {
			run.Error = err.Error()
		}
		var states []dekit.TaskState
		switch {
		case !l.dekit.Available():
			run.Error = "dekit is not installed"
		default:
			states, err = l.dekit.List(ctx, p.Root)
			switch {
			case errors.Is(err, dekit.ErrRunnerDown):
				run.Up = false
			case err != nil:
				run.Error = err.Error()
			default:
				run.Up = true
			}
		}
		snap.Runners = append(snap.Runners, run)

		joined := joinTasks(cfg, states)
		for _, t := range joined {
			t.root = p.Root
			if p.Within != "" && (t.cfg == nil || !dekit.Inside(t.cfg.Dir, p.Within)) {
				continue
			}
			t.order = order
			order++
			tasks = append(tasks, t)
			byRoot[p.Root] = append(byRoot[p.Root], t)
		}
	}

	listeners, _ := l.os.Listeners(ctx)
	cache := osinfo.NewCache(l.os)
	routes := l.routes()
	proxy := l.proxy()
	routeByPID := map[int]portless.Route{}
	routeByPort := map[int]portless.Route{}
	for _, r := range routes {
		if r.PID > 0 {
			routeByPID[r.PID] = r
		}
		routeByPort[r.Port] = r
	}

	// Assign listeners to tasks through the process tree: dekit starts each
	// task as a direct child of its runner process.
	pidRunner := map[int]string{}
	for root, pid := range runnerPIDs {
		pidRunner[pid] = root
	}
	listening := map[int]bool{}
	var unowned []osinfo.Listener
	self := os.Getpid()
	for _, ln := range listeners {
		listening[ln.Port] = true
		if ln.PID == self {
			continue
		}
		if ln.PID <= 0 {
			// Owned by another user (system services, Docker's proxy): not
			// the user's dev servers, and nothing Portplane can act on.
			continue
		}
		chain := append([]int{ln.PID}, cache.Ancestors(ctx, ln.PID)...)
		var owner *task
		for i := 0; i+1 < len(chain); i++ {
			root, ok := pidRunner[chain[i+1]]
			if !ok {
				continue
			}
			owner = matchTask(ctx, cache, byRoot[root], chain[i])
			if owner != nil {
				owner.rootPI = chain[i]
			}
			break
		}
		if owner == nil {
			unowned = append(unowned, ln)
			continue
		}
		owner.app.Ports = appendUnique(owner.app.Ports, ln.Port)
		if owner.app.PID == 0 {
			owner.app.PID = owner.rootPI
		}
	}

	// Fill in every app.
	claimed := map[int]bool{}
	for _, t := range tasks {
		for _, p := range t.app.Ports {
			claimed[p] = true
		}
	}
	for _, t := range tasks {
		l.describe(t, tasks, routeByPID, routeByPort, proxy, listening, claimed)
	}
	for _, t := range tasks {
		t.app.State, t.app.Detail = deriveState(t, tasks, listening)
		snap.Apps = append(snap.Apps, t.app)
	}

	// Everything else that listens.
	for _, ln := range unowned {
		if claimed[ln.Port] || l.isProxyPort(ln.Port, proxy) {
			continue
		}
		p := model.Port{Port: ln.Port, Address: ln.Address, PID: ln.PID}
		if proc := cache.Proc(ctx, ln.PID); proc != nil {
			p.Process = osinfo.DisplayName(proc.Cmdline)
		}
		p.Dir = cache.Cwd(ctx, ln.PID)
		if repo := l.git.Find(p.Dir); repo != nil && p.Dir != "" {
			p.Project = repo.Name()
		}
		for _, f := range folders {
			if dekit.Inside(p.Dir, f) {
				p.InFolder = true
				break
			}
		}
		if r, ok := routeByPort[ln.Port]; ok {
			p.Route = r.Hostname
			p.URL = proxy.URL(r.Hostname)
		} else {
			p.URL = "http://localhost:" + strconv.Itoa(ln.Port)
		}
		snap.OtherPorts = append(snap.OtherPorts, p)
	}
	sort.SliceStable(snap.OtherPorts, func(i, j int) bool {
		if snap.OtherPorts[i].InFolder != snap.OtherPorts[j].InFolder {
			return snap.OtherPorts[i].InFolder
		}
		return snap.OtherPorts[i].Port < snap.OtherPorts[j].Port
	})

	snap.Projects = model.Group(snap.Apps)
	snap.UpdatedAt = time.Now().UTC()
	return snap
}

// joinTasks merges config tasks with live states, in the runner's order when
// it is up and config order otherwise.
func joinTasks(cfg *dekit.Config, states []dekit.TaskState) []*task {
	var out []*task
	used := map[string]bool{}
	for i := range states {
		st := &states[i]
		t := &task{state: st}
		if cfg != nil {
			t.cfg = cfg.Task(st.Path)
		}
		used[st.Path] = true
		out = append(out, t)
	}
	if cfg != nil {
		for i := range cfg.Tasks {
			if !used[cfg.Tasks[i].Path] {
				out = append(out, &task{cfg: &cfg.Tasks[i]})
			}
		}
	}
	return out
}

// matchTask finds which task of a runner a process (a direct child of the
// runner) belongs to, by comparing its command line with each task's cmd.
func matchTask(ctx context.Context, cache *osinfo.Cache, tasks []*task, pid int) *task {
	proc := cache.Proc(ctx, pid)
	if proc == nil {
		return nil
	}
	var best *task
	bestScore := 0
	for _, t := range tasks {
		if t.cfg == nil || len(t.cfg.Cmd) == 0 {
			continue
		}
		if s := cmdScore(proc.Cmdline, t.cfg.Cmd); s > bestScore {
			best, bestScore = t, s
		}
	}
	if best != nil {
		return best
	}
	// A single alive task without a known command: it must be that one.
	var alive []*task
	for _, t := range tasks {
		if t.state != nil && aliveState(t.state.State) {
			alive = append(alive, t)
		}
	}
	if len(alive) == 1 && (alive[0].cfg == nil || len(alive[0].cfg.Cmd) == 0) {
		return alive[0]
	}
	return nil
}

// cmdScore compares a process command line with a task's argv. dekit runs
// argv directly, but scripts appear as "<interpreter> <script path> args…",
// and Windows shims as "cmd /c …". A higher score is a better match; 0 is no
// match.
func cmdScore(cmdline, argv []string) int {
	if len(cmdline) == 0 || len(argv) == 0 {
		return 0
	}
	n := len(argv) - 1 // arguments after the program
	if n > len(cmdline)-1 {
		return 0
	}
	tail := cmdline[len(cmdline)-n:]
	for i := range tail {
		if tail[i] != argv[i+1] {
			return 0
		}
	}
	prog := progName(argv[0])
	for _, c := range cmdline[:len(cmdline)-n] {
		if progName(c) == prog {
			return 10 + n
		}
	}
	if n > 0 {
		return n // arguments match, program name differs (wrapper or shim)
	}
	return 0
}

func progName(p string) string {
	p = strings.ReplaceAll(p, `\`, "/")
	if i := strings.LastIndex(p, "/"); i >= 0 {
		p = p[i+1:]
	}
	p = strings.ToLower(p)
	for _, ext := range []string{".exe", ".cmd", ".bat", ".js", ".mjs", ".cjs"} {
		p = strings.TrimSuffix(p, ext)
	}
	return p
}

func aliveState(s string) bool {
	switch s {
	case "running", "ready", "starting", "stopping":
		return true
	}
	return false
}

// describe fills an app's identity, URL and ports.
func (l *Local) describe(t *task, all []*task, routeByPID, routeByPort map[int]portless.Route, proxy portless.Proxy, listening, claimed map[int]bool) {
	a := &t.app
	a.Runner = t.root
	a.Order = t.order
	a.Kind = "service"
	switch {
	case t.state != nil:
		a.Task, a.Label, a.RawState = t.state.Path, t.state.Label, t.state.State
		if t.state.Kind != "" {
			a.Kind = t.state.Kind
		}
	case t.cfg != nil:
		a.Task = t.cfg.Path
		a.Kind = t.cfg.Kind
	}
	a.ID = t.root + "#" + a.Task
	var cmd []string
	if t.cfg != nil {
		if a.Label == "" {
			a.Label = t.cfg.Label
		}
		a.Dir = t.cfg.Dir
		a.Command = t.cfg.Cmd
		a.Deps = t.cfg.Deps
		cmd = t.cfg.Cmd
	}
	if a.Label == "" {
		a.Label = a.Task
		if i := strings.LastIndex(a.Task, "/"); i >= 0 {
			a.Label = a.Task[i+1:]
		}
	}

	repo := l.git.Find(a.Dir)
	if repo != nil {
		a.Worktree = repo.WorktreeName
	}
	switch {
	case strings.Contains(a.Task, "/"):
		a.Project, _, _ = strings.Cut(a.Task, "/")
	case repo != nil:
		a.Project = repo.Name()
	default:
		a.Project = filepath.Base(t.root)
	}

	// The URL: a route owned by the task's process, else the name its
	// command gives portless, else a static alias job it depends on.
	if r, ok := routeByPID[t.rootPI]; ok && t.rootPI > 0 {
		a.Hostname, a.Port = r.Hostname, r.Port
	}
	if a.Hostname == "" {
		if w := portless.ParseCommand(cmd); w != nil {
			a.Hostname = w.Hostname(a.Worktree, "localhost")
		}
	}
	if a.Hostname == "" {
		for _, dep := range a.Deps {
			for _, o := range all {
				if o.root == t.root && o.cfg != nil && o.cfg.Path == dep {
					if name, port := aliasOf(o.cfg.Cmd); name != "" {
						a.Hostname = name
						if port > 0 && listening[port] {
							a.Port = port
						}
					}
				}
			}
		}
	}
	if a.Hostname != "" && a.Port == 0 {
		if r, ok := routeByHost(routeByPort, a.Hostname); ok && (t.state == nil || aliveState(t.state.State)) {
			a.Port = r.Port
		}
	}
	// Ports the task declares (ready.tcp, --app-port, PORT) when the process
	// tree did not tell us.
	if a.Port == 0 && len(a.Ports) == 0 && t.state != nil && aliveState(t.state.State) {
		for _, p := range declaredPorts(t.cfg) {
			if listening[p] && !claimed[p] {
				a.Ports = appendUnique(a.Ports, p)
				claimed[p] = true
			}
		}
	}
	if a.Port == 0 && len(a.Ports) > 0 {
		a.Port = a.Ports[0]
	}
	if a.Port != 0 {
		a.Ports = appendUnique(a.Ports, a.Port)
		sort.Ints(a.Ports)
	}
	switch {
	case a.Hostname != "" && l.portless.Available():
		a.URL = proxy.URL(a.Hostname)
	case a.Port != 0 && t.state != nil && aliveState(t.state.State):
		a.URL = "http://localhost:" + strconv.Itoa(a.Port)
	}
}

func routeByHost(routes map[int]portless.Route, host string) (portless.Route, bool) {
	for _, r := range routes {
		if r.Hostname == host {
			return r, true
		}
	}
	return portless.Route{}, false
}

// aliasOf recognises `portless alias <name> <port>` jobs (field notes:
// servers that cannot be wrapped get a static route).
func aliasOf(cmd []string) (string, int) {
	for i := 0; i+3 < len(cmd); i++ {
		if progName(cmd[i]) != "portless" || cmd[i+1] != "alias" || strings.HasPrefix(cmd[i+2], "-") {
			continue
		}
		port, _ := strconv.Atoi(cmd[i+3])
		name := cmd[i+2]
		if !strings.HasSuffix(name, ".localhost") {
			name += ".localhost"
		}
		return name, port
	}
	return "", 0
}

// declaredPorts are ports a task's config names: ready.tcp, ready.http,
// --app-port, --port/-p flags and a PORT variable.
func declaredPorts(t *dekit.Task) []int {
	if t == nil {
		return nil
	}
	var out []int
	add := func(s string) {
		if p, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && p > 0 && p < 65536 {
			out = appendUnique(out, p)
		}
	}
	if t.ReadyTCP != "" {
		s := t.ReadyTCP
		if i := strings.LastIndex(s, ":"); i >= 0 {
			s = s[i+1:]
		}
		add(s)
	}
	if t.ReadyHTTP != "" {
		s := strings.TrimPrefix(strings.TrimPrefix(t.ReadyHTTP, "http://"), "https://")
		if i := strings.IndexByte(s, '/'); i >= 0 {
			s = s[:i]
		}
		if i := strings.LastIndex(s, ":"); i >= 0 {
			add(s[i+1:])
		}
	}
	for i, a := range t.Cmd {
		switch {
		case (a == "--port" || a == "-p" || a == "--app-port") && i+1 < len(t.Cmd):
			add(t.Cmd[i+1])
		case strings.HasPrefix(a, "--port="):
			add(strings.TrimPrefix(a, "--port="))
		}
	}
	if v, ok := t.Env["PORT"]; ok {
		add(v)
	}
	return out
}

// deriveState turns dekit's state and the port facts into what the user sees.
func deriveState(t *task, all []*task, listening map[int]bool) (model.State, string) {
	if t.state == nil {
		return model.StateOff, ""
	}
	st := t.state
	switch st.State {
	case "ready", "running":
		if t.app.Kind == "job" {
			return model.StateStarting, "running"
		}
		expects := t.app.Port
		if expects == 0 && t.app.Hostname != "" && len(t.app.Ports) == 0 {
			return model.StateStarting, "waiting for its port"
		}
		if expects != 0 && !listening[expects] {
			return model.StateStarting, "waiting for port " + strconv.Itoa(expects)
		}
		return model.StateOn, ""
	case "starting":
		for _, dep := range t.app.Deps {
			for _, o := range all {
				if o.root == t.root && o.app.Task == dep && o.state != nil && aliveState(o.state.State) && o.state.State != "ready" {
					return model.StateStarting, "waiting for " + dep
				}
			}
		}
		return model.StateStarting, "starting"
	case "stopping":
		return model.StateStopping, "stopping"
	case "exited", "backoff":
		detail := exitDetail(st)
		if st.State == "backoff" {
			detail = "restarting after failure (" + detail + ")"
		}
		if st.State == "exited" && st.ExitCode != nil && *st.ExitCode == 0 && st.SignalName() == "" && st.Reason == "" {
			return model.StateOff, "exited"
		}
		return model.StateFailed, detail
	case "done":
		return model.StateDone, ""
	case "idle":
		if st.Reason == "kill_timeout" {
			return model.StateOff, "stop timed out"
		}
		return model.StateOff, ""
	}
	return model.StateUnknown, st.State
}

func exitDetail(st *dekit.TaskState) string {
	switch {
	case st.Reason == "ready_timeout":
		return "not ready in time"
	case st.SignalName() != "":
		return "killed by " + st.SignalName()
	case st.ExitCode != nil:
		return fmt.Sprintf("exit code %d", *st.ExitCode)
	}
	return st.State
}

func appendUnique(s []int, v int) []int {
	for _, x := range s {
		if x == v {
			return s
		}
	}
	return append(s, v)
}

func (l *Local) isProxyPort(port int, p portless.Proxy) bool {
	if !l.portless.Available() {
		return false
	}
	return port == p.Port || (p.HTTPS && port == 80 && p.Port == 443)
}
