package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/portless"
)

// Docker Compose projects (plan §5.9, M5.6): the projects portless knows
// from its compose/ state, their services and routes, and Start and Stop
// through `portless compose up -d` and `down`, as jobs with their output.
// portless keeps no record of the compose file itself, so Portplane finds
// it: the file it last started the project with, a dekit task that runs
// `portless compose`, the folder Docker recorded on the containers, or the
// folders the project's model mentions. Otherwise the user picks it.

// ComposeRoute is one address of a project.
type ComposeRoute struct {
	Hostname string `json:"hostname"`
	URL      string `json:"url"`
	Port     int    `json:"port"`
	Service  string `json:"service,omitempty"`
	// Listening: something answers on the port (the container runs).
	Listening bool `json:"listening"`
}

// ComposeView is one project in GET /api/portless/compose.
type ComposeView struct {
	portless.ComposeProject
	// State: "running" (a routed port answers), "stopped" (routes are
	// there but nothing answers), "down" (portless brought it down; only
	// Portplane remembers it).
	State string `json:"state"`
	// File is the project's compose file; FileFrom how Portplane found it
	// ("remembered", "task", "containers", "guess").
	File     string         `json:"file,omitempty"`
	FileFrom string         `json:"fileFrom,omitempty"`
	Routes   []ComposeRoute `json:"routes"`
}

// ComposeOverview is GET /api/portless/compose.
type ComposeOverview struct {
	Docker       bool          `json:"docker"`
	Requirements []Requirement `json:"requirements"`
	Projects     []ComposeView `json:"projects"`
	TLD          string        `json:"tld"`
}

func (p *portlessAPI) composeRequirements(ctx context.Context) []Requirement {
	cmd, page := hint("docker", p.d.GOOS)
	docker := Requirement{ID: "docker-installed", OK: p.lookup("docker") != "", Label: "Docker is installed"}
	if !docker.OK {
		docker.Problem = "Docker isn't installed, and portless runs compose projects through it."
		docker.Fix = "Install Docker (Docker Desktop on macOS and Windows, Docker Engine on Linux), then check again."
		docker.Command, docker.URL = cmd, page
		return []Requirement{docker}
	}
	compose := Requirement{ID: "docker-compose", OK: true, Label: "Docker Compose is available"}
	if _, err := p.d.Tool(ctx, "docker", "compose", "version", "--short"); err != nil {
		compose.OK = false
		compose.Problem = "docker compose doesn't run here: " + err.Error()
		compose.Fix = "Install the Docker Compose plugin (it comes with Docker Desktop), and make sure Docker is running."
		compose.URL = "https://docs.docker.com/compose/install/"
	}
	return []Requirement{docker, compose}
}

func (p *portlessAPI) composeViews(ctx context.Context) ([]ComposeView, error) {
	projects, err := p.d.Client.ComposeProjects()
	if err != nil {
		return nil, err
	}
	states, _ := p.d.Client.RouteStates()
	proxy := p.d.Client.Proxy()
	listening := map[int]bool{}
	for _, l := range p.d.Listeners(ctx) {
		listening[l.Port] = true
	}
	known := map[string]bool{}
	out := []ComposeView{}
	for _, pr := range projects {
		known[pr.Name] = true
		v := ComposeView{ComposeProject: pr, Routes: []ComposeRoute{}, State: "stopped"}
		for _, s := range states {
			if s.Kind != portless.KindCompose || s.Compose != pr.Name {
				continue
			}
			rt := ComposeRoute{Hostname: s.Hostname, URL: proxy.URL(s.Hostname), Port: s.Port, Listening: listening[s.Port]}
			if svc, ok := pr.ServiceFor(s.Hostname, s.Port); ok {
				rt.Service = svc.Name
			}
			if rt.Listening {
				v.State = "running"
			}
			v.Routes = append(v.Routes, rt)
		}
		v.File, v.FileFrom = p.composeFile(ctx, pr)
		out = append(out, v)
	}
	// Projects Portplane started that portless brought down since.
	for name, file := range p.compose.all() {
		if known[name] {
			continue
		}
		if _, err := os.Stat(file); err != nil {
			continue
		}
		out = append(out, ComposeView{ComposeProject: portless.ComposeProject{Name: name, Label: portless.ComposeLabel(name), Ports: map[string]int{}, Services: []portless.ComposeService{}}, State: "down", File: file, FileFrom: "remembered", Routes: []ComposeRoute{}})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// composeFile finds a project's compose file, and how.
func (p *portlessAPI) composeFile(ctx context.Context, pr portless.ComposeProject) (string, string) {
	if f := p.compose.get(pr.Name); f != "" {
		if _, err := os.Stat(f); err == nil {
			return f, "remembered"
		}
	}
	if f := p.composeFromTasks(ctx, pr.Name); f != "" {
		return f, "task"
	}
	if p.lookup("docker") != "" {
		out, err := p.d.Tool(ctx, "docker", "ps", "-a", "--filter", "label=com.docker.compose.project="+pr.Name, "--format", `{{.Label "com.docker.compose.project.working_dir"}}`)
		if err == nil {
			for _, line := range strings.Split(string(out), "\n") {
				if d := strings.TrimSpace(line); d != "" && filepath.IsAbs(d) {
					if f := portless.FindComposeFile(d); f != "" {
						return f, "containers"
					}
				}
			}
		}
	}
	if f := portless.GuessComposeFile(pr.Name, pr.Dirs); f != "" {
		return f, "guess"
	}
	return "", ""
}

// composeFromTasks looks for a dekit task that runs `portless compose` for
// the project.
func (p *portlessAPI) composeFromTasks(ctx context.Context, project string) string {
	if p.d.Config == nil || p.d.Local == nil {
		return ""
	}
	for _, r := range p.d.Local(ctx).Runners {
		cfg, err := p.d.Config(r.Root)
		if err != nil || cfg == nil {
			continue
		}
		for _, t := range cfg.Tasks {
			c, ok := portless.ParseComposeCommand(t.Cmd)
			if !ok || t.Dir == "" {
				continue
			}
			file := ""
			if len(c.Files) > 0 {
				file = c.Files[0]
				if !filepath.IsAbs(file) {
					file = filepath.Join(t.Dir, file)
				}
			} else {
				file = portless.FindComposeFile(t.Dir)
			}
			if file == "" {
				continue
			}
			if c.Project == project || (c.Project == "" && portless.ComposeFileProject(file) == project) {
				return file
			}
		}
	}
	return ""
}

func (p *portlessAPI) composeOverview(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	views, err := p.composeViews(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	reqs := p.composeRequirements(r.Context())
	writeJSON(w, http.StatusOK, ComposeOverview{Docker: len(missing(reqs)) == 0, Requirements: reqs, Projects: views, TLD: p.d.Client.ProxyState(r.Context()).MainTLD()})
}

type composeRequest struct {
	// Op is "up" (Start) or "down" (Stop).
	Op      string `json:"op"`
	Project string `json:"project,omitempty"`
	File    string `json:"file,omitempty"`
}

// ComposePlan is POST /api/portless/compose/preview: what Start or Stop
// runs, before it runs.
type ComposePlan struct {
	Op       string   `json:"op"`
	Project  string   `json:"project,omitempty"`
	Title    string   `json:"title"`
	Summary  string   `json:"summary"`
	File     string   `json:"file,omitempty"`
	Dir      string   `json:"dir"`
	Argv     []string `json:"argv"`
	Terminal string   `json:"terminal"`
	// Problem: it can't run (no compose file, no Docker).
	Problem string `json:"problem,omitempty"`
	// Warnings: it runs, but something may get in the way.
	Warnings []string `json:"warnings"`
}

func checkComposeFile(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("give the compose file's full path")
	}
	fi, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("there's no file at %s", path)
	}
	if fi.IsDir() {
		if f := portless.FindComposeFile(path); f != "" {
			return nil
		}
		return fmt.Errorf("%s has no compose.yaml or docker-compose.yml", path)
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".yml", ".yaml":
		return nil
	}
	return errors.New("a compose file ends in .yaml or .yml")
}

func (p *portlessAPI) planCompose(ctx context.Context, req composeRequest) (ComposePlan, error) {
	pl := ComposePlan{Op: req.Op, Project: req.Project, Warnings: []string{}}
	if req.Op != "up" && req.Op != "down" {
		return pl, fmt.Errorf("unknown compose operation %q", req.Op)
	}
	if req.Op == "down" && req.Project == "" {
		return pl, errors.New("name the project to stop")
	}
	if p.lookup("docker") == "" {
		pl.Problem = "Docker isn't installed, and portless runs compose projects through it."
	}
	file := strings.TrimSpace(req.File)
	if file != "" {
		if err := checkComposeFile(file); err != nil {
			return pl, err
		}
		if fi, _ := os.Stat(file); fi != nil && fi.IsDir() {
			file = portless.FindComposeFile(file)
		}
	} else if req.Project != "" {
		var pr portless.ComposeProject
		projects, _ := p.d.Client.ComposeProjects()
		for _, x := range projects {
			if x.Name == req.Project {
				pr = x
			}
		}
		if pr.Name == "" {
			pr = portless.ComposeProject{Name: req.Project}
		}
		file, _ = p.composeFile(ctx, pr)
	}
	pl.File = file
	if req.Op == "up" && file == "" && pl.Problem == "" {
		pl.Problem = "Portplane can't find this project's compose file. Choose it to start the project."
	}
	if file != "" {
		pl.Dir = filepath.Dir(file)
	} else {
		pl.Dir = os.TempDir()
	}
	var args []string
	name := req.Project
	if req.Op == "up" {
		args = portless.ComposeUpArgs(req.Project, file)
		if name == "" {
			name = portless.ComposeFileProject(file)
		}
		pl.Title = "Start " + name
		pl.Summary = "Starts the project's containers in the background with portless, which gives each service that publishes an HTTP port an address under ." + portless.ComposeLabel(name) + ". Docker may pull or build images first."
		if !p.d.Client.ProxyState(ctx).Responding {
			pl.Warnings = append(pl.Warnings, "The portless proxy isn't running, so portless starts it first. If that needs your password, it can't ask from here and the start fails: start the proxy in Domains → Proxy, then try again.")
		}
	} else {
		args = portless.ComposeDownArgs(req.Project, file)
		pl.Title = "Stop " + name
		pl.Summary = "Stops and removes the project's containers and networks, and their addresses. Volumes and images stay, so starting it again keeps your data."
	}
	pl.Argv = append([]string{p.d.Client.Path()}, args...)
	pl.Terminal = "cd " + shellLine([]string{pl.Dir}) + " && " + shellLine(pl.Argv)
	return pl, nil
}

func (p *portlessAPI) composePreview(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	var req composeRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	pl, err := p.planCompose(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, pl)
}

func (p *portlessAPI) composeRun(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	if p.d.Jobs == nil {
		writeError(w, http.StatusNotImplemented, errors.New("jobs are not available"))
		return
	}
	var req composeRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	pl, err := p.planCompose(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if pl.Problem != "" {
		writeError(w, http.StatusBadRequest, errors.New(pl.Problem))
		return
	}
	key := "compose|" + req.Project
	if req.Project == "" {
		key = "compose|" + pl.File
	}
	c := p.d.Client
	job := p.d.Jobs.Start(jobs.Spec{Kind: "portless.compose-" + req.Op, Title: pl.Title, Key: key, Steps: []string{pl.Title}}, func(ctx context.Context, run *jobs.Run) error {
		defer p.d.Refresh()
		run.Step(pl.Title)
		run.Logf("$ %s", pl.Terminal)
		out, err := c.ComposeRun(ctx, pl.Dir, run, pl.Argv[1:]...)
		if err != nil {
			return err
		}
		project := req.Project
		if project == "" {
			project = portless.ComposeStartedProject(out)
		}
		if req.Op == "up" && project != "" && pl.File != "" {
			p.compose.set(project, pl.File)
		}
		run.SetResult(map[string]string{"project": project, "file": pl.File})
		return nil
	})
	StartJob(w, job)
}

// composeMemory remembers which compose file started which project, in a
// small JSON file next to Portplane's settings.
type composeMemory struct {
	path  string
	mu    sync.Mutex
	files map[string]string
}

func newComposeMemory(path string) *composeMemory {
	m := &composeMemory{path: path, files: map[string]string{}}
	if path != "" {
		if b, err := os.ReadFile(path); err == nil {
			var v struct {
				Projects map[string]string `json:"projects"`
			}
			if json.Unmarshal(b, &v) == nil && v.Projects != nil {
				m.files = v.Projects
			}
		}
	}
	return m
}

func (m *composeMemory) get(project string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.files[project]
}

func (m *composeMemory) all() map[string]string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]string, len(m.files))
	for k, v := range m.files {
		out[k] = v
	}
	return out
}

func (m *composeMemory) set(project, file string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.files[project] == file {
		return
	}
	m.files[project] = file
	if m.path == "" {
		return
	}
	b, err := json.MarshalIndent(map[string]any{"projects": m.files}, "", "  ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(m.path), 0o700)
	tmp := m.path + ".tmp"
	if os.WriteFile(tmp, append(b, '\n'), 0o600) == nil {
		_ = os.Rename(tmp, m.path)
	}
}
