package portless

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/akamachinecode/portplane/internal/dekit"
)

// composeState copies portless 0.16's compose state into a temporary state
// folder.
func composeState(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "compose"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"shop.json", "shop.ports.json", "blog.ports.json"} {
		b, err := os.ReadFile(filepath.Join("testdata", "0.16", "compose", f))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "compose", f), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestComposeProjects(t *testing.T) {
	c := &Client{StateDir: composeState(t)}
	projects, err := c.ComposeProjects()
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 2 || projects[0].Name != "blog" || projects[1].Name != "shop" {
		t.Fatalf("%+v", projects)
	}
	blog, shop := projects[0], projects[1]
	if blog.Started || len(blog.Services) != 1 || blog.Services[0].Name != "site" || blog.Services[0].Ports[0].HostPort != 14010 {
		t.Errorf("blog %+v", blog)
	}
	if !shop.Started || shop.Label != "shop" || len(shop.Services) != 5 {
		t.Fatalf("shop %+v", shop)
	}
	byName := map[string]ComposeService{}
	for _, s := range shop.Services {
		byName[s.Name] = s
	}
	api := byName["api"]
	if api.Label != "backend" || api.NameLabel != "backend" || len(api.Ports) != 2 || !api.Ports[0].Routed || api.Ports[0].HostPort != 14002 {
		t.Errorf("api %+v", api)
	}
	if got := api.Hostnames("shop", "localhost"); !reflect.DeepEqual(got, []string{"backend.shop.localhost", "8080.backend.shop.localhost", "9229.backend.shop.localhost"}) {
		t.Errorf("api hostnames %v", got)
	}
	if db := byName["db"]; db.Ports[0].Routed || db.Ports[0].Reason != "not HTTP" || db.Hostnames("shop", "localhost") != nil {
		t.Errorf("db %+v", db)
	}
	if mail := byName["mail"]; mail.Enabled || mail.Ports[0].Routed || mail.Ports[0].Reason != "portless.enable=false" {
		t.Errorf("mail %+v", mail)
	}
	if web := byName["web"]; !reflect.DeepEqual(web.Hostnames("shop", "test"), []string{"web.shop.test"}) || web.Ports[0].HostPort != 14001 {
		t.Errorf("web %+v", web)
	}
	if w := byName["worker"]; len(w.Ports) != 0 {
		t.Errorf("worker %+v", w)
	}
	if !reflect.DeepEqual(shop.Dirs, []string{"/home/dev/code/shop/api", "/home/dev/code/shop/web", "/home/dev/code/shop/web/src"}) {
		t.Errorf("dirs %v", shop.Dirs)
	}
	if s, ok := shop.ServiceFor("anything", 14001); !ok || s.Name != "web" {
		t.Errorf("by port %+v", s)
	}
	if s, ok := shop.ServiceFor("9229.backend.shop.localhost", 0); !ok || s.Name != "api" {
		t.Errorf("by name %+v", s)
	}

	// Without the compose folder: no projects.
	if p, err := (&Client{StateDir: t.TempDir()}).ComposeProjects(); err != nil || len(p) != 0 {
		t.Errorf("empty %v %v", p, err)
	}

	// The routes of a project come out as compose routes.
	write := func(p, s string) {
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(c.StateDir, "routes.json"), `[{"hostname":"web.shop.localhost","port":14001,"pid":0},{"hostname":"backend.shop.localhost","port":14002,"pid":0}]`)
	states, _ := c.RouteStates()
	for _, s := range states {
		if s.Kind != KindCompose || s.Compose != "shop" {
			t.Errorf("%+v", s)
		}
	}
}

func TestComposeLabelsAndNames(t *testing.T) {
	cases := map[string]string{"Web App": "web-app", "api_v2": "api-v2", "--x--": "x", "shop": "shop"}
	for in, want := range cases {
		if got := ComposeLabel(in); got != want {
			t.Errorf("%q: %q", in, got)
		}
	}
	long := strings.Repeat("a", 70)
	if l := ComposeLabel(long); len(l) != 63 || !strings.HasPrefix(l, strings.Repeat("a", 56)+"-") {
		t.Errorf("long %q", l)
	}
	for _, bad := range []string{"", "api.v2", "Api", "a_b", "-a", "b-", strings.Repeat("x", 64)} {
		if ComposeNameProblem(bad) == "" {
			t.Errorf("accepted %q", bad)
		}
	}
	for _, ok := range []string{"store", "proxy", "web-2"} {
		if p := ComposeNameProblem(ok); p != "" {
			t.Errorf("%s: %s", ok, p)
		}
	}
	if ComposeProjectName("/home/dev/code/My Shop.v2") != "myshopv2" {
		t.Errorf("project name %q", ComposeProjectName("/home/dev/code/My Shop.v2"))
	}
}

func TestComposeCommands(t *testing.T) {
	if got := strings.Join(ComposeUpArgs("shop", "/c/compose.yaml"), " "); got != "compose -p shop -f /c/compose.yaml up -d" {
		t.Error(got)
	}
	if got := strings.Join(ComposeUpArgs("", "/c/compose.yaml"), " "); got != "compose -f /c/compose.yaml up -d" {
		t.Error(got)
	}
	if got := strings.Join(ComposeDownArgs("shop", ""), " "); got != "compose -p shop down" {
		t.Error(got)
	}
	c, ok := ParseComposeCommand([]string{"portless", "compose", "-f", "compose.dev.yml", "--project-name=shop", "up"})
	if !ok || !reflect.DeepEqual(c.Files, []string{"compose.dev.yml"}) || c.Project != "shop" {
		t.Errorf("%+v %v", c, ok)
	}
	if c, ok := ParseComposeCommand([]string{"npx", "portless", "compose", "--profile", "dev", "up"}); !ok || c.Project != "" || c.Files != nil {
		t.Errorf("%+v", c)
	}
	if _, ok := ParseComposeCommand([]string{"portless", "web", "pnpm", "dev"}); ok {
		t.Error("not compose")
	}
	b, err := os.ReadFile(filepath.Join("testdata", "0.16", "compose-up.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if got := ComposeStartedProject("\x1b[1m" + string(b) + "\x1b[22m"); got != "shop" {
		t.Errorf("started %q", got)
	}
}

func TestComposeFiles(t *testing.T) {
	root := t.TempDir()
	shop := filepath.Join(root, "shop")
	if err := os.MkdirAll(filepath.Join(shop, "web", "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if FindComposeFile(shop) != "" {
		t.Error("no file yet")
	}
	file := filepath.Join(shop, "docker-compose.yml")
	if err := os.WriteFile(file, []byte("services:\n  web:\n    build: ./web\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if FindComposeFile(shop) != file || ComposeFileProject(file) != "shop" {
		t.Errorf("find %q %q", FindComposeFile(shop), ComposeFileProject(file))
	}
	if got := GuessComposeFile("shop", []string{filepath.Join(shop, "web", "src")}); got != file {
		t.Errorf("guess %q", got)
	}
	if got := GuessComposeFile("other", []string{filepath.Join(shop, "web", "src")}); got != "" {
		t.Errorf("wrong project %q", got)
	}
	named := filepath.Join(root, "named")
	if err := os.MkdirAll(named, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(named, "compose.yaml"), []byte("name: store\nservices: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if ComposeFileProject(filepath.Join(named, "compose.yaml")) != "store" {
		t.Error("name: wins")
	}
}

func TestSetComposeName(t *testing.T) {
	src := `# shop
name: shop
x-defaults: &defaults
  restart: unless-stopped

services:
  web:
    build: ./web
    labels:
      portless.name: store # the storefront
      com.example.team: web
    ports:
      - "5173:5173"
  api:
    build: ./api
    labels:
      - "portless.ports=8080"
    ports: ["8080:8080"]
  admin:
    image: nginx
    ports:
      - 8081:80

  # the worker
  worker:
    <<: *defaults
    build: ./api
volumes:
  data: {}
`
	out, err := SetComposeName([]byte(src), "web", "shop-front")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "      portless.name: shop-front # the storefront\n      com.example.team: web\n") {
		t.Errorf("mapping:\n%s", out)
	}
	out, err = SetComposeName([]byte(src), "api", "backend")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "    labels:\n      - \"portless.ports=8080\"\n      - \"portless.name=backend\"\n") {
		t.Errorf("list:\n%s", out)
	}
	out, err = SetComposeName([]byte(src), "admin", "console")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "      - 8081:80\n    labels:\n      portless.name: console\n\n  # the worker\n") {
		t.Errorf("new labels:\n%s", out)
	}
	// Everything outside the service stays as it was.
	for _, o := range [][]byte{out} {
		if !strings.HasPrefix(string(o), "# shop\nname: shop\nx-defaults: &defaults\n  restart: unless-stopped\n\nservices:\n  web:\n") || !strings.HasSuffix(string(o), "volumes:\n  data: {}\n") {
			t.Errorf("rest changed:\n%s", o)
		}
	}
	if _, err := SetComposeName([]byte(src), "worker", "jobs"); !errors.Is(err, dekit.ErrNotEditable) {
		t.Errorf("merge key: %v", err)
	}
	if _, err := SetComposeName([]byte(src), "missing", "x"); err == nil || !strings.Contains(err.Error(), "isn't defined in this file") {
		t.Errorf("missing service: %v", err)
	}
	if _, err := SetComposeName([]byte("include:\n  - other.yaml\n"), "web", "x"); err == nil {
		t.Error("no services")
	}
}
