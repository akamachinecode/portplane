package setup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/akamachinecode/portplane/internal/browsertrust"
	"github.com/akamachinecode/portplane/internal/installer"
	"github.com/akamachinecode/portplane/internal/osinfo"
	"github.com/akamachinecode/portplane/internal/portless"
)

func byID(c Check) map[string]Requirement {
	m := map[string]Requirement{}
	for _, r := range c.Requirements {
		m[r.ID] = r
	}
	return m
}

// fresh is a machine with nothing installed.
func fresh(goos string) Facts {
	return Facts{
		GOOS: goos, Extended: true,
		Managers: map[string]string{"npm": "", "pnpm": "", "yarn": "", "bun": ""},
		Port:     &PortInfo{Port: 443, Free: true},
		CA:       &portless.CA{},
		Path:     &installer.PathStatus{Dir: "/home/dev/.local/bin", OnPath: false, Line: `export PATH="$HOME/.local/bin:$PATH"`},
	}
}

func TestEvaluateFreshMachine(t *testing.T) {
	for _, goos := range []string{"linux", "darwin", "windows"} {
		c := Evaluate(fresh(goos))
		r := byID(c)
		if c.Ready {
			t.Fatalf("%s: nothing installed is not ready", goos)
		}
		if len(c.Requirements) != len(CheckIDs) {
			t.Errorf("%s: every check is listed: %d", goos, len(c.Requirements))
		}
		for id, fix := range map[string]string{"dekit": "install-dekit", "node": "install-node", "portless": "install-portless", "proxy": "proxy", "path": "path-profile"} {
			if r[id].Fix != fix || r[id].OK {
				t.Errorf("%s %s: %+v", goos, id, r[id])
			}
		}
		if r["dekit"].Status != "missing" || r["path"].Status != "warning" || r["git"].Status != "warning" {
			t.Errorf("%s: statuses %s %s %s", goos, r["dekit"].Status, r["path"].Status, r["git"].Status)
		}
		if r["hosts"].Status != "skipped" || r["lan"].Status != "skipped" {
			t.Errorf("%s: hosts and LAN only apply when used", goos)
		}
		if !r["port"].OK || r["ca"].Status != "info" {
			t.Errorf("%s: port %+v ca %+v", goos, r["port"], r["ca"])
		}
		if r["proxy"].Problem != "Needs portless first." || !r["proxy"].Privilege {
			t.Errorf("%s: proxy %+v", goos, r["proxy"])
		}
	}
	win := byID(Evaluate(fresh("windows")))
	if win["dekit"].Commands[0] != "irm https://dekit.run/install.ps1 | iex" || win["git"].Commands[0] != "winget install --id Git.Git -e" || win["path"].Name != `~\.local\bin on Path` {
		t.Errorf("windows texts: %+v", win)
	}
	mac := byID(Evaluate(fresh("darwin")))
	if mac["dekit"].Commands[0] != "curl -fsSL https://dekit.run/install.sh | sh" || mac["git"].Commands[0] != "xcode-select --install" {
		t.Errorf("mac texts: %+v", mac)
	}
}

func TestEvaluateOldNodeOffersManager(t *testing.T) {
	f := fresh("linux")
	f.NodeInfo = installer.NodeInfo{UserVersion: "v20.11.0", UserPath: "/usr/bin/node"}
	f.Node = "v20.11.0"
	f.NodeManagers = []string{"fnm"}
	r := byID(Evaluate(f))["node"]
	if r.Status != "outdated" || r.Version != "v20.11.0" || !strings.Contains(r.Problem, "v20.11.0") || strings.Join(r.Commands, "; ") != "fnm install 24; fnm default 24" {
		t.Errorf("old node: %+v", r)
	}
	// With Portplane's own Node, the user's old one stays and it's fine.
	f.NodeInfo = installer.NodeInfo{Path: "/home/dev/.local/share/portplane/node/v24.1.0/bin/node", Version: "v24.1.0", Private: true, UserVersion: "v20.11.0"}
	f.Node = "v24.1.0"
	r = byID(Evaluate(f))["node"]
	if !r.OK || !strings.Contains(r.Detail, "Portplane's own copy") || !strings.Contains(r.Detail, "v20.11.0") {
		t.Errorf("private node: %+v", r)
	}
}

func TestEvaluateReadyMachine(t *testing.T) {
	f := fresh("linux")
	f.Dekit, f.Portless, f.Node = "0.10.3", "0.16.0", "v24.1.0"
	f.DekitTool.Origin = &installer.Origin{Kind: "script", Label: "dekit's install script", Update: []string{"dekit", "update"}}
	f.Git = "2.47.0"
	f.Managers["pnpm"] = "10.2.0"
	f.ProxyRunning, f.ProxyPort, f.ProxyHTTPS = true, 443, true
	f.Service = &portless.ServiceStatus{Installed: true, Responding: true, Port: 443, HTTPS: true, TLDs: []string{"localhost"}}
	f.Port = &PortInfo{Port: 443, Portless: true, PID: 812, Known: true}
	f.CA = &portless.CA{Exists: true, Trusted: true}
	f.Browsers = &browsertrust.Report{CAExists: true, SystemTrusted: true, Browsers: []browsertrust.Browser{{ID: "firefox", Name: "Firefox", Profiles: []browsertrust.Profile{{Status: browsertrust.System}}}}}
	f.Path.OnPath = true
	f.PortplaneOnPATH = true
	c := Evaluate(f)
	if !c.Ready {
		t.Fatal("ready")
	}
	for _, r := range c.Requirements {
		if !r.OK {
			t.Errorf("%s: %+v", r.ID, r)
		}
	}
	r := byID(c)
	if r["dekit"].Detail != "Installed with dekit's install script" || r["proxy"].Detail != "Installed as a service: it starts with your computer." || r["packages"].Detail != "pnpm 10.2.0 (not found: bun, npm, yarn)" {
		t.Errorf("details: %q %q %q", r["dekit"].Detail, r["proxy"].Detail, r["packages"].Detail)
	}
}

func TestEvaluateProblems(t *testing.T) {
	f := fresh("linux")
	f.Dekit, f.Portless = "0.9.1", "0.15.2"
	f.DekitTool.Origin = &installer.Origin{Kind: "homebrew", Update: []string{"brew", "upgrade", "dekit"}}
	f.Port = &PortInfo{Port: 443, PID: 1201, Process: "nginx", Known: true}
	f.Service = &portless.ServiceStatus{Installed: true, NodePath: "/opt/brew/Cellar/node/26.1.0/bin/node", NodeMissing: true, TLDs: []string{"test"}, LAN: true}
	f.ServiceInstall = "sudo env HOME=/home/dev /home/dev/.local/bin/portless service install --port 443 --https"
	f.CA = &portless.CA{Exists: true, SystemCopy: "/etc/pki/ca-trust/source/anchors/portless-ca.crt", SystemCopyNotRoot: true, Trusted: true}
	f.Browsers = &browsertrust.Report{CAExists: true, Browsers: []browsertrust.Browser{{ID: "firefox", Name: "Firefox (Snap)", Profiles: []browsertrust.Profile{{Status: browsertrust.Missing}}}}}
	r := byID(Evaluate(f))
	if r["dekit"].Status != "outdated" || r["dekit"].Commands[0] != "brew upgrade dekit" || r["dekit"].Fix != "update-dekit" {
		t.Errorf("old dekit: %+v", r["dekit"])
	}
	if r["portless"].Status != "outdated" || r["portless"].Commands[0] != "npm install -g portless@latest" {
		t.Errorf("old portless: %+v", r["portless"])
	}
	if r["port"].Status != "warning" || r["port"].Fix != "use-1355" || !strings.Contains(r["port"].Problem, "nginx (PID 1201)") {
		t.Errorf("port: %+v", r["port"])
	}
	if r["proxy"].Fix != "reinstall-service" || !strings.Contains(r["proxy"].Problem, "/opt/brew/Cellar/node/26.1.0/bin/node") || r["proxy"].Commands[0] != f.ServiceInstall {
		t.Errorf("service with a missing Node: %+v", r["proxy"])
	}
	if r["ca"].Status != "warning" || r["ca"].Fix != "trust-browsers" || !strings.Contains(r["ca"].Problem, "Firefox (Snap)") || !strings.Contains(strings.Join(r["ca"].Commands, " "), "sudo chown root:root") {
		t.Errorf("ca: %+v", r["ca"])
	}
	if r["hosts"].Status != "missing" || r["hosts"].Commands[0] != "sudo portless hosts sync" {
		t.Errorf("hosts with .test: %+v", r["hosts"])
	}
	if r["lan"].Status != "missing" {
		t.Errorf("lan without avahi: %+v", r["lan"])
	}

	f.CA = &portless.CA{Exists: true}
	f.Browsers = nil
	ca := byID(Evaluate(f))["ca"]
	if ca.Fix != "trust-system" || ca.Commands[0] != "sudo portless trust" || !ca.Privilege {
		t.Errorf("untrusted on linux: %+v", ca)
	}
	f.GOOS = "darwin"
	ca = byID(Evaluate(f))["ca"]
	if ca.Commands[0] != "portless trust" || ca.Privilege {
		t.Errorf("untrusted on mac (the keychain asks on its own): %+v", ca)
	}
}

func TestEvaluateOnly(t *testing.T) {
	f := fresh("linux")
	f.Only = []string{"port", "git"}
	c := Evaluate(f)
	if len(c.Requirements) != 2 || c.Requirements[0].ID != "git" || c.Requirements[1].ID != "port" {
		t.Errorf("only: %+v", c.Requirements)
	}
}

func TestEvaluateTray(t *testing.T) {
	f := fresh("linux")
	f.TrayChecked, f.TrayVisible, f.GNOME = true, false, true
	r := byID(Evaluate(f))["tray"]
	if !strings.Contains(r.Problem, "AppIndicator") || r.Docs == "" {
		t.Errorf("gnome: %+v", r)
	}
}

func TestSuggestFolders(t *testing.T) {
	home := t.TempDir()
	for _, d := range []string{"code/shop/.git", "code/blog/.git", "code/group/api/.git", "code/notes", "src", "projects/.git", "Repos/node_modules/x/.git"} {
		if err := os.MkdirAll(filepath.Join(home, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	got := SuggestFolders(home)
	want := map[string]int{"code": 3, "projects": 1}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for _, s := range got {
		if want[filepath.Base(s.Path)] != s.Repos {
			t.Errorf("%s: %d", s.Path, s.Repos)
		}
	}
}

func TestUnsupportedProjects(t *testing.T) {
	folder := t.TempDir()
	write := func(p, s string) {
		_ = os.MkdirAll(filepath.Dir(filepath.Join(folder, p)), 0o755)
		if err := os.WriteFile(filepath.Join(folder, p), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("django-site/.git/HEAD", "ref: refs/heads/main\n")
	write("django-site/manage.py", "")
	write("django-site/docker-compose.yml", "")
	write("web/package.json", `{"name":"web","scripts":{"dev":"vite"}}`)
	write("web/.git/HEAD", "ref: refs/heads/main\n")
	p, err := Propose(context.Background(), folder, Overrides{}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Unsupported) != 1 || p.Unsupported[0].Dir != "django-site" || strings.Join(p.Unsupported[0].Kinds, ",") != "Docker Compose,Python" {
		t.Errorf("unsupported: %+v", p.Unsupported)
	}
}

type fakeOS struct{ ls []osinfo.Listener }

func (f fakeOS) Listeners(context.Context) ([]osinfo.Listener, error) { return f.ls, nil }
func (f fakeOS) Proc(_ context.Context, pid int) (osinfo.Proc, bool) {
	return osinfo.Proc{PID: pid, Cmdline: []string{"/usr/sbin/nginx", "-g", "daemon off;"}}, true
}
func (f fakeOS) Cwd(context.Context, int) string { return "" }

func TestSystemPort(t *testing.T) {
	s := &System{OS: fakeOS{ls: []osinfo.Listener{{Port: 80, PID: 1}, {Port: 443, PID: 1201, Address: "0.0.0.0"}}}, AnswersAsPortless: func(context.Context, int) bool { return false }}
	pi := s.port(context.Background())
	if pi.Free || pi.PID != 1201 || pi.Process != "nginx" || pi.Portless {
		t.Errorf("nginx on 443: %+v", pi)
	}
	s.OS = fakeOS{}
	if pi := s.port(context.Background()); !pi.Free {
		t.Errorf("free: %+v", pi)
	}
	s.OS = fakeOS{ls: []osinfo.Listener{{Port: 443}}}
	s.AnswersAsPortless = func(context.Context, int) bool { return true }
	if pi := s.port(context.Background()); pi.Free || pi.Known || !pi.Portless {
		t.Errorf("portless as root (owner hidden): %+v", pi)
	}
}
