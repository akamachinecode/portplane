package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/portless"
	"github.com/akamachinecode/portplane/internal/privileged"
)

// The portless center (plan §5, ADR-0023): reads come from portless's state
// files and its read-only commands; every change goes through the portless
// CLI. Changes that need an administrator run only from a job the user
// started after seeing the plan's exact commands (ADR-0020); the page sends
// choices ("start the proxy on 443 with HTTPS"), never a command.

// Listener is a listening port and the process behind it.
type Listener struct {
	Port    int    `json:"port"`
	PID     int    `json:"pid,omitempty"`
	Process string `json:"process,omitempty"`
}

// BrowserTrust says whether one browser profile trusts the CA. It is
// filled by the onboarding's browser check (M5.1) when it is wired in.
type BrowserTrust struct {
	Browser string `json:"browser"`
	Profile string `json:"profile,omitempty"`
	Trusted bool   `json:"trusted"`
	Detail  string `json:"detail,omitempty"`
}

// PortlessDeps wires the portless center to this computer.
type PortlessDeps struct {
	Client *portless.Client
	Jobs   *jobs.Manager
	// Local is this computer's snapshot; Machines every machine's.
	Local    func(ctx context.Context) model.MachineSnapshot
	Machines func() []model.MachineSnapshot
	// Config reads a dekit project's config (dekit.LoadConfig).
	Config func(root string) (*dekit.Config, error)
	// Reload applies a changed dekit config; Restart restarts one task.
	Reload  func(ctx context.Context, root string) error
	Restart func(ctx context.Context, root, task string) error
	// Listeners are the ports listening now, with their processes.
	Listeners func(ctx context.Context) []Listener
	// Elevate runs a command as administrator (privileged.Run); Method
	// names how ("pkexec", "osascript", "uac", or "" when it can't).
	Elevate func(ctx context.Context, c privileged.Command, out io.Writer) error
	Method  func() string
	// Exec runs a command that needs no administrator (an npm update).
	Exec func(ctx context.Context, argv []string, env map[string]string, out io.Writer) error
	// Refresh collects the snapshot again soon, tools included.
	Refresh func()
	// Reveal shows a file's folder; Downloads is where exports go.
	Reveal    func(path string) error
	Downloads func() string
	// BrowserTrust lists browser profiles and whether they trust the CA.
	// Nil until the browser check lands (internal/browsertrust, M5.1).
	BrowserTrust func(ctx context.Context) []BrowserTrust
	// Lookup finds programs (npm, brew) for updates; nil: envpath.Lookup.
	Lookup func(string) string
	GOOS   string
	Now    func() time.Time

	// Sharing, compose and LAN mode (M5.6).

	// Start starts one task (sharing an app that isn't running yet).
	Start func(ctx context.Context, root, task string) error
	// Tool runs a read-only command of another program (tailscale status
	// --json, docker ps); nil: portless.RunTool.
	Tool portless.ToolRunner
	// Network lists this computer's interfaces and the address of its
	// default route; nil: the real ones.
	Network func() ([]portless.Iface, string)
	// OSRelease is /etc/os-release, to name Linux packages.
	OSRelease func() string
	// Home is the user's home folder and Getenv reads the environment
	// (ngrok's config); nil: the real ones.
	Home   func() string
	Getenv func(string) string
	// User is the name of the user Portplane runs as.
	User func() string
	// ComposeMemory is the file where Portplane remembers the compose
	// files it started; empty keeps them in memory only.
	ComposeMemory string
	// ShareWait is how long applying a share waits for its URL.
	ShareWait time.Duration
}

type portlessAPI struct {
	d       PortlessDeps
	compose *composeMemory
}

// PortlessHandlers returns the /api/portless endpoints.
func PortlessHandlers(d PortlessDeps) map[string]http.HandlerFunc {
	if d.GOOS == "" {
		d.GOOS = runtime.GOOS
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Elevate == nil {
		d.Elevate = privileged.Run
	}
	if d.Method == nil {
		d.Method = privileged.Method
	}
	if d.Exec == nil {
		d.Exec = ExecArgv
	}
	if d.Refresh == nil {
		d.Refresh = func() {}
	}
	if d.Listeners == nil {
		d.Listeners = func(context.Context) []Listener { return nil }
	}
	if d.Machines == nil {
		d.Machines = func() []model.MachineSnapshot { return nil }
	}
	p := &portlessAPI{d: d}
	p.extDefaults()
	routes := map[string]http.HandlerFunc{
		"GET /api/portless/status":                 p.status,
		"GET /api/portless/doctor":                 p.doctor,
		"GET /api/portless/routes":                 p.routes,
		"GET /api/portless/prune":                  p.prunePreview,
		"POST /api/portless/aliases":               p.addAlias,
		"PUT /api/portless/aliases":                p.replaceAlias,
		"DELETE /api/portless/aliases/{name}":      p.removeAlias,
		"GET /api/portless/certificates":           p.certificates,
		"POST /api/portless/certificates/export":   p.exportCA,
		"GET /api/portless/certificates/ca.pem":    p.caPEM,
		"GET /api/portless/hosts":                  p.hosts,
		"POST /api/portless/actions/{action}/plan": p.plan,
		"POST /api/portless/actions/{action}":      p.run,
		"GET /api/portless/names":                  p.nameInfo,
		"POST /api/portless/names/preview":         p.namePreview,
		"POST /api/portless/names/apply":           p.nameApply,
		"GET /api/portless/configs":                p.configs,
		"GET /api/portless/config":                 p.config,
		"POST /api/portless/config/preview":        p.configPreview,
		"PUT /api/portless/config":                 p.configSave,
	}
	for pattern, h := range p.extRoutes() {
		routes[pattern] = h
	}
	return routes
}

var errNoPortless = errors.New("portless isn't installed on this machine: install it from Settings → Tools or the welcome screen")

func (p *portlessAPI) needPortless(w http.ResponseWriter) bool {
	if p.d.Client == nil || !p.d.Client.Available() {
		writeError(w, http.StatusServiceUnavailable, errNoPortless)
		return false
	}
	return true
}

// ---- status ----

// PortlessStatus is GET /api/portless/status.
type PortlessStatus struct {
	Installed bool   `json:"installed"`
	Version   string `json:"version,omitempty"`
	Path      string `json:"path,omitempty"`
	StateDir  string `json:"stateDir"`
	OS        string `json:"os"`
	// Proxy is how the proxy stands; Service its startup service.
	Proxy        portless.ProxyState      `json:"proxy"`
	Service      *portless.ServiceStatus  `json:"service,omitempty"`
	ServiceError string                   `json:"serviceError,omitempty"`
	Program      *portless.ServiceProgram `json:"program,omitempty"`
	// Options are the proxy's options now: the service's when it is
	// installed, else the last start's; the form starts from them.
	Options portless.ProxyOptions `json:"options"`
	// AdminToStart and AdminToStop: starting with Options, or stopping the
	// running proxy, asks for the password.
	AdminToStart bool `json:"adminToStart"`
	AdminToStop  bool `json:"adminToStop"`
	// Method is how this computer asks for the password ("" when it can't:
	// the user then runs the shown command in a terminal).
	Method  string           `json:"method"`
	Install portless.Install `json:"install"`
	// HostsNeeded: a domain other than .localhost needs /etc/hosts entries.
	HostsNeeded bool `json:"hostsNeeded"`
}

type proxyFacts struct {
	state   portless.ProxyState
	service *portless.ServiceStatus
	svcErr  error
	program *portless.ServiceProgram
	options portless.ProxyOptions
}

func (p *portlessAPI) facts(ctx context.Context) proxyFacts {
	c := p.d.Client
	f := proxyFacts{state: c.ProxyState(ctx)}
	if st, err := c.ServiceStatus(ctx); err != nil {
		f.svcErr = err
	} else {
		f.service = &st
		if st.Installed && st.Entry != "" {
			if prog, ok := portless.ReadServiceProgram(st.Entry); ok {
				f.program = &prog
			}
		}
	}
	f.options = p.currentOptions(f)
	return f
}

// currentOptions: the service's options, else those of the last start.
func (p *portlessAPI) currentOptions(f proxyFacts) portless.ProxyOptions {
	if f.program != nil {
		if o, ok := f.program.Options(); ok {
			return o
		}
	}
	if !f.state.Configured {
		return portless.DefaultProxyOptions()
	}
	o := portless.ProxyOptions{Port: f.state.Port, HTTPS: f.state.HTTPS, TLDs: f.state.TLDs, Unprivileged: f.state.Unprivileged}
	if f.state.LAN {
		o.LAN, o.LANIP, o.TLDs = true, f.state.LANIP, []string{"local"}
	}
	if f.service != nil && f.service.Installed {
		o.Wildcard = f.service.Wildcard
	}
	return o
}

func (f proxyFacts) serviceInstalled() bool { return f.service != nil && f.service.Installed }

func (p *portlessAPI) adminToStop(f proxyFacts) bool {
	if f.state.AsRoot {
		return true
	}
	// Windows: the service runs the proxy as SYSTEM.
	return p.d.GOOS == "windows" && f.serviceInstalled() && f.state.Responding
}

func (p *portlessAPI) status(w http.ResponseWriter, r *http.Request) {
	c := p.d.Client
	st := PortlessStatus{OS: p.d.GOOS, Method: p.d.Method(), Options: portless.DefaultProxyOptions()}
	if c != nil {
		st.StateDir = c.StateDir
	}
	if c == nil || !c.Available() {
		writeJSON(w, http.StatusOK, st)
		return
	}
	st.Installed = true
	st.Path = c.Path()
	st.Version, _ = c.Version(r.Context())
	f := p.facts(r.Context())
	st.Proxy, st.Service, st.Program, st.Options = f.state, f.service, f.program, f.options
	if f.svcErr != nil {
		st.ServiceError = f.svcErr.Error()
	}
	st.AdminToStart = f.options.NeedsAdmin()
	st.AdminToStop = p.adminToStop(f)
	st.Install = portless.DetectInstall(st.Path, p.d.Lookup)
	st.HostsNeeded = hostsNeeded(f.state.TLDs)
	writeJSON(w, http.StatusOK, st)
}

func hostsNeeded(tlds []string) bool {
	for _, t := range tlds {
		if t != "localhost" {
			return true
		}
	}
	return false
}

// ---- doctor ----

// DoctorReport is GET /api/portless/doctor: portless doctor's findings,
// plus what Portplane checks itself (the service's Node and script).
type DoctorReport struct {
	portless.Doctor
	Error string `json:"error,omitempty"`
}

func (p *portlessAPI) doctor(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	d, err := p.d.Client.Doctor(r.Context())
	rep := DoctorReport{Doctor: d}
	if err != nil {
		rep.Error = err.Error()
	}
	if st, err := p.d.Client.ServiceStatus(r.Context()); err == nil && st.Installed && st.Entry != "" {
		if prog, ok := portless.ReadServiceProgram(st.Entry); ok && (prog.NodeMissing || prog.ScriptMissing) {
			missing := prog.Node
			if !prog.NodeMissing {
				missing = prog.Script
			}
			rep.Findings = append(rep.Findings, portless.Finding{
				Status:  portless.FindingFail,
				Message: "The proxy service starts a program that no longer exists: " + missing,
				Hint:    "Reinstalling the service points it at the Node.js and portless you have now.",
				Check:   "service",
				Fix:     portless.FixReinstallService,
				Subject: missing,
			})
			rep.Failures++
		}
	}
	writeJSON(w, http.StatusOK, rep)
}

// ---- routes ----

// RouteOwner is who a route belongs to.
type RouteOwner struct {
	// Kind: app (a dekit task), process (another program), portplane
	// (this UI), remote (an app on another machine, ADR-0016), compose.
	Kind    string `json:"kind"`
	Label   string `json:"label"`
	Machine string `json:"machine,omitempty"`
	AppID   string `json:"appId,omitempty"`
	PID     int    `json:"pid,omitempty"`
	Process string `json:"process,omitempty"`
}

// RouteView is one row of the routes table.
type RouteView struct {
	portless.RouteState
	URL   string      `json:"url"`
	Owner *RouteOwner `json:"owner,omitempty"`
}

func (p *portlessAPI) routeViews(ctx context.Context) ([]RouteView, error) {
	states, err := p.d.Client.RouteStates()
	if err != nil {
		return nil, err
	}
	proxy := p.d.Client.Proxy()
	var local model.MachineSnapshot
	if p.d.Local != nil {
		local = p.d.Local(ctx)
	}
	listeners := map[int]Listener{}
	for _, l := range p.d.Listeners(ctx) {
		listeners[l.Port] = l
	}
	out := make([]RouteView, 0, len(states))
	for _, s := range states {
		v := RouteView{RouteState: s, URL: proxy.URL(s.Hostname)}
		v.Owner = p.owner(s, local, listeners)
		if v.Owner != nil && v.Owner.Kind == "remote" {
			v.Kind = "remote"
		}
		out = append(out, v)
	}
	return out, nil
}

func (p *portlessAPI) owner(s portless.RouteState, local model.MachineSnapshot, listeners map[int]Listener) *RouteOwner {
	appOwner := func(machine string, a model.App) *RouteOwner {
		label := strings.Join(nonEmpty(a.Project, a.Worktree, a.Label), " · ")
		return &RouteOwner{Kind: "app", Label: label, Machine: machine, AppID: a.ID, PID: a.PID}
	}
	if s.Hostname == StableHost {
		return &RouteOwner{Kind: "portplane", Label: "Portplane"}
	}
	if s.Kind == portless.KindCompose {
		return &RouteOwner{Kind: "compose", Label: "docker compose project " + s.Compose}
	}
	for _, a := range local.Apps {
		if (s.PID > 0 && a.PID == s.PID) || (a.Hostname != "" && a.Hostname == s.Hostname) {
			return appOwner(local.Machine.ID, a)
		}
	}
	if s.PID == 0 {
		for _, ms := range p.d.Machines() {
			if ms.Machine.Local {
				continue
			}
			for _, a := range ms.Apps {
				if a.RemoteURL != "" && hostOf(a.RemoteURL) == s.Hostname {
					o := appOwner(ms.Machine.ID, a)
					o.Kind, o.Label = "remote", o.Label+" on "+ms.Machine.Name
					return o
				}
			}
		}
	}
	if l, ok := listeners[s.Port]; ok && l.PID > 0 {
		label := l.Process
		if label == "" {
			label = fmt.Sprintf("PID %d", l.PID)
		}
		return &RouteOwner{Kind: "process", Label: label, PID: l.PID, Process: l.Process}
	}
	if s.PID > 0 {
		return &RouteOwner{Kind: "process", Label: fmt.Sprintf("PID %d", s.PID), PID: s.PID}
	}
	return nil
}

func hostOf(u string) string {
	u = strings.TrimPrefix(strings.TrimPrefix(u, "https://"), "http://")
	u, _, _ = strings.Cut(u, "/")
	if h, _, ok := strings.Cut(u, ":"); ok {
		return h
	}
	return u
}

func nonEmpty(parts ...string) []string {
	var out []string
	for _, s := range parts {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func (p *portlessAPI) routes(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	views, err := p.routeViews(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, views)
}

// StaleRoute is a route whose portless process is gone, with the programs
// still holding its port: what prune stops.
type StaleRoute struct {
	Hostname  string     `json:"hostname"`
	Port      int        `json:"port"`
	PID       int        `json:"pid"`
	Processes []Listener `json:"processes"`
}

func (p *portlessAPI) prunePreview(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	states, err := p.d.Client.RouteStates()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	byPort := map[int][]Listener{}
	for _, l := range p.d.Listeners(r.Context()) {
		if l.PID > 0 {
			byPort[l.Port] = append(byPort[l.Port], l)
		}
	}
	out := []StaleRoute{}
	for _, s := range states {
		if s.Alive || s.PID == 0 {
			continue
		}
		procs := byPort[s.Port]
		if procs == nil {
			procs = []Listener{}
		}
		out = append(out, StaleRoute{Hostname: s.Hostname, Port: s.Port, PID: s.PID, Processes: procs})
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- aliases ----

type aliasRequest struct {
	From  string `json:"from,omitempty"` // the hostname being replaced (PUT)
	Name  string `json:"name"`
	Port  int    `json:"port"`
	Force bool   `json:"force"`
}

func (p *portlessAPI) mainTLD() string {
	return p.d.Client.ProxyState(context.Background()).MainTLD()
}

func (p *portlessAPI) checkAlias(req aliasRequest) error {
	if prob := portless.NameProblem(req.Name, p.mainTLD()); prob != "" {
		return errors.New(prob)
	}
	if req.Port < 1 || req.Port > 65535 {
		return errors.New("pick a port between 1 and 65535")
	}
	if portless.Hostname(req.Name, p.mainTLD()) == StableHost {
		return errors.New("portplane.localhost is Portplane's own address")
	}
	return nil
}

// aliasError turns portless's refusal into advice.
func aliasError(err error) (int, error) {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "already registered by a running process"):
		return http.StatusConflict, errors.New("a running app already uses that name: pick another, or turn on “Replace the existing route” to take it over (that app's portless process is stopped)")
	case strings.Contains(msg, "is a static alias"):
		return http.StatusConflict, errors.New("another alias already uses that name: pick another, or turn on “Replace the existing route”")
	case strings.Contains(msg, "No alias found"):
		return http.StatusNotFound, errors.New("there is no alias with that name any more")
	}
	return http.StatusBadGateway, err
}

func (p *portlessAPI) addAlias(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	var req aliasRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := p.checkAlias(req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if _, err := p.d.Client.AddAlias(r.Context(), strings.TrimSpace(req.Name), req.Port, req.Force); err != nil {
		code, e := aliasError(err)
		writeError(w, code, e)
		return
	}
	p.d.Refresh()
	p.routes(w, r)
}

func (p *portlessAPI) replaceAlias(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	var req aliasRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := p.checkAlias(req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	tld := p.mainTLD()
	same := portless.BaseName(req.From, []string{tld}) == portless.BaseName(portless.Hostname(req.Name, tld), []string{tld})
	// The new route first, so a refusal leaves the old one in place.
	if _, err := p.d.Client.AddAlias(r.Context(), strings.TrimSpace(req.Name), req.Port, req.Force || same); err != nil {
		code, e := aliasError(err)
		writeError(w, code, e)
		return
	}
	if !same && req.From != "" {
		if _, err := p.d.Client.RemoveAliasOutput(r.Context(), req.From); err != nil {
			writeError(w, http.StatusBadGateway, fmt.Errorf("added the new alias, but removing %s failed: %w", req.From, err))
			return
		}
	}
	p.d.Refresh()
	p.routes(w, r)
}

func (p *portlessAPI) removeAlias(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	name := r.PathValue("name")
	if name == StableHost || name == "portplane" {
		writeError(w, http.StatusBadRequest, errors.New("portplane.localhost is Portplane's own address; it goes away when Portplane quits"))
		return
	}
	if _, err := p.d.Client.RemoveAliasOutput(r.Context(), name); err != nil {
		code, e := aliasError(err)
		writeError(w, code, e)
		return
	}
	p.d.Refresh()
	p.routes(w, r)
}

// ---- certificates ----

// Certificates is GET /api/portless/certificates.
type Certificates struct {
	CA        portless.CA         `json:"ca"`
	HostCerts []portless.HostCert `json:"hostCerts"`
	// Browsers is nil until the browser check exists (M5.1).
	Browsers []BrowserTrust `json:"browsers,omitempty"`
	OS       string         `json:"os"`
	Method   string         `json:"method"`
	// TrustNeedsAdmin: trusting asks for the administrator password
	// (Linux); macOS asks for the login keychain's own password.
	TrustNeedsAdmin bool `json:"trustNeedsAdmin"`
}

func (p *portlessAPI) certificates(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	c := Certificates{
		CA:              p.d.Client.CA(),
		HostCerts:       p.d.Client.HostCerts(),
		OS:              p.d.GOOS,
		Method:          p.d.Method(),
		TrustNeedsAdmin: p.d.GOOS == "linux",
	}
	if p.d.BrowserTrust != nil {
		c.Browsers = p.d.BrowserTrust(r.Context())
	}
	writeJSON(w, http.StatusOK, c)
}

func (p *portlessAPI) exportCA(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	dir := ""
	if p.d.Downloads != nil {
		dir = p.d.Downloads()
	}
	if dir == "" {
		writeError(w, http.StatusInternalServerError, errors.New("no folder to save the certificate in"))
		return
	}
	path, err := p.d.Client.ExportCA(dir)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	revealed := false
	if p.d.Reveal != nil {
		revealed = p.d.Reveal(dir) == nil
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": path, "revealed": revealed})
}

// caPEM answers with the CA certificate itself. Portplane reads a remote
// machine's this way to save it on this computer (ADR-0026).
func (p *portlessAPI) caPEM(w http.ResponseWriter, _ *http.Request) {
	if !p.needPortless(w) {
		return
	}
	ca := p.d.Client.CA()
	b, err := os.ReadFile(ca.Path)
	if !ca.Exists || err != nil {
		writeError(w, http.StatusNotFound, errors.New("portless has no certificate yet: start the proxy with HTTPS or trust it first"))
		return
	}
	w.Header().Set("Content-Type", "application/x-pem-file")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(b)
}

// ---- hosts ----

// HostsView is GET /api/portless/hosts.
type HostsView struct {
	portless.HostsState
	// Needed: the proxy serves a domain other than .localhost, which the
	// system resolver only finds through the hosts file.
	Needed bool     `json:"needed"`
	TLDs   []string `json:"tlds"`
}

func (p *portlessAPI) hosts(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	states, err := p.d.Client.RouteStates()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	var names []string
	for _, s := range states {
		if s.Alive {
			names = append(names, s.Hostname)
		}
	}
	sort.Strings(names)
	tlds := p.d.Client.ProxyState(r.Context()).TLDs
	writeJSON(w, http.StatusOK, HostsView{HostsState: portless.CompareHosts(portless.HostsPath(), names), Needed: hostsNeeded(tlds), TLDs: tlds})
}

// ExecArgv runs argv with extra environment variables and streams its
// output, without colours, to out. It never goes through a shell.
func ExecArgv(ctx context.Context, argv []string, env map[string]string, out io.Writer) error {
	if len(argv) == 0 {
		return errors.New("nothing to run")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = append(os.Environ(), "NO_COLOR=1", "FORCE_COLOR=0", "npm_config_color=false")
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.WaitDelay = 2 * time.Second
	w := portless.CleanWriter(out)
	cmd.Stdout, cmd.Stderr = w, w
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s failed: %w", argv[0], err)
	}
	return nil
}
