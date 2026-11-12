package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/jobs"
)

// The dekit center (plan §4, M5.3): runners, why, the config editor,
// reload review, one-off commands, adding an app by hand, and dekit itself
// (version, kernel, update, help). Everything here acts on this computer;
// task actions (kill, veto, remove...) go through POST /api/actions so
// they work on every machine.

// DekitDeps wires the dekit center to the running Portplane.
type DekitDeps struct {
	CLI  *dekit.CLI
	Jobs *jobs.Manager
	// Folders are the folders Portplane watches; their dekit projects can
	// be configured.
	Folders func() []string
	// Refresh collects a new snapshot soon (after a change).
	Refresh func()
	// RefreshTools forgets the tool versions (after an update).
	RefreshTools func()
	// OpenFile opens a file in the user's default app for it.
	OpenFile func(path string) error
	// RunCommand runs a program for a job, streaming its output to w (a
	// package manager's update). Nil: os/exec.
	RunCommand func(ctx context.Context, w io.Writer, argv []string) error
	// GOOS is the system Portplane runs on; runtime.GOOS when empty.
	GOOS string
	// HostConfig is the host runner's dekit.yaml; dekit.HostConfigFile() when empty.
	HostConfig string
}

// RunnerInfo is one runner as the Runners view shows it (plan §4.1).
type RunnerInfo struct {
	Root            string   `json:"root"` // "host" for the host runner
	Name            string   `json:"name"`
	Kind            string   `json:"kind"`  // project or host
	State           string   `json:"state"` // running, starting, stale, failed, absent
	PID             int      `json:"pid,omitempty"`
	Version         string   `json:"version,omitempty"`
	Binary          string   `json:"binary,omitempty"`
	SelectedBinary  string   `json:"selectedBinary,omitempty"`
	SelectionError  string   `json:"selectionError,omitempty"`
	RestartRequired bool     `json:"restartRequired"`
	Since           string   `json:"since,omitempty"` // RFC 3339
	Warnings        []string `json:"warnings"`
	Watched         bool     `json:"watched"`          // in the folders Portplane watches
	Config          string   `json:"config,omitempty"` // its dekit.yaml
	ConfigExists    bool     `json:"configExists"`
	Error           string   `json:"error,omitempty"`
}

// RunnersResponse is GET /api/dekit/runners.
type RunnersResponse struct {
	Available bool         `json:"available"`
	Runners   []RunnerInfo `json:"runners"`
	Host      RunnerInfo   `json:"host"`
	Stale     int          `json:"stale"`
	// Live is false on Windows: dekit cannot restart or upgrade a runner
	// in place there.
	Live bool `json:"live"`
}

// FileEdit is one file an edit changes, with the digest it was read at
// (the dekit center sets it; the portless center's renames leave it "").
type FileEdit struct {
	Path    string `json:"path"`
	Before  string `json:"before"`
	After   string `json:"after"`
	Created bool   `json:"created"`
	Changed bool   `json:"changed"`
	Digest  string `json:"digest"` // of Before; "" when the file is new
}

// EditResult is what an edit would write (write: false) or wrote.
type EditResult struct {
	Files    []FileEdit      `json:"files"`
	Problems []dekit.Problem `json:"problems"`
	Warnings []string        `json:"warnings"`
	Written  bool            `json:"written"`
	// After a write: the runner's reload plan, so the user reviews what
	// changes in the running tasks.
	Up        bool          `json:"up"`
	Reload    *dekit.Reload `json:"reload,omitempty"`
	ReloadErr string        `json:"reloadError,omitempty"`
}

// EditRequest is POST /api/dekit/config/edit.
type EditRequest struct {
	Runner string `json:"runner"`
	// File is the file to change (absolute); "portplane" for Portplane's
	// fragment, which is created (and loaded) when it does not exist.
	File string `json:"file"`
	// Digests are the files' digests when the user saw them; a file
	// changed since is a conflict (409).
	Digests map[string]string `json:"digests,omitempty"`
	Ops     []dekit.EditOp    `json:"ops"`
	Write   bool              `json:"write"`
}

// AddAppRequest is POST /api/dekit/apps.
type AddAppRequest struct {
	Runner  string            `json:"runner"`
	App     dekit.NewApp      `json:"app"`
	Target  string            `json:"target"` // portplane (default) or main
	Digests map[string]string `json:"digests,omitempty"`
	Write   bool              `json:"write"`
}

// ReloadResponse is GET and POST /api/dekit/reload.
type ReloadResponse struct {
	Up        bool          `json:"up"`
	Reload    *dekit.Reload `json:"reload,omitempty"`
	Error     string        `json:"error,omitempty"`
	Restarted []string      `json:"restarted"`
}

// AboutResponse is GET /api/dekit/about.
type AboutResponse struct {
	Installed bool                `json:"installed"`
	Version   string              `json:"version,omitempty"`
	Path      string              `json:"path,omitempty"`
	Origin    dekit.Origin        `json:"origin"`
	Kernel    *dekit.KernelStatus `json:"kernel,omitempty"`
	KernelErr string              `json:"kernelError,omitempty"`
	OS        string              `json:"os"`
}

type dekitAPI struct {
	d DekitDeps
	// mu serialises config writes, so two saves never interleave.
	mu sync.Mutex
}

// DekitHandlers returns the /api/dekit endpoints.
func DekitHandlers(d DekitDeps) map[string]http.HandlerFunc {
	if d.GOOS == "" {
		d.GOOS = goos()
	}
	if d.HostConfig == "" {
		d.HostConfig = dekit.HostConfigFile()
	}
	if d.Refresh == nil {
		d.Refresh = func() {}
	}
	if d.RefreshTools == nil {
		d.RefreshTools = func() {}
	}
	if d.RunCommand == nil {
		d.RunCommand = runCommand
	}
	a := &dekitAPI{d: d}
	return map[string]http.HandlerFunc{
		"GET /api/dekit/runners":              a.runners,
		"POST /api/dekit/runners/action":      a.runnerAction,
		"POST /api/dekit/runners/clean":       a.clean,
		"POST /api/dekit/runners/upgrade-all": a.upgradeAll,
		"GET /api/dekit/why":                  a.why,
		"GET /api/dekit/config":               a.config,
		"POST /api/dekit/config/edit":         a.edit,
		"POST /api/dekit/config/validate":     a.validate,
		"POST /api/dekit/config/open":         a.openFile,
		"GET /api/dekit/reload":               a.reloadPlan,
		"POST /api/dekit/reload":              a.reloadApply,
		"POST /api/dekit/spawn":               a.spawn,
		"POST /api/dekit/suggest":             a.suggest,
		"POST /api/dekit/apps":                a.addApp,
		"GET /api/dekit/about":                a.about,
		"POST /api/dekit/kernel":              a.kernel,
		"POST /api/dekit/update":              a.update,
		"GET /api/dekit/help":                 a.help,
	}
}

func (a *dekitAPI) needDekit(w http.ResponseWriter) bool {
	if a.d.CLI == nil || !a.d.CLI.Available() {
		writeError(w, http.StatusConflict, errors.New("dekit isn't installed: install it from Settings → Tools first"))
		return false
	}
	return true
}

// projects are the dekit projects in the watched folders.
func (a *dekitAPI) projects() []string {
	var out []string
	if a.d.Folders == nil {
		return out
	}
	for _, p := range dekit.Discover(a.d.Folders()) {
		out = append(out, p.Root)
	}
	return out
}

// root resolves a runner the UI names: "host", a watched project, or a
// project dekit has a runner record for.
func (a *dekitAPI) root(ctx context.Context, runner string) (string, error) {
	if runner == dekit.HostRunner {
		return runner, nil
	}
	if runner == "" || !filepath.IsAbs(runner) {
		return "", errors.New("choose a project")
	}
	runner = filepath.Clean(runner)
	for _, p := range a.projects() {
		if p == runner {
			return p, nil
		}
	}
	if a.d.CLI != nil && a.d.CLI.Available() {
		if recs, err := a.d.CLI.Runners(ctx); err == nil {
			for _, r := range recs {
				if filepath.Clean(r.Root) == runner {
					return runner, nil
				}
			}
		}
	}
	return "", fmt.Errorf("%s isn't a dekit project Portplane knows", runner)
}

// configFile is the runner's main dekit.yaml.
func (a *dekitAPI) configFile(root string) string {
	if root == dekit.HostRunner {
		return a.d.HostConfig
	}
	return filepath.Join(root, dekit.ConfigFile)
}

func (a *dekitAPI) runners(w http.ResponseWriter, r *http.Request) {
	resp := RunnersResponse{Runners: []RunnerInfo{}, Live: a.d.GOOS != "windows"}
	if a.d.CLI == nil || !a.d.CLI.Available() {
		resp.Host = a.hostInfo(dekit.RunnerStatus{Status: "absent"}, nil)
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.Available = true
	ctx := r.Context()
	recs, err := a.d.CLI.Runners(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	watched := map[string]bool{}
	roots := []string{}
	for _, p := range a.projects() {
		watched[p] = true
		roots = append(roots, p)
	}
	byRoot := map[string]dekit.RunnerRecord{}
	hostRoot := ""
	for _, rec := range recs {
		root := filepath.Clean(rec.Root)
		if rec.Kind == "host" {
			hostRoot = root
			continue
		}
		byRoot[root] = rec
		if !watched[root] {
			roots = append(roots, root)
		}
	}
	sort.Strings(roots)
	infos := make([]RunnerInfo, len(roots))
	var host RunnerInfo
	var wg sync.WaitGroup
	for i, root := range roots {
		wg.Add(1)
		go func() {
			defer wg.Done()
			st, err := a.d.CLI.Status(ctx, root)
			info := runnerInfo(root, st, byRoot[root], err)
			info.Watched = watched[root]
			info.Config = filepath.Join(root, dekit.ConfigFile)
			_, statErr := os.Stat(info.Config)
			info.ConfigExists = statErr == nil
			infos[i] = info
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		st, err := a.d.CLI.Status(ctx, dekit.HostRunner)
		host = a.hostInfo(st, err)
		if hostRoot != "" && host.State == "absent" {
			host.State = "stale"
		}
	}()
	wg.Wait()
	for _, info := range infos {
		if info.State == "stale" {
			resp.Stale++
		}
	}
	if host.State == "stale" {
		resp.Stale++
	}
	resp.Runners, resp.Host = infos, host
	writeJSON(w, http.StatusOK, resp)
}

func (a *dekitAPI) hostInfo(st dekit.RunnerStatus, err error) RunnerInfo {
	info := runnerInfo(dekit.HostRunner, st, dekit.RunnerRecord{}, err)
	info.Kind, info.Name, info.Config = "host", "This computer", a.d.HostConfig
	if a.d.HostConfig != "" {
		_, statErr := os.Stat(a.d.HostConfig)
		info.ConfigExists = statErr == nil
	}
	return info
}

func runnerInfo(root string, st dekit.RunnerStatus, rec dekit.RunnerRecord, err error) RunnerInfo {
	info := RunnerInfo{Root: root, Name: filepath.Base(root), Kind: "project", State: st.Status, Warnings: []string{}}
	if err != nil {
		info.State, info.Error = "failed", err.Error()
		if rec.Root != "" && !rec.Running {
			info.State = "stale"
		}
	}
	if info.State == "" {
		info.State = "absent"
	}
	info.PID, info.Version, info.Binary = st.PID, st.Version, st.Binary
	if info.PID == 0 && rec.Running {
		info.PID = rec.PID
	}
	if info.Version == "" {
		info.Version = rec.Version
	}
	info.SelectedBinary = st.SelectedBinary
	if st.SelectionError != nil {
		info.SelectionError = *st.SelectionError
	}
	info.RestartRequired = st.RestartRequired
	started := st.StartedAt
	if started == 0 {
		started = rec.StartedAt
	}
	if started > 0 && info.State != "absent" {
		info.Since = time.Unix(started, 0).UTC().Format(time.RFC3339)
	}
	info.Warnings = append(info.Warnings, st.Warnings...)
	if len(st.Warnings) == 0 {
		info.Warnings = append(info.Warnings, rec.Warnings...)
	}
	return info
}

type runnerActionRequest struct {
	Root   string             `json:"root"`
	Action dekit.RunnerAction `json:"action"`
}

var runnerTitles = map[dekit.RunnerAction]string{
	dekit.RunnerUp:      "Start %s",
	dekit.RunnerDown:    "Stop %s and save its tasks",
	dekit.RunnerStop:    "Stop %s without saving",
	dekit.RunnerRestart: "Restart %s",
	dekit.RunnerUpgrade: "Upgrade %s",
}

func runnerLabel(root string) string {
	if root == dekit.HostRunner {
		return "this computer's runner"
	}
	return filepath.Base(root)
}

func (a *dekitAPI) runnerAction(w http.ResponseWriter, r *http.Request) {
	var req runnerActionRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if !req.Action.Valid() {
		writeError(w, http.StatusBadRequest, fmt.Errorf("unknown runner action %q", req.Action))
		return
	}
	if (req.Action == dekit.RunnerRestart || req.Action == dekit.RunnerUpgrade) && a.d.GOOS == "windows" {
		writeError(w, http.StatusBadRequest, errors.New("dekit can't restart or upgrade a runner in place on Windows: stop it and start it again"))
		return
	}
	if !a.needDekit(w) || a.d.Jobs == nil {
		return
	}
	root, err := a.root(r.Context(), req.Root)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	args, err := dekit.RunnerArgs(root, req.Action)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	cli := a.d.CLI
	timeout := 2 * time.Minute
	if req.Action == dekit.RunnerUp {
		timeout = dekit.UpWaitTimeout + 30*time.Second
	}
	job := a.d.Jobs.Start(jobs.Spec{
		Kind:  "dekit-runner",
		Title: fmt.Sprintf(runnerTitles[req.Action], runnerLabel(root)),
		Key:   "dekit-runner|" + root,
	}, func(ctx context.Context, run *jobs.Run) error {
		defer a.d.Refresh()
		run.Logf("$ dekit %s", strings.Join(args, " "))
		out, err := cli.RunLong(ctx, run, timeout, args...)
		if req.Action == dekit.RunnerUp && len(out) > 0 {
			if res, perr := dekit.ParseWait(out); perr == nil {
				run.SetResult(res)
				if res.Wait != "met" {
					return waitError(res)
				}
			}
		}
		if err != nil && req.Action == dekit.RunnerDown && errors.Is(err, dekit.ErrRunnerDown) {
			return nil // down on a runner that is not running does nothing
		}
		return err
	})
	StartJob(w, job)
}

// waitError says which tasks did not get ready.
func waitError(res dekit.WaitResult) error {
	var failed, pending []string
	for _, t := range res.Tasks {
		switch t.Wait {
		case "failed":
			detail := t.State
			if t.ExitCode != nil {
				detail = fmt.Sprintf("%s (code %d)", t.State, *t.ExitCode)
			}
			if t.Reason == "ready_timeout" {
				detail = "not ready in time"
			}
			failed = append(failed, t.Path+": "+detail)
		case "pending":
			pending = append(pending, t.Path)
		}
	}
	switch {
	case len(failed) > 0:
		return fmt.Errorf("the runner is up, but these didn't start: %s", strings.Join(failed, ", "))
	case len(pending) > 0:
		return fmt.Errorf("the runner is up; still waiting for %s", strings.Join(pending, ", "))
	}
	return fmt.Errorf("the runner is up, but its tasks didn't all get ready (%s)", res.Wait)
}

func (a *dekitAPI) clean(w http.ResponseWriter, r *http.Request) {
	if !a.needDekit(w) {
		return
	}
	if err := a.d.CLI.Clean(r.Context()); err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	a.d.Refresh()
	writeJSON(w, http.StatusOK, struct{}{})
}

func (a *dekitAPI) upgradeAll(w http.ResponseWriter, _ *http.Request) {
	if a.d.GOOS == "windows" {
		writeError(w, http.StatusBadRequest, errors.New("on Windows a runner picks up a new dekit when it starts again: stop it and start it"))
		return
	}
	if !a.needDekit(w) || a.d.Jobs == nil {
		return
	}
	cli := a.d.CLI
	job := a.d.Jobs.Start(jobs.Spec{Kind: "dekit-upgrade", Title: "Upgrade every runner", Key: "dekit-upgrade"}, func(ctx context.Context, run *jobs.Run) error {
		defer a.d.Refresh()
		run.Logf("$ dekit %s", strings.Join(dekit.UpgradeAllArgs(), " "))
		_, err := cli.RunLong(ctx, run, 2*time.Minute, dekit.UpgradeAllArgs()...)
		return err
	})
	StartJob(w, job)
}

func (a *dekitAPI) why(w http.ResponseWriter, r *http.Request) {
	if !a.needDekit(w) {
		return
	}
	q := r.URL.Query()
	root, err := a.root(r.Context(), q.Get("runner"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	why, err := a.d.CLI.Why(r.Context(), root, q.Get("task"))
	switch {
	case errors.Is(err, dekit.ErrRunnerDown):
		writeError(w, http.StatusConflict, errors.New("the runner isn't running: start it to see why"))
	case err != nil:
		writeError(w, http.StatusBadGateway, err)
	default:
		writeJSON(w, http.StatusOK, why)
	}
}

func (a *dekitAPI) config(w http.ResponseWriter, r *http.Request) {
	root, err := a.root(r.Context(), r.URL.Query().Get("runner"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	pc, err := a.readProject(root)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, pc)
}

func (a *dekitAPI) readProject(root string) (*dekit.ProjectConfig, error) {
	if root == dekit.HostRunner {
		if a.d.HostConfig == "" {
			return nil, errors.New("no home folder for the host runner's config")
		}
		pc, err := dekit.ReadProject(filepath.Dir(a.d.HostConfig), a.d.HostConfig)
		if err != nil {
			return nil, err
		}
		pc.Root = dekit.HostRunner
		// The host runner has no Portplane fragment: apps go in its dekit.yaml.
		files := pc.Files[:0]
		for _, f := range pc.Files {
			if f.Role != "portplane" || f.Exists {
				files = append(files, f)
			}
		}
		pc.Files = files
		return pc, nil
	}
	return dekit.ReadProject(root, "")
}

// allowedFile checks that file belongs to the runner's config.
func (a *dekitAPI) allowedFile(pc *dekit.ProjectConfig, file string) (dekit.ConfigFileInfo, bool) {
	for _, f := range pc.Files {
		if f.Path == filepath.Clean(file) {
			return f, true
		}
	}
	return dekit.ConfigFileInfo{}, false
}

const fragmentHeader = `# Generated by Portplane (https://github.com/akamachinecode/portplane).
# Every scan rewrites this file and keeps the portless names you change here.
# To own a task completely, move it into dekit.yaml: Portplane then leaves it alone.
`

// plan applies ops to a file of the runner's config, and returns every
// file that changes: the fragment and dekit.yaml when Portplane's fragment
// is created.
func (a *dekitAPI) plan(root, file string, ops []dekit.EditOp, digests map[string]string) (*EditResult, error) {
	pc, err := a.readProject(root)
	if err != nil {
		return nil, err
	}
	if file == "portplane" {
		file = pc.Fragment
	}
	info, ok := a.allowedFile(pc, file)
	if !ok {
		return nil, fmt.Errorf("%s isn't part of this project's dekit config", file)
	}
	res := &EditResult{Files: []FileEdit{}, Problems: []dekit.Problem{}, Warnings: []string{}}
	for _, f := range []dekit.ConfigFileInfo{info, pc.Files[0]} {
		if want, ok := digests[f.Path]; ok && want != f.Digest {
			return nil, errConflict
		}
	}
	before := []byte(info.Content)
	src := before
	created := !info.Exists
	if created && info.Role == "portplane" {
		src = []byte(fragmentHeader)
	}
	after, err := dekit.ApplyOps(src, ops)
	if err != nil {
		return nil, err
	}
	res.Files = append(res.Files, FileEdit{Path: info.Path, Before: string(before), After: string(after), Created: created, Changed: string(before) != string(after), Digest: info.Digest})
	for _, p := range dekit.ValidateConfig(after) {
		p.Message = info.Rel + ": " + p.Message
		res.Problems = append(res.Problems, p)
	}
	if info.Role == "portplane" && !loads(pc, info.Path) {
		main := pc.Files[0]
		mafter, err := dekit.AppendLoad([]byte(main.Content), dekit.PortplaneFragment, "")
		if err != nil {
			return nil, fmt.Errorf("add %q under load: in %s by hand first (%w)", dekit.PortplaneFragment, main.Rel, err)
		}
		res.Files = append(res.Files, FileEdit{Path: main.Path, Before: main.Content, After: string(mafter), Created: !main.Exists, Changed: main.Content != string(mafter), Digest: main.Digest})
	}
	res.Warnings = append(res.Warnings, cwdWarnings(info.Path, after)...)
	return res, nil
}

var errConflict = errors.New("the file changed on disk since you opened it: review it again")

func loads(pc *dekit.ProjectConfig, file string) bool {
	for _, t := range pc.Tasks {
		if t.File == file {
			return true
		}
	}
	for _, l := range pc.Load {
		if filepath.Clean(filepath.Join(filepath.Dir(pc.File), filepath.FromSlash(l.File))) == file {
			return true
		}
	}
	return false
}

// cwdWarnings names task folders that do not exist.
func cwdWarnings(file string, src []byte) []string {
	var out []string
	cfgDir := filepath.Dir(file)
	var doc struct {
		Tasks map[string]struct {
			Cwd any `yaml:"cwd"`
		} `yaml:"tasks"`
	}
	if err := yamlUnmarshal(src, &doc); err != nil {
		return nil
	}
	keys := make([]string, 0, len(doc.Tasks))
	for k := range doc.Tasks {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		cwd, ok := doc.Tasks[k].Cwd.(string)
		if !ok || cwd == "" || strings.HasPrefix(cwd, "~") {
			continue
		}
		p := cwd
		if !filepath.IsAbs(p) {
			p = filepath.Join(cfgDir, filepath.FromSlash(cwd))
		}
		if fi, err := os.Stat(p); err != nil || !fi.IsDir() {
			out = append(out, fmt.Sprintf("%s: the folder %s doesn't exist", k, cwd))
		}
	}
	return out
}

func (a *dekitAPI) edit(w http.ResponseWriter, r *http.Request) {
	var req EditRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	root, err := a.root(r.Context(), req.Runner)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	res, err := a.plan(root, req.File, req.Ops, req.Digests)
	if err != nil {
		a.editError(w, err)
		return
	}
	if req.Write {
		a.write(r.Context(), root, res)
	}
	writeJSON(w, http.StatusOK, res)
}

func (a *dekitAPI) editError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errConflict):
		writeError(w, http.StatusConflict, err)
	case errors.Is(err, dekit.ErrNotEditable):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": err.Error(), "notEditable": true})
	default:
		writeError(w, http.StatusBadRequest, err)
	}
}

// write saves a planned edit unless it has problems, then asks the runner
// what a reload would change.
func (a *dekitAPI) write(ctx context.Context, root string, res *EditResult) {
	if len(res.Problems) > 0 {
		return
	}
	for _, f := range res.Files {
		if !f.Changed {
			continue
		}
		if err := dekit.WriteFileAtomic(f.Path, []byte(f.After)); err != nil {
			res.Problems = append(res.Problems, dekit.Problem{Message: "writing " + f.Path + ": " + err.Error()})
			return
		}
	}
	res.Written = true
	a.d.Refresh()
	if a.d.CLI == nil || !a.d.CLI.Available() {
		return
	}
	plan, err := a.d.CLI.ReloadPlanFor(ctx, root)
	switch {
	case errors.Is(err, dekit.ErrRunnerDown):
	case err != nil:
		res.Up, res.ReloadErr = true, err.Error()
	default:
		res.Up, res.Reload = true, &plan
	}
}

type validateRequest struct {
	Content string `json:"content"`
}

func (a *dekitAPI) validate(w http.ResponseWriter, r *http.Request) {
	var req validateRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	probs := dekit.ValidateConfig([]byte(req.Content))
	if probs == nil {
		probs = []dekit.Problem{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"problems": probs})
}

type openFileRequest struct {
	Runner string `json:"runner"`
	File   string `json:"file"`
}

func (a *dekitAPI) openFile(w http.ResponseWriter, r *http.Request) {
	var req openFileRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	root, err := a.root(r.Context(), req.Runner)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	pc, err := a.readProject(root)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	info, ok := a.allowedFile(pc, req.File)
	if !ok || !info.Exists {
		writeError(w, http.StatusBadRequest, errors.New("that file isn't part of this project's dekit config"))
		return
	}
	if a.d.OpenFile == nil {
		writeError(w, http.StatusNotImplemented, errors.New("can't open files on this system"))
		return
	}
	if err := a.d.OpenFile(info.Path); err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *dekitAPI) reloadPlan(w http.ResponseWriter, r *http.Request) {
	if !a.needDekit(w) {
		return
	}
	root, err := a.root(r.Context(), r.URL.Query().Get("runner"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	resp := ReloadResponse{Restarted: []string{}}
	plan, err := a.d.CLI.ReloadPlanFor(r.Context(), root)
	switch {
	case errors.Is(err, dekit.ErrRunnerDown):
	case err != nil:
		resp.Up, resp.Error = true, err.Error()
	default:
		resp.Up, resp.Reload = true, &plan
	}
	writeJSON(w, http.StatusOK, resp)
}

type reloadRequest struct {
	Runner string `json:"runner"`
	// Restart restarts the running tasks the reload changed.
	Restart bool `json:"restart"`
}

// aliveStates are dekit states whose process runs.
var aliveStates = map[string]bool{"running": true, "ready": true, "starting": true}

func (a *dekitAPI) reloadApply(w http.ResponseWriter, r *http.Request) {
	var req reloadRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if !a.needDekit(w) {
		return
	}
	ctx := r.Context()
	root, err := a.root(ctx, req.Runner)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	res, err := a.d.CLI.ApplyReload(ctx, root)
	if errors.Is(err, dekit.ErrRunnerDown) {
		writeError(w, http.StatusConflict, errors.New("the runner isn't running: it reads the config when it starts"))
		return
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	resp := ReloadResponse{Up: true, Reload: &res, Restarted: []string{}}
	if req.Restart {
		changed := map[string]bool{}
		for _, c := range res.Plan.Changes {
			if c.Kind == "changed" && c.Apply {
				changed[c.Path] = true
			}
		}
		if len(changed) > 0 {
			states, err := a.d.CLI.List(ctx, root)
			if err != nil {
				resp.Error = err.Error()
			}
			for _, s := range states {
				if !changed[s.Path] || !aliveStates[s.State] {
					continue
				}
				if err := a.d.CLI.Act(ctx, root, "restart", s.Path); err != nil {
					resp.Error = err.Error()
					continue
				}
				resp.Restarted = append(resp.Restarted, s.Path)
			}
		}
	}
	a.d.Refresh()
	writeJSON(w, http.StatusOK, resp)
}

type spawnRequest struct {
	Runner string          `json:"runner"`
	Spec   dekit.SpawnSpec `json:"spec"`
}

func (a *dekitAPI) spawn(w http.ResponseWriter, r *http.Request) {
	var req spawnRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if !a.needDekit(w) {
		return
	}
	root, err := a.root(r.Context(), req.Runner)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if req.Spec.Cwd != "" {
		cwd := req.Spec.Cwd
		if !filepath.IsAbs(cwd) && root != dekit.HostRunner {
			cwd = filepath.Join(root, filepath.FromSlash(cwd))
		}
		if fi, err := os.Stat(cwd); err != nil || !fi.IsDir() {
			writeError(w, http.StatusBadRequest, fmt.Errorf("the folder %s doesn't exist", req.Spec.Cwd))
			return
		}
		req.Spec.Cwd = cwd
	} else if root != dekit.HostRunner {
		req.Spec.Cwd = root // dekit's default is the current folder: make it the project's
	}
	if err := a.d.CLI.Spawn(r.Context(), root, req.Spec); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	a.d.Refresh()
	writeJSON(w, http.StatusOK, struct{}{})
}

type suggestRequest struct {
	Folder string `json:"folder"`
}

func (a *dekitAPI) suggest(w http.ResponseWriter, r *http.Request) {
	var req suggestRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if !filepath.IsAbs(req.Folder) {
		writeError(w, http.StatusBadRequest, errors.New("use the folder's full path"))
		return
	}
	fi, err := os.Stat(req.Folder)
	if err != nil || !fi.IsDir() {
		writeError(w, http.StatusBadRequest, fmt.Errorf("%s isn't a folder", req.Folder))
		return
	}
	project := dekit.FindAbove(req.Folder)
	writeJSON(w, http.StatusOK, map[string]any{"suggestions": dekit.Suggest(req.Folder, a.d.GOOS), "project": project})
}

func (a *dekitAPI) addApp(w http.ResponseWriter, r *http.Request) {
	var req AddAppRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	root, err := a.root(r.Context(), req.Runner)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if root != dekit.HostRunner && !dekit.Inside(req.App.Folder, root) {
		writeError(w, http.StatusBadRequest, fmt.Errorf("the app's folder must be inside the project %s", root))
		return
	}
	file := "portplane"
	dir := filepath.Join(root, filepath.Dir(filepath.FromSlash(dekit.PortplaneFragment)))
	if req.Target == "main" || root == dekit.HostRunner {
		file = a.configFile(root)
		dir = filepath.Dir(file)
	}
	ops, err := req.App.InsertOps(dir)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if pc, err := a.readProject(root); err == nil {
		for _, t := range pc.Tasks {
			if t.Path == req.App.Path || (req.App.Name != "" && !req.App.Wrap && t.Path == req.App.AliasTask()) {
				writeError(w, http.StatusBadRequest, fmt.Errorf("the project already has a task %s: choose another path", t.Path))
				return
			}
		}
	}
	res, err := a.plan(root, file, ops, req.Digests)
	if err != nil {
		a.editError(w, err)
		return
	}
	if req.Write {
		a.write(r.Context(), root, res)
	}
	writeJSON(w, http.StatusOK, res)
}

func (a *dekitAPI) about(w http.ResponseWriter, r *http.Request) {
	resp := AboutResponse{OS: a.d.GOOS}
	if a.d.CLI == nil || !a.d.CLI.Available() {
		writeJSON(w, http.StatusOK, resp)
		return
	}
	ctx := r.Context()
	resp.Installed = true
	resp.Path = a.d.CLI.Path()
	resp.Version, _ = a.d.CLI.Version(ctx)
	resp.Origin = dekit.DetectOrigin(resp.Path, "")
	if k, err := a.d.CLI.Kernel(ctx, ""); err == nil {
		resp.Kernel = &k
	} else {
		resp.KernelErr = err.Error()
	}
	writeJSON(w, http.StatusOK, resp)
}

type kernelRequest struct {
	// Path becomes the default kernel; "" clears the default.
	Path string `json:"path"`
}

func (a *dekitAPI) kernel(w http.ResponseWriter, r *http.Request) {
	var req kernelRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if !a.needDekit(w) {
		return
	}
	if err := a.d.CLI.SetDefaultKernel(r.Context(), req.Path); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	k, err := a.d.CLI.Kernel(r.Context(), "")
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, k)
}

type updateRequest struct {
	Version string `json:"version"` // "", latest, canary or 1.2.3
}

func (a *dekitAPI) update(w http.ResponseWriter, r *http.Request) {
	var req updateRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := dekit.ValidUpdateVersion(req.Version); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if !a.needDekit(w) || a.d.Jobs == nil {
		return
	}
	version := req.Version
	if version == "latest" {
		version = ""
	}
	cli := a.d.CLI
	origin := dekit.DetectOrigin(cli.Path(), version)
	if len(origin.Update) == 0 {
		writeError(w, http.StatusBadRequest, fmt.Errorf("this dekit (%s) was installed in a way Portplane can't update: update it the same way, then upgrade the runners", cli.Path()))
		return
	}
	if origin.Kind != "script" && version == "canary" {
		writeError(w, http.StatusBadRequest, errors.New("canary builds come only with dekit's install script"))
		return
	}
	steps := []string{"Update dekit", "Switch the running runners"}
	job := a.d.Jobs.Start(jobs.Spec{Kind: "dekit-update", Title: "Update dekit", Key: "dekit-update", Steps: steps}, func(ctx context.Context, run *jobs.Run) error {
		defer a.d.RefreshTools()
		defer a.d.Refresh()
		run.Step(steps[0])
		run.Logf("$ %s", strings.Join(origin.Update, " "))
		if origin.Kind == "script" {
			if _, err := cli.RunLong(ctx, run, 5*time.Minute, origin.Update[1:]...); err != nil {
				return err
			}
			run.Skip(steps[1]) // dekit update ends with runner upgrade --all
			return nil
		}
		if err := a.d.RunCommand(ctx, run, origin.Update); err != nil {
			return err
		}
		run.Step(steps[1])
		if a.d.GOOS == "windows" {
			run.Logf("On Windows, runners pick up the new version when they start again.")
			return nil
		}
		run.Logf("$ dekit %s", strings.Join(dekit.UpgradeAllArgs(), " "))
		_, err := cli.RunLong(ctx, run, 2*time.Minute, dekit.UpgradeAllArgs()...)
		return err
	})
	StartJob(w, job)
}

func (a *dekitAPI) help(w http.ResponseWriter, r *http.Request) {
	if !a.needDekit(w) {
		return
	}
	b, err := a.d.CLI.Help(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(b)
}
