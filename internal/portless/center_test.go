package portless

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/akamachinecode/portplane/internal/dekit"
)

// Tests for the portless center (M5.2): every parser runs against the
// fixtures recorded from portless 0.16 in testdata/0.16.

func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "0.16", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestParseDoctorHealthy(t *testing.T) {
	d := ParseDoctor(fixture(t, "doctor-healthy.txt"))
	if !d.Parsed || len(d.Findings) != 8 || d.Failures != 0 || d.Warnings != 0 || len(d.Unparsed) != 0 {
		t.Fatalf("%+v", d)
	}
	if d.Version != "0.16.0" || d.Node != "24.11.1" || d.Platform != "linux x64" || d.StateDir != "/home/dev/.portless" || d.Mode != "HTTPS, .localhost" || d.ProxyTarget != "https://127.0.0.1" {
		t.Fatalf("header: %+v", d)
	}
	wantChecks := []string{"node", "state", "proxy", "pid", "openssl", "ca", "routes", "dns"}
	for i, f := range d.Findings {
		if f.Status != FindingOK || f.Fix != "" || f.Check != wantChecks[i] {
			t.Errorf("finding %d: %+v", i, f)
		}
	}
	if d.Findings[1].Subject != "/home/dev/.portless" {
		t.Errorf("subject: %+v", d.Findings[1])
	}
}

func TestParseDoctorWarningsInColour(t *testing.T) {
	d := ParseDoctor(fixture(t, "doctor-warnings.txt"))
	if !d.Parsed || d.Failures != 0 || d.Warnings != 10 || len(d.Unparsed) != 0 {
		t.Fatalf("%+v", d)
	}
	type want struct{ status, check, fix, subject, hint string }
	got := make([]want, len(d.Findings))
	for i, f := range d.Findings {
		got[i] = want{f.Status, f.Check, f.Fix, f.Subject, f.Hint}
	}
	exp := []want{
		{"ok", "node", "", "", ""},
		{"ok", "state", "", "/home/dev/.portless", ""},
		{"warn", "proxy", FixStartProxy, "", "Run: portless proxy start"},
		{"warn", "pid", FixRestartProxy, "", "Run: portless proxy stop"},
		{"ok", "openssl", "", "", ""},
		{"warn", "ca", FixTrust, "", "Run: portless trust"},
		{"warn", "routes", FixPrune, "", "Run: portless prune"},
		{"warn", "routes", FixPrune, "web.localhost", ""},
		{"warn", "routes", FixPrune, "api.web.localhost", ""},
		{"warn", "ports", "", "db.localhost", "Remove the alias or start that service."},
		{"warn", "dns", FixHostsSync, "", "Run: portless hosts sync"},
		{"warn", "dns", FixHostsSync, "docs.test", ""},
	}
	if !reflect.DeepEqual(got, exp) {
		t.Fatalf("findings:\n got %+v\nwant %+v", got, exp)
	}
	if strings.Contains(d.Findings[2].Message, "\x1b") {
		t.Fatal("colour codes left in the message")
	}
}

func TestParseDoctorFailures(t *testing.T) {
	d := ParseDoctor(fixture(t, "doctor-failures.txt"))
	if !d.Parsed || d.Failures != 3 || d.Warnings != 0 || d.Node != "22.12.0" {
		t.Fatalf("%+v", d)
	}
	byCheck := map[string]Finding{}
	for _, f := range d.Findings {
		byCheck[f.Check] = f
	}
	if f := byCheck["proxy"]; f.Status != FindingFail || f.Fix != "" || f.Hint != "Process on port: PID 812" {
		t.Errorf("port taken: %+v", f)
	}
	if f := byCheck["ca"]; f.Status != FindingInfo || f.Fix != FixTrust {
		t.Errorf("no CA yet: %+v", f)
	}
	if f := byCheck["openssl"]; f.Status != FindingFail || f.Hint == "" {
		t.Errorf("openssl: %+v", f)
	}
	if f := byCheck["node"]; f.Status != FindingFail || f.Hint != "Install Node.js 24 or newer." {
		t.Errorf("node: %+v", f)
	}
}

func TestParseDoctorLANAndUnknown(t *testing.T) {
	d := ParseDoctor(fixture(t, "doctor-lan.txt"))
	if !d.Parsed || d.Warnings != 1 || d.Platform != "darwin arm64" {
		t.Fatalf("%+v", d)
	}
	last := d.Findings[len(d.Findings)-1]
	if last.Check != "lan" || last.Fix != "" {
		t.Errorf("%+v", last)
	}
	// A line from a newer portless: kept, placed under "other", no fix.
	n := ParseDoctor("\nportless doctor\n\nwarn  Something new happened.\nsomething odd\n")
	if !n.Parsed || n.Findings[0].Check != "other" || n.Findings[0].Fix != "" || n.Warnings != 1 || len(n.Unparsed) != 1 {
		t.Fatalf("%+v", n)
	}
	if ParseDoctor("Error: unknown command").Parsed {
		t.Fatal("parsed an error")
	}
}

func TestServiceStatusFixtures(t *testing.T) {
	linux := ParseServiceStatus(fixture(t, "service-status-linux.txt"))
	if !linux.Parsed || !linux.Installed || !linux.Responding || !linux.Wildcard || !reflect.DeepEqual(linux.TLDs, []string{"localhost", "test"}) {
		t.Fatalf("%+v", linux)
	}
	mac := ParseServiceStatus(fixture(t, "service-status-macos-lan.txt"))
	if !mac.Parsed || mac.ManagerState != "running" || !mac.LAN || mac.LANIP != "192.168.1.20" || mac.Entry != "/Library/LaunchDaemons/sh.portless.proxy.plist" {
		t.Fatalf("%+v", mac)
	}
	none := ParseServiceStatus(fixture(t, "service-status-none.txt"))
	if !none.Parsed || none.Installed || none.Responding || none.ManagerState != "not installed" {
		t.Fatalf("%+v", none)
	}
}

func TestParsePrune(t *testing.T) {
	if r := ParsePrune(fixture(t, "prune-none.txt")); !r.Parsed || r.Routes != 0 || len(r.Lines) != 0 {
		t.Fatalf("%+v", r)
	}
	r := ParsePrune(fixture(t, "prune-some.txt"))
	if !r.Parsed || r.Routes != 3 || r.Killed != 2 || len(r.Lines) != 5 {
		t.Fatalf("%+v", r)
	}
	want := []PruneLine{
		{Hostname: "web.localhost", PID: 51030, Action: "killed-group", Signal: "SIGTERM"},
		{Hostname: "api.web.localhost", Port: 4512, Action: "removed"},
		{Hostname: "docs.localhost", Port: 4519, PID: 51101, Action: "killed", Signal: "SIGKILL"},
		{Hostname: "docs.localhost", Port: 4519, PID: 51102, Action: "exited"},
		{Hostname: "shop.localhost", Action: "tunnel"},
	}
	if !reflect.DeepEqual(r.Lines, want) {
		t.Fatalf("got %+v", r.Lines)
	}
}

func TestServiceProgram(t *testing.T) {
	unit, ok := ParseServiceProgram(fixture(t, "portless.service"))
	if !ok || unit.Node != "/opt/node/24.11.1/bin/node" || unit.Script != "/usr/lib/node_modules/portless/dist/cli.js" {
		t.Fatalf("%+v", unit)
	}
	o, ok := unit.Options()
	want := ProxyOptions{Port: 443, HTTPS: true, TLDs: []string{"localhost", "test"}, Wildcard: true}
	if !ok || !reflect.DeepEqual(o, want) {
		t.Fatalf("unit options %+v", o)
	}
	plist, ok := ParseServiceProgram(fixture(t, "sh.portless.proxy.plist"))
	if !ok || plist.Node != "/opt/homebrew/Cellar/node/24.11.1/bin/node" {
		t.Fatalf("%+v", plist)
	}
	o, ok = plist.Options()
	want = ProxyOptions{Port: 8443, HTTPS: true, TLDs: []string{"local"}, LAN: true, LANIP: "192.168.1.20", CertPath: "/Users/dev/certs/dev & test.pem", KeyPath: "/Users/dev/certs/dev-key.pem"}
	if !ok || !reflect.DeepEqual(o, want) {
		t.Fatalf("plist options %+v", o)
	}
	if err := o.Validate(); err != nil {
		t.Fatal(err)
	}
	if _, ok := ParseServiceProgram("[Unit]\nDescription=x\n"); ok {
		t.Fatal("parsed a unit without ExecStart")
	}

	// The files on disk: a missing Node is reported.
	dir := t.TempDir()
	entry := filepath.Join(dir, "portless.service")
	script := filepath.Join(dir, "cli.js")
	if err := os.WriteFile(script, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, []byte(`ExecStart="`+filepath.Join(dir, "gone", "node")+`" "`+script+`" "proxy" "start"`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	p, ok := ReadServiceProgram(entry)
	if !ok || !p.NodeMissing || p.ScriptMissing {
		t.Fatalf("%+v", p)
	}
}

func TestOptionsFromArgs(t *testing.T) {
	o, ok := OptionsFromArgs([]string{"--unprivileged"})
	if !ok || o.HTTPS || o.Port != 80 || !o.Unprivileged {
		t.Fatalf("%+v", o)
	}
	o, ok = OptionsFromArgs([]string{"proxy", "start", "-p", "1355", "--tld", "test,dev.example.com"})
	if !ok || o.Port != 1355 || !o.HTTPS || !reflect.DeepEqual(o.TLDs, []string{"test", "dev.example.com"}) {
		t.Fatalf("%+v", o)
	}
	if _, ok := OptionsFromArgs([]string{"--surprise"}); ok {
		t.Fatal("accepted an unknown flag")
	}
}

func TestRouteStates(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "routes.json"), []byte(fixture(t, "routes.json")), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "compose"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "compose", "shop.ports.json"), []byte(`{"web:3000": 14001}`), 0o644); err != nil {
		t.Fatal(err)
	}
	c := &Client{StateDir: dir}
	states, err := c.RouteStates()
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 4 {
		t.Fatalf("the entry without port and pid must be skipped: %+v", states)
	}
	by := map[string]RouteState{}
	for _, s := range states {
		by[s.Hostname] = s
	}
	if s := by["db.localhost"]; s.Kind != KindAlias || !s.Alive {
		t.Errorf("alias: %+v", s)
	}
	if s := by["shop-web.localhost"]; s.Kind != KindCompose || s.Compose != "shop" {
		t.Errorf("compose: %+v", s)
	}
	if s := by["docs.localhost"]; s.Kind != KindApp || s.Alive || len(s.Shared) != 1 || s.Shared[0].Kind != "ngrok" {
		t.Errorf("stale: %+v", s)
	}
	if s := by["web.localhost"]; s.ChildPGID != 4101 || len(s.Shared) != 1 || s.Shared[0].Kind != "tailscale" {
		t.Errorf("shared: %+v", s)
	}
	if states[0].Hostname != "db.localhost" {
		t.Errorf("not sorted: %s", states[0].Hostname)
	}
	// Missing file: no routes; broken file: an error to show.
	empty := &Client{StateDir: t.TempDir()}
	if r, err := empty.RouteStates(); err != nil || len(r) != 0 {
		t.Fatalf("%v %v", r, err)
	}
	if err := os.WriteFile(filepath.Join(empty.StateDir, "routes.json"), []byte("{oops"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := empty.RouteStates(); err == nil {
		t.Fatal("no error for a broken routes.json")
	}
}

func TestCompareHosts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hosts")
	if err := os.WriteFile(path, []byte(fixture(t, "hosts")), 0o644); err != nil {
		t.Fatal(err)
	}
	st := CompareHosts(path, []string{"docs.test", "web.test"})
	if !st.Readable || !st.Block || len(st.Entries) != 2 || st.InSync {
		t.Fatalf("%+v", st)
	}
	if !reflect.DeepEqual(st.Missing, []string{"docs.test"}) || !reflect.DeepEqual(st.Extra, []string{"old.test"}) {
		t.Fatalf("missing %v extra %v", st.Missing, st.Extra)
	}
	if ok := CompareHosts(path, []string{"old.test", "web.test"}); !ok.InSync {
		t.Fatalf("%+v", ok)
	}
	if none := CompareHosts(filepath.Join(t.TempDir(), "nope"), nil); none.Readable || none.Block {
		t.Fatalf("%+v", none)
	}
	if found, _ := ParseHostsBlock("# portless-end\n# portless-start\n"); found {
		t.Fatal("markers in the wrong order")
	}
}

func TestNameProblem(t *testing.T) {
	ok := []string{"web", "api.shop", "a-b.c-d", "x1", "web.localhost", strings.Repeat("a", 63)}
	for _, n := range ok {
		if p := NameProblem(n, ""); p != "" {
			t.Errorf("%q: %s", n, p)
		}
	}
	bad := map[string]string{
		"":                              "Type a name.",
		"Web":                           "Use lowercase letters.",
		"-web":                          "Start the name with a letter or a digit.",
		"web.":                          "End the name with a letter or a digit.",
		"a..b":                          "Two dots in a row aren't allowed.",
		"a_b":                           `"_" isn't allowed: use letters, digits, dashes and dots.`,
		"a.-b":                          "Each part between dots must start and end with a letter or a digit.",
		strings.Repeat("a", 64):         `"` + strings.Repeat("a", 64) + `" is longer than 63 characters, the limit for one part of a name.`,
		"proxy":                         `"proxy" is one of portless's own commands; pick another name.`,
		strings.Repeat("ab.", 84) + "c": "The address would be longer than 253 characters.",
	}
	for n, want := range bad {
		if got := NameProblem(n, "localhost"); got != want {
			t.Errorf("%q: got %q, want %q", n, got, want)
		}
	}
	if NameProblem("proxy.shop", "") != "" {
		t.Error("a reserved word is fine as part of a name")
	}
	if Hostname("Api.Shop", "test") != "api.shop.test" || Hostname("web.test", "test") != "web.test" || Hostname(" ", "") != "" {
		t.Error("Hostname")
	}
	if BaseName("api.shop.test", []string{"test"}) != "api.shop" || BaseName("x.localhost", nil) != "x" || BaseName("x.dev", nil) != "x.dev" {
		t.Error("BaseName")
	}
}

func TestNameArg(t *testing.T) {
	cases := []struct {
		argv   []string
		idx    int
		prefix string
		ok     bool
	}{
		{[]string{"portless", "web", "pnpm", "run", "dev"}, 1, "", true},
		{[]string{"npx", "portless", "web", "next", "dev"}, 2, "", true},
		{[]string{"portless", "run", "--name", "web", "next", "dev"}, 3, "", true},
		{[]string{"portless", "run", "--app-port", "5173", "--name=web", "vite"}, 4, "--name=", true},
		{[]string{"portless", "run", "next", "dev"}, 0, "", false},
		{[]string{"portless", "alias", "db", "5432", "--force"}, 2, "", true},
		{[]string{"portless", "proxy", "start"}, 0, "", false},
		{[]string{"pnpm", "dev"}, 0, "", false},
	}
	for _, c := range cases {
		idx, prefix, ok := NameArg(c.argv)
		if idx != c.idx || prefix != c.prefix || ok != c.ok {
			t.Errorf("%q: got %d %q %v", c.argv, idx, prefix, ok)
		}
	}
	if n, p, ok := AliasArgs([]string{"portless", "alias", "db", "5432"}); !ok || n != "db" || p != "5432" {
		t.Errorf("AliasArgs: %s %s %v", n, p, ok)
	}
}

func TestRenameInCmd(t *testing.T) {
	fragment := "# Generated by Portplane\ntasks:\n  shop/web:\n    cwd: \"../apps/web\"\n    cmd: [\"portless\", \"shop\", \"pnpm\", \"run\", \"dev\"]\n    env: {AGENT: null}\n  shop/api:\n    cmd: [\"portless\", \"api.shop\", \"pnpm\", \"run\", \"dev\"]\n"
	out, err := RenameInCmd([]byte(fragment), "shop/web", []string{"portless", "shop", "pnpm", "run", "dev"}, "shop", "store")
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Replace(fragment, `"portless", "shop",`, `"portless", "store",`, 1)
	if string(out) != want {
		t.Fatalf("fragment:\n%s\nwant:\n%s", out, want)
	}

	hand := "tasks:\n  # the shop\n  web:\n    cmd:\n      - portless\n      - run\n      - --name\n      - shop # keep\n      - next\n      - dev\n  other: {cmd: [x]}\n"
	out, err = RenameInCmd([]byte(hand), "web", []string{"portless", "run", "--name", "shop", "next", "dev"}, "shop", "store")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "- store # keep") || !strings.Contains(string(out), "# the shop") || !strings.HasSuffix(string(out), "  other: {cmd: [x]}\n") {
		t.Fatalf("hand-written:\n%s", out)
	}

	str := "tasks:\n  web:\n    cmd: portless --name=web run vite\n"
	if _, err := RenameInCmd([]byte(str), "web", []string{"portless", "--name=web", "run", "vite"}, "web", "site"); err == nil {
		t.Fatal("a flag before run is not a name")
	}
	str = "tasks:\n  web:\n    cmd: portless web pnpm run web\n"
	if _, err := RenameInCmd([]byte(str), "web", []string{"portless", "web", "pnpm", "run", "web"}, "web", "site"); !errors.Is(err, dekit.ErrNotEditable) {
		t.Fatalf("an ambiguous string: %v", err)
	}
	str = "tasks:\n  web:\n    cmd: portless shop pnpm run dev\n"
	out, err = RenameInCmd([]byte(str), "web", []string{"portless", "shop", "pnpm", "run", "dev"}, "shop", "store")
	if err != nil || string(out) != "tasks:\n  web:\n    cmd: portless store pnpm run dev\n" {
		t.Fatalf("string cmd: %q %v", out, err)
	}

	alias := "tasks:\n  db-url:\n    type: job\n    cmd: [portless, alias, db, \"5432\", --force]\n"
	out, err = RenameInCmd([]byte(alias), "db-url", []string{"portless", "alias", "db", "5432", "--force"}, "db", "postgres")
	if err != nil || !strings.Contains(string(out), "cmd: [portless, alias, postgres, \"5432\", --force]") {
		t.Fatalf("alias job: %s %v", out, err)
	}

	js := "tasks:\n  web:\n    cmd: !js '[\"portless\", \"web\", \"vite\"]'\n"
	if _, err := RenameInCmd([]byte(js), "web", []string{"portless", "web", "vite"}, "web", "site"); !errors.Is(err, dekit.ErrNotEditable) {
		t.Fatalf("!js: %v", err)
	}

	win := "tasks:\n  web:\n    cmd: [cmd, /c, \"portless web pnpm run dev\"]\n"
	out, err = RenameInCmd([]byte(win), "web", []string{"cmd", "/c", "portless web pnpm run dev"}, "web", "site")
	if err != nil || !strings.Contains(string(out), `"portless site pnpm run dev"`) {
		t.Fatalf("cmd /c: %s %v", out, err)
	}
	if !IsFragment("/home/dev/code/.portplane/tasks.yaml") || IsFragment("/home/dev/code/dekit.yaml") {
		t.Fatal("IsFragment")
	}
}

func TestSetJSONPath(t *testing.T) {
	src := "{\n  \"name\": \"web\",\n  \"script\": \"dev\" // no comments in JSON\n}\n"
	if _, err := SetJSONPath([]byte(src), []string{"name"}, "x"); err == nil {
		t.Fatal("accepted invalid JSON")
	}
	src = "{\n  \"name\": \"web\",\n  \"scripts\": {\"dev\": \"vite\"},\n  \"version\": \"1.0.0\"\n}\n"
	out, err := SetJSONPath([]byte(src), []string{"name"}, "site")
	if err != nil || string(out) != strings.Replace(src, `"web"`, `"site"`, 1) {
		t.Fatalf("replace: %q %v", out, err)
	}
	out, err = SetJSONPath([]byte(src), []string{"portless"}, map[string]any{"name": "web"})
	want := "{\n  \"name\": \"web\",\n  \"scripts\": {\"dev\": \"vite\"},\n  \"version\": \"1.0.0\",\n  \"portless\": {\n    \"name\": \"web\"\n  }\n}\n"
	if err != nil || string(out) != want {
		t.Fatalf("insert:\n%s\nwant:\n%s %v", out, want, err)
	}
	out, err = SetJSONPath([]byte(src), []string{"scripts", "build"}, "vite build")
	if err != nil || !strings.Contains(string(out), `{"dev": "vite",`) || !strings.Contains(string(out), `"build": "vite build"`) {
		t.Fatalf("nested: %s %v", out, err)
	}
	out, err = SetJSONPath([]byte(src), []string{"apps", "apps/web", "name"}, "web")
	if err != nil || !strings.Contains(string(out), "\"apps\": {\n    \"apps/web\": {\n      \"name\": \"web\"\n    }\n  }") {
		t.Fatalf("create path: %s %v", out, err)
	}
	for _, key := range []string{"name", "scripts", "version"} {
		out, err = SetJSONPath([]byte(src), []string{key}, nil)
		if err != nil {
			t.Fatal(err)
		}
		var v map[string]any
		if err := jsonUnmarshal(out, &v); err != nil || len(v) != 2 {
			t.Fatalf("remove %s: %s %v", key, out, err)
		}
	}
	out, err = SetJSONPath([]byte("{}"), []string{"name"}, "web")
	if err != nil || string(out) != "{\n  \"name\": \"web\"\n}" {
		t.Fatalf("empty object: %q %v", out, err)
	}
	out, err = SetJSONPath([]byte("{\n\t\"a\": 1\n}\n"), []string{"b"}, 2)
	if err != nil || string(out) != "{\n\t\"a\": 1,\n\t\"b\": 2\n}\n" {
		t.Fatalf("tabs: %q %v", out, err)
	}
}

func TestValidateConfig(t *testing.T) {
	cfg, problems, warnings := ValidateConfig([]byte(`{"name":"web","script":"dev","appPort":5173,"proxy":true,"turbo":false,"apps":{"apps/api":{"name":"api","extra":1}},"other":1}`))
	if len(problems) != 0 || cfg.Name != "web" || cfg.AppPort != 5173 || *cfg.Proxy != true || *cfg.Turbo != false || cfg.Apps["apps/api"].Name != "api" {
		t.Fatalf("%+v %v", cfg, problems)
	}
	if len(warnings) != 2 {
		t.Fatalf("warnings: %v", warnings)
	}
	_, problems, _ = ValidateConfig([]byte(`{"name":"","appPort":70000,"proxy":"yes","apps":[]}`))
	if len(problems) != 4 {
		t.Fatalf("problems: %v", problems)
	}
	cfg, problems, _ = ValidateConfig([]byte(`"web"`))
	if len(problems) != 0 || cfg.Name != "web" {
		t.Fatalf("string: %+v %v", cfg, problems)
	}
	if _, problems, _ = ValidateConfig([]byte(`{"name":`)); len(problems) != 1 || !strings.HasPrefix(problems[0], "This isn't valid JSON") {
		t.Fatalf("broken: %v", problems)
	}
	if _, problems, _ = ValidateConfig([]byte(`[1]`)); len(problems) != 1 {
		t.Fatalf("array: %v", problems)
	}
	if _, problems, _ = ValidateConfig([]byte(`{"name":"Web"}`)); len(problems) != 1 {
		t.Fatalf("bad name: %v", problems)
	}
}

func TestPlanConfigName(t *testing.T) {
	write := func(dir, name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// No config: a new portless.json.
	dir := t.TempDir()
	write(dir, "package.json", "{\"name\": \"@acme/web\"}\n")
	e, err := PlanConfigName(dir, "", "site")
	if err != nil || !e.Created || e.Path != filepath.Join(dir, "portless.json") || e.After != "{\n  \"name\": \"site\"\n}\n" {
		t.Fatalf("%+v %v", e, err)
	}
	if err := WriteEdit(e); err != nil {
		t.Fatal(err)
	}
	pc := ReadProjectConfigs(dir)
	if pc.Wins != ConfigFile || pc.Portless.Config.Name != "site" || pc.PackageName != "@acme/web" {
		t.Fatalf("%+v", pc)
	}
	// portless.json wins and keeps its other keys.
	write(dir, "portless.json", "{\n  \"script\": \"start\",\n  \"name\": \"site\"\n}\n")
	e, err = PlanConfigName(dir, "", "shop")
	if err != nil || e.After != "{\n  \"script\": \"start\",\n  \"name\": \"shop\"\n}\n" {
		t.Fatalf("%q %v", e.After, err)
	}
	// A stale edit is refused.
	write(dir, "portless.json", "{}\n")
	if err := WriteEdit(e); !errors.Is(err, ErrConfigChanged) {
		t.Fatalf("stale write: %v", err)
	}
	// package.json's "portless" key, as a string and as an object.
	pkg := t.TempDir()
	write(pkg, "package.json", "{\n  \"name\": \"web\",\n  \"portless\": \"web\"\n}\n")
	e, err = PlanConfigName(pkg, "", "site")
	if err != nil || e.After != "{\n  \"name\": \"web\",\n  \"portless\": \"site\"\n}\n" {
		t.Fatalf("string key: %q %v", e.After, err)
	}
	write(pkg, "package.json", "{\n  \"portless\": {\"script\": \"dev\"}\n}\n")
	e, err = PlanConfigName(pkg, "", "site")
	if err != nil || e.After != "{\n  \"portless\": {\"script\": \"dev\", \"name\": \"site\"}\n}\n" {
		t.Fatalf("object key: %q %v", e.After, err)
	}
	// The whole text, from the editor.
	e, err = PlanConfigText(pkg, PackageFile, `{"name":"api"}`)
	if err != nil || !strings.Contains(e.After, "\"portless\": {\n    \"name\": \"api\"\n  }") {
		t.Fatalf("text: %q %v", e.After, err)
	}
	if _, err := PlanConfigText(pkg, ConfigFile, `{"appPort": "x"}`); err == nil {
		t.Fatal("accepted a bad config")
	}
}

func TestDetectInstall(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	none := func(string) string { return "" }
	// macOS's temp folder is behind a symlink (/var → /private/var), and
	// DetectInstall resolves links: compare resolved paths.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	mk := func(p string) string {
		t.Helper()
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("#!/usr/bin/env node\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		return full
	}
	link := func(target, p string) string {
		t.Helper()
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, full); err != nil {
			t.Fatal(err)
		}
		return full
	}

	brewCLI := mk("brew/Cellar/portless/0.16.0/libexec/lib/node_modules/portless/dist/cli.js")
	brew := mk("brew/bin/brew")
	in := DetectInstall(link(brewCLI, "brew/bin/portless"), none)
	if in.Origin != OriginHomebrew || in.Update == nil || in.Update.Argv[0] != brew || strings.Join(in.Update.Argv[1:], " ") != "upgrade portless" || in.Script != brewCLI {
		t.Fatalf("homebrew: %+v", in)
	}

	npmCLI := mk("npm/lib/node_modules/portless/dist/cli.js")
	npm := mk("npm/bin/npm")
	in = DetectInstall(link(npmCLI, "npm/bin/portless"), none)
	if in.Origin != OriginNPM || in.Prefix != filepath.Join(root, "npm") || in.Update.Argv[0] != npm || in.Update.Admin || strings.Join(in.Uninstall.Argv[1:], " ") != "uninstall --global portless" {
		t.Fatalf("npm: %+v %+v", in, in.Update)
	}

	privCLI := mk("data/portplane/portless/lib/node_modules/portless/dist/cli.js")
	privNPM := mk("data/portplane/node/24.11.1/bin/npm")
	shim := filepath.Join(root, "bin", "portless")
	if err := os.MkdirAll(filepath.Dir(shim), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(shim, []byte("#!/bin/sh\nexec \""+filepath.Join(root, "data/portplane/node/24.11.1/bin/node")+"\" \""+privCLI+"\" \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	in = DetectInstall(shim, none)
	if in.Origin != OriginPortplane || in.Script != privCLI || in.Update == nil || in.Update.Argv[0] != privNPM || !strings.Contains(strings.Join(in.Update.Argv, " "), "--prefix "+filepath.Join(root, "data/portplane/portless")) || !strings.HasPrefix(in.Update.Env["PATH"], filepath.Dir(privNPM)) {
		t.Fatalf("portplane: %+v %+v", in, in.Update)
	}

	if in := DetectInstall(mk("elsewhere/portless"), none); in.Origin != OriginUnknown || in.Update != nil {
		t.Fatalf("unknown: %+v", in)
	}
	if in := DetectInstall("", none); in.Origin != OriginUnknown {
		t.Fatalf("missing: %+v", in)
	}
}

func testCA(t *testing.T) (*x509.Certificate, *ecdsa.PrivateKey, []byte) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "portless Local CA"}, NotBefore: time.Now(), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return cert, key, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func TestHostCertsExportAndBackup(t *testing.T) {
	dir := t.TempDir()
	ca, caKey, caPEM := testCA(t)
	if err := os.WriteFile(filepath.Join(dir, "ca.pem"), caPEM, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "host-certs"), 0o755); err != nil {
		t.Fatal(err)
	}
	hostKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "web.localhost"}, DNSNames: []string{"web.localhost", "*.web.localhost"}, NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &hostKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{
		"web_localhost.pem":     pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		"web_localhost-key.pem": []byte("key"),
		"junk.pem":              []byte("not a certificate"),
	}
	for name, b := range files {
		if err := os.WriteFile(filepath.Join(dir, "host-certs", name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	c := &Client{StateDir: dir}
	certs := c.HostCerts()
	if len(certs) != 1 || !certs[0].SignedByCA || !reflect.DeepEqual(certs[0].Names, []string{"web.localhost", "*.web.localhost"}) || certs[0].NotAfter.IsZero() {
		t.Fatalf("%+v", certs)
	}

	out := t.TempDir()
	p1, err := c.ExportCA(out)
	if err != nil || filepath.Base(p1) != "portless-ca.pem" {
		t.Fatalf("%s %v", p1, err)
	}
	p2, _ := c.ExportCA(out)
	if filepath.Base(p2) != "portless-ca-2.pem" {
		t.Fatalf("second export overwrote the first: %s", p2)
	}

	backup, err := c.BackupCA(time.Date(2026, 11, 12, 9, 30, 0, 0, time.UTC))
	if err != nil || filepath.Base(backup) != "ca-backup-20261112-093000" {
		t.Fatalf("%s %v", backup, err)
	}
	if exists(filepath.Join(dir, "ca.pem")) || !exists(filepath.Join(backup, "ca.pem")) || !exists(filepath.Join(backup, "host-certs", "web_localhost.pem")) {
		t.Fatal("files not moved")
	}
	if again, err := c.BackupCA(time.Now()); err != nil || again != "" {
		t.Fatalf("nothing left to move: %q %v", again, err)
	}
	if _, err := c.ExportCA(out); err == nil {
		t.Fatal("exported a missing CA")
	}
	cmd, err := FixOwnershipCommand("/etc/pki/ca-trust/source/anchors/portless-ca.crt")
	if err != nil || len(cmd.Argv) != 3 || !filepath.IsAbs(cmd.Argv[0]) || cmd.Argv[1] != "root:root" {
		t.Fatalf("%+v %v", cmd, err)
	}
}

func TestProxyState(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Portless", "1")
	}))
	defer srv.Close()
	_, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("proxy.port", port+"\n")
	write("proxy.tlds", "localhost\ntest\n")
	write("proxy.unprivileged", "1")
	write("proxy.pid", strconv.Itoa(os.Getpid()))
	c := &Client{StateDir: dir}
	st := c.ProxyState(context.Background())
	if !st.Responding || !st.Running || st.HTTPS || !st.Configured || !st.Unprivileged || st.PID != os.Getpid() || st.AsRoot {
		t.Fatalf("%+v", st)
	}
	if !reflect.DeepEqual(st.TLDs, []string{"localhost", "test"}) || st.MainTLD() != "localhost" {
		t.Fatalf("%+v", st.TLDs)
	}
	write("proxy.lan", "192.168.1.20\n")
	st = c.ProxyState(context.Background())
	if !st.LAN || st.LANIP != "192.168.1.20" || !reflect.DeepEqual(st.TLDs, []string{"local"}) {
		t.Fatalf("lan: %+v", st)
	}
	// Something else on the port is not a portless proxy.
	other := httptest.NewServer(http.NotFoundHandler())
	defer other.Close()
	_, otherPort, _ := net.SplitHostPort(other.Listener.Addr().String())
	n, _ := strconv.Atoi(otherPort)
	if Probe(context.Background(), n, false) {
		t.Fatal("a server without X-Portless answered as the proxy")
	}
	if fresh := (&Client{StateDir: t.TempDir()}).ProxyState(context.Background()); fresh.Configured || fresh.Port != 443 || !fresh.HTTPS {
		t.Fatalf("fresh: %+v", fresh)
	}
}

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
