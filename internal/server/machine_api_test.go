package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/akamachinecode/portplane/internal/hub"
	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/remote"
)

// The machine API end to end (ADR-0026): a remote machine's agent runs in
// this process over an in-memory pipe, serving the real setup, dekit and
// portless handlers on fakes; Portplane's own server reaches it at
// /api/m/box/…. No test here opens an SSH connection.

type pipeEnd struct {
	io.Reader
	io.Writer
	closers []io.Closer
}

func (p pipeEnd) Close() error {
	for _, c := range p.closers {
		_ = c.Close()
	}
	return nil
}

// pipePair is the two ends of an agent's stdin and stdout.
func pipePair() (io.ReadWriteCloser, io.ReadWriteCloser) {
	ar, bw := io.Pipe()
	br, aw := io.Pipe()
	return pipeEnd{ar, aw, []io.Closer{ar, aw}}, pipeEnd{br, bw, []io.Closer{br, bw}}
}

type remoteEnv struct {
	t         *testing.T
	url       string
	folder    string // the remote machine's watched folder
	dk        *dekitEnv
	pl        *portlessFixture
	localJobs *jobs.Manager
	downloads string
}

func newRemoteEnv(t *testing.T) *remoteEnv {
	t.Helper()
	// The remote machine: a JS project to set up, a dekit project to edit,
	// portless state to read, and its own jobs.
	folder := t.TempDir()
	write(t, filepath.Join(folder, "shop", "package.json"), `{"name":"shop","private":true,"scripts":{"dev":"vite"},"devDependencies":{"vite":"8.0.0"}}`)
	dk := newDekitEnv(t, "linux", func(_ string, args []string) (string, string, error) {
		s := strings.Join(args, " ")
		switch {
		case strings.Contains(s, "upgrade"):
			return "upgraded 1 runner\n", "", nil
		case strings.HasSuffix(s, "ls --json"):
			return `{"tasks":[]}`, "", nil
		}
		return "", "", errors.New("unexpected dekit " + s)
	})
	pl := newPortlessFixture(t)
	agentJobs := jobs.NewManager()
	dd := *dk.deps
	dd.Jobs = agentJobs
	api := http.NewServeMux()
	routes := SetupHandlers(SetupDeps{Folders: func() []string { return []string{folder} }})
	for p, h := range DekitHandlers(dd) {
		routes[p] = h
	}
	for p, h := range JobHandlers(agentJobs) {
		routes[p] = h
	}
	for p, h := range routes {
		api.HandleFunc(p, h)
	}
	api.Handle("/api/portless/", pl.handler)

	fa := &fakeAgent{snap: model.MachineSnapshot{Machine: model.Machine{ID: "remote", Status: "online"}}}
	serve := func(o remote.ServeOptions) remote.Connector {
		return remote.ConnectorFunc(func(context.Context) (io.ReadWriteCloser, error) {
			client, server := pipePair()
			go func() { _ = remote.ServeWith(context.Background(), server, fa, o) }()
			return client, nil
		})
	}
	box := remote.NewAgent("box", "box", nil, serve(remote.ServeOptions{
		API: api, Jobs: agentJobs,
		OnHello: func(h remote.Hello) { agentJobs.SetMachine(h.Machine) },
	}))
	// An agent from before the machine API: snapshots only.
	old := remote.NewAgent("old", "old-box", nil, serve(remote.ServeOptions{}))
	t.Cleanup(func() {
		_ = box.Close()
		_ = old.Close()
	})

	h := hub.New()
	h.Add("local", &fakeAgent{snap: model.MachineSnapshot{Machine: model.Machine{ID: "local", Local: true, Status: "online"}}}, model.Machine{ID: "local", Local: true})
	h.Add("box", box, model.Machine{ID: "box", Name: "box"})
	h.Add("old", old, model.Machine{ID: "old", Name: "old-box"})
	t.Cleanup(h.Close)

	localJobs := jobs.NewManager()
	localRoutes := http.NewServeMux()
	localRoutes.HandleFunc("GET /api/portless/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"local": true})
	})
	env := &remoteEnv{t: t, folder: folder, dk: dk, pl: pl, localJobs: localJobs, downloads: t.TempDir()}
	s := &Server{
		Hub: h, Token: "secret", Jobs: localJobs,
		UI: fstest.MapFS{"index.html": {Data: []byte("ui")}},
		Extra: MachineAPIHandlers(MachineAPIDeps{
			Local:  "local",
			Routes: localRoutes,
			Machine: func(id string) (MachineTunnel, string, error) {
				switch id {
				case "box":
					box.MirrorJobs(localJobs)
					return box, "box", nil
				case "old":
					return old, "old-box", nil
				}
				return nil, "", fmt.Errorf("unknown machine %q", id)
			},
			Downloads: func() string { return env.downloads },
		}),
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	s.Port, _ = strconv.Atoi(u.Port())
	env.url = srv.URL

	// Both machines come online.
	deadline := time.Now().Add(5 * time.Second)
	for _, id := range []string{"box", "old"} {
		for {
			if snap := h.Snapshot(); online(snap, id) {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s never came online", id)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	return env
}

func online(s model.Snapshot, id string) bool {
	for _, m := range s.Machines {
		if m.Machine.ID == id {
			return m.Machine.Status == "online"
		}
	}
	return false
}

func (e *remoteEnv) do(method, path string, body any, token bool) (int, []byte) {
	e.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = strings.NewReader(string(b))
	}
	req, _ := http.NewRequestWithContext(context.Background(), method, e.url+path, r)
	if token {
		req.Header.Set("X-Portplane-Token", "secret")
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, b
}

// jobEvents follows the event stream and hands over every job event.
func (e *remoteEnv) jobEvents(ctx context.Context) <-chan jobs.Job {
	e.t.Helper()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, e.url+"/api/events?token=secret", nil)
	res, err := http.DefaultClient.Do(req) //nolint:bodyclose // the reader below closes it
	if err != nil {
		e.t.Fatal(err)
	}
	out := make(chan jobs.Job, 64)
	go func() {
		defer func() { _ = res.Body.Close() }()
		sc := bufio.NewScanner(res.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		event := ""
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: ") && event == "job":
				var j jobs.Job
				if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &j) == nil {
					out <- j
				}
			}
		}
	}()
	return out
}

func TestMachineAPIRoutes(t *testing.T) {
	e := newRemoteEnv(t)
	// The token check stays on this side.
	if code, _ := e.do("GET", "/api/m/box/portless/routes", nil, false); code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", code)
	}
	// This computer is served here.
	if code, b := e.do("GET", "/api/m/local/portless/status", nil, true); code != 200 || !strings.Contains(string(b), `"local":true`) {
		t.Fatalf("local: %d %s", code, b)
	}
	// Only the areas that act on one machine travel.
	for _, p := range []string{"/api/m/box/machines", "/api/m/box/preferences", "/api/m/box/jobs", "/api/m/local/settings"} {
		if code, _ := e.do("GET", p, nil, true); code != http.StatusNotFound {
			t.Errorf("%s: %d", p, code)
		}
	}
	if code, _ := e.do("GET", "/api/m/nowhere/portless/routes", nil, true); code != http.StatusNotFound {
		t.Fatalf("unknown machine: %d", code)
	}
}

func TestMachineAPISetupScan(t *testing.T) {
	e := newRemoteEnv(t)
	code, b := e.do("POST", "/api/m/box/setup/scan", map[string]any{"folder": e.folder, "overrides": map[string]any{}}, true)
	if code != 200 {
		t.Fatalf("scan: %d %s", code, b)
	}
	var p struct {
		Apps []struct {
			Task     string `json:"task"`
			Hostname string `json:"hostname"`
		} `json:"apps"`
	}
	_ = json.Unmarshal(b, &p)
	if len(p.Apps) != 1 || p.Apps[0].Hostname != "shop.localhost" {
		t.Fatalf("the remote folder's apps: %s", b)
	}
	// Folders the machine does not watch are refused there.
	if code, b := e.do("POST", "/api/m/box/setup/scan", map[string]any{"folder": t.TempDir(), "overrides": map[string]any{}}, true); code != 400 || !strings.Contains(string(b), "watches") {
		t.Fatalf("unwatched: %d %s", code, b)
	}
}

func TestMachineAPIDekitEditPreview(t *testing.T) {
	e := newRemoteEnv(t)
	root := e.dk.root
	code, b := e.do("GET", "/api/m/box/dekit/config?runner="+url.QueryEscape(root), nil, true)
	if code != 200 {
		t.Fatalf("config: %d %s", code, b)
	}
	var cfg struct {
		Files []struct {
			Path   string `json:"path"`
			Digest string `json:"digest"`
		} `json:"files"`
	}
	_ = json.Unmarshal(b, &cfg)
	main := filepath.Join(root, "dekit.yaml")
	edit := map[string]any{
		"runner":  root,
		"file":    main,
		"digests": map[string]string{main: cfg.Files[0].Digest},
		"ops":     []map[string]any{{"op": "set", "path": []string{"tasks", "api"}, "key": "cmd", "value": []string{"node", "server.js"}}},
	}
	code, b = e.do("POST", "/api/m/box/dekit/config/edit", edit, true)
	var res EditResult
	_ = json.Unmarshal(b, &res)
	if code != 200 || res.Written || len(res.Files) != 1 || !strings.Contains(res.Files[0].After, "server.js") {
		t.Fatalf("preview: %d %s", code, b)
	}
	if now, _ := os.ReadFile(main); strings.Contains(string(now), "server.js") {
		t.Fatal("a preview must not write")
	}
}

func TestMachineAPIPortlessRoutesAndCA(t *testing.T) {
	e := newRemoteEnv(t)
	write(t, filepath.Join(e.pl.state, "routes.json"), `[{"hostname": "db.localhost", "port": 5432, "pid": 0}]`)
	code, b := e.do("GET", "/api/m/box/portless/routes", nil, true)
	var views []RouteView
	_ = json.Unmarshal(b, &views)
	if code != 200 || len(views) != 1 || views[0].Hostname != "db.localhost" {
		t.Fatalf("routes: %d %s", code, b)
	}
	// Without a CA there, nothing is saved here.
	if code, _ := e.do("POST", "/api/m/box/portless/certificates/export", map[string]any{}, true); code != http.StatusNotFound {
		t.Fatalf("export without a CA: %d", code)
	}
	pemText := "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n"
	write(t, filepath.Join(e.pl.state, "ca.pem"), pemText)
	code, b = e.do("POST", "/api/m/box/portless/certificates/export", map[string]any{}, true)
	if code != 200 {
		t.Fatalf("export: %d %s", code, b)
	}
	saved, err := os.ReadFile(filepath.Join(e.downloads, "portless-ca-box.pem"))
	if err != nil || string(saved) != pemText {
		t.Fatalf("the remote CA is saved on this computer: %q %v", saved, err)
	}
}

func TestMachineAPIRemoteJobReachesTheEventStream(t *testing.T) {
	e := newRemoteEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	events := e.jobEvents(ctx)
	code, b := e.do("POST", "/api/m/box/dekit/runners/upgrade-all", map[string]any{}, true)
	var started jobs.Job
	_ = json.Unmarshal(b, &started)
	if code != http.StatusAccepted || !strings.HasPrefix(started.ID, "box:") || started.Machine != "box" {
		t.Fatalf("start: %d %s", code, b)
	}
	for {
		select {
		case j := <-events:
			if j.ID != started.ID {
				continue
			}
			if j.Machine != "box" {
				t.Fatalf("the job says where it runs: %+v", j)
			}
			if !j.Done() {
				continue
			}
			if j.State != jobs.Succeeded || !strings.Contains(strings.Join(j.Output, "\n"), "dekit runner upgrade --all") {
				t.Fatalf("ended: %+v", j)
			}
			// It is a job of this Portplane now, like a local one.
			if code, b := e.do("GET", "/api/jobs/"+url.PathEscape(started.ID), nil, true); code != 200 || !strings.Contains(string(b), `"machine":"box"`) {
				t.Fatalf("get: %d %s", code, b)
			}
			return
		case <-ctx.Done():
			t.Fatal("the remote job never reached the event stream")
		}
	}
}

func TestMachineAPIOlderAgent(t *testing.T) {
	e := newRemoteEnv(t)
	code, b := e.do("GET", "/api/m/old/portless/routes", nil, true)
	var res map[string]string
	_ = json.Unmarshal(b, &res)
	if code != http.StatusNotImplemented || res["code"] != AgentOutdated || !strings.Contains(res["error"], "Update the agent on old-box") {
		t.Fatalf("older agent: %d %s", code, b)
	}
}

func TestIsMachineArea(t *testing.T) {
	for p, want := range map[string]bool{
		"setup/scan": true, "dekit/config": true, "portless/routes": true, "tools/install": true,
		"proxy/start": true, "trust/system": true, "path/profile": true, "folders/suggestions": true,
		"folders/pick": false, "machines": false, "events": false, "jobs/x/cancel": false, "settings": false, "dekitx": false,
	} {
		if got := IsMachineArea(p); got != want {
			t.Errorf("%s: %v", p, got)
		}
	}
}
