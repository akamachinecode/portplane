package portless

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/akamachinecode/portplane/internal/dekit"
)

func TestShareFlags(t *testing.T) {
	cases := []struct {
		argv []string
		want []string
	}{
		{[]string{"portless", "web", "pnpm", "dev"}, nil},
		{[]string{"portless", "web", "--tailscale", "pnpm", "dev"}, []string{"tailscale"}},
		{[]string{"portless", "web", "--app-port", "3000", "--ngrok", "--cloudflare", "pnpm", "dev"}, []string{"ngrok", "cloudflare"}},
		{[]string{"portless", "run", "--funnel", "--name", "web", "next", "dev"}, []string{"funnel"}},
		{[]string{"npx", "portless", "run", "--tailscale", "--", "next", "dev"}, []string{"tailscale"}},
		// A flag of the wrapped command isn't portless's.
		{[]string{"portless", "web", "vite", "--tailscale"}, nil},
		{[]string{"cmd", "/c", "portless web --ngrok pnpm run dev"}, []string{"ngrok"}},
		{[]string{"portless", "alias", "db", "5432"}, nil},
		{[]string{"pnpm", "dev"}, nil},
	}
	for _, c := range cases {
		if got := ShareFlags(c.argv); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%v: got %v, want %v", c.argv, got, c.want)
		}
	}
}

func TestSetShareArgs(t *testing.T) {
	cases := []struct {
		argv []string
		kind string
		on   bool
		want string
	}{
		{[]string{"portless", "web", "pnpm", "dev"}, "tailscale", true, "portless web --tailscale pnpm dev"},
		{[]string{"portless", "web", "--app-port", "3000", "pnpm", "dev"}, "ngrok", true, "portless web --ngrok --app-port 3000 pnpm dev"},
		{[]string{"portless", "run", "--name", "web", "next", "dev"}, "cloudflare", true, "portless run --cloudflare --name web next dev"},
		// Tailscale and Funnel replace each other.
		{[]string{"portless", "web", "--tailscale", "pnpm", "dev"}, "funnel", true, "portless web --funnel pnpm dev"},
		{[]string{"portless", "web", "--funnel", "--ngrok", "pnpm", "dev"}, "tailscale", true, "portless web --tailscale --ngrok pnpm dev"},
		{[]string{"portless", "web", "--funnel", "--ngrok", "pnpm", "dev"}, "funnel", false, "portless web --ngrok pnpm dev"},
		{[]string{"portless", "web", "pnpm", "dev", "--ngrok"}, "ngrok", false, "portless web pnpm dev --ngrok"},
	}
	for _, c := range cases {
		got, err := SetShareArgs(c.argv, c.kind, c.on)
		if err != nil || strings.Join(got, " ") != c.want {
			t.Errorf("%v %s %v: got %q (%v), want %q", c.argv, c.kind, c.on, strings.Join(got, " "), err, c.want)
		}
	}
	if _, err := SetShareArgs([]string{"portless", "web", "x"}, "bluetooth", true); err == nil {
		t.Error("unknown kind")
	}
	if _, err := SetShareArgs([]string{"pnpm", "dev"}, "ngrok", true); err == nil {
		t.Error("not portless")
	}
}

func TestSetShareInCmd(t *testing.T) {
	src := `# dekit project
tasks:
  # the shop's storefront
  web:
    cwd: apps/web
    cmd: ["portless", "web", "pnpm", "run", "dev"] # keep this comment
    deps: [install]
  api:
    cmd:
      - portless
      - api
      - --tailscale
      - pnpm
      - start
  docs:
    cmd: portless run  --name docs   astro dev --host 127.0.0.1
  quoted:
    cmd: portless "q" pnpm dev
  script:
    cmd: !js "['portless', 'x', 'y']"
  win:
    cmd: [cmd, /c, "portless win pnpm run dev"]
`
	check := func(key string, argv []string, kind string, on bool, want string) {
		t.Helper()
		out, err := SetShareInCmd([]byte(src), key, argv, kind, on)
		if err != nil {
			t.Fatalf("%s: %v", key, err)
		}
		if !strings.Contains(string(out), want) {
			t.Fatalf("%s: %q not in\n%s", key, want, out)
		}
		// Only that task's lines change.
		if !strings.Contains(string(out), "# the shop's storefront\n") || !strings.HasPrefix(string(out), "# dekit project\ntasks:\n") {
			t.Fatalf("%s: comments lost\n%s", key, out)
		}
	}
	check("web", []string{"portless", "web", "pnpm", "run", "dev"}, "ngrok", true, `cmd: ["portless", "web", "--ngrok", "pnpm", "run", "dev"] # keep this comment`)
	check("api", []string{"portless", "api", "--tailscale", "pnpm", "start"}, "tailscale", false, "      - portless\n      - api\n      - pnpm\n")
	check("api", []string{"portless", "api", "--tailscale", "pnpm", "start"}, "funnel", true, "      - api\n      - --funnel\n      - pnpm\n")
	check("docs", []string{"portless", "run", "--name", "docs", "astro", "dev", "--host", "127.0.0.1"}, "cloudflare", true, "cmd: portless run --cloudflare --name docs astro dev --host 127.0.0.1")
	check("win", []string{"cmd", "/c", "portless win pnpm run dev"}, "tailscale", true, `"portless win --tailscale pnpm run dev"`)

	for _, key := range []string{"quoted", "script"} {
		argv := []string{"portless", "q", "pnpm", "dev"}
		if key == "script" {
			argv = []string{"portless", "x", "y"}
		}
		if _, err := SetShareInCmd([]byte(src), key, argv, "ngrok", true); !errors.Is(err, dekit.ErrNotEditable) {
			t.Errorf("%s: %v", key, err)
		}
	}
}

func TestShareEnvAndLabels(t *testing.T) {
	if got := ShareEnvKinds(map[string]string{"PORTLESS_NGROK": "1", "PORTLESS_FUNNEL": "true", "PORTLESS_TAILSCALE": "0"}); !reflect.DeepEqual(got, []string{"funnel", "ngrok"}) {
		t.Errorf("env: %v", got)
	}
	if SharePublic(ShareTailscale) || !SharePublic(ShareFunnel) || !SharePublic(ShareNgrok) || !SharePublic(ShareCloudflare) {
		t.Error("public")
	}
	for _, k := range ShareKinds {
		if ShareLabel(k) == k && k != ShareNgrok {
			t.Errorf("no label for %s", k)
		}
	}
}

func TestSharedRoutesFixture(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("testdata", "0.16", "routes-shared.json"))
	if err != nil {
		t.Fatal(err)
	}
	routes, err := ParseRoutes(b)
	if err != nil || len(routes) != 3 {
		t.Fatalf("%v %+v", err, routes)
	}
	web, api, docs := routes[0], routes[1], routes[2]
	if web.ShareURL(ShareTailscale) != "https://workstation.tail4c2a.ts.net" || web.ShareURL(ShareFunnel) != "" || web.TailscaleHTTPSPort != 443 {
		t.Errorf("web %+v", web)
	}
	if api.ShareURL(ShareFunnel) != "https://workstation.tail4c2a.ts.net:8443" || api.ShareURL(ShareTailscale) != "" || api.ShareURL(ShareCloudflare) == "" || api.CloudflarePID != 51300 {
		t.Errorf("api %+v", api)
	}
	if docs.ShareURL(ShareNgrok) != "https://3f2a-81-0-0-1.ngrok-free.app" || docs.NgrokPID != 51200 {
		t.Errorf("docs %+v", docs)
	}

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "routes.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	states, err := (&Client{StateDir: dir}).RouteStates()
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string][]string{}
	for _, s := range states {
		for _, sh := range s.Shared {
			kinds[s.Hostname] = append(kinds[s.Hostname], sh.Kind)
		}
	}
	want := map[string][]string{"web.localhost": {"tailscale"}, "api.localhost": {"funnel", "cloudflare"}, "docs.localhost": {"ngrok"}}
	if !reflect.DeepEqual(kinds, want) {
		t.Errorf("shares %v", kinds)
	}
}

func TestTailscaleStatus(t *testing.T) {
	read := func(name string) []byte {
		b, err := os.ReadFile(filepath.Join("testdata", "0.16", "tailscale", name))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	st, err := ParseTailscaleStatus(read("status-running.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !st.Running || st.DNSName != "workstation.tail4c2a.ts.net" || !st.HTTPS || st.Funnel || !st.MagicDNS || st.NodeID != "nAbCdEf1CNTRL" {
		t.Errorf("running %+v", st)
	}
	if st, _ := ParseTailscaleStatus(read("status-funnel.json")); !st.Funnel || !st.HTTPS {
		t.Errorf("funnel %+v", st)
	}
	if st, _ := ParseTailscaleStatus(read("status-nohttps.json")); st.HTTPS || !st.Running {
		t.Errorf("no https %+v", st)
	}
	if st, _ := ParseTailscaleStatus(read("status-loggedout.json")); st.Running || st.BackendState != "NeedsLogin" || st.DNSName != "" {
		t.Errorf("logged out %+v", st)
	}
	if _, err := ParseTailscaleStatus([]byte("not json")); err == nil {
		t.Error("garbage")
	}
	if op, ok := ParseTailscalePrefs(read("debug-prefs.json")); !ok || op != "dev" {
		t.Errorf("operator %q %v", op, ok)
	}
	if op, ok := ParseTailscalePrefs([]byte(`{"WantRunning":true}`)); !ok || op != "" {
		t.Errorf("no operator %q %v", op, ok)
	}

	fake := func(outputs map[string][]byte, errs map[string]error) ToolRunner {
		return func(_ context.Context, name string, args ...string) ([]byte, error) {
			k := name + " " + strings.Join(args, " ")
			return outputs[k], errs[k]
		}
	}
	if st := ReadTailscale(context.Background(), fake(nil, map[string]error{"tailscale status --json": ErrToolMissing}), "linux"); st.Installed {
		t.Errorf("missing %+v", st)
	}
	st = ReadTailscale(context.Background(), fake(map[string][]byte{"tailscale status --json": read("status-running.json"), "tailscale debug prefs": read("debug-prefs.json")}, nil), "linux")
	if !st.Running || !st.OperatorKnown || st.Operator != "dev" {
		t.Errorf("read %+v", st)
	}
	if st := ReadTailscale(context.Background(), fake(map[string][]byte{"tailscale status --json": read("status-running.json")}, nil), "darwin"); st.OperatorKnown {
		t.Errorf("operator matters only on Linux: %+v", st)
	}
	down := ReadTailscale(context.Background(), fake(nil, map[string]error{"tailscale status --json": errors.New("tailscale status --json: failed to connect to local tailscaled; it doesn't appear to be running (sudo systemctl start tailscaled ?)")}), "linux")
	if !down.Installed || !down.DaemonDown || down.Running {
		t.Errorf("daemon down %+v", down)
	}
	if TailscaleFunnelPage("n1") != "https://login.tailscale.com/f/funnel?node=n1" || strings.Join(TailscaleOperatorArgs("dev"), " ") != "set --operator=dev" {
		t.Error("tailscale helpers")
	}
}

func TestNgrok(t *testing.T) {
	read := func(name string) []byte {
		b, err := os.ReadFile(filepath.Join("testdata", "0.16", "ngrok", name))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	if !HasNgrokAuthtoken(read("ngrok-v3.yml")) || !HasNgrokAuthtoken(read("ngrok-v2.yml")) || HasNgrokAuthtoken(read("ngrok-empty.yml")) || HasNgrokAuthtoken([]byte(":bad")) {
		t.Error("authtoken detection")
	}
	home := t.TempDir()
	env := map[string]string{}
	getenv := func(k string) string { return env[k] }
	lookup := func(string) string { return "/usr/local/bin/ngrok" }
	if st := ReadNgrok(lookup, "linux", home, getenv); !st.Installed || st.Authtoken {
		t.Errorf("no config %+v", st)
	}
	cfg := filepath.Join(home, ".config", "ngrok", "ngrok.yml")
	if err := os.MkdirAll(filepath.Dir(cfg), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg, read("ngrok-v3.yml"), 0o600); err != nil {
		t.Fatal(err)
	}
	if st := ReadNgrok(lookup, "linux", home, getenv); !st.Authtoken || st.ConfigPath != cfg {
		t.Errorf("v3 %+v", st)
	}
	env["NGROK_AUTHTOKEN"] = "x"
	if st := ReadNgrok(func(string) string { return "" }, "darwin", home, getenv); st.Installed || !st.Authtoken || !st.FromEnv {
		t.Errorf("env %+v", st)
	}
	paths := NgrokConfigPaths("windows", `C:\Users\dev`, func(k string) string {
		if k == "LOCALAPPDATA" {
			return `C:\Users\dev\AppData\Local`
		}
		return ""
	})
	if len(paths) != 2 || !strings.Contains(paths[0], "ngrok") {
		t.Errorf("windows paths %v", paths)
	}
	if !ValidNgrokToken("2abcDEFghiJKLmnoPQRstuVWX_0123456789abcdefGHIJ") || ValidNgrokToken("short") || ValidNgrokToken("has space in it 0123456789") {
		t.Error("token check")
	}
	if strings.Join(NgrokAuthtokenArgs("T"), " ") != "config add-authtoken T" {
		t.Error("args")
	}
	for _, tool := range []string{"tailscale", "ngrok", "cloudflared", "docker"} {
		for _, goos := range []string{"linux", "darwin", "windows"} {
			if h := ToolInstallHint(tool, goos); !strings.HasPrefix(h.Page, "https://") {
				t.Errorf("%s on %s: %+v", tool, goos, h)
			}
		}
	}
}
