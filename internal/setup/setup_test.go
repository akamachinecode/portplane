package setup

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/portless"
)

func write(t *testing.T, p, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// makeFolder builds a folder with a pnpm monorepo (with a linked worktree)
// and a single-package Astro site.
func makeFolder(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	base := t.TempDir()
	shop := filepath.Join(base, "Shop")
	write(t, filepath.Join(shop, "package.json"), `{"name":"shop","private":true,"packageManager":"pnpm@11.0.0","scripts":{"dev":"turbo dev"}}`)
	write(t, filepath.Join(shop, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n")
	write(t, filepath.Join(shop, "apps/web/package.json"), `{"name":"@shop/web","scripts":{"dev":"next dev --port 3001"},"dependencies":{"next":"16.0.0","better-auth":"1.0.0"}}`)
	write(t, filepath.Join(shop, "apps/admin/package.json"), `{"name":"@shop/admin","scripts":{"dev":"vite"},"devDependencies":{"vite":"8.0.0"}}`)
	write(t, filepath.Join(shop, "apps/studio/package.json"), `{"name":"@shop/studio","scripts":{"dev":"sanity dev"},"dependencies":{"sanity":"4.0.0"}}`)
	write(t, filepath.Join(shop, "packages/ui/package.json"), `{"name":"@shop/ui","scripts":{"build":"tsc"}}`)
	git(t, shop, "init", "-q")
	git(t, shop, "add", ".")
	git(t, shop, "commit", "-q", "-m", "init")
	git(t, shop, "worktree", "add", "-q", filepath.Join(base, "shop-checkout"), "-b", "feature-x")

	blog := filepath.Join(base, "blog")
	write(t, filepath.Join(blog, "package.json"), `{"name":"blog","scripts":{"dev":"astro dev"},"devDependencies":{"astro":"7.0.0"}}`)
	write(t, filepath.Join(blog, "package-lock.json"), "{}")
	return base
}

func TestProposeMonorepoWithWorktree(t *testing.T) {
	folder := makeFolder(t)
	p, err := Propose(context.Background(), folder, Overrides{}, Options{GOOS: "linux"})
	if err != nil {
		t.Fatal(err)
	}
	apps := map[string]AppProposal{}
	for _, a := range p.Apps {
		apps[a.Task] = a
	}
	// Shop: web is the main app; the linked worktree gets its own tasks.
	web := apps["shop/web"]
	if web.Hostname != "shop.localhost" || web.Framework != "next" || web.Status != "new" {
		t.Fatalf("shop/web: %+v", web)
	}
	if !reflect.DeepEqual(web.Command, []string{"portless", "shop", "pnpm", "exec", "next", "dev"}) {
		t.Fatalf("a hard-coded port must be bypassed: %q", web.Command)
	}
	if a := apps["shop/admin"]; a.Hostname != "admin.shop.localhost" || !reflect.DeepEqual(a.Command, []string{"portless", "admin.shop", "pnpm", "run", "dev"}) {
		t.Fatalf("shop/admin: %+v", a)
	}
	if s := apps["shop/studio"]; !reflect.DeepEqual(s.Command, []string{"portless", "studio.shop", "portplane", "port-exec", "--", "pnpm", "exec", "sanity", "dev", "--host", "{HOST}", "--port", "{PORT}"}) {
		t.Fatalf("shop/studio: %q", s.Command)
	}
	if _, ok := apps["shop/ui"]; ok {
		t.Fatal("packages without a dev script are not apps")
	}
	wt := apps["shop/shop-checkout/web"]
	if wt.Hostname != "shop-checkout.shop.localhost" || wt.Worktree != "shop-checkout" {
		t.Fatalf("worktree web: %+v", wt)
	}
	if a := apps["shop/shop-checkout/admin"]; a.Hostname != "admin.shop-checkout.shop.localhost" {
		t.Fatalf("worktree admin: %+v", a)
	}
	// Blog: a single package is the main app, with npm.
	if b := apps["blog/web"]; b.Hostname != "blog.localhost" || !reflect.DeepEqual(b.Command, []string{"portless", "blog", "npm", "run", "dev"}) {
		t.Fatalf("blog/web: %+v", b)
	}
	if len(p.Warnings) != 2 {
		t.Fatalf("want the cookie and CORS warnings: %q", p.Warnings)
	}

	// The fragment parses as dekit config and keeps the generated commands
	// recognisable by the router.
	frag := p.Files[0]
	if !frag.Created || !strings.Contains(frag.After, "shop/install:") {
		t.Fatalf("fragment:\n%s", frag.After)
	}
	if p.Files[1].Before != "" || !strings.Contains(p.Files[1].After, "- .portplane/tasks.yaml") {
		t.Fatalf("dekit.yaml:\n%s", p.Files[1].After)
	}

	res, err := Apply(context.Background(), folder, p.Digest, Overrides{}, Options{GOOS: "linux"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Written) != 2 {
		t.Fatalf("written %v", res.Written)
	}
	cfg, err := dekit.LoadConfig(folder)
	if err != nil || len(cfg.Warnings) != 0 {
		t.Fatalf("generated config: %v %v", err, cfg.Warnings)
	}
	web2 := cfg.Task("shop/web")
	if web2 == nil || web2.Dir != filepath.Join(folder, "Shop", "apps", "web") || !reflect.DeepEqual(web2.Deps, []string{"shop/install"}) {
		t.Fatalf("parsed web task: %+v", web2)
	}
	if w := portless.ParseCommand(web2.Cmd); w == nil || w.Name != "shop" {
		t.Fatalf("router cannot read the command: %q", web2.Cmd)
	}
	if install := cfg.Task("shop/install"); install == nil || install.Kind != "job" {
		t.Fatalf("install: %+v", install)
	}

	// A second scan finds nothing to change.
	again, err := Propose(context.Background(), folder, Overrides{}, Options{GOOS: "linux"})
	if err != nil {
		t.Fatal(err)
	}
	if len(again.Change.Added)+len(again.Change.Changed)+len(again.Change.Removed) != 0 || again.Files[0].Changed || again.Files[1].Changed {
		t.Fatalf("second scan should be a no-op: %+v", again.Change)
	}
	// A stale digest is refused.
	if _, err := Apply(context.Background(), folder, p.Digest, Overrides{}, Options{GOOS: "linux"}); !errors.Is(err, ErrStale) {
		t.Fatalf("stale apply: %v", err)
	}
}

func TestOverridesAndEditedNames(t *testing.T) {
	folder := makeFolder(t)
	ov := Overrides{Names: map[string]string{"shop/admin": "Backoffice.Shop.localhost"}, Skip: map[string]bool{"shop/studio": true}}
	p, err := Propose(context.Background(), folder, ov, Options{GOOS: "linux"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(context.Background(), folder, p.Digest, ov, Options{GOOS: "linux"}); err != nil {
		t.Fatal(err)
	}
	frag, _ := os.ReadFile(filepath.Join(folder, ".portplane", "tasks.yaml"))
	if !strings.Contains(string(frag), `"portless", "backoffice.shop"`) || strings.Contains(string(frag), "shop/studio:") {
		t.Fatalf("overrides not applied:\n%s", frag)
	}
	// Without overrides, the next scan keeps the edited name from the fragment.
	p2, _ := Propose(context.Background(), folder, Overrides{}, Options{GOOS: "linux"})
	for _, a := range p2.Apps {
		if a.Task == "shop/admin" && a.Name != "backoffice.shop" {
			t.Fatalf("edited name lost: %+v", a)
		}
	}
}

func TestHandWrittenTasksWin(t *testing.T) {
	folder := makeFolder(t)
	write(t, filepath.Join(folder, "dekit.yaml"), "# mine\ntasks:\n  blog/web:\n    cwd: blog\n    cmd: [\"portless\", \"myblog\", \"npm\", \"run\", \"dev\"]\nload:\n  - other/*.yaml\n")
	write(t, filepath.Join(folder, "other", "x.yaml"), "tasks:\n  extra:\n    cmd: [\"true\"]\n")
	p, err := Propose(context.Background(), folder, Overrides{}, Options{GOOS: "linux"})
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range p.Apps {
		if a.Task == "blog/web" && (a.Status != "manual" || !a.Skipped) {
			t.Fatalf("hand-written task must win: %+v", a)
		}
	}
	after := p.Files[1].After
	if !strings.HasPrefix(after, "# mine\n") || !strings.Contains(after, "  - other/*.yaml\n  - .portplane/tasks.yaml\n") {
		t.Fatalf("dekit.yaml edit:\n%s", after)
	}
}

func TestEnsureLoad(t *testing.T) {
	got, err := ensureLoad("tasks:\n  a:\n    cmd: x\n")
	if err != nil || got != "tasks:\n  a:\n    cmd: x\nload:\n  - .portplane/tasks.yaml\n" {
		t.Fatalf("append: %q %v", got, err)
	}
	same := "load:\n- .portplane/tasks.yaml\n"
	if got, _ := ensureLoad(same); got != same {
		t.Fatalf("already there: %q", got)
	}
	got, err = ensureLoad("load:\n- file: a.yaml\n  at: web\ntasks: {}\n")
	if err != nil || got != "load:\n- file: a.yaml\n  at: web\n- .portplane/tasks.yaml\ntasks: {}\n" {
		t.Fatalf("mapping items: %q %v", got, err)
	}
	if _, err := ensureLoad("load: [a.yaml]\n"); err == nil {
		t.Fatal("inline lists are left to the user")
	}
}

func TestWindowsCommands(t *testing.T) {
	got := command(Options{GOOS: "windows"}, []string{"portless", "shop", "pnpm", "run", "dev"})
	if !reflect.DeepEqual(got, []string{"cmd", "/c", "portless shop pnpm run dev"}) {
		t.Fatalf("got %q", got)
	}
	if w := portless.ParseCommand(got); w == nil || w.Name != "shop" {
		t.Fatalf("router must read cmd /c commands: %+v", w)
	}
}

func TestEvaluate(t *testing.T) {
	c := Evaluate(Facts{GOOS: "darwin", Node: "v22.1.0"})
	if c.Ready {
		t.Fatal("nothing installed is not ready")
	}
	byID := map[string]Requirement{}
	for _, r := range c.Requirements {
		byID[r.ID] = r
	}
	if byID["node"].OK || byID["dekit"].Commands[0] != "curl -fsSL https://dekit.run/install.sh | sh" || !byID["proxy"].Privilege {
		t.Fatalf("report: %+v", c)
	}
	c = Evaluate(Facts{GOOS: "windows", Node: "v24.2.0", Dekit: "0.10.3", Portless: "0.16.0"})
	if !c.Ready {
		t.Fatalf("should be ready: %+v", c)
	}
}

func TestFrameworkAndPorts(t *testing.T) {
	cases := []struct {
		script, fw, port string
	}{
		{"next dev -p 3005", "next", "3005"},
		{"cross-env NODE_ENV=development vite --port=5174", "vite", "5174"},
		{"PORT=4000 node server.js", "node", "4000"},
		{"pnpm exec astro dev", "astro", ""},
		{"react-router dev", "react-router", ""},
		{"remotion studio", "remotion", ""},
	}
	for _, c := range cases {
		if fw := detectFramework(c.script, nil); fw != c.fw {
			t.Errorf("%q: framework %s, want %s", c.script, fw, c.fw)
		}
		if p := hardPort(c.script); p != c.port {
			t.Errorf("%q: port %q, want %q", c.script, p, c.port)
		}
	}
	if Label("@Scope/My_App") != "my-app" {
		t.Error(Label("@Scope/My_App"))
	}
}

func TestParseWorktrees(t *testing.T) {
	out := []byte("worktree /r/shop\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/shop-feat\nHEAD def\nbranch refs/heads/feat\n\nworktree /r/gone\nHEAD 123\nprunable gitdir file points to non-existent location\n")
	got := parseWorktrees(out)
	if len(got) != 2 || got[0].Worktree != "" || got[1].Worktree != "shop-feat" || got[1].Branch != "feat" {
		t.Fatalf("got %+v", got)
	}
}
