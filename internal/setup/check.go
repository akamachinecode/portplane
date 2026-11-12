package setup

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/browsertrust"
	"github.com/akamachinecode/portplane/internal/installer"
	"github.com/akamachinecode/portplane/internal/portless"
)

// Minimum versions Portplane works with.
const (
	MinDekit    = "0.10.0"
	MinPortless = "0.16.0"
)

// Requirement is one thing setup checks, with what is wrong and how to fix
// it: by hand (Commands) or from Portplane (Fix).
type Requirement struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Why  string `json:"why"`
	OK   bool   `json:"ok"`
	// Status is ok, missing, outdated, warning, info or skipped (the check
	// does not apply here, such as /etc/hosts with .localhost names).
	Status    string   `json:"status"`
	Version   string   `json:"version,omitempty"`
	Detail    string   `json:"detail,omitempty"` // what was found
	Problem   string   `json:"problem,omitempty"`
	Commands  []string `json:"commands,omitempty"` // copyable, in order
	Docs      string   `json:"docs,omitempty"`
	Privilege bool     `json:"privilege"` // the step needs an administrator
	// Optional: setup works without it.
	Optional bool `json:"optional,omitempty"`
	// Fix is what Portplane can do about it: install-dekit, install-node,
	// install-portless, update-dekit, update-portless, proxy,
	// reinstall-service, use-1355, trust-system, trust-browsers,
	// path-profile.
	Fix string `json:"fix,omitempty"`

	Origin   *installer.Origin     `json:"origin,omitempty"`
	Install  *installer.Plan       `json:"install,omitempty"`
	Port     *PortInfo             `json:"port,omitempty"`
	Service  *ServiceInfo          `json:"service,omitempty"`
	Browsers *browsertrust.Report  `json:"browsers,omitempty"`
	Managers map[string]string     `json:"managers,omitempty"` // package manager -> version ("" missing)
	Path     *installer.PathStatus `json:"path,omitempty"`
}

// Check is the report.
type Check struct {
	Requirements []Requirement `json:"requirements"`
	// Ready: everything needed to write and run config (dekit, Node 24,
	// portless).
	Ready bool `json:"ready"`
	// Admin is how this system asks for an administrator password:
	// pkexec, osascript, uac, or "" when it cannot (the user runs the
	// command in a terminal).
	Admin string `json:"admin"`
	OS    string `json:"os"`
}

// PortInfo is who listens on the proxy's port.
type PortInfo struct {
	Port     int    `json:"port"`
	Free     bool   `json:"free"`
	Portless bool   `json:"portless"` // answers with X-Portless: 1
	PID      int    `json:"pid,omitempty"`
	Process  string `json:"process,omitempty"`
	Known    bool   `json:"known"` // the owner could be read
}

// ServiceInfo is the proxy and its startup service.
type ServiceInfo struct {
	Installed   bool     `json:"installed"`
	Responding  bool     `json:"responding"`
	Running     bool     `json:"running"` // a proxy answers, service or not
	Port        int      `json:"port,omitempty"`
	HTTPS       bool     `json:"https"`
	TLDs        []string `json:"tlds,omitempty"`
	LAN         bool     `json:"lan"`
	NodePath    string   `json:"nodePath,omitempty"`
	NodeMissing bool     `json:"nodeMissing"`
	State       string   `json:"state,omitempty"`
	// Commands are the exact privileged commands, for doing it by hand.
	InstallCommand string `json:"installCommand,omitempty"`
}

// Tool is what was found of dekit or portless.
type Tool struct {
	Path    string
	Version string
	Origin  *installer.Origin
}

// Facts are the inputs of a check, so it can be tested. Extended adds
// every M5 check; without it (the CLI), only the tools and the proxy.
type Facts struct {
	GOOS            string
	Dekit           string // version, empty when missing
	Portless        string
	Node            string // "v24.1.0"
	ProxyRunning    bool
	PortplaneOnPATH bool

	Extended bool
	// Only limits gathering and the report to some checks (by id).
	Only []string

	DekitTool    Tool
	PortlessTool Tool
	NodeInfo     installer.NodeInfo
	NodeOrigin   *installer.Origin
	NodeManagers []string
	Plans        map[string]installer.Plan
	Git          string
	// Managers are the package managers' versions ("" when missing).
	Managers map[string]string
	Port     *PortInfo
	Service  *portless.ServiceStatus
	// ServiceInstall is the exact `sudo … service install` for the
	// default options.
	ServiceInstall string
	ProxyPort      int
	ProxyHTTPS     bool
	CA             *portless.CA
	Browsers       *browsertrust.Report
	// HostsBlock: /etc/hosts has portless's block.
	HostsBlock bool
	LANTool    string // avahi-publish-address or dns-sd, when found
	Path       *installer.PathStatus
	// Tray: Visible, and GNOME for the AppIndicator hint.
	TrayChecked bool
	TrayVisible bool
	GNOME       bool
	Admin       string
}

// IDs of the checks, in the order the report lists them.
var CheckIDs = []string{"dekit", "node", "portless", "git", "packages", "port", "proxy", "ca", "hosts", "lan", "path", "tray", "portplane"}

// GatherFacts reads the basic facts (tools and proxy) from this machine.
func GatherFacts(ctx context.Context, dekitVersion, portlessVersion string, proxyRunning bool) Facts {
	f := Facts{GOOS: runtime.GOOS, Dekit: dekitVersion, Portless: portlessVersion, ProxyRunning: proxyRunning}
	if node, err := exec.LookPath("node"); err == nil {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if out, err := exec.CommandContext(ctx, node, "--version").Output(); err == nil {
			f.Node = strings.TrimSpace(string(out))
		}
	}
	_, err := exec.LookPath("portplane")
	f.PortplaneOnPATH = err == nil
	return f
}

func (f Facts) wants(id string) bool {
	if len(f.Only) == 0 {
		return true
	}
	for _, o := range f.Only {
		if o == id {
			return true
		}
	}
	return false
}

// Evaluate turns facts into requirements with instructions per OS.
func Evaluate(f Facts) Check {
	var reqs []Requirement
	add := func(id string, build func() Requirement) {
		if f.wants(id) {
			r := build()
			r.ID = id
			if r.Status == "" {
				r.Status = statusOf(r)
			}
			reqs = append(reqs, r)
		}
	}
	nodeOK := nodeMajor(f.Node) >= installer.NodeMajor || f.NodeInfo.OK()

	add("dekit", f.dekit)
	add("node", func() Requirement { return f.node(nodeOK) })
	add("portless", f.portless)
	if f.Extended {
		add("git", f.git)
		add("packages", f.packages)
		add("port", f.port)
	}
	add("proxy", f.proxy)
	if f.Extended {
		add("ca", f.ca)
		add("hosts", f.hosts)
		add("lan", f.lan)
		add("path", f.path)
		add("tray", f.tray)
	}
	add("portplane", func() Requirement {
		pp := Requirement{Name: "portplane on PATH", Why: "A few generated tasks (Sanity, Remotion) call `portplane port-exec` to pass the port.", OK: f.PortplaneOnPATH, Optional: true}
		if !pp.OK {
			pp.Status = "warning"
			pp.Problem = "The portplane binary is not on PATH; tasks that use port-exec would not start."
		}
		return pp
	})

	dekitOK := f.Dekit != "" && installer.CompareVersions(f.Dekit, MinDekit) >= 0
	portlessOK := f.Portless != "" && installer.CompareVersions(f.Portless, MinPortless) >= 0
	return Check{Requirements: reqs, Ready: dekitOK && portlessOK && nodeOK, Admin: f.Admin, OS: f.GOOS}
}

func statusOf(r Requirement) string {
	switch {
	case r.OK:
		return "ok"
	case r.Optional:
		return "warning"
	default:
		return "missing"
	}
}

func (f Facts) plan(tool string) *installer.Plan {
	if p, ok := f.Plans[tool]; ok {
		return &p
	}
	return nil
}

func (f Facts) dekit() Requirement {
	win := f.GOOS == "windows"
	r := Requirement{Name: "dekit", Why: "Runs and supervises your dev servers; Portplane writes its config and starts and stops tasks through it.", Version: f.Dekit, Docs: "https://dekit.run", Origin: f.DekitTool.Origin, Install: f.plan(installer.Dekit)}
	manual := "curl -fsSL https://dekit.run/install.sh | sh"
	if win {
		manual = "irm https://dekit.run/install.ps1 | iex"
	}
	switch {
	case f.Dekit == "":
		r.Problem = "dekit was not found."
		r.Commands = []string{manual}
		r.Fix = "install-dekit"
	case installer.CompareVersions(f.Dekit, MinDekit) < 0:
		r.Status = "outdated"
		r.Problem = fmt.Sprintf("dekit %s is older than %s, the oldest Portplane works with.", f.Dekit, MinDekit)
		r.Commands = updateCommands(f.DekitTool.Origin, manual)
		r.Fix = "update-dekit"
	default:
		r.OK = true
	}
	if r.Origin != nil && r.Origin.Label != "" {
		r.Detail = "Installed with " + r.Origin.Label
	}
	return r
}

func updateCommands(o *installer.Origin, fallback string) []string {
	if o != nil && len(o.Update) > 0 {
		return []string{strings.Join(o.Update, " ")}
	}
	return []string{fallback}
}

func (f Facts) node(ok bool) Requirement {
	v := strconv.Itoa(installer.NodeMajor)
	r := Requirement{Name: "Node.js " + v + " or later", Why: "portless runs on Node.js " + v + "+.", OK: ok, Version: f.Node, Docs: "https://nodejs.org", Origin: f.NodeOrigin, Install: f.plan(installer.Node)}
	if f.NodeInfo.Version != "" {
		r.Version = f.NodeInfo.Version
	}
	if ok {
		switch {
		case f.NodeInfo.Private:
			r.Detail = "Portplane's own copy, used only by portless"
			if f.NodeInfo.UserVersion != "" && f.NodeInfo.UserVersion != f.NodeInfo.Version {
				r.Detail += " (your Node.js " + f.NodeInfo.UserVersion + " stays as it is)"
			}
		case r.Origin != nil && r.Origin.Label != "":
			r.Detail = "Installed with " + r.Origin.Label
		}
		return r
	}
	have := f.Node
	if f.NodeInfo.UserVersion != "" {
		have = f.NodeInfo.UserVersion
	}
	r.Fix = "install-node"
	if have == "" {
		r.Problem = "Node.js was not found."
	} else {
		r.Status = "outdated"
		r.Version = have
		r.Problem = "Node.js " + have + " is too old for portless."
	}
	r.Commands = []string{"mise use -g node@" + v}
	for _, m := range f.NodeManagers {
		if cmds := installer.NodeManagerCommands(m); len(cmds) > 0 {
			r.Commands = nil
			for _, c := range cmds {
				r.Commands = append(r.Commands, strings.Join(c, " "))
			}
			break
		}
	}
	return r
}

func (f Facts) portless() Requirement {
	r := Requirement{Name: "portless", Why: "Gives every dev server a stable https://<name>.localhost URL, whatever port it lands on.", Version: f.Portless, Docs: "https://github.com/vercel-labs/portless", Origin: f.PortlessTool.Origin, Install: f.plan(installer.Portless)}
	switch {
	case f.Portless == "":
		r.Problem = "portless was not found."
		r.Commands = []string{"npm install -g portless"}
		r.Fix = "install-portless"
	case installer.CompareVersions(f.Portless, MinPortless) < 0:
		r.Status = "outdated"
		r.Problem = fmt.Sprintf("portless %s is older than %s, the oldest Portplane works with.", f.Portless, MinPortless)
		r.Commands = updateCommands(f.PortlessTool.Origin, "npm install -g portless@latest")
		r.Fix = "update-portless"
	default:
		r.OK = true
	}
	if r.Origin != nil && r.Origin.Label != "" {
		r.Detail = "Installed with " + r.Origin.Label
	}
	return r
}

func (f Facts) git() Requirement {
	r := Requirement{Name: "git", Why: "Lets setup find your projects and their worktrees.", OK: f.Git != "", Version: f.Git, Optional: true, Docs: "https://git-scm.com/downloads"}
	if !r.OK {
		r.Problem = "git was not found: setup still works, but worktrees are not recognised."
		switch f.GOOS {
		case "darwin":
			r.Commands = []string{"xcode-select --install"}
		case "windows":
			r.Commands = []string{"winget install --id Git.Git -e"}
		}
	}
	return r
}

func (f Facts) packages() Requirement {
	r := Requirement{Name: "Package managers", Why: "Your apps install and start with npm, pnpm, Yarn or Bun; setup tells you if one it needs is missing.", OK: true, Status: "info", Managers: f.Managers}
	var have, missing []string
	names := make([]string, 0, len(f.Managers))
	for k := range f.Managers {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		if f.Managers[k] != "" {
			have = append(have, k+" "+f.Managers[k])
		} else {
			missing = append(missing, k)
		}
	}
	switch {
	case len(have) == 0:
		r.Detail = "None found yet: " + strings.Join(missing, ", ") + "."
	case len(missing) > 0:
		r.Detail = strings.Join(have, " · ") + " (not found: " + strings.Join(missing, ", ") + ")"
	default:
		r.Detail = strings.Join(have, " · ")
	}
	return r
}

func (f Facts) port() Requirement {
	p := f.Port
	r := Requirement{Name: "Port 443", Why: "HTTPS addresses without a port number need the proxy on port 443.", Port: p}
	switch {
	case p == nil:
		r.Status = "info"
		r.OK = true
		r.Detail = "Not checked."
	case p.Free:
		r.OK, r.Detail = true, "Free for the proxy."
	case p.Portless:
		r.OK, r.Detail = true, "The portless proxy answers on it."
	case !p.Known:
		r.Status = "warning"
		r.Optional = true
		r.Problem = "Another program is using port 443 (Portplane cannot see which one)."
		r.Fix = "use-1355"
	default:
		r.Status = "warning"
		r.Optional = true
		name := p.Process
		if name == "" {
			name = "Another program"
		}
		r.Problem = fmt.Sprintf("%s (PID %d) is using port 443, so the proxy can't. Stop it, or use port 1355 instead.", name, p.PID)
		r.Fix = "use-1355"
	}
	return r
}

func (f Facts) proxy() Requirement {
	r := Requirement{Name: "portless proxy", Why: "Serves the .localhost URLs over HTTPS with a trusted local certificate, and starts with your computer.", OK: f.ProxyRunning, Privilege: true}
	manual := f.ServiceInstall
	if manual == "" {
		manual = "sudo portless service install"
		if f.GOOS == "windows" {
			manual = "portless service install   # in a terminal opened as Administrator"
		}
	}
	si := &ServiceInfo{Running: f.ProxyRunning, Port: f.ProxyPort, HTTPS: f.ProxyHTTPS, InstallCommand: manual}
	if s := f.Service; s != nil {
		si.Installed, si.Responding, si.NodePath, si.NodeMissing, si.State = s.Installed, s.Responding, s.NodePath, s.NodeMissing, s.ManagerState
		si.TLDs, si.LAN = s.TLDs, s.LAN
		if s.Port > 0 {
			si.Port, si.HTTPS = s.Port, s.HTTPS
		}
	}
	r.Service = si
	if f.Extended {
		r.Fix = "proxy"
	}
	switch {
	case si.NodeMissing:
		r.OK = false
		r.Status = "missing"
		r.Problem = "The proxy service starts with a Node.js that no longer exists (" + si.NodePath + "). Install the service again."
		r.Fix = "reinstall-service"
		r.Commands = []string{manual}
	case f.ProxyRunning && si.Port != 0 && si.Port != portless.DefaultPort:
		r.Detail = fmt.Sprintf("Running on port %d: addresses carry :%d.", si.Port, si.Port)
	case f.ProxyRunning && si.Installed:
		r.Detail = "Installed as a service: it starts with your computer."
	case f.ProxyRunning:
		r.Detail = "Running, but not as a service: it stops when you log out or restart."
	case si.Installed:
		r.Problem = "The proxy service is installed but isn't answering."
		r.Fix = "reinstall-service"
		r.Commands = []string{manual}
	case f.Portless == "" && f.Extended:
		r.Problem = "Needs portless first."
		r.Commands = []string{manual}
	default:
		r.Problem = "The proxy isn't set up yet."
		r.Commands = []string{manual}
	}
	return r
}

func (f Facts) ca() Requirement {
	r := Requirement{Name: "Local certificate", Why: "Browsers trust https://….localhost addresses once they trust portless's local certificate authority."}
	ca := f.CA
	if ca == nil || !ca.Exists {
		r.Status = "info"
		r.OK = true
		r.Detail = "Created when the proxy is set up."
		return r
	}
	r.Browsers = f.Browsers
	var notes []string
	if !ca.Trusted {
		r.Problem = "Your system doesn't trust the certificate yet."
		r.Fix = "trust-system"
		r.Privilege = f.GOOS == "linux"
		r.Commands = []string{"portless trust"}
		if f.GOOS == "linux" {
			r.Commands = []string{"sudo portless trust"}
		}
	}
	if b := f.Browsers; b != nil && b.NeedsAction() {
		var names []string
		for _, br := range b.Browsers {
			for _, p := range br.Profiles {
				if p.Status == browsertrust.Missing || p.Status == browsertrust.Outdated || p.Status == browsertrust.Unknown {
					names = append(names, br.Name)
					break
				}
			}
		}
		notes = append(notes, "Not trusted yet by "+strings.Join(names, ", ")+".")
		if r.Fix == "" {
			r.Fix = "trust-browsers"
		}
	}
	if ca.SystemCopyNotRoot && ca.SystemCopy != "" {
		notes = append(notes, "The trusted copy at "+ca.SystemCopy+" belongs to your user, so any program you run could replace it.")
		r.Commands = append(r.Commands, "sudo chown root:root "+ca.SystemCopy)
	}
	r.OK = r.Problem == "" && len(notes) == 0
	switch {
	case r.OK:
		r.Detail = "Trusted by your system and your browsers."
	case r.Problem == "":
		r.Status = "warning"
		r.Problem = strings.Join(notes, " ")
	case len(notes) > 0:
		r.Problem += " " + strings.Join(notes, " ")
	}
	return r
}

func (f Facts) tlds() []string {
	if f.Service != nil {
		return f.Service.TLDs
	}
	return nil
}

func (f Facts) hosts() Requirement {
	r := Requirement{Name: "/etc/hosts", Why: "Names under a top-level domain other than .localhost resolve through /etc/hosts.", Privilege: true}
	other := false
	for _, t := range f.tlds() {
		if t != "localhost" {
			other = true
		}
	}
	if !other || f.GOOS == "windows" {
		r.Status, r.OK, r.Detail = "skipped", true, ".localhost names need no /etc/hosts entries."
		return r
	}
	r.OK = f.HostsBlock
	if !r.OK {
		r.Problem = "/etc/hosts has no portless entries yet."
		r.Commands = []string{"sudo portless hosts sync"}
	}
	return r
}

func (f Facts) lan() Requirement {
	r := Requirement{Name: "LAN tools", Why: "LAN mode publishes your apps as .local names for phones and other computers."}
	if f.Service == nil || !f.Service.LAN {
		r.Status, r.OK, r.Detail = "skipped", true, "LAN mode is off."
		return r
	}
	r.OK = f.LANTool != "" || f.GOOS == "windows"
	if !r.OK {
		r.Problem = "LAN mode needs avahi-publish-address."
		r.Commands = []string{"sudo apt install avahi-utils"}
		if f.GOOS == "darwin" {
			r.Problem = "LAN mode needs dns-sd."
			r.Commands = nil
		}
	}
	return r
}

func (f Facts) path() Requirement {
	p := f.Path
	r := Requirement{Name: "~/.local/bin on PATH", Why: "Lets your terminal find dekit and portless. Portplane itself doesn't need it.", Optional: true, Path: p}
	if f.GOOS == "windows" {
		r.Name = `~\.local\bin on Path`
	}
	switch {
	case p == nil:
		r.Status, r.OK, r.Detail = "info", true, "Not checked."
	case p.OnPath:
		r.OK, r.Detail = true, "Your terminal finds the tools installed there."
	default:
		r.Status = "warning"
		r.Problem = "New terminals won't find the tools Portplane installs there."
		r.Fix = "path-profile"
		r.Commands = []string{p.Line}
	}
	return r
}

func (f Facts) tray() Requirement {
	r := Requirement{Name: "Tray icon", Why: "Shows Portplane in the top bar or tray, so you can reopen it and see your apps at a glance.", Optional: true}
	switch {
	case !f.TrayChecked || f.TrayVisible:
		r.Status, r.OK = "ok", true
	case f.GNOME:
		r.Status = "info"
		r.OK = true
		r.Problem = "GNOME shows tray icons only with the AppIndicator extension."
		r.Commands = []string{"https://extensions.gnome.org/extension/615/appindicator-support/"}
		r.Docs = "https://extensions.gnome.org/extension/615/appindicator-support/"
	default:
		r.Status = "info"
		r.OK = true
		r.Detail = "Your desktop shows no tray icons; the window stays reachable from your app launcher."
	}
	return r
}

func nodeMajor(v string) int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	major, _, _ := strings.Cut(v, ".")
	n, err := strconv.Atoi(major)
	if err != nil {
		return 0
	}
	return n
}
