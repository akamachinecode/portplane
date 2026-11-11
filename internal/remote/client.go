package remote

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/yamux"

	"github.com/akamachinecode/portplane/internal/model"
)

// Connector opens a byte stream to a fresh `portplane agent --stdio`.
type Connector interface {
	Connect(ctx context.Context) (io.ReadWriteCloser, error)
}

// ConnectorFunc adapts a function.
type ConnectorFunc func(ctx context.Context) (io.ReadWriteCloser, error)

// Connect calls f.
func (f ConnectorFunc) Connect(ctx context.Context) (io.ReadWriteCloser, error) { return f(ctx) }

// ErrOffline is returned while the machine is not connected.
var ErrOffline = errors.New("machine is offline")

// Agent is a remote machine seen through its agent. It reconnects on its own.
type Agent struct {
	id, name string
	conn     Connector

	mu       sync.Mutex
	folders  []string
	sess     *yamux.Session
	ctl      net.Conn
	enc      *json.Encoder
	pending  map[uint64]chan message
	nextID   uint64
	last     model.MachineSnapshot
	watchers map[chan model.MachineSnapshot]struct{}
	interval time.Duration
	hello    Hello
	warning  string // shown on the machine while online (missing folders)

	wmu    sync.Mutex
	closed chan struct{}
	once   sync.Once
}

// NewAgent starts connecting to a remote machine in the background.
func NewAgent(id, name string, folders []string, c Connector) *Agent {
	a := &Agent{
		id: id, name: name, conn: c,
		folders:  append([]string{}, folders...),
		pending:  map[uint64]chan message{},
		watchers: map[chan model.MachineSnapshot]struct{}{},
		closed:   make(chan struct{}),
	}
	a.last = a.statusSnapshot("connecting", "")
	return a
}

// SetName changes the display name.
func (a *Agent) SetName(name string) {
	a.mu.Lock()
	a.name = name
	a.mu.Unlock()
}

func (a *Agent) statusSnapshot(status, errMsg string) model.MachineSnapshot {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := model.MachineSnapshot{Folders: append([]string{}, a.folders...), Runners: []model.Runner{}, Apps: []model.App{}, OtherPorts: []model.Port{}, Projects: []model.Project{}}
	if a.last.Machine.ID != "" {
		s = a.last
	}
	s.Machine.ID, s.Machine.Name, s.Machine.Local = a.id, a.name, false
	s.Machine.Status, s.Machine.Error = status, errMsg
	if status != "online" {
		// Nothing is known to be running while we cannot see the machine.
		s.Apps, s.Projects, s.OtherPorts = []model.App{}, []model.Project{}, []model.Port{}
	}
	return s
}

// Start runs the connection loop until Close.
func (a *Agent) Start() {
	a.once.Do(func() { go a.loop() })
}

func (a *Agent) loop() {
	backoff := time.Second
	for {
		started := time.Now()
		err := a.session()
		select {
		case <-a.closed:
			return
		default:
		}
		msg := "connection lost"
		if err != nil {
			msg = err.Error()
		}
		a.publish(a.statusSnapshot("offline", msg))
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		select {
		case <-a.closed:
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
		a.publish(a.statusSnapshot("connecting", msg))
	}
}

// session connects once and serves until the connection ends.
func (a *Agent) session() error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-a.closed:
			cancel()
		case <-ctx.Done():
		}
	}()
	rwc, err := a.conn.Connect(ctx)
	if err != nil {
		return err
	}
	sess, err := yamux.Client(rwc, yamuxConfig())
	if err != nil {
		_ = rwc.Close()
		return err
	}
	defer func() { _ = sess.Close() }()
	ctl, err := sess.Open()
	if err != nil {
		return err
	}
	a.mu.Lock()
	a.sess, a.ctl, a.enc = sess, ctl, json.NewEncoder(ctl)
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.sess, a.ctl, a.enc = nil, nil, nil
		for id, ch := range a.pending {
			close(ch)
			delete(a.pending, id)
		}
		a.mu.Unlock()
	}()

	// Calls made while setting up end as soon as the connection does.
	live, lost := context.WithCancel(ctx)
	defer lost()
	readErr := make(chan error, 1)
	go func() {
		err := a.read(ctl)
		lost()
		readErr <- err
	}()
	fail := func(err error) error {
		select {
		case rerr := <-readErr:
			return rerr // the connection's own error says more
		default:
			return err
		}
	}

	hctx, hcancel := context.WithTimeout(live, 20*time.Second)
	var hello Hello
	err = a.call(hctx, "hello", Hello{Protocol: Protocol}, &hello)
	hcancel()
	if err != nil {
		// The cached start command may be stale (binary removed): install
		// again on the next attempt.
		if r, ok := a.conn.(interface{ Reset() }); ok {
			r.Reset()
		}
		return fmt.Errorf("agent handshake: %w", fail(err))
	}
	a.mu.Lock()
	a.hello = hello
	folders := append([]string{}, a.folders...)
	interval := a.interval
	a.mu.Unlock()
	// A folder missing on that machine is a warning, not a lost machine:
	// the agent applies the others.
	warn := ""
	if err := a.call(live, "setFolders", foldersParams{Folders: folders}, nil); err != nil {
		if live.Err() != nil {
			return fail(err)
		}
		warn = err.Error()
	}
	a.mu.Lock()
	a.warning = warn
	a.mu.Unlock()
	if interval > 0 {
		_ = a.call(live, "setInterval", intervalParams{Millis: interval.Milliseconds()}, nil)
	}
	if err := a.call(live, "watch", nil, nil); err != nil {
		return fail(err)
	}
	select {
	case err := <-readErr:
		return err
	case <-a.closed:
		return nil
	}
}

func (a *Agent) read(ctl net.Conn) error {
	dec := json.NewDecoder(bufio.NewReader(ctl))
	for {
		var m message
		if err := dec.Decode(&m); err != nil {
			if errors.Is(err, io.EOF) {
				return errors.New("the agent closed the connection")
			}
			return err
		}
		if m.ID != 0 {
			a.mu.Lock()
			ch := a.pending[m.ID]
			delete(a.pending, m.ID)
			a.mu.Unlock()
			if ch != nil {
				ch <- m
			}
			continue
		}
		if m.Method == "snapshot" {
			var s model.MachineSnapshot
			if json.Unmarshal(m.Params, &s) != nil {
				continue
			}
			a.mu.Lock()
			h, name, warn := a.hello, a.name, a.warning
			a.mu.Unlock()
			s.Machine.ID, s.Machine.Name, s.Machine.Local = a.id, name, false
			s.Machine.Status, s.Machine.Error = "online", warn
			if s.Machine.Agent == "" {
				s.Machine.Agent = h.Version
			}
			a.publish(s)
		}
	}
}

// publish stores s and hands it to every watcher. Sends never block and
// happen under the lock, so a watcher cannot be closed mid-send.
func (a *Agent) publish(s model.MachineSnapshot) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.last = s
	for w := range a.watchers {
		select {
		case w <- s:
		default:
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
}

// call sends a request and waits for its reply.
func (a *Agent) call(ctx context.Context, method string, params, out any) error {
	var raw json.RawMessage
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return err
		}
		raw = b
	}
	a.mu.Lock()
	if a.enc == nil {
		a.mu.Unlock()
		return ErrOffline
	}
	a.nextID++
	id := a.nextID
	ch := make(chan message, 1)
	a.pending[id] = ch
	enc := a.enc
	a.mu.Unlock()

	a.wmu.Lock()
	err := enc.Encode(message{ID: id, Method: method, Params: raw})
	a.wmu.Unlock()
	if err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		a.mu.Lock()
		delete(a.pending, id)
		a.mu.Unlock()
		return ctx.Err()
	case m, ok := <-ch:
		if !ok {
			return ErrOffline
		}
		if m.Error != "" {
			return errors.New(m.Error)
		}
		if out != nil && len(m.Result) > 0 {
			return json.Unmarshal(m.Result, out)
		}
		return nil
	}
}

// Snapshot returns the latest snapshot the agent pushed.
func (a *Agent) Snapshot(context.Context) (model.MachineSnapshot, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.last, nil
}

// Watch delivers snapshots (including connection status changes).
func (a *Agent) Watch(ctx context.Context) <-chan model.MachineSnapshot {
	ch := make(chan model.MachineSnapshot, 1)
	a.mu.Lock()
	a.watchers[ch] = struct{}{}
	ch <- a.last
	a.mu.Unlock()
	a.Start()
	go func() {
		select {
		case <-ctx.Done():
		case <-a.closed:
		}
		a.mu.Lock()
		delete(a.watchers, ch)
		a.mu.Unlock()
		close(ch)
	}()
	return ch
}

// Act forwards an action.
func (a *Agent) Act(ctx context.Context, t model.Target, v model.Verb) error {
	return a.call(ctx, "act", actParams{Target: t, Verb: v}, nil)
}

// Up starts a runner on the remote machine.
func (a *Agent) Up(ctx context.Context, runner string) error {
	return a.call(ctx, "up", taskParams{Runner: runner}, nil)
}

// Excerpt reads a task's last lines.
func (a *Agent) Excerpt(ctx context.Context, runner, task string) (model.Excerpt, error) {
	var ex model.Excerpt
	err := a.call(ctx, "excerpt", taskParams{Runner: runner, Task: task}, &ex)
	return ex, err
}

// SetFolders changes the remote folders (kept for reconnects).
func (a *Agent) SetFolders(ctx context.Context, folders []string) error {
	err := a.call(ctx, "setFolders", foldersParams{Folders: folders}, nil)
	if err != nil && !errors.Is(err, ErrOffline) {
		// Rejected: the agent already applied the folders that exist, so
		// put the old ones back (best effort) and keep them.
		a.mu.Lock()
		old := append([]string{}, a.folders...)
		a.mu.Unlock()
		_ = a.call(ctx, "setFolders", foldersParams{Folders: old}, nil)
		return err
	}
	a.mu.Lock()
	a.folders = append([]string{}, folders...)
	a.warning = ""
	a.mu.Unlock()
	return nil // applied now, or on the next connect
}

// Folders returns the remote folders.
func (a *Agent) Folders() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string{}, a.folders...)
}

// SetInterval asks the remote agent to collect faster or slower.
func (a *Agent) SetInterval(d time.Duration) {
	a.mu.Lock()
	a.interval = d
	a.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = a.call(ctx, "setInterval", intervalParams{Millis: d.Milliseconds()}, nil)
	}()
}

// Dial opens a stream to a port on the remote machine.
func (a *Agent) Dial(ctx context.Context, port int) (net.Conn, error) {
	a.mu.Lock()
	sess := a.sess
	a.mu.Unlock()
	if sess == nil {
		return nil, ErrOffline
	}
	s, err := sess.Open()
	if err != nil {
		return nil, err
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = s.SetDeadline(dl)
	}
	b, _ := json.Marshal(dialHeader{Dial: port})
	if _, err := s.Write(append(b, '\n')); err != nil {
		_ = s.Close()
		return nil, err
	}
	r := bufio.NewReader(s)
	line, err := r.ReadString('\n')
	if err != nil {
		_ = s.Close()
		return nil, err
	}
	if strings.TrimSpace(line) != "ok" {
		_ = s.Close()
		return nil, errors.New(strings.TrimSpace(strings.TrimPrefix(line, "error:")))
	}
	_ = s.SetDeadline(time.Time{})
	return &bufferedConn{Conn: s, r: r}, nil
}

// Close disconnects for good.
func (a *Agent) Close() error {
	a.mu.Lock()
	select {
	case <-a.closed:
	default:
		close(a.closed)
	}
	sess := a.sess
	a.mu.Unlock()
	if sess != nil {
		_ = sess.Close()
	}
	return nil
}
