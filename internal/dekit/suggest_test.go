package dekit

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func labels(s []Suggestion) []string {
	out := []string{}
	for _, x := range s {
		out = append(out, x.Label)
	}
	return out
}

func TestSuggestByLanguage(t *testing.T) {
	cases := []struct {
		files map[string]string
		goos  string
		want  []string
		check func(t *testing.T, s []Suggestion)
	}{
		{
			files: map[string]string{"package.json": `{"scripts":{"dev":"vite --port 3001","build":"vite build"},"devDependencies":{"vite":"7"}}`, "pnpm-lock.yaml": ""},
			want:  []string{"pnpm run dev", "pnpm install --frozen-lockfile"},
			check: func(t *testing.T, s []Suggestion) {
				if !s[0].Wrap || s[0].Ready == nil || s[0].Ready.Log != "ready in" || !strings.Contains(s[0].Note, "3001") || !s[1].Job {
					t.Errorf("node: %+v", s)
				}
			},
		},
		{
			files: map[string]string{"manage.py": "", "uv.lock": ""},
			want:  []string{"Django development server"},
			check: func(t *testing.T, s []Suggestion) {
				if !reflect.DeepEqual(s[0].Cmd, []string{"sh", "-c", `exec uv run python manage.py runserver "127.0.0.1:$PORT"`}) || !s[0].Wrap {
					t.Errorf("django: %+v", s[0])
				}
			},
		},
		{
			files: map[string]string{"manage.py": ""},
			goos:  "windows",
			want:  []string{"Django development server"},
			check: func(t *testing.T, s []Suggestion) {
				if s[0].Wrap || s[0].Port != 8000 || s[0].Cmd[0] != "python" {
					t.Errorf("django on windows uses an alias: %+v", s[0])
				}
			},
		},
		{files: map[string]string{"main.py": "app = FastAPI()"}, want: []string{"FastAPI with uvicorn"}},
		{files: map[string]string{"go.mod": "module x"}, want: []string{"go run ."}},
		{files: map[string]string{"Gemfile": "", "bin/rails": ""}, want: []string{"Rails server", "bundle install"}},
		{
			files: map[string]string{"composer.json": "{}", "public/index.php": ""},
			want:  []string{"PHP built-in server", "composer install"},
			check: func(t *testing.T, s []Suggestion) {
				if s[0].Wrap || s[0].Port != 8000 || s[0].Cmd[len(s[0].Cmd)-1] != "public" || s[0].Ready.TCP != 8000 {
					t.Errorf("php: %+v", s[0])
				}
			},
		},
		{files: map[string]string{"artisan": "", "composer.json": "{}"}, want: []string{"Laravel (artisan serve)", "composer install"}},
		{
			files: map[string]string{"compose.yaml": "services:\n  web:\n    ports:\n      - \"8080:80\"\n      - 127.0.0.1:5433:5432\n"},
			want:  []string{"docker compose up"},
			check: func(t *testing.T, s []Suggestion) {
				if s[0].Port != 5433 || s[0].Wrap || !strings.Contains(s[0].Note, "2 ports") {
					t.Errorf("compose: %+v", s[0])
				}
			},
		},
		{
			files: map[string]string{"Procfile": "web: bundle exec puma -p $PORT\nworker: bundle exec sidekiq\n# note\n"},
			want:  []string{"Procfile: web", "Procfile: worker"},
			check: func(t *testing.T, s []Suggestion) {
				if s[0].Cmd[0] != "sh" || !s[0].Wrap || s[1].Wrap || s[1].Cmd[0] != "bundle" {
					t.Errorf("procfile: %+v", s)
				}
			},
		},
		{files: map[string]string{"README.md": ""}, want: []string{}},
	}
	for _, c := range cases {
		dir := t.TempDir()
		writeFiles(t, dir, c.files)
		goos := c.goos
		if goos == "" {
			goos = "linux"
		}
		got := Suggest(dir, goos)
		if !reflect.DeepEqual(labels(got), c.want) {
			t.Errorf("%v: got %v want %v", c.files, labels(got), c.want)
			continue
		}
		if c.check != nil {
			c.check(t, got)
		}
	}
}

// hostAbs turns a Unix-style absolute path into one the host sees as
// absolute.
func hostAbs(p string) string {
	if runtime.GOOS == "windows" {
		return `C:` + filepath.FromSlash(p)
	}
	return p
}

func TestNewAppOps(t *testing.T) {
	app := NewApp{Path: "site", Folder: hostAbs("/home/dev/code/blog/site"), Cmd: []string{"php", "-S", "127.0.0.1:8000"}, Name: "blog", Port: 8000, Ready: &Ready{TCP: 8000}, Deps: []string{"install"}}
	ops, err := app.InsertOps(hostAbs("/home/dev/code/blog/.portplane"))
	if err != nil {
		t.Fatal(err)
	}
	if len(ops) != 2 || ops[0].Key != "site-url" || ops[1].Key != "site" {
		t.Fatalf("ops %+v", ops)
	}
	if string(ops[0].Value) != `{"label":"site URL","type":"job","cmd":["portless","alias","blog","8000","--force"]}` {
		t.Fatalf("alias %s", ops[0].Value)
	}
	if string(ops[1].Value) != `{"cwd":"../site","cmd":["php","-S","127.0.0.1:8000"],"deps":["install","site-url"],"ready":{"tcp":8000}}` {
		t.Fatalf("app %s", ops[1].Value)
	}
	app = NewApp{Path: "web", Label: "Web", Folder: hostAbs("/home/dev/code/shop/apps/web"), Cmd: []string{"pnpm", "run", "dev"}, Name: "shop", Wrap: true, Autostart: true}
	ops, err = app.InsertOps(hostAbs("/home/dev/code/shop"))
	if err != nil || len(ops) != 1 {
		t.Fatal(err, ops)
	}
	var v map[string]any
	_ = json.Unmarshal(ops[0].Value, &v)
	if !reflect.DeepEqual(v["cmd"], []any{"portless", "shop", "pnpm", "run", "dev"}) || v["cwd"] != "apps/web" || v["autostart"] != true {
		t.Fatalf("wrapped %s", ops[0].Value)
	}
	for _, bad := range []NewApp{
		{Path: "x", Folder: "rel", Cmd: []string{"a"}},
		{Path: "x", Folder: hostAbs("/a"), Cmd: []string{"a"}, Name: "Bad Name", Wrap: true},
		{Path: "x", Folder: hostAbs("/a"), Cmd: []string{"a"}, Name: "ok"},
		{Path: "x", Folder: hostAbs("/a"), Cmd: []string{"a"}, Job: true, Ready: &Ready{Log: "x"}},
	} {
		if err := bad.Validate(); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
	// The ops apply to an empty fragment and give a valid file.
	out, err := ApplyOps(nil, ops)
	if err != nil || len(ValidateConfig(out)) > 0 {
		t.Fatalf("apply: %v\n%s", err, out)
	}
}
