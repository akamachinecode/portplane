package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/akamachinecode/portplane/internal/buildinfo"
	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/gitinfo"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/osinfo"
	"github.com/akamachinecode/portplane/internal/portless"
)

// Options configures a local agent.
type Options struct {
	ID       string // machine id; "local" by default
	Name     string // display name; the hostname by default
	Folders  []string
	Interval time.Duration // how often to collect while watched; 2s by default
	Dekit    Runner
	Portless Router
	OS       osinfo.Source
}

// Local is the agent for the machine Portplane runs on.
type Local struct {
	id, name string
	pace     atomic.Int64 // collection interval, as a time.Duration
	dekit    Runner
	portless Router
	os       osinfo.Source
	git      *gitinfo.Lookup
	configs  *configCache
	home     string

	mu       sync.Mutex
	folders  []string
	last     model.MachineSnapshot
	lastKey  []byte
	lastAt   time.Time
	watchers map[chan model.MachineSnapshot]struct{}
	poke     chan struct{}
	states   map[string][]dekit.TaskState // last good `dekit ls` per runner
	toolsAt  time.Time
	toolsVal model.Tools
	closed   chan struct{}
	loopOnce sync.Once
}

// NewLocal creates the local agent.
func NewLocal(o Options) *Local {
	if o.ID == "" {
		o.ID = "local"
	}
	if o.Name == "" {
		o.Name, _ = os.Hostname()
	}
	if o.Interval == 0 {
		o.Interval = 2 * time.Second
	}
	if o.Dekit == nil {
		o.Dekit = dekit.NewCLI()
	}
	if o.Portless == nil {
		o.Portless = portless.New()
	}
	if o.OS == nil {
		o.OS = osinfo.System{}
	}
	home, _ := os.UserHomeDir()
	l := &Local{
		id: o.ID, name: o.Name,
		dekit: o.Dekit, portless: o.Portless, os: o.OS,
		git: gitinfo.NewLookup(), configs: newConfigCache(), home: home,
		folders:  cleanFolders(o.Folders),
		watchers: map[chan model.MachineSnapshot]struct{}{},
		poke:     make(chan struct{}, 1),
		closed:   make(chan struct{}),
	}
	l.pace.Store(int64(o.Interval))
	return l
}

func cleanFolders(in []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, f := range in {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		if abs, err := filepath.Abs(f); err == nil {
			f = abs
		}
		if !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	return out
}

func (l *Local) rememberStates(root string, s []dekit.TaskState) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.states == nil {
		l.states = map[string][]dekit.TaskState{}
	}
	if s == nil {
		delete(l.states, root)
		return
	}
	l.states[root] = s
}

func (l *Local) rememberedStates(root string) []dekit.TaskState {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.states[root]
}

// Folders returns the watched folders.
func (l *Local) Folders() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]string, len(l.folders)) // never nil: the UI reads .length
	copy(out, l.folders)
	return out
}

// SetFolders replaces the watched folders and refreshes.
func (l *Local) SetFolders(_ context.Context, folders []string) error {
	for i, f := range folders {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		if f == "~" || strings.HasPrefix(f, "~/") || strings.HasPrefix(f, `~\`) {
			f = filepath.Join(l.home, f[1:])
		}
		if !filepath.IsAbs(f) {
			return fmt.Errorf("%s: use a full path (such as %s)", f, filepath.Join(l.home, f))
		}
		folders[i] = f
		fi, err := os.Stat(f)
		if err != nil {
			return fmt.Errorf("folder %s: %w", f, err)
		}
		if !fi.IsDir() {
			return fmt.Errorf("%s is not a folder", f)
		}
	}
	l.mu.Lock()
	l.folders = cleanFolders(folders)
	l.mu.Unlock()
	l.refreshSoon()
	return nil
}

func (l *Local) machine() model.Machine {
	host, _ := os.Hostname()
	return model.Machine{
		ID: l.id, Name: l.name, Local: true, Hostname: host,
		OS: runtime.GOOS, Arch: runtime.GOARCH, Status: "online",
		Agent: buildinfo.Version(),
	}
}

// tools is refreshed once a minute, since versions rarely change, and at
// once when a tool appears or goes away (installed from the UI, say).
func (l *Local) tools(ctx context.Context) model.Tools {
	dekitThere, portlessThere := l.dekit.Available(), l.portless.Available()
	l.mu.Lock()
	same := (l.toolsVal.Dekit != "") == dekitThere && (l.toolsVal.Portless != "") == portlessThere
	if same && time.Since(l.toolsAt) < time.Minute && !l.toolsAt.IsZero() {
		t := l.toolsVal
		l.mu.Unlock()
		t.ProxyRunning, t.ProxyHTTPS, t.ProxyPort = l.proxyFacts()
		return t
	}
	l.mu.Unlock()
	var t model.Tools
	if dekitThere {
		t.Dekit, _ = l.dekit.Version(ctx)
		if t.Dekit == "" {
			t.Dekit = "unknown"
		}
	}
	if portlessThere {
		t.Portless, _ = l.portless.Version(ctx)
		if t.Portless == "" {
			t.Portless = "unknown"
		}
	}
	l.mu.Lock()
	l.toolsVal, l.toolsAt = t, time.Now()
	l.mu.Unlock()
	t.ProxyRunning, t.ProxyHTTPS, t.ProxyPort = l.proxyFacts()
	return t
}

// RefreshTools forgets the tool versions and collects again soon, such as
// after an install or an upgrade.
func (l *Local) RefreshTools() {
	l.mu.Lock()
	l.toolsAt = time.Time{}
	l.mu.Unlock()
	l.refreshSoon()
}

func (l *Local) proxyFacts() (bool, bool, int) {
	if !l.portless.Available() {
		return false, false, 0
	}
	p := l.portless.Proxy()
	return p.Running, p.HTTPS, p.Port
}

func (l *Local) routes() []portless.Route {
	if !l.portless.Available() {
		return nil
	}
	return l.portless.Routes()
}

func (l *Local) proxy() portless.Proxy { return l.portless.Proxy() }

// shortPath shows a folder relative to the home directory as "~/…".
func (l *Local) shortPath(p string) string {
	if l.home != "" {
		if rel, err := filepath.Rel(l.home, p); err == nil && !strings.HasPrefix(rel, "..") {
			if rel == "." {
				return "~"
			}
			return "~" + string(filepath.Separator) + rel
		}
	}
	return p
}

// Snapshot collects now unless a snapshot newer than a second exists.
func (l *Local) Snapshot(ctx context.Context) (model.MachineSnapshot, error) {
	l.mu.Lock()
	if time.Since(l.lastAt) < time.Second && !l.lastAt.IsZero() {
		s := l.last
		l.mu.Unlock()
		return s, nil
	}
	l.mu.Unlock()
	return l.refresh(ctx), nil
}

// refresh collects and notifies watchers when anything but the timestamp changed.
func (l *Local) refresh(ctx context.Context) model.MachineSnapshot {
	s := l.collect(ctx)
	key := snapshotKey(s)
	l.mu.Lock()
	defer l.mu.Unlock()
	changed := !bytes.Equal(key, l.lastKey)
	l.last, l.lastKey, l.lastAt = s, key, time.Now()
	if !changed {
		return s
	}
	// Sends never block and happen under the lock, so Watch can close a
	// channel safely once its context ends.
	for w := range l.watchers {
		select {
		case w <- s:
		default:
			// The watcher is behind: drop the stale value and send the new one.
			select {
			case <-w:
			default:
			}
			select {
			case w <- s:
			default:
			}
		}
	}
	return s
}

func snapshotKey(s model.MachineSnapshot) []byte {
	s.UpdatedAt = time.Time{}
	b, _ := json.Marshal(s)
	return b
}

func (l *Local) refreshSoon() {
	select {
	case l.poke <- struct{}{}:
	default:
	}
}

// Watch delivers snapshots on change. The first value is the current state.
func (l *Local) Watch(ctx context.Context) <-chan model.MachineSnapshot {
	ch := make(chan model.MachineSnapshot, 1)
	l.mu.Lock()
	l.watchers[ch] = struct{}{}
	l.mu.Unlock()
	l.loopOnce.Do(func() { go l.loop() })
	go func() {
		s, _ := l.Snapshot(ctx)
		l.mu.Lock()
		select {
		case ch <- s:
		default:
		}
		l.mu.Unlock()
		select {
		case <-ctx.Done():
		case <-l.closed:
		}
		l.mu.Lock()
		delete(l.watchers, ch)
		close(ch)
		l.mu.Unlock()
	}()
	return ch
}

// SetInterval changes how often the agent collects while watched. The
// latest call wins; it never blocks.
func (l *Local) SetInterval(d time.Duration) {
	if d <= 0 {
		return
	}
	l.pace.Store(int64(d))
	l.refreshSoon()
}

func (l *Local) loop() {
	current := time.Duration(l.pace.Load())
	t := time.NewTicker(current)
	defer t.Stop()
	for {
		select {
		case <-l.closed:
			return
		case <-t.C:
		case <-l.poke:
		}
		if d := time.Duration(l.pace.Load()); d != current {
			current = d
			t.Reset(d)
		}
		l.mu.Lock()
		n := len(l.watchers)
		l.mu.Unlock()
		if n == 0 {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		l.refresh(ctx)
		cancel()
	}
}

// Act runs a verb on an app or group, after checking that every task exists.
func (l *Local) Act(ctx context.Context, target model.Target, verb model.Verb) error {
	if !verb.Valid() {
		return fmt.Errorf("unknown action %q", verb)
	}
	snap, err := l.Snapshot(ctx)
	if err != nil {
		return err
	}
	var apps []model.App
	for _, a := range snap.Apps {
		if a.Runner == target.Runner {
			apps = append(apps, a)
		}
	}
	if len(apps) == 0 {
		return fmt.Errorf("unknown project %s", target.Runner)
	}
	exists := func(task string) bool {
		for _, a := range apps {
			if a.Task == task {
				return true
			}
		}
		return false
	}
	var targets []string
	switch {
	case target.Task != "":
		if !exists(target.Task) {
			return fmt.Errorf("unknown app %s", target.Task)
		}
		targets = []string{target.Task}
	case target.Prefix != "" || len(target.Tasks) > 0:
		if target.Prefix != "" && !strings.HasSuffix(target.Prefix, "/") {
			return fmt.Errorf("a project prefix must end in /, got %q", target.Prefix)
		}
		var group []model.App
		for _, a := range apps {
			if (target.Prefix != "" && strings.HasPrefix(a.Task, target.Prefix)) || contains(target.Tasks, a.Task) {
				group = append(group, a)
			}
		}
		if len(group) == 0 {
			return errors.New("no apps match")
		}
		prefix := target.Prefix
		if prefix != "" && !l.prefixCovered(target.Runner, prefix, group) {
			prefix = "" // the glob would reach tasks this view does not show
		}
		targets = groupTargets(group, prefix, verb, l.configs.autostart(target.Runner))
	default:
		return errors.New("nothing to act on")
	}
	if !l.dekit.Available() {
		return dekit.ErrNotInstalled
	}
	for _, t := range targets {
		if err := l.dekit.Act(ctx, target.Runner, string(verb), t); err != nil {
			return err
		}
	}
	l.refreshSoon()
	return nil
}

// groupTargets decides what a project- or worktree-wide action touches.
// Stop takes everything under the prefix at once (so dependencies do not
// restart each other); start takes the autostart services, or every service
// when none is marked; restart takes the services that are running.
func groupTargets(group []model.App, prefix string, verb model.Verb, autostart map[string]bool) []string {
	var out []string
	switch verb {
	case model.VerbStop:
		if prefix != "" {
			return []string{prefix + "**"}
		}
		for _, a := range group {
			out = append(out, a.Task)
		}
	case model.VerbStart:
		var marked, services []string
		for _, a := range group {
			if a.Kind == "job" {
				continue
			}
			services = append(services, a.Task)
			if autostart[a.Task] {
				marked = append(marked, a.Task)
			}
		}
		if len(marked) > 0 {
			return marked
		}
		out = services
	case model.VerbRestart:
		for _, a := range group {
			if a.Kind != "job" && a.State.Alive() {
				out = append(out, a.Task)
			}
		}
	}
	return out
}

// prefixCovered reports whether every configured task under prefix is in
// group, so `dekit stop prefix**` touches nothing else.
func (l *Local) prefixCovered(runner, prefix string, group []model.App) bool {
	in := map[string]bool{}
	for _, a := range group {
		in[a.Task] = true
	}
	cfg, _ := l.configs.load(runner)
	if cfg == nil {
		return false
	}
	for _, t := range cfg.Tasks {
		if strings.HasPrefix(t.Path, prefix) && !in[t.Path] {
			return false
		}
	}
	return true
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// Up starts a runner that is down.
func (l *Local) Up(ctx context.Context, runner string) error {
	if !l.knownRunner(runner) {
		return fmt.Errorf("unknown project %s", runner)
	}
	if err := l.dekit.Up(ctx, runner); err != nil {
		return err
	}
	l.refreshSoon()
	return nil
}

func (l *Local) knownRunner(root string) bool {
	for _, p := range dekit.Discover(l.Folders()) {
		if p.Root == root {
			return true
		}
	}
	return false
}

var ansi = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]`)

// excerptLines is how many lines a failure excerpt shows (ADR-0011).
const excerptLines = 15

// Excerpt returns the last lines of a task's terminal, without colours.
func (l *Local) Excerpt(ctx context.Context, runner, task string) (model.Excerpt, error) {
	if !l.knownRunner(runner) {
		return model.Excerpt{}, fmt.Errorf("unknown project %s", runner)
	}
	cfg, _ := l.configs.load(runner)
	snap, _ := l.Snapshot(ctx)
	found := false
	for _, a := range snap.Apps {
		if a.Runner == runner && a.Task == task {
			found = true
		}
	}
	if !found && (cfg == nil || cfg.Task(task) == nil) {
		return model.Excerpt{}, fmt.Errorf("unknown app %s", task)
	}
	screen, err := l.dekit.Screen(ctx, runner, task)
	if err != nil {
		return model.Excerpt{}, err
	}
	return model.Excerpt{Lines: lastLines(screen, excerptLines), Command: "dekit -C " + quoteArg(runner) + " screen " + quoteArg(task)}, nil
}

func lastLines(screen string, n int) []string {
	screen = ansi.ReplaceAllString(screen, "")
	screen = strings.ReplaceAll(screen, "\r\n", "\n")
	screen = strings.ReplaceAll(screen, "\r", "\n")
	var lines []string
	for _, ln := range strings.Split(screen, "\n") {
		ln = strings.TrimRight(ln, " \t")
		if ln != "" {
			lines = append(lines, ln)
		}
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	if lines == nil {
		lines = []string{}
	}
	return lines
}

func quoteArg(s string) string {
	if s != "" && !strings.ContainsAny(s, " \t'\"$`\\*?[]{}()<>|&;#~") {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// Dial connects to a port on this machine.
func (l *Local) Dial(ctx context.Context, port int) (net.Conn, error) {
	if port <= 0 || port > 65535 {
		return nil, fmt.Errorf("invalid port %d", port)
	}
	var d net.Dialer
	return d.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
}

// Close stops the watch loop.
func (l *Local) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	select {
	case <-l.closed:
	default:
		close(l.closed)
	}
	return nil
}

// configCache re-reads a project's config only when one of its files changed.
type configCache struct {
	mu      sync.Mutex
	entries map[string]*configEntry
}

type configEntry struct {
	cfg   *dekit.Config
	err   error
	mtime map[string]time.Time
}

func newConfigCache() *configCache { return &configCache{entries: map[string]*configEntry{}} }

func (c *configCache) load(root string) (*dekit.Config, error) {
	c.mu.Lock()
	e := c.entries[root]
	c.mu.Unlock()
	if e != nil && !e.stale() {
		return e.cfg, e.err
	}
	cfg, err := dekit.LoadConfig(root)
	e = &configEntry{cfg: cfg, err: err, mtime: map[string]time.Time{}}
	files := []string{filepath.Join(root, dekit.ConfigFile)}
	if cfg != nil {
		files = cfg.Files
	}
	for _, f := range files {
		if fi, err := os.Stat(f); err == nil {
			e.mtime[f] = fi.ModTime()
		}
	}
	c.mu.Lock()
	c.entries[root] = e
	c.mu.Unlock()
	return cfg, err
}

func (e *configEntry) stale() bool {
	for f, t := range e.mtime {
		fi, err := os.Stat(f)
		if err != nil || !fi.ModTime().Equal(t) {
			return true
		}
	}
	return len(e.mtime) == 0
}

func (c *configCache) autostart(root string) map[string]bool {
	cfg, _ := c.load(root)
	out := map[string]bool{}
	if cfg != nil {
		for _, t := range cfg.Tasks {
			if t.Autostart {
				out[t.Path] = true
			}
		}
	}
	return out
}
