package setup

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/akamachinecode/portplane/internal/browsertrust"
	"github.com/akamachinecode/portplane/internal/installer"
	"github.com/akamachinecode/portplane/internal/osinfo"
	"github.com/akamachinecode/portplane/internal/portless"
	"github.com/akamachinecode/portplane/internal/privileged"
)

// System gathers the facts of the extended check (plan §3.2 step 2) from
// this machine, the checks that are asked for, in parallel.
type System struct {
	GOOS      string
	Installer *installer.Installer
	Portless  *portless.Client
	// Version runs `<tool> --version` and returns the version.
	Version func(ctx context.Context, path string) string
	// Browsers reports the browsers' trust in the CA.
	Browsers func(ctx context.Context, ca portless.CA) browsertrust.Report
	// Listeners and Proc read the OS (osinfo.System).
	OS osinfo.Source
	// AnswersAsPortless reports whether the proxy on port answers like
	// portless (X-Portless: 1).
	AnswersAsPortless func(ctx context.Context, port int) bool
	// Tray says whether a tray icon can be seen (tray.Visible).
	Tray      func() bool
	HostsFile string
}

// Gather reads the facts for the checks in only (all when empty).
func (s *System) Gather(ctx context.Context, only []string) Facts {
	f := Facts{GOOS: s.GOOS, Extended: true, Only: only, Admin: privileged.Method(), Plans: map[string]installer.Plan{}}
	want := func(ids ...string) bool {
		for _, id := range ids {
			if f.wants(id) {
				return true
			}
		}
		return false
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	do := func(fn func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			fn()
		}()
	}
	set := func(fn func(*Facts)) {
		mu.Lock()
		fn(&f)
		mu.Unlock()
	}
	in := s.Installer
	oenv := in.OriginEnv()

	// Each tool is probed only for the checks that read it, so the UI can
	// ask for checks one by one without running every probe each time.
	// Ready is meaningful when dekit, node and portless were all asked for.
	if want("dekit") {
		do(func() {
			p := in.Lookup(installer.Dekit)
			t := Tool{Path: p}
			if p != "" {
				t.Version = s.Version(ctx, p)
				o := installer.DetectOrigin(installer.Dekit, p, oenv)
				t.Origin = &o
			}
			plan := in.DekitPlan()
			set(func(f *Facts) { f.DekitTool, f.Dekit, f.Plans[installer.Dekit] = t, t.Version, plan })
		})
	}
	if want("node", "portless") {
		do(func() {
			n := in.FindNode(ctx)
			var o *installer.Origin
			if n.Path != "" {
				x := installer.DetectOrigin(installer.Node, n.Path, oenv)
				o = &x
			} else if n.UserPath != "" {
				x := installer.DetectOrigin(installer.Node, n.UserPath, oenv)
				o = &x
			}
			plan := in.NodePlan()
			managers := in.NodeManagers()
			var portlessPlan installer.Plan
			if want("portless") {
				portlessPlan = in.PortlessPlan(ctx, n)
			}
			set(func(f *Facts) {
				f.NodeInfo, f.Node, f.NodeOrigin, f.NodeManagers, f.Plans[installer.Node] = n, n.Version, o, managers, plan
				if f.Node == "" {
					f.Node = n.UserVersion
				}
				if portlessPlan.Tool != "" {
					f.Plans[installer.Portless] = portlessPlan
				}
			})
		})
	}
	if want("portless", "proxy", "ca") {
		do(func() {
			p := s.Portless.Path()
			t := Tool{Path: p}
			if p != "" {
				t.Version = s.Version(ctx, p)
				o := installer.DetectOrigin(installer.Portless, p, oenv)
				t.Origin = &o
			}
			set(func(f *Facts) { f.PortlessTool, f.Portless = t, t.Version })
		})
	}
	if want("git") {
		do(func() {
			v := ""
			if p := in.Lookup("git"); p != "" {
				v = installer.CleanVersion(s.Version(ctx, p))
			}
			set(func(f *Facts) { f.Git = v })
		})
	}
	if want("packages") {
		do(func() {
			m := map[string]string{}
			for _, pm := range []string{"npm", "pnpm", "yarn", "bun"} {
				m[pm] = ""
				if p := in.Lookup(pm); p != "" {
					m[pm] = installer.CleanVersion(s.Version(ctx, p))
				}
			}
			set(func(f *Facts) { f.Managers = m })
		})
	}
	if want("port", "proxy", "hosts", "lan") {
		do(func() {
			pi := s.port(ctx)
			px := s.Portless.Proxy()
			running := px.Running || (px.Port == portless.DefaultPort && pi != nil && pi.Portless)
			if !running && px.Port > 0 && s.AnswersAsPortless != nil {
				running = s.AnswersAsPortless(ctx, px.Port)
			}
			var st *portless.ServiceStatus
			if s.Portless.Available() {
				if ss, err := s.Portless.ServiceStatus(ctx); err == nil {
					st = &ss
				}
			}
			manual := ""
			if cmd, err := s.Portless.ServiceInstallCommand(portless.DefaultProxyOptions()); err == nil {
				manual = privileged.Terminal(cmd, s.GOOS)
			}
			hosts := false
			if b, err := os.ReadFile(s.HostsFile); err == nil {
				hosts = strings.Contains(string(b), "# portless-start")
			}
			lanTool := ""
			for _, t := range []string{"avahi-publish-address", "dns-sd"} {
				if p := in.Lookup(t); p != "" {
					lanTool = p
				}
			}
			set(func(f *Facts) {
				f.Port, f.ProxyRunning, f.ProxyPort, f.ProxyHTTPS, f.Service, f.ServiceInstall, f.HostsBlock, f.LANTool = pi, running, px.Port, px.HTTPS, st, manual, hosts, lanTool
			})
		})
	}
	if want("ca") {
		do(func() {
			ca := s.Portless.CA()
			var br *browsertrust.Report
			if s.Browsers != nil {
				r := s.Browsers(ctx, ca)
				br = &r
			}
			set(func(f *Facts) { f.CA, f.Browsers = &ca, br })
		})
	}
	if want("path") {
		do(func() {
			ps := in.PathStatus(ctx)
			set(func(f *Facts) { f.Path = &ps })
		})
	}
	if want("tray") && s.Tray != nil {
		do(func() {
			v := s.Tray()
			gnome := strings.Contains(strings.ToUpper(os.Getenv("XDG_CURRENT_DESKTOP")), "GNOME")
			set(func(f *Facts) { f.TrayChecked, f.TrayVisible, f.GNOME = true, v, gnome })
		})
	}
	if want("portplane") {
		do(func() {
			_, err := exec.LookPath("portplane")
			set(func(f *Facts) { f.PortplaneOnPATH = err == nil })
		})
	}
	wg.Wait()
	return f
}

// port reports who listens on port 443: nobody, the portless proxy, or
// another process (with its PID and name when they can be read).
func (s *System) port(ctx context.Context) *PortInfo {
	port := portless.DefaultPort
	if s.OS == nil {
		return nil
	}
	ls, err := s.OS.Listeners(ctx)
	if err != nil {
		return nil
	}
	pi := &PortInfo{Port: port, Free: true}
	for _, l := range ls {
		if l.Port != port {
			continue
		}
		pi.Free = false
		if l.PID > 0 {
			pi.PID, pi.Known = l.PID, true
			if p, ok := s.OS.Proc(ctx, l.PID); ok {
				pi.Process = osinfo.DisplayName(p.Cmdline)
			}
		}
		break
	}
	if !pi.Free && s.AnswersAsPortless != nil {
		pi.Portless = s.AnswersAsPortless(ctx, port)
	}
	return pi
}

// AnswersAsPortless asks the server on a loopback port for any page and
// reports whether portless answered (it sets X-Portless: 1). It reads one
// header from this computer; certificate checks do not matter for that.
func AnswersAsPortless(ctx context.Context, port int) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	tr := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true, ServerName: "localhost"}, //nolint:gosec // loopback, header only
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, addr)
		},
		DisableKeepAlives: true,
	}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for _, scheme := range []string{"https", "http"} {
		req, err := http.NewRequestWithContext(ctx, http.MethodHead, scheme+"://localhost/", nil)
		if err != nil {
			return false
		}
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		_ = resp.Body.Close()
		return resp.Header.Get("X-Portless") == "1"
	}
	return false
}

// VersionOf runs `<path> --version` with a timeout.
func VersionOf(ctx context.Context, path string) string {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	cmd.Env = append(os.Environ(), "NO_COLOR=1")
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	line, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	return installer.CleanVersion(line)
}
