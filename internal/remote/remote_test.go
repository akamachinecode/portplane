package remote

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akamachinecode/portplane/internal/portless"

	"github.com/akamachinecode/portplane/internal/model"
)

type pipeConn struct {
	io.Reader
	io.Writer
	closers []io.Closer
}

func (p pipeConn) Close() error {
	for _, c := range p.closers {
		_ = c.Close()
	}
	return nil
}

// connPair returns the two ends of an in-memory stdio connection.
func connPair() (io.ReadWriteCloser, io.ReadWriteCloser) {
	ar, bw := io.Pipe()
	br, aw := io.Pipe()
	return pipeConn{ar, aw, []io.Closer{ar, aw}}, pipeConn{br, bw, []io.Closer{br, bw}}
}

type fakeAgent struct {
	mu      sync.Mutex
	acted   []model.Verb
	folders []string
	snap    model.MachineSnapshot
}

func (f *fakeAgent) Snapshot(context.Context) (model.MachineSnapshot, error) { return f.snap, nil }
func (f *fakeAgent) Watch(ctx context.Context) <-chan model.MachineSnapshot {
	c := make(chan model.MachineSnapshot, 1)
	c <- f.snap
	return c
}
func (f *fakeAgent) Act(_ context.Context, _ model.Target, v model.Verb) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if v == "stop" {
		return errors.New("cannot stop")
	}
	f.acted = append(f.acted, v)
	return nil
}
func (f *fakeAgent) Up(context.Context, string) error { return nil }
func (f *fakeAgent) Excerpt(_ context.Context, _, task string) (model.Excerpt, error) {
	return model.Excerpt{Lines: []string{"boom in " + task}}, nil
}
func (f *fakeAgent) SetFolders(_ context.Context, folders []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.folders = folders
	return nil
}
func (f *fakeAgent) Dial(ctx context.Context, port int) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "tcp", "127.0.0.1:"+strconv.Itoa(port))
}
func (f *fakeAgent) Close() error { return nil }

func waitSnapshot(t *testing.T, c <-chan model.MachineSnapshot, status string) model.MachineSnapshot {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case s := <-c:
			if s.Machine.Status == status {
				return s
			}
		case <-deadline:
			t.Fatalf("no %s snapshot", status)
		}
	}
}

func TestProtocolEndToEnd(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "host="+r.Host)
	}))
	defer upstream.Close()
	port, _ := strconv.Atoi(upstream.URL[strings.LastIndex(upstream.URL, ":")+1:])

	fa := &fakeAgent{snap: model.MachineSnapshot{
		Machine: model.Machine{ID: "remote", Status: "online"},
		Apps:    []model.App{{ID: "r#shop/web", Task: "shop/web", State: model.StateOn, Port: port, Hostname: "web.shop.localhost"}},
	}}
	connects := 0
	var current io.ReadWriteCloser
	var mu sync.Mutex
	conn := ConnectorFunc(func(ctx context.Context) (io.ReadWriteCloser, error) {
		client, server := connPair()
		mu.Lock()
		connects++
		current = client
		mu.Unlock()
		go func() { _ = Serve(context.Background(), server, fa) }()
		return client, nil
	})
	code := t.TempDir()
	a := NewAgent("box", "Box", []string{code, "/definitely/missing"}, conn)
	defer func() { _ = a.Close() }()

	fwd := NewForwarder(nil)
	defer fwd.Close()
	w := fwd.Wrap(a, "box")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	snaps := w.Watch(ctx)
	s := waitSnapshot(t, snaps, "online")
	if s.Machine.ID != "box" || s.Machine.Name != "Box" || s.Machine.Local {
		t.Fatalf("machine: %+v", s.Machine)
	}
	fa.mu.Lock()
	folders := fa.folders
	fa.mu.Unlock()
	if len(folders) != 1 || folders[0] != code {
		t.Fatalf("existing folders are applied: %v", folders)
	}
	if !strings.Contains(s.Machine.Error, "/definitely/missing") {
		t.Fatalf("a missing folder is a warning on an online machine: %+v", s.Machine)
	}

	// The running app is reachable through a local URL, with its own Host.
	url := s.Apps[0].RemoteURL
	if !strings.HasPrefix(url, "http://127.0.0.1:") {
		t.Fatalf("remote url %q", url)
	}
	resp, err := http.Get(url + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if string(body) != "host=web.shop.localhost" {
		t.Fatalf("proxied body %q", body)
	}

	// Calls travel both ways, errors included.
	if err := a.Act(ctx, model.Target{Task: "shop/web"}, model.VerbRestart); err != nil {
		t.Fatal(err)
	}
	if err := a.Act(ctx, model.Target{Task: "shop/web"}, model.VerbStop); err == nil || err.Error() != "cannot stop" {
		t.Fatalf("remote error: %v", err)
	}
	ex, err := a.Excerpt(ctx, "/r", "shop/web")
	if err != nil || ex.Lines[0] != "boom in shop/web" {
		t.Fatalf("excerpt %+v %v", ex, err)
	}

	// Losing the connection marks the machine offline, then it reconnects.
	mu.Lock()
	_ = current.Close()
	mu.Unlock()
	off := waitSnapshot(t, snaps, "offline")
	if len(off.Apps) != 0 {
		t.Fatalf("an offline machine shows no running apps: %+v", off.Apps)
	}
	waitSnapshot(t, snaps, "online")
	mu.Lock()
	n := connects
	mu.Unlock()
	if n < 2 {
		t.Fatalf("expected a reconnect, got %d connects", n)
	}
}

func TestParseUname(t *testing.T) {
	cases := map[string]Platform{
		"Linux x86_64\n": {"linux", "amd64"},
		"Linux aarch64":  {"linux", "arm64"},
		"Darwin arm64":   {"darwin", "arm64"},
		"Darwin x86_64":  {"darwin", "amd64"},
	}
	for in, want := range cases {
		if got, err := parseUname(in); err != nil || got != want {
			t.Errorf("%q: %+v %v", in, got, err)
		}
	}
	if _, err := parseUname("'uname' is not recognized"); err == nil {
		t.Error("windows output must fail clearly")
	}
}

func TestAliasAndLabel(t *testing.T) {
	if got := aliasName("web.shop.localhost", 4100, "box"); got != "web.shop.box" {
		t.Error(got)
	}
	if got := aliasName("", 9000, "box"); got != "port-9000.box" {
		t.Error(got)
	}
	if got := Label("My Box.local"); got != "my-box-local" {
		t.Error(got)
	}
}

func TestSSHConfigHosts(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := dir + "/" + name
		if err := writeFile(p, body); err != nil {
			t.Fatal(err)
		}
		return p
	}
	write("extra.conf", "Host gpu-box\n  HostName 10.0.0.9\n")
	cfg := write("config", "# comment\nHost *\n  ServerAliveInterval 30\nHost box workstation\n  User me\nHost *.internal !bastion\nInclude extra.conf\nHost=box\n")
	got := SSHConfigHosts(cfg)
	if strings.Join(got, ",") != "box,workstation,gpu-box" {
		t.Fatalf("got %v", got)
	}
}

func TestParseTailscale(t *testing.T) {
	got := parseTailscale([]byte(`{"Peer":{"a":{"HostName":"box","DNSName":"box.tail1234.ts.net.","OS":"linux","Online":true},"b":{"HostName":"phone","DNSName":"phone.tail1234.ts.net.","OS":"iOS","Online":true}}}`))
	if len(got) != 1 || got[0].Host != "box.tail1234.ts.net" || got[0].Name != "box" || !*got[0].Online {
		t.Fatalf("got %+v", got)
	}
}

type fakeRouter struct {
	mu      sync.Mutex
	aliases map[string]int
	routes  []portless.Route
}

func (r *fakeRouter) Available() bool { return true }
func (r *fakeRouter) Routes() []portless.Route {
	return r.routes
}
func (r *fakeRouter) Alias(_ context.Context, name string, port int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.aliases[name] = port
	return nil
}
func (r *fakeRouter) RemoveAlias(_ context.Context, name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.aliases, name)
	return nil
}
func (r *fakeRouter) Proxy() portless.Proxy { return portless.Proxy{Port: 1, HTTPS: false} }

func online(apps ...model.App) model.MachineSnapshot {
	return model.MachineSnapshot{Machine: model.Machine{ID: "box", Status: "online"}, Apps: apps}
}

func TestForwardsFollowTheAppOnAPort(t *testing.T) {
	f := NewForwarder(nil)
	defer f.Close()
	fa := &fakeAgent{}
	s := f.sync(fa, "box", online(model.App{Task: "a", State: model.StateOn, Port: 4100, Hostname: "a.shop.localhost"}))
	urlA := s.Apps[0].RemoteURL
	// App b takes the same port: it gets a fresh forward, not a's.
	s = f.sync(fa, "box", online(model.App{Task: "b", State: model.StateOn, Port: 4100, Hostname: "b.shop.localhost"}))
	if s.Apps[0].RemoteURL == "" || s.Apps[0].RemoteURL == urlA {
		t.Fatalf("b must not inherit a's forward: %q vs %q", s.Apps[0].RemoteURL, urlA)
	}
	f.mu.Lock()
	host := f.entries[key("box", 4100)].remoteHost
	f.mu.Unlock()
	if host != "b.shop.localhost" {
		t.Fatalf("forward host %q", host)
	}
}

func TestProxyRefusesForeignHosts(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, r.Host) }))
	defer upstream.Close()
	port, _ := strconv.Atoi(upstream.URL[strings.LastIndex(upstream.URL, ":")+1:])
	f := NewForwarder(nil)
	defer f.Close()
	s := f.sync(&fakeAgent{}, "box", online(model.App{Task: "web", State: model.StateOn, Port: port, Hostname: "web.shop.localhost"}))
	u := s.Apps[0].RemoteURL
	req, _ := http.NewRequest("GET", u+"/", nil)
	req.Host = "evil.example"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("a rebound host must be refused, got %d", resp.StatusCode)
	}
	resp, err = http.Get(u + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if string(body) != "web.shop.localhost" {
		t.Fatalf("own host: %q", body)
	}
}

func TestRemovedMachineGetsNoForwards(t *testing.T) {
	r := &fakeRouter{aliases: map[string]int{}}
	f := NewForwarder(r)
	defer f.Close()
	fa := &fakeAgent{}
	f.Wrap(fa, "box")
	f.closeMachine("box")
	f.sync(fa, "box", online(model.App{Task: "web", State: model.StateOn, Port: 4100, Hostname: "web.localhost"}))
	f.mu.Lock()
	n := len(f.entries)
	f.mu.Unlock()
	r.mu.Lock()
	aliases := len(r.aliases)
	r.mu.Unlock()
	if n != 0 || aliases != 0 {
		t.Fatalf("entries %d, aliases %d after removal", n, aliases)
	}
	// Adding the machine again works.
	f.Wrap(fa, "box")
	if s := f.sync(fa, "box", online(model.App{Task: "web", State: model.StateOn, Port: 4100, Hostname: "web.localhost"})); s.Apps[0].RemoteURL == "" {
		t.Fatal("re-added machine gets forwards again")
	}
}

func TestRemoteAliasNeverTakesALocalAppsName(t *testing.T) {
	r := &fakeRouter{aliases: map[string]int{}, routes: []portless.Route{{Hostname: "web.shop.localhost", Port: 4000, PID: 42}}}
	f := NewForwarder(r)
	defer f.Close()
	// Machine id "shop": its app web.localhost would become web.shop.
	s := f.sync(&fakeAgent{}, "shop", model.MachineSnapshot{Machine: model.Machine{ID: "shop", Status: "online"}, Apps: []model.App{{Task: "web", State: model.StateOn, Port: 4100, Hostname: "web.localhost"}}})
	if _, taken := r.aliases["web.shop"]; taken || !strings.HasPrefix(s.Apps[0].RemoteURL, "http://127.0.0.1:") {
		t.Fatalf("aliases %v url %q", r.aliases, s.Apps[0].RemoteURL)
	}
}

func TestDropDuringSetupReconnects(t *testing.T) {
	block := make(chan struct{})
	fa := &blockingAgent{fakeAgent: fakeAgent{snap: online()}, block: block}
	var mu sync.Mutex
	var conns []io.ReadWriteCloser
	conn := ConnectorFunc(func(context.Context) (io.ReadWriteCloser, error) {
		client, server := connPair()
		mu.Lock()
		conns = append(conns, client)
		mu.Unlock()
		go func() { _ = Serve(context.Background(), server, fa) }()
		return client, nil
	})
	a := NewAgent("box", "box", []string{t.TempDir()}, conn)
	defer func() { _ = a.Close() }()
	snaps := a.Watch(context.Background())
	time.Sleep(200 * time.Millisecond) // the agent is now stuck in SetFolders
	mu.Lock()
	_ = conns[0].Close()
	mu.Unlock()
	waitSnapshot(t, snaps, "offline")
	close(block)
}

type blockingAgent struct {
	fakeAgent
	block chan struct{}
	once  sync.Once
}

func (b *blockingAgent) SetFolders(ctx context.Context, f []string) error {
	first := false
	b.once.Do(func() { first = true })
	if first {
		select {
		case <-b.block:
		case <-ctx.Done():
		}
	}
	return b.fakeAgent.SetFolders(ctx, f)
}
