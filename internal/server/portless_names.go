package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/portless"
)

// Changing an app's name (plan §5.4): find where the name lives, show the
// edit as a diff, then write it, reload dekit and restart the app.

// NameInfo is GET /api/portless/names?machine=&app=.
type NameInfo struct {
	Source   string `json:"source"`         // portless.Source* constants
	Name     string `json:"name"`           // the name as written, or inferred
	Inferred bool   `json:"inferred"`       // portless works the name out itself
	Hostname string `json:"hostname"`       // the hostname now
	Editable bool   `json:"editable"`       // Portplane can change it here
	Reason   string `json:"reason"`         // why not, when not editable
	File     string `json:"file,omitempty"` // the file that holds the name
	// Task is the task whose command holds the name (the alias job for
	// alias-task).
	Task string `json:"task,omitempty"`
	// Target is the config file a `portless run` name goes in.
	Target string `json:"target,omitempty"`
	TLD    string `json:"tld"`
	// RunMode: `portless run`, which puts the worktree prefix in front.
	RunMode bool   `json:"runMode"`
	Prefix  string `json:"prefix,omitempty"`
	Port    int    `json:"port,omitempty"`
	Compose string `json:"compose,omitempty"`
	// Taken are hostnames other apps and routes use.
	Taken []string `json:"taken"`
	Notes []string `json:"notes"`
	// Running: applying restarts the app.
	Running bool   `json:"running"`
	Dir     string `json:"dir,omitempty"`
}

// FileEdit is one file a rename or a config change writes.
type FileEdit struct {
	Path    string `json:"path"`
	Before  string `json:"before"`
	After   string `json:"after"`
	Created bool   `json:"created"`
	Changed bool   `json:"changed"`
}

// NamePreview is POST /api/portless/names/preview.
type NamePreview struct {
	Name     string     `json:"name"`
	Hostname string     `json:"hostname,omitempty"`
	URL      string     `json:"url,omitempty"`
	Problem  string     `json:"problem,omitempty"`
	Files    []FileEdit `json:"files"`
	Steps    []string   `json:"steps"`
	Warnings []string   `json:"warnings"`
	// Digest covers the files as they are now; applying refuses when they
	// changed since.
	Digest string `json:"digest,omitempty"`
}

type nameRequest struct {
	Machine string `json:"machine"`
	App     string `json:"app"`
	Name    string `json:"name"`
	Digest  string `json:"digest,omitempty"`
}

// renameCtx is everything a rename needs, found once.
type renameCtx struct {
	info  NameInfo
	app   model.App
	root  string
	task  *dekit.Task // the task whose cmd holds the name (fragment, task, alias-task)
	proxy portless.ProxyState
}

func (p *portlessAPI) findApp(ctx context.Context, machine, id string) (model.App, model.MachineSnapshot, error) {
	if p.d.Local == nil {
		return model.App{}, model.MachineSnapshot{}, errors.New("no local machine")
	}
	local := p.d.Local(ctx)
	if machine != "" && machine != local.Machine.ID {
		return model.App{}, local, errors.New("names of apps on other machines can be changed on that machine for now; remote machines get this later")
	}
	for _, a := range local.Apps {
		if a.ID == id {
			return a, local, nil
		}
	}
	return model.App{}, local, fmt.Errorf("unknown app %q", id)
}

func (p *portlessAPI) resolveName(ctx context.Context, machine, id string) (*renameCtx, error) {
	app, local, err := p.findApp(ctx, machine, id)
	if err != nil {
		return nil, err
	}
	rc := &renameCtx{app: app, root: app.Runner}
	rc.proxy = p.d.Client.ProxyState(ctx)
	tld := rc.proxy.MainTLD()
	info := &rc.info
	*info = NameInfo{Source: portless.SourceNone, Hostname: app.Hostname, TLD: tld, Taken: []string{}, Notes: []string{}, Running: app.State.Alive(), Dir: app.Dir}

	// Hostnames in use elsewhere.
	taken := map[string]bool{}
	for _, a := range local.Apps {
		if a.ID != app.ID && a.Hostname != "" {
			taken[a.Hostname] = true
		}
	}
	routes, _ := p.d.Client.RouteStates()
	for _, r := range routes {
		if r.Hostname != app.Hostname {
			taken[r.Hostname] = true
		}
	}
	for h := range taken {
		info.Taken = append(info.Taken, h)
	}
	sort.Strings(info.Taken)

	var cfg *dekit.Config
	if p.d.Config != nil {
		cfg, _ = p.d.Config(app.Runner)
	}
	var task *dekit.Task
	if cfg != nil {
		task = cfg.Task(app.Task)
	}
	if task != nil {
		if w := portless.ParseCommand(task.Cmd); w != nil {
			info.RunMode = w.Run
			if w.Name != "" {
				info.Source, info.Name, info.File, info.Task = portless.SourceTask, w.Name, task.File, task.Path
				if portless.IsFragment(task.File) {
					info.Source = portless.SourceFragment
				}
				rc.task = task
				if w.Run {
					info.Prefix = app.Worktree
				}
				p.checkEditable(rc)
				return rc, nil
			}
			// portless run without a name: portless.json or package.json.
			info.Source, info.Dir = portless.SourceConfig, task.Dir
			pc := portless.ReadProjectConfigs(task.Dir)
			info.Target = pc.Wins
			if info.Target == "" {
				info.Target = portless.ConfigFile
			}
			switch {
			case pc.Wins == portless.ConfigFile && pc.Portless.Config != nil && pc.Portless.Config.Name != "":
				info.Name = pc.Portless.Config.Name
			case pc.Wins == portless.PackageFile && pc.Package.Config != nil && pc.Package.Config.Name != "":
				info.Name = pc.Package.Config.Name
			default:
				info.Inferred = true
				info.Name = portless.BaseName(app.Hostname, []string{tld})
				if app.Worktree != "" {
					info.Name = strings.TrimPrefix(info.Name, app.Worktree+".")
				}
			}
			if pc.Portless.Exists && pc.Package.HasConfig {
				info.Notes = append(info.Notes, "This folder has both portless.json and a \"portless\" key in package.json; portless reads portless.json and ignores the other.")
			}
			if pc.Wins == portless.ConfigFile && pc.Portless.Config != nil && len(pc.Portless.Config.Apps) > 0 {
				info.Notes = append(info.Notes, "portless.json here has \"apps\", which portless reads only when it starts every app of a monorepo at once.")
			}
			info.Prefix = app.Worktree
			info.Editable = true
			return rc, nil
		}
		// An alias job the app depends on names it.
		for _, dep := range task.Deps {
			if dt := cfg.Task(dep); dt != nil {
				if name, port, ok := portless.AliasArgs(dt.Cmd); ok {
					info.Source, info.Name, info.File, info.Task = portless.SourceAliasTask, name, dt.File, dt.Path
					fmt.Sscanf(port, "%d", &info.Port) //nolint:errcheck // a non-number leaves 0
					rc.task = dt
					p.checkEditable(rc)
					return rc, nil
				}
			}
		}
	}
	for _, r := range routes {
		if r.Hostname != app.Hostname || app.Hostname == "" {
			continue
		}
		switch r.Kind {
		case portless.KindCompose:
			info.Source, info.Compose = portless.SourceCompose, r.Compose
			info.Name = portless.BaseName(r.Hostname, rc.proxy.TLDs)
			info.Reason = "This name comes from the portless.name label of a docker compose service. Change the label in your compose file; editing it here comes later."
			return rc, nil
		case portless.KindAlias:
			info.Source, info.Port = portless.SourceAlias, r.Port
			info.Name = portless.BaseName(r.Hostname, rc.proxy.TLDs)
			info.Editable = true
			return rc, nil
		}
	}
	info.Reason = "This app doesn't run through portless, so it has no name to change. Wrap its command with portless <name> to give it one."
	return rc, nil
}

// checkEditable tries the edit with a placeholder name, so the form can say
// up front when the file can't be changed here.
func (p *portlessAPI) checkEditable(rc *renameCtx) {
	info := &rc.info
	src, err := os.ReadFile(info.File)
	if err != nil {
		info.Reason = "Portplane can't read " + info.File + "."
		return
	}
	if _, err := portless.RenameInCmd(src, rc.task.Key, rc.task.Cmd, info.Name, "portplane-check"); err != nil {
		if errors.Is(err, dekit.ErrNotEditable) {
			info.Reason = "This task's command is written in a way Portplane won't rewrite (a !js value, an anchor, or a name inside a longer string). Open " + filepath.Base(info.File) + " in your editor to change it."
		} else {
			info.Reason = err.Error()
		}
		return
	}
	info.Editable = true
	if info.Source == portless.SourceTask {
		info.Notes = append(info.Notes, "Portplane changes only this task's lines in "+filepath.Base(info.File)+"; the preview shows exactly what changes.")
	}
}

func (p *portlessAPI) nameInfo(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	q := r.URL.Query()
	rc, err := p.resolveName(r.Context(), q.Get("machine"), q.Get("app"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, rc.info)
}

// newHostname is what portless will call the app with name.
func (p *portlessAPI) newHostname(ctx context.Context, rc *renameCtx, name string) string {
	info := rc.info
	if info.Source == portless.SourceConfig && info.Dir != "" {
		// portless get applies the same worktree logic as portless run.
		gctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if u, err := p.d.Client.Get(gctx, info.Dir, name); err == nil && u != "" {
			return hostOf(u)
		}
	}
	base := name
	if info.RunMode && info.Prefix != "" {
		base = info.Prefix + "." + name
	}
	return portless.Hostname(base, info.TLD)
}

func (p *portlessAPI) planRename(ctx context.Context, rc *renameCtx, name string) (NamePreview, error) {
	info := rc.info
	name = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(name)), "."+info.TLD)
	pv := NamePreview{Name: name, Files: []FileEdit{}, Steps: []string{}, Warnings: []string{}}
	if !info.Editable {
		pv.Problem = info.Reason
		return pv, nil
	}
	if prob := portless.NameProblem(name, info.TLD); prob != "" {
		pv.Problem = prob
		return pv, nil
	}
	pv.Hostname = p.newHostname(ctx, rc, name)
	pv.URL = rc.proxy.URL(pv.Hostname)
	if name == info.Name && !info.Inferred {
		pv.Problem = "That's the name it has now."
		return pv, nil
	}
	for _, t := range info.Taken {
		if t == pv.Hostname {
			pv.Problem = pv.Hostname + " is already used by another app or route."
			return pv, nil
		}
	}
	if _, parent, ok := strings.Cut(name, "."); ok {
		pv.Warnings = append(pv.Warnings, "A name with a dot is a subdomain of "+parent+"."+info.TLD+". Apps on sibling subdomains share a login only when the cookie domain is that parent, and services with a CORS allowlist need the new origin.")
	}
	switch info.Source {
	case portless.SourceFragment, portless.SourceTask, portless.SourceAliasTask:
		src, err := os.ReadFile(info.File)
		if err != nil {
			return pv, err
		}
		after, err := portless.RenameInCmd(src, rc.task.Key, rc.task.Cmd, info.Name, name)
		if err != nil {
			if errors.Is(err, dekit.ErrNotEditable) {
				pv.Problem = rc.info.Reason
				if pv.Problem == "" {
					pv.Problem = dekit.ErrNotEditable.Error()
				}
				return pv, nil
			}
			return pv, err
		}
		pv.Files = append(pv.Files, FileEdit{Path: info.File, Before: string(src), After: string(after), Changed: true})
		pv.Steps = append(pv.Steps, "Write "+filepath.Base(info.File), "Reload dekit")
		if info.Source == portless.SourceAliasTask {
			pv.Steps = append(pv.Steps, "Remove the old alias", "Restart "+rc.task.Path)
		} else if info.Running {
			pv.Steps = append(pv.Steps, "Restart "+rc.app.Label)
		}
	case portless.SourceConfig:
		e, err := portless.PlanConfigName(info.Dir, "", name)
		if err != nil {
			return pv, err
		}
		pv.Files = append(pv.Files, FileEdit(e))
		pv.Steps = append(pv.Steps, "Write "+filepath.Base(e.Path))
		if info.Running {
			pv.Steps = append(pv.Steps, "Restart "+rc.app.Label)
		}
		if info.Prefix != "" {
			pv.Warnings = append(pv.Warnings, "portless run puts this checkout's worktree name in front: the address is "+pv.Hostname+".")
		}
	case portless.SourceAlias:
		pv.Steps = append(pv.Steps, fmt.Sprintf("Add the alias %s → 127.0.0.1:%d", pv.Hostname, info.Port), "Remove the alias "+info.Hostname)
	}
	pv.Digest = editsDigest(pv.Files)
	return pv, nil
}

func editsDigest(files []FileEdit) string {
	h := sha256.New()
	for _, f := range files {
		h.Write([]byte(f.Path))
		h.Write([]byte{0})
		h.Write([]byte(f.Before))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (p *portlessAPI) namePreview(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	var req nameRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	rc, err := p.resolveName(r.Context(), req.Machine, req.App)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	pv, err := p.planRename(r.Context(), rc, req.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, pv)
}

func (p *portlessAPI) nameApply(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	if p.d.Jobs == nil {
		writeError(w, http.StatusNotImplemented, errors.New("jobs are not available"))
		return
	}
	var req nameRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	rc, err := p.resolveName(r.Context(), req.Machine, req.App)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	pv, err := p.planRename(r.Context(), rc, req.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if pv.Problem != "" {
		writeError(w, http.StatusBadRequest, errors.New(pv.Problem))
		return
	}
	if req.Digest == "" || req.Digest != pv.Digest {
		writeError(w, http.StatusConflict, errors.New("the file changed since the preview: review the new preview and apply again"))
		return
	}
	info, app, c := rc.info, rc.app, p.d.Client
	title := fmt.Sprintf("Rename %s to %s", app.Label, pv.Hostname)
	job := p.d.Jobs.Start(jobs.Spec{Kind: "portless.rename", Title: title, Key: "rename|" + app.ID, Steps: pv.Steps}, func(ctx context.Context, run *jobs.Run) error {
		defer p.d.Refresh()
		for _, f := range pv.Files {
			run.Step("Write " + filepath.Base(f.Path))
			if err := portless.WriteEdit(portless.ConfigEdit(f)); err != nil {
				return err
			}
			run.Logf("Wrote %s", f.Path)
		}
		dekitFile := info.Source == portless.SourceFragment || info.Source == portless.SourceTask || info.Source == portless.SourceAliasTask
		if dekitFile {
			run.Step("Reload dekit")
			if p.d.Reload != nil {
				if err := p.d.Reload(ctx, rc.root); err != nil {
					if errors.Is(err, dekit.ErrRunnerDown) {
						run.Logf("dekit isn't running for this project; the new name applies when it starts.")
					} else {
						return fmt.Errorf("dekit reload: %w", err)
					}
				}
			}
		}
		switch info.Source {
		case portless.SourceAliasTask:
			run.Step("Remove the old alias")
			if _, err := c.RemoveAliasOutput(ctx, info.Hostname); err != nil {
				run.Logf("%v", err)
			}
			run.Step("Restart " + rc.task.Path)
			if p.d.Restart != nil {
				if err := p.d.Restart(ctx, rc.root, rc.task.Path); err != nil {
					return err
				}
			}
		case portless.SourceAlias:
			run.Step(fmt.Sprintf("Add the alias %s → 127.0.0.1:%d", pv.Hostname, info.Port))
			if _, err := c.AddAlias(ctx, pv.Name, info.Port, false); err != nil {
				_, e := aliasError(err)
				return e
			}
			run.Step("Remove the alias " + info.Hostname)
			if _, err := c.RemoveAliasOutput(ctx, info.Hostname); err != nil {
				return err
			}
		default:
			if info.Running && p.d.Restart != nil {
				run.Step("Restart " + app.Label)
				if err := p.d.Restart(ctx, rc.root, app.Task); err != nil {
					return err
				}
			}
		}
		run.SetResult(map[string]string{"hostname": pv.Hostname, "url": pv.URL})
		return nil
	})
	StartJob(w, job)
}
