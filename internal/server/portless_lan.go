package server

import (
	"context"
	"net/http"
	"strings"

	"github.com/akamachinecode/portplane/internal/portless"
)

// LAN mode (plan §5.1, §5.6, M5.6): what it needs on this computer, the
// addresses phones would use, and every app's .local address. Turning it on
// or off changes the proxy's options (--lan, --ip) through the existing
// proxy actions, which reinstall the service with the password; the page
// only reads here.

// LANApp is one app's address on the network.
type LANApp struct {
	Hostname string `json:"hostname"` // name.local
	URL      string `json:"url"`
	// Route is the address the app registered; it differs from Hostname
	// until the app restarts after LAN mode was turned on.
	Route   string `json:"route"`
	Label   string `json:"label"`
	Kind    string `json:"kind"` // app, alias, compose
	Machine string `json:"machine,omitempty"`
	AppID   string `json:"appId,omitempty"`
}

// LANView is GET /api/portless/lan.
type LANView struct {
	OS           string        `json:"os"`
	MDNS         portless.MDNS `json:"mdns"`
	Requirements []Requirement `json:"requirements"`
	// Ready: nothing is missing to turn it on.
	Ready bool `json:"ready"`
	// Enabled: the proxy runs in LAN mode now; IP is the address it
	// publishes (pinned or followed).
	Enabled    bool   `json:"enabled"`
	Responding bool   `json:"responding"`
	IP         string `json:"ip,omitempty"`
	// Addresses this computer has that phones could reach; the default
	// one is what portless follows when no address is pinned.
	Addresses []portless.LANAddress `json:"addresses"`
	Apps      []LANApp              `json:"apps"`
	// Options are the proxy's options now; turning LAN mode on or off
	// starts from them.
	Options          portless.ProxyOptions `json:"options"`
	ServiceInstalled bool                  `json:"serviceInstalled"`
	Port             int                   `json:"port"`
	HTTPS            bool                  `json:"https"`
	CA               portless.CA           `json:"ca"`
}

func (p *portlessAPI) lanRequirements(ctx context.Context, m portless.MDNS, addrs []portless.LANAddress) []Requirement {
	if !m.Supported {
		return []Requirement{{ID: "lan-os", Label: "This system can publish .local names",
			Problem: "portless can't publish .local names on this system (it supports macOS and Linux), so LAN mode doesn't start here.",
			Fix:     "Share the app on your tailnet instead, or use LAN mode from a Mac or a Linux computer."}}
	}
	tool := Requirement{ID: "mdns-tool", OK: m.Installed, Label: m.Tool + " is installed"}
	if !m.Installed {
		if m.Tool == "dns-sd" {
			tool.Problem = "dns-sd, which macOS includes, isn't on the PATH Portplane sees."
			tool.Fix = "Check that /usr/bin is on your PATH."
		} else {
			tool.Problem = "portless publishes .local names with avahi-publish-address, from the " + m.Package + " package, which isn't installed."
			tool.Fix = "Install it, then check again."
			tool.Command = m.Install
		}
	}
	reqs := []Requirement{tool}
	if m.Tool == "avahi-publish-address" && p.lookup("systemctl") != "" {
		out, _ := p.d.Tool(ctx, "systemctl", "is-active", "avahi-daemon")
		state := strings.TrimSpace(string(out))
		if state != "" && state != "active" && state != "activating" {
			reqs = append(reqs, Requirement{ID: "avahi-daemon", Label: "The Avahi service is running",
				Problem: "The Avahi service isn't running (" + state + "), so nothing answers when a phone looks up a .local name.",
				Fix:     "Start it, and have it start with the computer.", Command: "sudo systemctl enable --now avahi-daemon"})
		} else if state != "" {
			reqs = append(reqs, Requirement{ID: "avahi-daemon", OK: true, Label: "The Avahi service is running"})
		}
	}
	network := Requirement{ID: "lan-address", OK: len(addrs) > 0, Label: "This machine is on a network"}
	if !network.OK {
		network.Problem = "This machine has no address a phone could reach: it isn't on Wi-Fi or Ethernet."
		network.Fix = "Connect to the same Wi-Fi as your phone, then check again."
	}
	return append(reqs, network)
}

func (p *portlessAPI) lan(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	ctx := r.Context()
	c := p.d.Client
	f := p.facts(ctx)
	m := portless.CheckMDNS(p.d.GOOS, p.lookup, p.d.OSRelease())
	ifaces, def := p.d.Network()
	addrs := portless.LANCandidates(ifaces, def)
	if addrs == nil {
		addrs = []portless.LANAddress{}
	}
	v := LANView{
		OS: p.d.GOOS, MDNS: m, Addresses: addrs, Apps: []LANApp{},
		Enabled: f.state.LAN, Responding: f.state.Responding, IP: f.state.LANIP,
		Options: f.options, ServiceInstalled: f.serviceInstalled(),
		Port: f.state.Port, HTTPS: f.state.HTTPS, CA: c.CA(),
	}
	if f.options.LANIP != "" {
		v.IP = f.options.LANIP
	}
	v.Requirements = p.lanRequirements(ctx, m, addrs)
	v.Ready = len(missing(v.Requirements)) == 0
	views, err := p.routeViews(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	proxy := portless.Proxy{Port: f.state.Port, HTTPS: f.state.HTTPS}
	seen := map[string]bool{}
	for _, rv := range views {
		// Portplane's own address answers this computer only (ADR-0008).
		if !rv.Alive || rv.Kind == "remote" || (rv.Owner != nil && rv.Owner.Kind == "portplane") {
			continue
		}
		host := portless.LANHostname(rv.Hostname, f.state.TLDs)
		if host == "" || seen[host] {
			continue
		}
		seen[host] = true
		a := LANApp{Hostname: host, URL: proxy.URL(host), Route: rv.Hostname, Kind: rv.Kind, Label: rv.Hostname}
		if rv.Owner != nil {
			a.Label = rv.Owner.Label
			if rv.Owner.Kind == "app" {
				a.Machine, a.AppID = rv.Owner.Machine, rv.Owner.AppID
			}
		}
		v.Apps = append(v.Apps, a)
	}
	writeJSON(w, http.StatusOK, v)
}
