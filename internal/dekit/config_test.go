package dekit

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestLoadConfig(t *testing.T) {
	root, _ := filepath.Abs("testdata/project")
	cfg, err := LoadConfig(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Warnings) != 0 {
		t.Fatalf("warnings: %v", cfg.Warnings)
	}
	var paths []string
	for _, tk := range cfg.Tasks {
		paths = append(paths, tk.Path)
	}
	want := []string{"shop/install", "shop/api", "computed", "plain", "db", "web/dev"}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("paths %v, want %v", paths, want)
	}
	if !reflect.DeepEqual(cfg.Folders, []string{"shop"}) {
		t.Fatalf("folders %v", cfg.Folders)
	}

	install := cfg.Task("shop/install")
	if install.Kind != "job" || !reflect.DeepEqual(install.Cmd, []string{"pnpm", "install", "--frozen-lockfile"}) || install.Dir != root {
		t.Fatalf("install: %+v", install)
	}
	if install.Env["FROM_DEFAULTS"] != "1" {
		t.Fatalf("install should get the defaults env: %v", install.Env)
	}

	api := cfg.Task("shop/api")
	if api.Label != "API" || api.Dir != filepath.Join(root, "apps/api") || api.ReadyTCP != "127.0.0.1:4100" {
		t.Fatalf("api: %+v", api)
	}
	if _, ok := api.Env["FROM_DEFAULTS"]; ok {
		t.Fatalf("a task env replaces the defaults env: %v", api.Env)
	}
	if _, ok := api.Env["AI_AGENT"]; ok || api.Env["API_URL"] != "https://api.shop.localhost" {
		t.Fatalf("api env: %v", api.Env)
	}

	computed := cfg.Task("computed")
	if computed.Cmd != nil || computed.Dir != "" {
		t.Fatalf("!js values must stay unknown: %+v", computed)
	}
	if got := cfg.Task("plain").Cmd; !reflect.DeepEqual(got, []string{"node", "-e", "console.log(1)"}) {
		t.Fatalf("plain cmd %q", got)
	}
	if db := cfg.Task("db"); db.ReadyTCP != "5432" || db.Dir != root {
		t.Fatalf("db: %+v", db)
	}
	web := cfg.Task("web/dev")
	if web.Dir != filepath.Join(root, "apps/web") {
		t.Fatalf("fragment cwd resolves from the fragment: %q", web.Dir)
	}
	if !reflect.DeepEqual(web.Deps, []string{"web/db", "shop/api"}) {
		t.Fatalf("fragment deps: %v", web.Deps)
	}
	if len(cfg.Files) != 3 {
		t.Fatalf("files: %v", cfg.Files)
	}
}

func TestGlobRegexp(t *testing.T) {
	cases := []struct {
		pattern, path string
		match         bool
	}{
		{"services/*.yaml", "services/db.yaml", true},
		{"services/*.yaml", "services/x/db.yaml", false},
		{"**/tasks.yaml", "tasks.yaml", true},
		{"**/tasks.yaml", "apps/web/tasks.yaml", true},
		{"apps/**", "apps/web/tasks.yaml", true},
		{"a?.yaml", "ab.yaml", true},
	}
	for _, c := range cases {
		re, err := globRegexp(c.pattern)
		if err != nil {
			t.Fatal(err)
		}
		if got := re.MatchString(c.path); got != c.match {
			t.Errorf("%s ~ %s = %v", c.pattern, c.path, got)
		}
	}
}
