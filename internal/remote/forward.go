package remote

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/akamachinecode/portplane/internal/agent"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/portless"
)

// Router is what forwarding needs from portless.
type Router interface {
	Available() bool
	Routes() []portless.Route
	Alias(ctx context.Context, name string, port int) error
	RemoveAlias(ctx context.Context, name string) error
	Proxy() portless.Proxy
}

// Forwarder opens a remote app on this machine (ADR-0016): a loopback HTTP
// proxy per running remote app that dials through the agent, and a portless
// alias <app>.<machine> so it gets https://<app>.<machine>.localhost.
type Forwarder struct {
	router Router

	mu       sync.Mutex
	entries  map[string]*forward // machine + "|" + remote port
	closed   map[string]bool     // machines removed: no new forwards
	ensureMu sync.Mutex          // one forward created at a time
}

type forward struct {
	machine    string
	remotePort int
	remoteHost string // the app's hostname; "" for apps without one and on-demand ports
	onDemand   bool   // opened from "other ports", not for a running app
	agent      agent.Agent
	alias      string // portless name, "" without portless
	url        string
	ln         net.Listener
	srv        *http.Server
}

// NewForwarder returns a forwarder; router may be nil (plain loopback URLs).
func NewForwarder(router Router) *Forwarder {
	return &Forwarder{router: router, entries: map[string]*forward{}, closed: map[string]bool{}}
}

// Wrap returns an agent whose snapshots carry RemoteURL for running apps,
// opening and closing forwards as apps start and stop.
func (f *Forwarder) Wrap(a agent.Agent, machineLabel string) agent.Agent {
	label := Label(machineLabel)
	f.mu.Lock()
	delete(f.closed, label) // added (again)
	f.mu.Unlock()
	return &forwardingAgent{Agent: a, f: f, label: label}
}

type forwardingAgent struct {
	agent.Agent
	f     *Forwarder
	label string
}

func (w *forwardingAgent) Watch(ctx context.Context) <-chan model.MachineSnapshot {
	in := w.Agent.Watch(ctx)
	out := make(chan model.MachineSnapshot, 1)
	go func() {
		defer close(out)
		for s := range in {
			s = w.f.sync(w.Agent, w.label, s)
			select {
			case out <- s:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

func (w *forwardingAgent) Snapshot(ctx context.Context) (model.MachineSnapshot, error) {
	s, err := w.Agent.Snapshot(ctx)
	if err != nil {
		return s, err
	}
	return w.f.decorate(s), nil
}

func (w *forwardingAgent) Close() error {
	w.f.closeMachine(w.label)
	return w.Agent.Close()
}

// SetInterval passes pacing through to the wrapped agent.
func (w *forwardingAgent) SetInterval(d time.Duration) {
	if p, ok := w.Agent.(interface{ SetInterval(time.Duration) }); ok {
		p.SetInterval(d)
	}
}

// OpenPort forwards any port of a machine on demand (for "other ports").
func (w *forwardingAgent) OpenPort(ctx context.Context, port int) (string, error) {
	fw, err := w.f.ensure(ctx, w.Agent, w.label, port, "", true)
	if err != nil {
		return "", err
	}
	return fw.url, nil
}

func key(machine string, port int) string { return machine + "|" + strconv.Itoa(port) }

// sync opens forwards for running apps and closes the rest. A forward is
// stale when its app stopped, when another app took its port, or when it
// belongs to an agent that was replaced.
func (f *Forwarder) sync(a agent.Agent, label string, s model.MachineSnapshot) model.MachineSnapshot {
	want := map[string]model.App{}
	if s.Machine.Status == "online" {
		for _, app := range s.Apps {
			if app.State == model.StateOn && app.Port > 0 {
				want[key(label, app.Port)] = app
			}
		}
	}
	f.mu.Lock()
	var stale []*forward
	for k, fw := range f.entries {
		if fw.machine != label {
			continue
		}
		app, running := want[k]
		switch {
		case fw.agent != a,
			!running && !fw.onDemand,
			running && (fw.onDemand || fw.remoteHost != app.Hostname):
			stale = append(stale, fw)
			delete(f.entries, k)
		}
	}
	f.mu.Unlock()
	for _, fw := range stale {
		f.stop(fw)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for _, app := range want {
		_, _ = f.ensure(ctx, a, label, app.Port, app.Hostname, false)
	}
	return f.decorate(s)
}

// decorate fills RemoteURL from the forwards opened for these very apps.
func (f *Forwarder) decorate(s model.MachineSnapshot) model.MachineSnapshot {
	label := Label(s.Machine.ID)
	f.mu.Lock()
	defer f.mu.Unlock()
	apps := make([]model.App, len(s.Apps))
	copy(apps, s.Apps)
	for i := range apps {
		fw, ok := f.entries[key(label, apps[i].Port)]
		if ok && apps[i].Port > 0 && apps[i].State == model.StateOn && !fw.onDemand && fw.remoteHost == apps[i].Hostname {
			apps[i].RemoteURL = fw.url
		}
	}
	s.Apps = apps
	return s
}

var errMachineClosed = errors.New("machine removed")

func (f *Forwarder) ensure(ctx context.Context, a agent.Agent, label string, port int, remoteHost string, onDemand bool) (*forward, error) {
	f.ensureMu.Lock()
	defer f.ensureMu.Unlock()
	k := key(label, port)
	f.mu.Lock()
	if f.closed[label] {
		f.mu.Unlock()
		return nil, errMachineClosed
	}
	if fw, ok := f.entries[k]; ok {
		if fw.agent == a && (onDemand || (!fw.onDemand && fw.remoteHost == remoteHost)) {
			f.mu.Unlock()
			return fw, nil
		}
		delete(f.entries, k)
		f.mu.Unlock()
		f.stop(fw)
	} else {
		f.mu.Unlock()
	}

	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	localPort := ln.Addr().(*net.TCPAddr).Port
	fw := &forward{machine: label, remotePort: port, remoteHost: remoteHost, onDemand: onDemand, agent: a, ln: ln, url: "http://127.0.0.1:" + strconv.Itoa(localPort)}
	upstreamHost := remoteHost
	if upstreamHost == "" {
		upstreamHost = "localhost:" + strconv.Itoa(port)
	}
	if f.router != nil && f.router.Available() {
		name := aliasName(remoteHost, port, label)
		if !f.routedByLocalApp(name + ".localhost") {
			if err := f.router.Alias(ctx, name, localPort); err == nil {
				fw.alias = name
				proxy := f.router.Proxy()
				fw.url = proxy.URL(name + ".localhost")
				waitRoute(ctx, proxy, name+".localhost")
			}
		}
	}
	allowed := map[string]bool{"127.0.0.1:" + strconv.Itoa(localPort): true, "localhost:" + strconv.Itoa(localPort): true}
	https := false
	if u, err := url.Parse(fw.url); err == nil {
		allowed[u.Host] = true
		https = u.Scheme == "https"
	}
	fw.srv = &http.Server{
		Handler:           proxyHandler(a, port, upstreamHost, allowed, https, fw.url),
		ReadHeaderTimeout: 30 * time.Second,
	}
	go func() { _ = fw.srv.Serve(ln) }()

	f.mu.Lock()
	if f.closed[label] {
		f.mu.Unlock()
		f.stop(fw)
		return nil, errMachineClosed
	}
	f.entries[k] = fw
	f.mu.Unlock()
	return fw, nil
}

// routedByLocalApp reports whether portless already routes host to a live
// local app: a remote alias must never take its name.
func (f *Forwarder) routedByLocalApp(host string) bool {
	for _, r := range f.router.Routes() {
		if r.Hostname == host && r.PID > 0 {
			return true
		}
	}
	return false
}

// aliasName is "<remote name>.<machine>": web.shop.localhost on box becomes
// web.shop.box (https://web.shop.box.localhost).
func aliasName(remoteHost string, port int, machine string) string {
	base := strings.TrimSuffix(remoteHost, ".localhost")
	if base == "" {
		base = "port-" + strconv.Itoa(port)
	}
	return base + "." + machine
}

// proxyHandler forwards HTTP (and WebSocket upgrades) through the agent,
// presenting the remote app's own hostname so dev servers accept it. It
// answers only to its own names: anything else could be a rebound page
// trying to reach the remote app through the trusted hostname.
func proxyHandler(a agent.Agent, port int, upstreamHost string, allowed map[string]bool, https bool, public string) http.Handler {
	publicHost := ""
	if u, err := url.Parse(public); err == nil {
		publicHost = u.Host
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return a.Dial(ctx, port)
		},
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     60 * time.Second,
	}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = "http"
			pr.Out.URL.Host = "127.0.0.1:" + strconv.Itoa(port)
			pr.Out.Host = upstreamHost
			if o := pr.In.Header.Get("Origin"); o != "" && publicHost != "" && strings.HasSuffix(o, "://"+publicHost) {
				pr.Out.Header.Set("Origin", "http://"+upstreamHost)
			}
			pr.SetXForwarded()
			if https {
				pr.Out.Header.Set("X-Forwarded-Proto", "https") // TLS ends at the portless proxy
			}
		},
		Transport: transport,
		ModifyResponse: func(resp *http.Response) error {
			if loc := resp.Header.Get("Location"); loc != "" && publicHost != "" {
				if u, err := url.Parse(loc); err == nil && u.Host == upstreamHost {
					u.Host = publicHost
					if https {
						u.Scheme = "https"
					}
					resp.Header.Set("Location", u.String())
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			http.Error(w, fmt.Sprintf("Portplane could not reach port %d on the remote machine: %v", port, err), http.StatusBadGateway)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowed[strings.ToLower(r.Host)] {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		rp.ServeHTTP(w, r)
	})
}

// waitRoute waits (briefly) until the portless proxy serves a new alias: it
// reloads its routes shortly after `portless alias` returns, and a URL shown
// before that would answer "no app registered".
func waitRoute(ctx context.Context, proxy portless.Proxy, host string) {
	port := proxy.Port
	if port == 0 {
		port = 443
	}
	client := &http.Client{
		Timeout: time.Second,
		Transport: &http.Transport{
			// Only ever talks to the local proxy on loopback.
			TLSClientConfig: &tls.Config{ServerName: host, InsecureSkipVerify: true}, //nolint:gosec // loopback probe of our own route
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
			},
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	scheme := "http"
	if proxy.HTTPS {
		scheme = "https"
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		req, err := http.NewRequestWithContext(ctx, http.MethodHead, scheme+"://"+host+"/", nil)
		if err != nil {
			return
		}
		resp, err := client.Do(req)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusNotFound {
				return
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(150 * time.Millisecond):
		}
	}
}

func (f *Forwarder) stop(fw *forward) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = fw.srv.Close()
	if fw.alias != "" && f.router != nil {
		_ = f.router.RemoveAlias(ctx, fw.alias)
	}
}

func (f *Forwarder) closeMachine(label string) {
	f.mu.Lock()
	f.closed[label] = true
	var list []*forward
	for k, fw := range f.entries {
		if fw.machine == label {
			list = append(list, fw)
			delete(f.entries, k)
		}
	}
	f.mu.Unlock()
	for _, fw := range list {
		f.stop(fw)
	}
}

// Close stops every forward and removes every alias.
func (f *Forwarder) Close() {
	f.mu.Lock()
	list := make([]*forward, 0, len(f.entries))
	for k, fw := range f.entries {
		list = append(list, fw)
		delete(f.entries, k)
	}
	f.mu.Unlock()
	for _, fw := range list {
		f.stop(fw)
	}
}

var labelRe = strings.NewReplacer(" ", "-", "_", "-", ".", "-")

// Label turns a machine id into a DNS label.
func Label(s string) string {
	s = strings.ToLower(labelRe.Replace(s))
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "remote"
	}
	return out
}
