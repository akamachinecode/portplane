package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/portless"
)

// Sharing, compose projects and LAN mode run against the fake portless,
// fake tailscale/ngrok/docker output (the fixture's Tool) and temporary
// files. Nothing here runs a real tunnel, container or portless command.

func fixture(t *testing.T, parts ...string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(append([]string{"..", "portless", "testdata", "0.16"}, parts...)...))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func (f *portlessFixture) providers(t *testing.T) map[string]ShareProvider {
	t.Helper()
	ov := decodeBody[SharingOverview](t, f.do("GET", "/api/portless/sharing", nil))
	out := map[string]ShareProvider{}
	for _, p := range ov.Providers {
		out[p.Kind] = p
	}
	return out
}

func missingIDs(reqs []Requirement) string {
	var ids []string
	for _, r := range missing(reqs) {
		ids = append(ids, r.ID)
	}
	return strings.Join(ids, ",")
}

// routeWithShares writes routes.json with the app's route alive (this
// process's PID) and the given share fields.
func (f *portlessFixture) routeWithShares(hostname string, fields map[string]any) {
	e := map[string]any{"hostname": hostname, "port": 4600, "pid": os.Getpid()}
	for k, v := range fields {
		e[k] = v
	}
	b, _ := json.Marshal([]any{e, map[string]any{"hostname": "other.localhost", "port": 4700, "pid": os.Getpid(), "ngrokUrl": "https://other.ngrok-free.app"}})
	write(f.t, filepath.Join(f.state, "routes.json"), string(b))
}

func TestPortlessSharing(t *testing.T) {
	f := newPortlessFixture(t)
	f.setupProject(t)
	root := f.projectDir()
	id := func(task string) string { return root + "#" + task }
	f.programs["tailscale"] = "/usr/bin/tailscale"
	f.programs["ngrok"] = "/usr/local/bin/ngrok"
	f.tools["tailscale status --json"] = fixture(t, "tailscale", "status-running.json")
	f.tools["tailscale debug prefs"] = fixture(t, "tailscale", "debug-prefs.json")

	prov := f.providers(t)
	if !prov["tailscale"].Ready || prov["tailscale"].Where != "https://workstation.tail4c2a.ts.net" {
		t.Fatalf("tailscale %+v", prov["tailscale"])
	}
	if missingIDs(prov["funnel"].Requirements) != "tailscale-funnel" || !strings.Contains(missing(prov["funnel"].Requirements)[0].URL, "node=nAbCdEf1CNTRL") {
		t.Errorf("funnel %+v", prov["funnel"])
	}
	if r := missing(prov["ngrok"].Requirements); len(r) != 1 || r[0].ID != "ngrok-authtoken" || r[0].Action != "ngrok-authtoken" {
		t.Errorf("ngrok %+v", prov["ngrok"])
	}
	if r := missing(prov["cloudflare"].Requirements); len(r) != 1 || r[0].ID != "cloudflared-installed" || r[0].URL == "" || !prov["cloudflare"].Public {
		t.Errorf("cloudflare %+v", prov["cloudflare"])
	}

	info := decodeBody[ShareInfo](t, f.do("GET", "/api/portless/share?machine=local&app="+id("shop/web"), nil))
	if !info.Editable || info.Source != portless.SourceFragment || len(info.On) != 0 || !info.Running || len(info.Providers) != 4 {
		t.Fatalf("info %+v", info)
	}
	for task, reason := range map[string]string{"shop/js": "JavaScript", "shop/admin": "doesn't run through portless"} {
		if info := decodeBody[ShareInfo](t, f.do("GET", "/api/portless/share?app="+id(task), nil)); info.Editable || !strings.Contains(info.Reason, reason) {
			t.Errorf("%s: %+v", task, info)
		}
	}
	if rec := f.do("GET", "/api/portless/share?machine=box&app="+id("shop/web"), nil); rec.Code != http.StatusBadRequest {
		t.Errorf("remote: %d", rec.Code)
	}

	// On the tailnet: the flag goes in the fragment, behind a diff.
	pv := decodeBody[SharePreview](t, f.do("POST", "/api/portless/share/preview", shareRequest{App: id("shop/web"), Kind: "tailscale", On: true}))
	if pv.Problem != "" || pv.Public || len(pv.Files) != 1 || !strings.Contains(pv.Files[0].After, `["portless", "shop", "--tailscale", "pnpm", "run", "dev"]`) {
		t.Fatalf("preview %+v", pv)
	}
	if got := strings.Join(pv.Steps, ", "); got != "Write tasks.yaml, Reload dekit, Restart web, Wait for the shared address" {
		t.Errorf("steps %s", got)
	}
	if rec := f.do("POST", "/api/portless/share/apply", shareRequest{App: id("shop/web"), Kind: "tailscale", On: true, Digest: "old"}); rec.Code != http.StatusConflict {
		t.Errorf("stale digest: %d", rec.Code)
	}
	// portless records the URL when the app starts again.
	f.onRestart = func(string) {
		f.routeWithShares("shop.localhost", map[string]any{"tailscaleUrl": "https://workstation.tail4c2a.ts.net", "tailscaleHttpsPort": 443})
	}
	job := f.wait(decodeBody[jobs.Job](t, f.do("POST", "/api/portless/share/apply", shareRequest{App: id("shop/web"), Kind: "tailscale", On: true, Digest: pv.Digest})))
	if job.State != jobs.Succeeded {
		t.Fatalf("%+v", job)
	}
	if res, _ := json.Marshal(job.Result); !strings.Contains(string(res), `"url":"https://workstation.tail4c2a.ts.net"`) {
		t.Errorf("result %s", res)
	}
	b, _ := os.ReadFile(filepath.Join(root, ".portplane", "tasks.yaml"))
	if !strings.Contains(string(b), `"--tailscale"`) || strings.Join(f.restarts, ",") != "shop/web" {
		t.Fatalf("%s %v", b, f.restarts)
	}

	ov := decodeBody[SharingOverview](t, f.do("GET", "/api/portless/sharing", nil))
	if len(ov.Shares) != 2 {
		t.Fatalf("shares %+v", ov.Shares)
	}
	for _, s := range ov.Shares {
		switch s.Hostname {
		case "shop.localhost":
			if !s.Editable || s.Kind != "tailscale" || s.Public || s.Owner == nil || s.Owner.AppID != id("shop/web") {
				t.Errorf("own share %+v", s)
			}
		case "other.localhost":
			if s.Editable || !s.Public || !strings.Contains(s.Reason, "outside Portplane") {
				t.Errorf("other share %+v", s)
			}
		}
	}

	// ngrok needs its authtoken first.
	pv = decodeBody[SharePreview](t, f.do("POST", "/api/portless/share/preview", shareRequest{App: id("shop/web"), Kind: "ngrok", On: true}))
	if pv.Problem == "" || len(pv.Missing) != 1 || pv.Missing[0].ID != "ngrok-authtoken" || len(pv.Files) != 0 {
		t.Fatalf("ngrok not ready %+v", pv)
	}
	if rec := f.do("POST", "/api/portless/sharing/ngrok-authtoken", map[string]string{"token": "nope"}); rec.Code != http.StatusBadRequest {
		t.Errorf("bad token: %d", rec.Code)
	}
	token := "2abcDEFghiJKLmnoPQRstuVWX_0123456789abcdefGHIJ"
	if rec := f.do("POST", "/api/portless/sharing/ngrok-authtoken", map[string]string{"token": token}); rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), token) {
		t.Fatalf("token: %d %s", rec.Code, rec.Body.String())
	}
	if len(f.execs) != 1 || strings.Join(f.execs[0], " ") != "/usr/local/bin/ngrok config add-authtoken "+token {
		t.Fatalf("execs %v", f.execs)
	}
	write(t, filepath.Join(f.home, ".config", "ngrok", "ngrok.yml"), fixture(t, "ngrok", "ngrok-v3.yml"))

	// A public share needs the confirmation.
	pv = decodeBody[SharePreview](t, f.do("POST", "/api/portless/share/preview", shareRequest{App: id("shop/web"), Kind: "ngrok", On: true}))
	if pv.Problem != "" || !pv.Public || !strings.Contains(strings.Join(pv.Warnings, " "), "Anyone on the internet") || !strings.Contains(pv.Files[0].After, `"--ngrok", "--tailscale"`) {
		t.Fatalf("ngrok %+v", pv)
	}
	if rec := f.do("POST", "/api/portless/share/apply", shareRequest{App: id("shop/web"), Kind: "ngrok", On: true, Digest: pv.Digest}); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "confirmation") {
		t.Fatalf("unconfirmed: %d %s", rec.Code, rec.Body.String())
	}
	f.onRestart = func(string) {
		f.routeWithShares("shop.localhost", map[string]any{"tailscaleUrl": "https://workstation.tail4c2a.ts.net", "ngrokUrl": "https://3f2a.ngrok-free.app", "ngrokPid": 51200})
	}
	job = f.wait(decodeBody[jobs.Job](t, f.do("POST", "/api/portless/share/apply", shareRequest{App: id("shop/web"), Kind: "ngrok", On: true, Digest: pv.Digest, ConfirmPublic: true})))
	if job.State != jobs.Succeeded {
		t.Fatalf("ngrok job %+v", job)
	}
	if info := decodeBody[ShareInfo](t, f.do("GET", "/api/portless/share?app="+id("shop/web"), nil)); strings.Join(info.On, ",") != "tailscale,ngrok" || len(info.Shared) != 2 {
		t.Fatalf("after %+v", info)
	}

	// Already on, and Funnel replaces the tailnet share.
	if pv := decodeBody[SharePreview](t, f.do("POST", "/api/portless/share/preview", shareRequest{App: id("shop/web"), Kind: "ngrok", On: true})); !strings.Contains(pv.Problem, "already shared") {
		t.Errorf("twice %+v", pv)
	}
	f.tools["tailscale status --json"] = fixture(t, "tailscale", "status-funnel.json")
	pv = decodeBody[SharePreview](t, f.do("POST", "/api/portless/share/preview", shareRequest{App: id("shop/web"), Kind: "funnel", On: true}))
	if pv.Problem != "" || pv.Replaces != "tailscale" || !strings.Contains(pv.Files[0].After, `"--funnel", "--ngrok"`) || strings.Contains(pv.Files[0].After, "--tailscale") {
		t.Fatalf("funnel %+v", pv)
	}

	// Stopping: no wait for an address; a share that never ends doesn't hang.
	pv = decodeBody[SharePreview](t, f.do("POST", "/api/portless/share/preview", shareRequest{App: id("shop/web"), Kind: "ngrok", On: false}))
	if pv.Problem != "" || pv.Public || strings.Contains(strings.Join(pv.Steps, ","), "Wait") {
		t.Fatalf("stop %+v", pv)
	}
	f.onRestart = nil
	if job := f.wait(decodeBody[jobs.Job](t, f.do("POST", "/api/portless/share/apply", shareRequest{App: id("shop/web"), Kind: "ngrok", On: false, Digest: pv.Digest}))); job.State != jobs.Succeeded {
		t.Fatalf("stop job %+v", job)
	}
	b, _ = os.ReadFile(filepath.Join(root, ".portplane", "tasks.yaml"))
	if strings.Contains(string(b), "--ngrok") {
		t.Fatalf("still shared: %s", b)
	}

	// Started but portless never reports an address: the job says so.
	write(t, filepath.Join(f.state, "routes.json"), "[]")
	pv = decodeBody[SharePreview](t, f.do("POST", "/api/portless/share/preview", shareRequest{App: id("shop/api"), Kind: "tailscale", On: true}))
	if got := strings.Join(pv.Steps, ", "); got != "Write dekit.yaml, Reload dekit, Start api, Wait for the shared address" {
		t.Fatalf("stopped app %s", got)
	}
	job = f.wait(decodeBody[jobs.Job](t, f.do("POST", "/api/portless/share/apply", shareRequest{App: id("shop/api"), Kind: "tailscale", On: true, Digest: pv.Digest})))
	if job.State != jobs.Failed || !strings.Contains(job.Error, "didn't report a shared address") || strings.Join(f.starts, ",") != "shop/api" {
		t.Fatalf("no address %+v %v", job, f.starts)
	}
}

func TestPortlessSharingRequirements(t *testing.T) {
	f := newPortlessFixture(t)
	// Nothing installed.
	prov := f.providers(t)
	for kind, want := range map[string]string{"tailscale": "tailscale-installed", "funnel": "tailscale-installed", "ngrok": "ngrok-installed,ngrok-authtoken", "cloudflare": "cloudflared-installed"} {
		if got := missingIDs(prov[kind].Requirements); got != want || prov[kind].Ready {
			t.Errorf("%s: %s", kind, got)
		}
	}
	// Signed out, then signed in without HTTPS and without being the operator.
	f.programs["tailscale"] = "/usr/bin/tailscale"
	f.tools["tailscale status --json"] = fixture(t, "tailscale", "status-loggedout.json")
	if r := missing(f.providers(t)["tailscale"].Requirements); len(r) != 1 || r[0].ID != "tailscale-running" || r[0].Command != "sudo tailscale up" {
		t.Errorf("logged out %+v", r)
	}
	f.tools["tailscale status --json"] = fixture(t, "tailscale", "status-nohttps.json")
	f.tools["tailscale debug prefs"] = `{"OperatorUser": ""}`
	r := missing(f.providers(t)["tailscale"].Requirements)
	if len(r) != 2 || r[0].ID != "tailscale-https" || r[1].ID != "tailscale-operator" || r[1].Action != "tailscale-operator" || r[1].Command != "sudo tailscale set --operator=dev" {
		t.Fatalf("no https %+v", r)
	}
	plan := decodeBody[Plan](t, f.do("POST", "/api/portless/actions/tailscale-operator/plan", nil))
	if !plan.Admin || len(plan.Steps) != 1 || strings.Join(plan.Steps[0].Argv, " ") != "/usr/bin/tailscale set --operator=dev" {
		t.Fatalf("plan %+v", plan)
	}
	job := f.wait(decodeBody[jobs.Job](t, f.do("POST", "/api/portless/actions/tailscale-operator", nil)))
	if job.State != jobs.Succeeded || len(f.elevated) != 1 {
		t.Fatalf("%+v %v", job, f.elevated)
	}
	// The daemon isn't running.
	delete(f.tools, "tailscale status --json")
	f.toolErrs["tailscale status --json"] = errors.New("tailscale status --json: failed to connect to local tailscaled; it doesn't appear to be running")
	if r := missing(f.providers(t)["tailscale"].Requirements); len(r) != 1 || r[0].Command != "sudo systemctl enable --now tailscaled" {
		t.Errorf("daemon down %+v", r)
	}
	// No real tool ran.
	for _, c := range f.toolCalls {
		if !strings.HasPrefix(c, "tailscale ") {
			t.Errorf("unexpected tool call %q", c)
		}
	}
}

// composeProject sets up compose state, a compose file and fake Docker.
func (f *portlessFixture) composeProject(t *testing.T) (string, string) {
	t.Helper()
	for _, n := range []string{"shop.json", "shop.ports.json", "blog.ports.json"} {
		write(t, filepath.Join(f.state, "compose", n), fixture(t, "compose", n))
	}
	write(t, filepath.Join(f.state, "routes.json"), `[
  {"hostname": "web.shop.localhost", "port": 14001, "pid": 0},
  {"hostname": "backend.shop.localhost", "port": 14002, "pid": 0},
  {"hostname": "8080.backend.shop.localhost", "port": 14002, "pid": 0},
  {"hostname": "docs.localhost", "port": 4519, "pid": 0}
]`)
	dir := filepath.Join(f.project, "shop")
	file := filepath.Join(dir, "compose.yaml")
	write(t, file, "# the shop\nservices:\n  web:\n    build: ./web\n    ports:\n      - \"5173:5173\"\n  api:\n    build: ./api\n    labels:\n      portless.name: backend\n    ports:\n      - \"8080:8080\"\n      - \"9229:9229\"\n")
	f.programs["docker"] = "/usr/bin/docker"
	f.tools["docker compose version --short"] = "2.40.3\n"
	f.tools[`docker ps -a --filter label=com.docker.compose.project=shop --format {{.Label "com.docker.compose.project.working_dir"}}`] = dir + "\n" + dir + "\n"
	f.listen = []Listener{{Port: 14001, PID: 3001, Process: "docker-proxy"}}
	return dir, file
}

func TestPortlessCompose(t *testing.T) {
	f := newPortlessFixture(t)
	f.memory = filepath.Join(t.TempDir(), "compose-files.json")
	f.handler = f.serve()
	dir, file := f.composeProject(t)

	ov := decodeBody[ComposeOverview](t, f.do("GET", "/api/portless/compose", nil))
	if !ov.Docker || len(ov.Projects) != 2 || ov.TLD != "localhost" {
		t.Fatalf("%+v", ov)
	}
	blog, shop := ov.Projects[0], ov.Projects[1]
	if blog.Name != "blog" || blog.State != "stopped" || blog.File != "" || blog.Started {
		t.Errorf("blog %+v", blog)
	}
	if shop.State != "running" || shop.File != file || shop.FileFrom != "containers" || len(shop.Routes) != 3 || len(shop.Services) != 5 {
		t.Fatalf("shop %+v", shop)
	}
	for _, r := range shop.Routes {
		want := map[string]string{"web.shop.localhost": "web", "backend.shop.localhost": "api", "8080.backend.shop.localhost": "api"}[r.Hostname]
		if r.Service != want || r.URL == "" {
			t.Errorf("route %+v", r)
		}
	}

	// Start and stop: what runs, then the job.
	if pl := decodeBody[ComposePlan](t, f.do("POST", "/api/portless/compose/preview", composeRequest{Op: "up", Project: "blog"})); !strings.Contains(pl.Problem, "can't find") {
		t.Errorf("blog has no file: %+v", pl)
	}
	pl := decodeBody[ComposePlan](t, f.do("POST", "/api/portless/compose/preview", composeRequest{Op: "down", Project: "shop"}))
	if pl.Problem != "" || pl.Dir != dir || strings.Join(pl.Argv[1:], " ") != "compose -p shop -f "+file+" down" || !strings.Contains(pl.Summary, "Volumes and images stay") {
		t.Fatalf("down %+v", pl)
	}
	for _, bad := range []composeRequest{{Op: "build"}, {Op: "down"}, {Op: "up", File: "relative/compose.yaml"}, {Op: "up", File: filepath.Join(dir, "missing.yaml")}, {Op: "up", File: filepath.Join(f.project, "dekit.yaml.txt")}} {
		if rec := f.do("POST", "/api/portless/compose/preview", bad); rec.Code != http.StatusBadRequest {
			t.Errorf("%+v: %d", bad, rec.Code)
		}
	}
	job := f.wait(decodeBody[jobs.Job](t, f.do("POST", "/api/portless/compose/run", composeRequest{Op: "up", File: dir})))
	if job.State != jobs.Succeeded || !strings.Contains(f.calls(), "compose -f "+file+" up -d") {
		t.Fatalf("%+v\n%s", job, f.calls())
	}
	if b, _ := os.ReadFile(f.memory); !strings.Contains(string(b), `"shop": "`+file+`"`) {
		t.Fatalf("not remembered: %s", b)
	}
	job = f.wait(decodeBody[jobs.Job](t, f.do("POST", "/api/portless/compose/run", composeRequest{Op: "down", Project: "shop"})))
	if job.State != jobs.Succeeded || !strings.Contains(f.calls(), "compose -p shop -f "+file+" down") {
		t.Fatalf("%+v\n%s", job, f.calls())
	}

	// After `down` portless forgets the project; Portplane still offers to start it.
	_ = os.Remove(filepath.Join(f.state, "compose", "shop.json"))
	_ = os.Remove(filepath.Join(f.state, "compose", "shop.ports.json"))
	f.handler = f.serve()
	ov = decodeBody[ComposeOverview](t, f.do("GET", "/api/portless/compose", nil))
	if len(ov.Projects) != 2 || ov.Projects[1].Name != "shop" || ov.Projects[1].State != "down" || ov.Projects[1].File != file {
		t.Fatalf("remembered %+v", ov.Projects)
	}

	// Without Docker.
	delete(f.programs, "docker")
	ov = decodeBody[ComposeOverview](t, f.do("GET", "/api/portless/compose", nil))
	if ov.Docker || missingIDs(ov.Requirements) != "docker-installed" {
		t.Errorf("no docker %+v", ov.Requirements)
	}
	if rec := f.do("POST", "/api/portless/compose/run", composeRequest{Op: "up", Project: "shop"}); rec.Code != http.StatusBadRequest {
		t.Errorf("ran without docker: %d", rec.Code)
	}
}

func TestPortlessComposeRename(t *testing.T) {
	f := newPortlessFixture(t)
	_, file := f.composeProject(t)

	info := decodeBody[NameInfo](t, f.do("GET", "/api/portless/names?route=web.shop.localhost", nil))
	if info.Source != portless.SourceCompose || info.Service != "web" || info.Name != "web" || info.Suffix != "shop.localhost" || !info.Editable || !info.Running || info.File != file || len(info.Notes) != 1 {
		t.Fatalf("%+v", info)
	}
	if rec := f.do("GET", "/api/portless/names?route=docs.localhost", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("an alias isn't renamed by route: %d", rec.Code)
	}
	if rec := f.do("GET", "/api/portless/names?route=gone.localhost", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("unknown route: %d", rec.Code)
	}
	for name, problem := range map[string]string{"store.v2": "without dots", "backend": "api service", "web": "has now", "a_b": "letters, digits and dashes"} {
		pv := decodeBody[NamePreview](t, f.do("POST", "/api/portless/names/preview", nameRequest{Route: "web.shop.localhost", Name: name}))
		if !strings.Contains(pv.Problem, problem) {
			t.Errorf("%q: %q", name, pv.Problem)
		}
	}
	pv := decodeBody[NamePreview](t, f.do("POST", "/api/portless/names/preview", nameRequest{Route: "web.shop.localhost", Name: "store.shop.localhost"}))
	if pv.Problem != "" || pv.Hostname != "store.shop.localhost" || len(pv.Files) != 1 || !strings.Contains(pv.Files[0].After, "      - \"5173:5173\"\n    labels:\n      portless.name: store\n  api:") {
		t.Fatalf("%+v", pv)
	}
	if got := strings.Join(pv.Steps, ", "); got != "Write compose.yaml, Start shop again with the new name, Remove the old address" {
		t.Errorf("steps %s", got)
	}
	job := f.wait(decodeBody[jobs.Job](t, f.do("POST", "/api/portless/names/apply", nameRequest{Route: "web.shop.localhost", Name: "store", Digest: pv.Digest})))
	if job.State != jobs.Succeeded {
		t.Fatalf("%+v", job)
	}
	calls := f.calls()
	if !strings.Contains(calls, "compose -p shop -f "+file+" up -d") || !strings.Contains(calls, "alias --remove web.shop.localhost") {
		t.Fatalf("calls %s", calls)
	}
	if b, _ := os.ReadFile(file); !strings.Contains(string(b), "portless.name: store") || !strings.HasPrefix(string(b), "# the shop\n") {
		t.Fatalf("%s", b)
	}

	// A service with several ports changes every address.
	pv = decodeBody[NamePreview](t, f.do("POST", "/api/portless/names/preview", nameRequest{Route: "backend.shop.localhost", Name: "service"}))
	if pv.Problem != "" || !strings.Contains(strings.Join(pv.Warnings, " "), "several ports") || !strings.Contains(pv.Files[0].After, "portless.name: service") {
		t.Fatalf("api %+v", pv)
	}
}

func TestPortlessLAN(t *testing.T) {
	f := newPortlessFixture(t)
	f.setupProject(t)
	write(t, filepath.Join(f.state, "routes.json"), `[
  {"hostname": "shop.localhost", "port": 4600, "pid": `+strconv.Itoa(os.Getpid())+`},
  {"hostname": "portplane.localhost", "port": 39001, "pid": 0},
  {"hostname": "gone.localhost", "port": 4601, "pid": 999999999}
]`)
	v := decodeBody[LANView](t, f.do("GET", "/api/portless/lan", nil))
	if v.Enabled || v.Ready || !v.MDNS.Supported || v.MDNS.Installed || missingIDs(v.Requirements) != "mdns-tool" || missing(v.Requirements)[0].Command != "sudo dnf install avahi-tools" {
		t.Fatalf("no avahi %+v", v)
	}
	if len(v.Addresses) != 1 || !v.Addresses[0].Default || v.Addresses[0].IP != "192.168.1.20" {
		t.Errorf("addresses %+v", v.Addresses)
	}
	if len(v.Apps) != 1 || v.Apps[0].Hostname != "shop.local" || v.Apps[0].Route != "shop.localhost" || v.Apps[0].AppID == "" || !strings.HasPrefix(v.Apps[0].URL, "https://shop.local:") {
		t.Fatalf("apps %+v", v.Apps)
	}
	if v.Options.LAN || v.Options.Port != 443 || !v.ServiceInstalled {
		t.Errorf("options %+v", v.Options)
	}

	f.programs["avahi-publish-address"] = "/usr/bin/avahi-publish-address"
	f.programs["systemctl"] = "/usr/bin/systemctl"
	f.tools["systemctl is-active avahi-daemon"] = "inactive\n"
	f.toolErrs["systemctl is-active avahi-daemon"] = errors.New("exit status 3")
	v = decodeBody[LANView](t, f.do("GET", "/api/portless/lan", nil))
	if r := missing(v.Requirements); len(r) != 1 || r[0].ID != "avahi-daemon" || r[0].Command != "sudo systemctl enable --now avahi-daemon" {
		t.Fatalf("avahi daemon %+v", v.Requirements)
	}
	f.tools["systemctl is-active avahi-daemon"] = "active\n"
	delete(f.toolErrs, "systemctl is-active avahi-daemon")
	if v = decodeBody[LANView](t, f.do("GET", "/api/portless/lan", nil)); !v.Ready {
		t.Fatalf("ready %+v", v.Requirements)
	}

	// The proxy in LAN mode: names are .local already.
	write(t, filepath.Join(f.state, "proxy.lan"), "192.168.1.20\n")
	write(t, filepath.Join(f.state, "routes.json"), `[{"hostname": "shop.local", "port": 4600, "pid": `+strconv.Itoa(os.Getpid())+`}]`)
	v = decodeBody[LANView](t, f.do("GET", "/api/portless/lan", nil))
	if !v.Enabled || v.IP != "192.168.1.20" || len(v.Apps) != 1 || v.Apps[0].Hostname != "shop.local" || v.Apps[0].Route != "shop.local" {
		t.Fatalf("enabled %+v", v)
	}

	// Windows: portless 0.16 has no mDNS publisher there.
	w := newPortlessFixture(t)
	w.goos = "windows"
	w.handler = w.serve()
	v = decodeBody[LANView](t, w.do("GET", "/api/portless/lan", nil))
	if v.MDNS.Supported || missingIDs(v.Requirements) != "lan-os" {
		t.Fatalf("windows %+v", v)
	}
}
