package portless

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestParseCommand(t *testing.T) {
	cases := []struct {
		argv []string
		want *Wrapped
	}{
		{[]string{"portless", "web.shop", "pnpm", "run", "dev"}, &Wrapped{Name: "web.shop", Inner: []string{"pnpm", "run", "dev"}}},
		{[]string{"portless", "run", "--name", "subs", "--app-port", "5173", "pnpm", "dev"}, &Wrapped{Name: "subs", Run: true, AppPort: "5173", Inner: []string{"pnpm", "dev"}}},
		{[]string{"portless", "run", "next", "dev"}, &Wrapped{Run: true, Inner: []string{"next", "dev"}}},
		{[]string{"/usr/local/bin/portless", "api", "--tailscale", "node", "s.js"}, &Wrapped{Name: "api", Inner: []string{"node", "s.js"}}},
		{[]string{"npx", "portless", "docs", "pnpm", "run", "dev"}, &Wrapped{Name: "docs", Inner: []string{"pnpm", "run", "dev"}}},
		{[]string{"cmd", "/c", "portless web pnpm run dev"}, &Wrapped{Name: "web", Inner: []string{"pnpm", "run", "dev"}}},
		{[]string{"portless", "alias", "legacy", "8080"}, nil},
		{[]string{"pnpm", "run", "dev"}, nil},
		{[]string{"portless"}, nil},
	}
	for _, c := range cases {
		got := ParseCommand(c.argv)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("ParseCommand(%q) = %+v, want %+v", c.argv, got, c.want)
		}
	}
}

func TestHostname(t *testing.T) {
	named := &Wrapped{Name: "web.shop"}
	if got := named.Hostname("feature-x", ""); got != "web.shop.localhost" {
		t.Errorf("named mode ignores worktrees: %q", got)
	}
	run := &Wrapped{Name: "shop", Run: true}
	if got := run.Hostname("feature-x", "localhost"); got != "feature-x.shop.localhost" {
		t.Errorf("run mode adds the worktree: %q", got)
	}
	if got := run.Hostname("", ""); got != "shop.localhost" {
		t.Errorf("main checkout: %q", got)
	}
	if got := (&Wrapped{Run: true}).Hostname("", ""); got != "" {
		t.Errorf("inferred names are unknown: %q", got)
	}
}

func TestRoutesAndProxy(t *testing.T) {
	dir := t.TempDir()
	c := &Client{StateDir: dir}
	if c.Routes() != nil {
		t.Fatal("no file means no routes")
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("routes.json", `[{"hostname":"web.localhost","port":4514,"pid":123,"registeredAt":1,"childPgid":5,"future":"field"},{"hostname":"legacy.localhost","port":8080,"pid":0},{"hostname":"","port":1}]`)
	routes := c.Routes()
	if len(routes) != 2 || routes[0].Port != 4514 || routes[0].Static() || !routes[1].Static() {
		t.Fatalf("routes %+v", routes)
	}
	write("routes.json", `{not json`)
	if c.Routes() != nil {
		t.Fatal("a broken file means no routes, not a crash")
	}

	write("proxy.port", "443\n")
	write("proxy.tls", "1")
	p := c.Proxy()
	if p.Port != 443 || !p.HTTPS || p.URL("web.localhost") != "https://web.localhost" {
		t.Fatalf("proxy %+v url %q", p, p.URL("web.localhost"))
	}
	write("proxy.port", "1355")
	write("proxy.tls", "0")
	if got := c.Proxy().URL("web.localhost"); got != "http://web.localhost:1355" {
		t.Fatalf("url %q", got)
	}
}
