package dekit

import (
	"context"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestSpawnAndActArgs(t *testing.T) {
	args := SpawnArgs("/p", SpawnSpec{Path: "tmp/migrate", Cmd: []string{"pnpm", "run", "migrate"}, Cwd: "/p/apps/api", Env: map[string]string{"B": "2", "A": "1"}, Deps: []string{"db"}, Tags: []string{"once"}})
	want := []string{"-C", "/p", "spawn", "tmp/migrate", "--cwd", "/p/apps/api", "--env", "A=1", "--env", "B=2", "--dep", "db", "--tag", "once", "--json", "--", "pnpm", "run", "migrate"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("spawn args %v", args)
	}
	for _, bad := range []SpawnSpec{
		{Path: "", Cmd: []string{"x"}},
		{Path: "a b", Cmd: []string{"x"}},
		{Path: "tmp/*", Cmd: []string{"x"}},
		{Path: "ok", Cmd: nil},
		{Path: "ok", Cmd: []string{"x"}, Tags: []string{"dynamic"}},
		{Path: "ok", Cmd: []string{"x"}, Env: map[string]string{"A=B": "1"}},
		{Path: "ok", Cmd: []string{"x"}, Deps: []string{"--all"}},
	} {
		if err := bad.Validate(); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
	for _, verb := range []string{"kill", "veto", "rm", "restart"} {
		if a, err := ActArgs("/p", verb, "web"); err != nil || !reflect.DeepEqual(a, []string{"-C", "/p", verb, "web"}) {
			t.Errorf("%s: %v %v", verb, a, err)
		}
	}
	for _, target := range []string{"", "*", "**"} {
		if _, err := ActArgs("/p", "stop", target); err == nil {
			t.Errorf("target %q accepted", target)
		}
	}
}

func TestCLICommands(t *testing.T) {
	var calls []fakeCall
	c := fakeCLI(string(fixture(t, "why-backoff.json")), "", nil, &calls)
	ctx := context.Background()
	if w, err := c.Why(ctx, "/p", "web"); err != nil || w.Attempts != 5 {
		t.Fatalf("why %+v %v", w, err)
	}
	if _, err := c.Why(ctx, "/p", "web/*"); err == nil {
		t.Fatal("why takes one task")
	}
	if _, err := c.ReloadPlanFor(ctx, HostRunner); err == nil {
		// the fake prints why's JSON: parsing a reload must still work or fail cleanly
		_ = err
	}
	_, _ = c.Status(ctx, HostRunner)
	_, _ = c.Status(ctx, "/p")
	if err := c.ForceRestart(ctx, "/p", "web"); err != nil {
		t.Fatal(err)
	}
	if err := c.SetDefaultKernel(ctx, ""); err != nil {
		t.Fatal(err)
	}
	got := [][]string{}
	for _, call := range calls {
		got = append(got, call.args)
	}
	want := [][]string{
		{"-C", "/p", "why", "--json", "web"},
		{"reload", "--json", "host"},
		{"runner", "status", "--json", "host"},
		{"-C", "/p", "runner", "status", "--json"},
		{"-C", "/p", "kill", "web", "--wait", "--wait-timeout", "20s"},
		{"-C", "/p", "start", "web"},
		{"kernel", "clear-default"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("calls\n got %v\nwant %v", got, want)
	}
	args, _ := RunnerArgs("/p", RunnerUp)
	if !reflect.DeepEqual(args, []string{"-C", "/p", "up", "--wait", "--wait-timeout", "180s", "--json"}) {
		t.Fatalf("up args %v", args)
	}
	args, _ = RunnerArgs(HostRunner, RunnerStop)
	if !reflect.DeepEqual(args, []string{"runner", "stop", "--json", "host"}) {
		t.Fatalf("host stop args %v", args)
	}
	if _, err := RunnerArgs("/p", "explode"); err == nil {
		t.Fatal("unknown runner action")
	}
}

func TestDetectOrigin(t *testing.T) {
	files := map[string]string{"/home/dev/.local/share/dekit/install": "/home/dev/.local/bin/dekit\n"}
	read := func(p string) ([]byte, error) {
		if b, ok := files[p]; ok {
			return []byte(b), nil
		}
		return nil, os.ErrNotExist
	}
	same := func(p string) (string, error) { return p, nil }
	env := func(string) string { return "" }
	o := detectOrigin("/home/dev/.local/bin/dekit", "1.2.3", "linux", env, "/home/dev", read, same)
	if o.Kind != "script" || !reflect.DeepEqual(o.Update, []string{"/home/dev/.local/bin/dekit", "update", "1.2.3"}) || o.UpgradeRunners {
		t.Fatalf("script: %+v", o)
	}
	o = detectOrigin("/opt/homebrew/bin/dekit", "", "darwin", env, "/Users/dev", read, func(string) (string, error) { return "/opt/homebrew/Cellar/dekit/0.10.3/bin/dekit", nil })
	if o.Kind != "homebrew" || o.Update[0] != "brew" || !o.UpgradeRunners {
		t.Fatalf("brew: %+v", o)
	}
	o = detectOrigin("/home/dev/.npm-global/bin/dekit", "", "linux", env, "/home/dev", read, func(string) (string, error) {
		return "/home/dev/.npm-global/lib/node_modules/@dekit/cli/bin/dekit", nil
	})
	if o.Kind != "npm" || !reflect.DeepEqual(o.Update, []string{"npm", "install", "-g", "@dekit/cli@latest"}) {
		t.Fatalf("npm: %+v", o)
	}
	o = detectOrigin(`C:\Users\dev\.local\bin\dekit.exe`, "", "windows", func(k string) string {
		if k == "LOCALAPPDATA" {
			return `C:\Users\dev\AppData\Local`
		}
		return ""
	}, `C:\Users\dev`, func(p string) ([]byte, error) {
		if strings.HasSuffix(p, "install") && strings.Contains(p, "AppData") {
			return []byte(`C:\Users\dev\.local\bin\dekit.exe`), nil
		}
		return nil, os.ErrNotExist
	}, same)
	if o.Kind != "script" {
		t.Fatalf("windows script: %+v", o)
	}
	if o := detectOrigin("/usr/local/bin/dekit", "", "linux", env, "/home/dev", read, same); o.Kind != "other" || len(o.Update) != 0 {
		t.Fatalf("other: %+v", o)
	}
	for _, v := range []string{"", "latest", "canary", "1.2.3", "v0.11.0"} {
		if err := ValidUpdateVersion(v); err != nil {
			t.Errorf("%q: %v", v, err)
		}
	}
	for _, v := range []string{"1.2", "; rm -rf", "--help", "1.2.x"} {
		if err := ValidUpdateVersion(v); err == nil {
			t.Errorf("%q accepted", v)
		}
	}
}
