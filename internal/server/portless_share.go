package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/envpath"
	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/portless"
	"github.com/akamachinecode/portplane/internal/privileged"
)

// Sharing apps (plan §5.8, M5.6): Tailscale Serve (the tailnet), Tailscale
// Funnel, ngrok and Cloudflare quick tunnels, all through portless's own
// flags. Turning a share on or off edits the flag in the app's command (the
// same files a rename edits, behind the same diff), reloads dekit and
// restarts the app; the shared URL then comes from routes.json. Before a
// share starts, Portplane checks what it needs and says how to fix what's
// missing. A public share needs the user's explicit confirmation.

// extDefaults fills the M5.6 dependencies left empty.
func (p *portlessAPI) extDefaults() {
	d := &p.d
	if d.Tool == nil {
		d.Tool = portless.RunTool
	}
	if d.Network == nil {
		d.Network = func() ([]portless.Iface, string) { return portless.SystemIfaces(), portless.DefaultRouteIP() }
	}
	if d.OSRelease == nil {
		d.OSRelease = func() string {
			b, _ := os.ReadFile("/etc/os-release")
			return string(b)
		}
	}
	if d.Home == nil {
		d.Home = func() string { h, _ := os.UserHomeDir(); return h }
	}
	if d.Getenv == nil {
		d.Getenv = os.Getenv
	}
	if d.User == nil {
		d.User = func() string {
			if u, err := user.Current(); err == nil {
				return u.Username
			}
			return os.Getenv("USER")
		}
	}
	if d.ShareWait == 0 {
		d.ShareWait = 60 * time.Second
	}
	p.compose = newComposeMemory(d.ComposeMemory)
}

func (p *portlessAPI) extRoutes() map[string]http.HandlerFunc {
	return map[string]http.HandlerFunc{
		"GET /api/portless/sharing":                  p.sharing,
		"POST /api/portless/sharing/ngrok-authtoken": p.ngrokAuthtoken,
		"GET /api/portless/share":                    p.shareInfo,
		"POST /api/portless/share/preview":           p.sharePreview,
		"POST /api/portless/share/apply":             p.shareApply,
		"GET /api/portless/compose":                  p.composeOverview,
		"POST /api/portless/compose/preview":         p.composePreview,
		"POST /api/portless/compose/run":             p.composeRun,
		"GET /api/portless/lan":                      p.lan,
	}
}

func (p *portlessAPI) lookup(name string) string {
	if p.d.Lookup != nil {
		return p.d.Lookup(name)
	}
	return envpath.Lookup(name)
}

// Requirement is one thing a feature needs, and how to fix it when it's
// missing.
type Requirement struct {
	ID    string `json:"id"`
	OK    bool   `json:"ok"`
	Label string `json:"label"`
	// Problem says what's wrong in plain words; Fix what to do about it.
	Problem string `json:"problem,omitempty"`
	Fix     string `json:"fix,omitempty"`
	// Command is a command to copy; URL an official page to open.
	Command string `json:"command,omitempty"`
	URL     string `json:"url,omitempty"`
	// Action is a fix Portplane runs itself: "ngrok-authtoken" (a form)
	// or "tailscale-operator" (a plan that asks for the password).
	Action string `json:"action,omitempty"`
}

func missing(reqs []Requirement) []Requirement {
	out := []Requirement{}
	for _, r := range reqs {
		if !r.OK {
			out = append(out, r)
		}
	}
	return out
}

// ShareProvider is one way to share, and whether this computer is ready.
type ShareProvider struct {
	Kind   string `json:"kind"`
	Label  string `json:"label"`
	Public bool   `json:"public"`
	Ready  bool   `json:"ready"`
	// Where says what the shared address looks like.
	Where        string        `json:"where"`
	Requirements []Requirement `json:"requirements"`
	Notes        []string      `json:"notes"`
}

// shareTools is what the providers need, read once per request.
type shareTools struct {
	tailscale   portless.TailscaleState
	ngrok       portless.NgrokState
	cloudflared string
}

func (p *portlessAPI) readShareTools(ctx context.Context) shareTools {
	return shareTools{
		tailscale:   portless.ReadTailscale(ctx, p.d.Tool, p.d.GOOS),
		ngrok:       portless.ReadNgrok(p.lookup, p.d.GOOS, p.d.Home(), p.d.Getenv),
		cloudflared: p.lookup("cloudflared"),
	}
}

func hint(tool, goos string) (string, string) {
	h := portless.ToolInstallHint(tool, goos)
	return h.Command, h.Page
}

func (p *portlessAPI) tailscaleRequirements(t portless.TailscaleState, funnel bool) []Requirement {
	goos := p.d.GOOS
	cmd, page := hint("tailscale", goos)
	reqs := []Requirement{{ID: "tailscale-installed", OK: t.Installed, Label: "Tailscale is installed"}}
	if !t.Installed {
		reqs[0].Problem = "Tailscale isn't installed. Sharing on your tailnet goes through it."
		reqs[0].Fix = "Install Tailscale and sign in to your tailnet, then check again."
		reqs[0].Command, reqs[0].URL = cmd, page
		return reqs
	}
	up := Requirement{ID: "tailscale-running", OK: t.Running && !t.DaemonDown, Label: "Tailscale is connected"}
	upCmd := "tailscale up"
	if goos == "linux" {
		upCmd = "sudo tailscale up"
	}
	switch {
	case t.DaemonDown:
		up.Problem = "Tailscale is installed but its service isn't running."
		if goos == "linux" {
			up.Fix, up.Command = "Start the Tailscale service.", "sudo systemctl enable --now tailscaled"
		} else {
			up.Fix = "Open the Tailscale app."
		}
	case t.BackendState == "NeedsLogin" || t.BackendState == "NoState":
		up.Problem = "You aren't signed in to Tailscale on this machine."
		up.Fix, up.Command = "Sign in from the Tailscale app, or in a terminal.", upCmd
	case t.BackendState == "NeedsMachineAuth":
		up.Problem = "Your tailnet's admin hasn't approved this machine yet."
		up.Fix, up.URL = "Ask them to approve it in the admin console.", "https://login.tailscale.com/admin/machines"
	case t.BackendState == "Stopped":
		up.Problem = "Tailscale is turned off."
		up.Fix, up.Command = "Turn it on from the Tailscale app, or in a terminal.", upCmd
	case !t.Running:
		up.Problem = "Tailscale isn't connected"
		if t.BackendState != "" {
			up.Problem += " (" + t.BackendState + ")"
		}
		if t.Error != "" && t.BackendState == "" {
			up.Problem += ": " + t.Error
		}
		up.Problem += "."
		up.Fix, up.Command = "Connect it from the Tailscale app, or in a terminal.", upCmd
	}
	reqs = append(reqs, up)
	if !up.OK {
		return reqs
	}
	https := Requirement{ID: "tailscale-https", OK: t.HTTPS && t.DNSName != "", Label: "Your tailnet issues HTTPS certificates"}
	if !https.OK {
		https.Problem = "Your tailnet doesn't issue HTTPS certificates, and every Tailscale share needs one."
		if !t.MagicDNS {
			https.Fix = "In the admin console's DNS page, turn on MagicDNS, then HTTPS Certificates."
		} else {
			https.Fix = "In the admin console's DNS page, turn on HTTPS Certificates."
		}
		https.URL = "https://login.tailscale.com/admin/dns"
	}
	reqs = append(reqs, https)
	if goos == "linux" && t.OperatorKnown {
		u := p.d.User()
		ok := u == "root" || (u != "" && t.Operator == u)
		op := Requirement{ID: "tailscale-operator", OK: ok, Label: "Tailscale lets your user share"}
		if !ok {
			op.Problem = "On Linux, Tailscale only lets the administrator, or the user set as its operator, share apps."
			op.Fix = "Make " + u + " Tailscale's operator. It asks for your password once; Tailscale keeps the setting."
			op.Command = "sudo tailscale set --operator=" + u
			op.Action = "tailscale-operator"
		}
		reqs = append(reqs, op)
	}
	if funnel {
		f := Requirement{ID: "tailscale-funnel", OK: t.Funnel, Label: "Your tailnet allows Funnel on this machine"}
		if !t.Funnel {
			f.Problem = "Your tailnet's policy doesn't let this machine use Funnel, which is what makes a Tailscale address public."
			f.Fix = "An admin of your tailnet turns Funnel on for this machine. The page explains how and can do it for you."
			f.URL = portless.TailscaleFunnelPage(t.NodeID)
		}
		reqs = append(reqs, f)
	}
	return reqs
}

func (p *portlessAPI) providers(t shareTools) []ShareProvider {
	goos := p.d.GOOS
	tsWhere := "https://<this machine>.<your tailnet>.ts.net"
	if t.tailscale.DNSName != "" {
		tsWhere = "https://" + t.tailscale.DNSName
	}
	ts := ShareProvider{Kind: portless.ShareTailscale, Label: "Your tailnet", Where: tsWhere, Requirements: p.tailscaleRequirements(t.tailscale, false),
		Notes: []string{"Only devices signed in to your tailnet can open it. Each shared app takes the next free HTTPS port: 443, then 8443 and up."}}
	fu := ShareProvider{Kind: portless.ShareFunnel, Label: "Public, with Tailscale Funnel", Public: true, Where: tsWhere, Requirements: p.tailscaleRequirements(t.tailscale, true),
		Notes: []string{"Anyone on the internet with the address can open it. Funnel offers three ports (443, 8443 and 10000), so at most three apps at once."}}

	ngCmd, ngPage := hint("ngrok", goos)
	ngInstalled := Requirement{ID: "ngrok-installed", OK: t.ngrok.Installed, Label: "ngrok is installed"}
	if !t.ngrok.Installed {
		ngInstalled.Problem = "ngrok isn't installed."
		ngInstalled.Fix = "Install ngrok and create a free account, then check again."
		ngInstalled.Command, ngInstalled.URL = ngCmd, ngPage
	}
	ngToken := Requirement{ID: "ngrok-authtoken", OK: t.ngrok.Authtoken, Label: "ngrok knows your account"}
	if !t.ngrok.Authtoken {
		ngToken.Problem = "ngrok needs your account's authtoken before it opens a tunnel."
		ngToken.Fix = "Copy your authtoken from the ngrok dashboard and paste it here; Portplane saves it in ngrok's own config."
		ngToken.Command = "ngrok config add-authtoken <token>"
		ngToken.URL = "https://dashboard.ngrok.com/get-started/your-authtoken"
		ngToken.Action = "ngrok-authtoken"
	}
	ng := ShareProvider{Kind: portless.ShareNgrok, Label: "Public, with ngrok", Public: true, Where: "https://<random>.ngrok-free.app", Requirements: []Requirement{ngInstalled, ngToken},
		Notes: []string{"Anyone on the internet with the address can open it. On ngrok's free plan, visitors see an ngrok notice first."}}

	cfCmd, cfPage := hint("cloudflared", goos)
	cfInstalled := Requirement{ID: "cloudflared-installed", OK: t.cloudflared != "", Label: "cloudflared is installed"}
	if t.cloudflared == "" {
		cfInstalled.Problem = "cloudflared, Cloudflare's tunnel program, isn't installed."
		cfInstalled.Fix = "Install cloudflared, then check again. Quick tunnels need no Cloudflare account."
		cfInstalled.Command, cfInstalled.URL = cfCmd, cfPage
	}
	cf := ShareProvider{Kind: portless.ShareCloudflare, Label: "Public, with Cloudflare", Public: true, Where: "https://<random>.trycloudflare.com", Requirements: []Requirement{cfInstalled},
		Notes: []string{"Anyone on the internet with the address can open it. The address changes every time the app restarts.", "Quick tunnels need outbound UDP port 7844; on networks that block it, set TUNNEL_TRANSPORT_PROTOCOL=http2 in the app's environment."}}

	out := []ShareProvider{ts, fu, ng, cf}
	for i := range out {
		out[i].Ready = len(missing(out[i].Requirements)) == 0
		if !out[i].Ready {
			out[i].Notes = []string{}
		}
	}
	return out
}

// ---- overview ----

// ShareView is one shared address, from routes.json.
type ShareView struct {
	Hostname string      `json:"hostname"`
	Kind     string      `json:"kind"`
	URL      string      `json:"url"`
	Public   bool        `json:"public"`
	Alive    bool        `json:"alive"`
	Owner    *RouteOwner `json:"owner,omitempty"`
	// Editable: Portplane can stop the share (it owns the app's command);
	// Reason says why not.
	Editable bool   `json:"editable"`
	Reason   string `json:"reason,omitempty"`
}

// SharingOverview is GET /api/portless/sharing.
type SharingOverview struct {
	OS        string          `json:"os"`
	Providers []ShareProvider `json:"providers"`
	Shares    []ShareView     `json:"shares"`
}

func (p *portlessAPI) overview(ctx context.Context) (SharingOverview, error) {
	ov := SharingOverview{OS: p.d.GOOS, Providers: p.providers(p.readShareTools(ctx)), Shares: []ShareView{}}
	views, err := p.routeViews(ctx)
	if err != nil {
		return ov, err
	}
	for _, v := range views {
		for _, s := range v.Shared {
			sv := ShareView{Hostname: v.Hostname, Kind: s.Kind, URL: s.URL, Public: portless.SharePublic(s.Kind), Alive: v.Alive, Owner: v.Owner}
			switch {
			case !v.Alive:
				sv.Reason = "The app that shared it has stopped. Clean stale routes removes it."
			case v.Owner != nil && v.Owner.Kind == "app" && v.Owner.AppID != "":
				if sc, err := p.resolveShare(ctx, v.Owner.Machine, v.Owner.AppID); err == nil {
					sv.Editable, sv.Reason = sc.info.Editable, sc.info.Reason
					if sv.Editable && !contains(sc.info.On, s.Kind) {
						sv.Editable = false
						sv.Reason = "Turned on by " + portless.ShareEnv(s.Kind) + " in the task's environment, not by its command."
					}
				} else {
					sv.Reason = err.Error()
				}
			default:
				sv.Reason = "Started outside Portplane: stop it where it runs (Ctrl+C in its terminal), or start it again without " + portless.ShareFlag(s.Kind) + "."
			}
			ov.Shares = append(ov.Shares, sv)
		}
	}
	return ov, nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func (p *portlessAPI) sharing(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	ov, err := p.overview(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, ov)
}

// ngrokAuthtoken saves the user's ngrok authtoken with `ngrok config
// add-authtoken`. The token is never logged or sent back.
func (p *portlessAPI) ngrokAuthtoken(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	var req struct {
		Token string `json:"token"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	token := strings.TrimSpace(req.Token)
	if !portless.ValidNgrokToken(token) {
		writeError(w, http.StatusBadRequest, errors.New("that doesn't look like an ngrok authtoken: copy the whole token from the ngrok dashboard"))
		return
	}
	bin := p.lookup("ngrok")
	if bin == "" {
		writeError(w, http.StatusBadRequest, errors.New("ngrok isn't installed: install it first"))
		return
	}
	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if err := p.d.Exec(ctx, append([]string{bin}, portless.NgrokAuthtokenArgs(token)...), nil, &out); err != nil {
		msg := strings.TrimSpace(out.String())
		if msg == "" {
			msg = err.Error()
		}
		writeError(w, http.StatusBadGateway, fmt.Errorf("ngrok didn't save the token: %s", strings.ReplaceAll(msg, token, "…")))
		return
	}
	p.sharing(w, r)
}

// ---- one app ----

// ShareInfo is GET /api/portless/share?machine=&app=.
type ShareInfo struct {
	Hostname string `json:"hostname"`
	Source   string `json:"source"`
	Editable bool   `json:"editable"`
	Reason   string `json:"reason,omitempty"`
	File     string `json:"file,omitempty"`
	Task     string `json:"task,omitempty"`
	Running  bool   `json:"running"`
	// On are the shares the app's command turns on; Env the ones its
	// environment turns on (PORTLESS_NGROK=1…), which Portplane leaves.
	On  []string `json:"on"`
	Env []string `json:"env"`
	// Shared are the addresses portless reports for the app now.
	Shared    []portless.Shared `json:"shared"`
	Providers []ShareProvider   `json:"providers"`
}

type shareCtx struct {
	info ShareInfo
	app  model.App
	root string
	task *dekit.Task
}

func (p *portlessAPI) resolveShare(ctx context.Context, machine, id string) (*shareCtx, error) {
	app, _, err := p.findApp(ctx, machine, id)
	if err != nil {
		if strings.Contains(err.Error(), "other machines") {
			return nil, errors.New("apps on other machines can be shared from that machine for now; remote machines get this later")
		}
		return nil, err
	}
	sc := &shareCtx{app: app, root: app.Runner}
	info := &sc.info
	*info = ShareInfo{Hostname: app.Hostname, Source: portless.SourceNone, Running: app.State.Alive(), On: []string{}, Env: []string{}, Shared: []portless.Shared{}, Providers: []ShareProvider{}}
	if states, err := p.d.Client.RouteStates(); err == nil && app.Hostname != "" {
		for _, s := range states {
			if s.Hostname == app.Hostname {
				info.Shared = s.Shared
			}
		}
	}
	var cfg *dekit.Config
	if p.d.Config != nil {
		cfg, _ = p.d.Config(app.Runner)
	}
	if cfg != nil {
		sc.task = cfg.Task(app.Task)
	}
	t := sc.task
	if t != nil && t.Cmd == nil {
		info.Reason = "This task's command is written as JavaScript (!js or a script), which Portplane doesn't rewrite. Add " + portless.ShareFlag(portless.ShareTailscale) + " after the app's name there in your editor."
		return sc, nil
	}
	if t == nil || portless.ParseCommand(t.Cmd) == nil {
		info.Reason = "portless shares only the apps it starts, and this app's command doesn't run through portless <name> or portless run."
		if t != nil {
			if _, _, ok := portless.AliasArgs(t.Cmd); ok {
				info.Reason = "An alias only names a server portless doesn't start, so portless can't share it."
			}
		}
		return sc, nil
	}
	info.Source, info.File, info.Task = portless.SourceTask, t.File, t.Path
	if portless.IsFragment(t.File) {
		info.Source = portless.SourceFragment
	}
	if on := portless.ShareFlags(t.Cmd); on != nil {
		info.On = on
	}
	if env := portless.ShareEnvKinds(t.Env); env != nil {
		info.Env = env
	}
	src, err := os.ReadFile(t.File)
	if err != nil {
		info.Reason = "Portplane can't read " + t.File + "."
		return sc, nil
	}
	if _, err := portless.SetShareInCmd(src, t.Key, t.Cmd, portless.ShareCloudflare, !contains(info.On, portless.ShareCloudflare)); err != nil {
		if errors.Is(err, dekit.ErrNotEditable) {
			info.Reason = "This task's command is written in a way Portplane won't rewrite (a !js value, an anchor, or quotes around the command). Add " + portless.ShareFlag(portless.ShareTailscale) + " after the app's name in " + filepath.Base(t.File) + " in your editor."
		} else {
			info.Reason = err.Error()
		}
		return sc, nil
	}
	info.Editable = true
	return sc, nil
}

func (p *portlessAPI) shareInfo(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	q := r.URL.Query()
	sc, err := p.resolveShare(r.Context(), q.Get("machine"), q.Get("app"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	sc.info.Providers = p.providers(p.readShareTools(r.Context()))
	writeJSON(w, http.StatusOK, sc.info)
}

type shareRequest struct {
	Machine string `json:"machine"`
	App     string `json:"app"`
	Kind    string `json:"kind"`
	On      bool   `json:"on"`
	Digest  string `json:"digest,omitempty"`
	// ConfirmPublic: the user confirmed the app becomes reachable from
	// the internet. Turning on a public share needs it.
	ConfirmPublic bool `json:"confirmPublic,omitempty"`
}

// SharePreview is POST /api/portless/share/preview: what turning a share
// on or off changes, before it does.
type SharePreview struct {
	Kind   string `json:"kind"`
	On     bool   `json:"on"`
	Public bool   `json:"public"`
	// Problem: it can't be done now; Missing lists the requirements still
	// missing when that's why.
	Problem string        `json:"problem,omitempty"`
	Missing []Requirement `json:"missing"`
	// Replaces is the share this one takes the place of (Tailscale and
	// Funnel replace each other).
	Replaces string     `json:"replaces,omitempty"`
	Files    []FileEdit `json:"files"`
	Steps    []string   `json:"steps"`
	Warnings []string   `json:"warnings"`
	Digest   string     `json:"digest,omitempty"`
}

func (p *portlessAPI) planShare(ctx context.Context, sc *shareCtx, kind string, on bool) (SharePreview, error) {
	pv := SharePreview{Kind: kind, On: on, Public: on && portless.SharePublic(kind), Missing: []Requirement{}, Files: []FileEdit{}, Steps: []string{}, Warnings: []string{}}
	if !portless.ValidShareKind(kind) {
		pv.Problem = fmt.Sprintf("unknown share %q", kind)
		return pv, nil
	}
	info, label := sc.info, portless.ShareLabel(kind)
	if !info.Editable {
		pv.Problem = info.Reason
		return pv, nil
	}
	if on == contains(info.On, kind) {
		switch {
		case on:
			pv.Problem = sc.app.Label + " is already shared with " + label + "."
		case contains(info.Env, kind):
			pv.Problem = portless.ShareEnv(kind) + " in the task's environment turns this on. Remove it from " + filepath.Base(info.File) + " in your editor to stop sharing."
		default:
			pv.Problem = sc.app.Label + " isn't shared with " + label + "."
		}
		return pv, nil
	}
	if on {
		for _, prov := range p.providers(p.readShareTools(ctx)) {
			if prov.Kind == kind {
				pv.Missing = missing(prov.Requirements)
			}
		}
		if len(pv.Missing) > 0 {
			pv.Problem = "This machine isn't ready to share with " + label + " yet. Fix what's missing first."
			return pv, nil
		}
		other := map[string]string{portless.ShareTailscale: portless.ShareFunnel, portless.ShareFunnel: portless.ShareTailscale}[kind]
		if other != "" && contains(info.On, other) {
			pv.Replaces = other
		}
	}
	src, err := os.ReadFile(info.File)
	if err != nil {
		return pv, err
	}
	after, err := portless.SetShareInCmd(src, sc.task.Key, sc.task.Cmd, kind, on)
	if err != nil {
		if errors.Is(err, dekit.ErrNotEditable) {
			pv.Problem = dekit.ErrNotEditable.Error()
			return pv, nil
		}
		return pv, err
	}
	pv.Files = append(pv.Files, FileEdit{Path: info.File, Before: string(src), After: string(after), Changed: true})
	pv.Steps = append(pv.Steps, "Write "+filepath.Base(info.File), "Reload dekit")
	switch {
	case info.Running:
		pv.Steps = append(pv.Steps, "Restart "+sc.app.Label)
	case on:
		pv.Steps = append(pv.Steps, "Start "+sc.app.Label)
	}
	if on {
		pv.Steps = append(pv.Steps, "Wait for the shared address")
	}
	switch {
	case pv.Public:
		pv.Warnings = append(pv.Warnings, "Anyone on the internet who has the address can open "+sc.app.Label+" while it's shared. Share only an app with no real data, or one that asks for a login.")
	case on:
		pv.Warnings = append(pv.Warnings, "Everyone on your tailnet can open "+sc.app.Label+" while it's shared.")
	}
	if pv.Replaces != "" {
		pv.Warnings = append(pv.Warnings, "This replaces sharing with "+portless.ShareLabel(pv.Replaces)+": an app is shared on the tailnet or publicly through Funnel, not both.")
	}
	if !on && !info.Running {
		pv.Warnings = append(pv.Warnings, sc.app.Label+" isn't running; the change applies the next time it starts.")
	}
	pv.Digest = editsDigest(pv.Files)
	return pv, nil
}

func (p *portlessAPI) sharePreview(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	var req shareRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	sc, err := p.resolveShare(r.Context(), req.Machine, req.App)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	pv, err := p.planShare(r.Context(), sc, req.Kind, req.On)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, pv)
}

func (p *portlessAPI) shareApply(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	if p.d.Jobs == nil {
		writeError(w, http.StatusNotImplemented, errors.New("jobs are not available"))
		return
	}
	var req shareRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	sc, err := p.resolveShare(r.Context(), req.Machine, req.App)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	pv, err := p.planShare(r.Context(), sc, req.Kind, req.On)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if pv.Problem != "" {
		writeError(w, http.StatusBadRequest, errors.New(pv.Problem))
		return
	}
	if pv.Public && !req.ConfirmPublic {
		writeError(w, http.StatusBadRequest, errors.New("sharing publicly needs your confirmation that the app becomes reachable from the internet"))
		return
	}
	if req.Digest == "" || req.Digest != pv.Digest {
		writeError(w, http.StatusConflict, errors.New("the file changed since the preview: review the new preview and apply again"))
		return
	}
	app, label := sc.app, portless.ShareLabel(req.Kind)
	title := "Share " + app.Label + " with " + label
	if !req.On {
		title = "Stop sharing " + app.Label + " with " + label
	}
	job := p.d.Jobs.Start(jobs.Spec{Kind: "portless.share", Title: title, Key: "share|" + app.ID, Steps: pv.Steps}, func(ctx context.Context, run *jobs.Run) error {
		defer p.d.Refresh()
		for _, f := range pv.Files {
			run.Step("Write " + filepath.Base(f.Path))
			if err := portless.WriteEdit(configEdit(f)); err != nil {
				return err
			}
			run.Logf("Wrote %s", f.Path)
		}
		run.Step("Reload dekit")
		if p.d.Reload != nil {
			if err := p.d.Reload(ctx, sc.root); err != nil {
				if errors.Is(err, dekit.ErrRunnerDown) {
					return errors.New("dekit isn't running for this project, so the change waits until it starts: start the project, then the app")
				}
				return fmt.Errorf("dekit reload: %w", err)
			}
		}
		switch {
		case sc.info.Running:
			run.Step("Restart " + app.Label)
			if p.d.Restart != nil {
				if err := p.d.Restart(ctx, sc.root, app.Task); err != nil {
					return err
				}
			}
		case req.On:
			run.Step("Start " + app.Label)
			if p.d.Start != nil {
				if err := p.d.Start(ctx, sc.root, app.Task); err != nil {
					return err
				}
			}
		}
		if !req.On {
			run.SetResult(map[string]string{"kind": req.Kind})
			return nil
		}
		run.Step("Wait for the shared address")
		url, err := p.waitForShare(ctx, run, app, req.Kind)
		if err != nil {
			return err
		}
		run.Logf("%s → %s", app.Hostname, url)
		run.SetResult(map[string]string{"kind": req.Kind, "url": url})
		return nil
	})
	StartJob(w, job)
}

// waitForShare waits until routes.json records the app's shared address,
// or the app stops.
func (p *portlessAPI) waitForShare(ctx context.Context, run *jobs.Run, app model.App, kind string) (string, error) {
	start := time.Now()
	deadline := start.Add(p.d.ShareWait)
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	said := false
	for {
		if states, err := p.d.Client.RouteStates(); err == nil {
			for _, s := range states {
				if s.Hostname == app.Hostname && s.Alive {
					if u := s.ShareURL(kind); u != "" {
						return u, nil
					}
				}
			}
		}
		// The snapshot lags a restart by a moment: trust a failure after it.
		if p.d.Local != nil && time.Since(start) > 4*time.Second {
			for _, a := range p.d.Local(ctx).Apps {
				if a.ID == app.ID && a.State == model.StateFailed {
					return "", fmt.Errorf("%s stopped instead of sharing. Its output says why (often a missing requirement or a port %s already uses); open its Output tab", app.Label, portless.ShareLabel(kind))
				}
			}
		}
		if !said && time.Until(deadline) < p.d.ShareWait/2 {
			run.Logf("Still waiting for %s to report the address…", portless.ShareLabel(kind))
			said = true
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("portless didn't report a shared address within %s. The app may still be starting: check its Output tab, and Domains → Sharing in a moment", p.d.ShareWait.Round(time.Second))
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-tick.C:
		}
	}
}

// tailscaleOperatorAction makes the current user Tailscale's operator, so
// `tailscale serve` works without root (Linux).
func (p *portlessAPI) tailscaleOperatorAction(a *action) error {
	bin := p.lookup("tailscale")
	if bin == "" {
		return errors.New("tailscale isn't installed")
	}
	u := p.d.User()
	if u == "" || u == "root" {
		return errors.New("can't tell which user to make Tailscale's operator")
	}
	cmd := privileged.Command{Argv: append([]string{bin}, portless.TailscaleOperatorArgs(u)...), Reason: "Portplane needs your password to let your user share apps with Tailscale."}
	a.plan.Title = "Let " + u + " share with Tailscale"
	a.plan.Summary = "Makes " + u + " Tailscale's operator, so portless can share apps on your tailnet without your password each time. Tailscale keeps this until you change it."
	a.steps = append(a.steps, p.adminStep(a.plan.Title, cmd))
	return nil
}
