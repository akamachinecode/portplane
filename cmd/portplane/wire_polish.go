package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/akamachinecode/portplane/internal/buildinfo"
	"github.com/akamachinecode/portplane/internal/desktop"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/notify"
	"github.com/akamachinecode/portplane/internal/server"
	"github.com/akamachinecode/portplane/internal/settings"
	"github.com/akamachinecode/portplane/internal/tray"
	"github.com/akamachinecode/portplane/internal/updates"
	"github.com/akamachinecode/portplane/internal/window"
)

// polishHandlers wires M5.5: the window's theme, system notifications, the
// tray's pinned apps and problems, update checks and the diagnostic report
// (plan §6.4–6.6, ADR-0024, ADR-0025).
func polishHandlers(d deps) map[string]http.HandlerFunc {
	p := &polish{d: d}
	window.SetTheme(p.prefs().Theme) // the next window opens in the chosen theme
	tray.SetExtras(tray.Extras{
		Favorites: func() []string { return p.prefs().Favorites },
		Act:       p.act,
		OpenRoute: p.openRoute,
		OpenURL:   desktop.OpenURL,
		Problems:  tray.Problems,
	})
	p.startNotifications()
	p.updates = &updatesService{
		checker:   &updates.Checker{UserAgent: "portplane/" + buildinfo.Version()},
		store:     &updates.Store{Path: updates.DefaultPath()},
		installed: p.installed,
	}
	go p.updates.auto(d.ctx, func() bool { return p.prefs().UpdateCheck == "auto" })

	h := map[string]http.HandlerFunc{
		"PUT /api/window/theme":        p.putTheme,
		"POST /api/notifications/test": p.testNotification,
		"GET /api/updates":             p.updates.get,
		"POST /api/updates/check":      p.updates.check,
	}
	for pattern, handler := range server.DiagnosticsHandlers(server.DiagnosticsDeps{
		Collect:  p.collect,
		Save:     saveReport,
		Redactor: server.Redactor{Homes: homes()},
	}) {
		h[pattern] = handler
	}
	return h
}

func init() { areas = append(areas, polishHandlers) }

type polish struct {
	d       deps
	updates *updatesService

	mu       sync.Mutex
	sender   notify.Sender
	senderEr error
}

func (p *polish) prefs() settings.Preferences {
	st, err := p.d.store.Load()
	if err != nil {
		return settings.DefaultPreferences()
	}
	return st.Prefs()
}

// act starts, stops or restarts one app from the tray.
func (p *polish) act(ctx context.Context, machine string, app model.App, verb model.Verb) error {
	a, err := p.d.hub.Agent(machine)
	if err != nil {
		return err
	}
	return a.Act(ctx, model.Target{Machine: machine, Runner: app.Runner, Task: app.Task}, verb)
}

// openRoute brings up the window at a route of the UI ("#/health"); where
// no native window can open, the browser opens at that route instead.
func (p *polish) openRoute(fragment string) {
	if !window.ValidFragment(fragment) {
		fragment = ""
	}
	if window.Supported() {
		if err := window.Show(""); err == nil {
			if fragment != "" {
				window.Navigate(fragment)
			}
			return
		}
	}
	if err := desktop.OpenApp(p.uiURL(fragment)); err != nil {
		fmt.Fprintln(os.Stderr, "portplane: could not open a browser:", err)
	}
}

func (p *polish) uiURL(fragment string) string {
	u := p.d.publicURL
	if u == "" {
		u = p.d.rawURL
	}
	if fragment == "" {
		return u
	}
	return window.RouteURL(u, fragment)
}

func (p *polish) startNotifications() {
	s, err := notify.New(notify.Options{
		AppName:      "Portplane",
		DesktopEntry: window.AppID,
		Icon:         "portplane",
		LaunchBase:   p.uiURL(""),
		OnClick:      p.openRoute,
	})
	p.mu.Lock()
	p.sender, p.senderEr = s, err
	p.mu.Unlock()
	if err != nil {
		return // no notification service here: the test button says so
	}
	go func() {
		<-p.d.ctx.Done()
		_ = s.Close()
	}()
	var lastErr string
	go notify.Watch(p.d.ctx, notify.WatchOptions{
		Snapshots: p.d.hub.Observe(p.d.ctx),
		Jobs:      p.d.jobs.Subscribe(p.d.ctx),
		Prefs:     func() settings.Notifications { return p.prefs().Notifications },
		Sender:    s,
		Config:    notify.NewConfigWatch(),
		Report: func(err error) {
			if err.Error() != lastErr { // once per kind of failure, not per notification
				lastErr = err.Error()
				fmt.Fprintln(os.Stderr, "portplane: notification:", err)
			}
		},
	})
}

// testNotification is POST /api/notifications/test: the Settings button
// that shows what a notification looks like.
func (p *polish) testNotification(w http.ResponseWriter, r *http.Request) {
	var body struct{}
	if err := server.Decode(r, &body); err != nil {
		server.WriteError(w, http.StatusBadRequest, err)
		return
	}
	p.mu.Lock()
	s, serr := p.sender, p.senderEr
	p.mu.Unlock()
	if s == nil {
		msg := "this desktop has no notification service"
		if serr != nil {
			msg += ": " + serr.Error()
		}
		server.WriteError(w, http.StatusServiceUnavailable, errors.New(msg))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	err := s.Send(ctx, notify.Notification{
		ID:    "test",
		Kind:  notify.KindJob,
		Title: "Notifications work",
		Body:  "Portplane will tell you here when something needs you.",
		Route: "#/settings",
	})
	if err != nil {
		server.WriteError(w, http.StatusServiceUnavailable, fmt.Errorf("the notification didn't show: %w", err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// putTheme is PUT /api/window/theme: the page tells the native window the
// theme it shows, so the title bar matches.
func (p *polish) putTheme(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Theme string `json:"theme"`
	}
	if err := server.Decode(r, &body); err != nil {
		server.WriteError(w, http.StatusBadRequest, err)
		return
	}
	if window.NormalizeTheme(body.Theme) != body.Theme {
		server.WriteError(w, http.StatusBadRequest, errors.New("theme must be one of system, light, dark"))
		return
	}
	window.SetTheme(body.Theme)
	w.WriteHeader(http.StatusNoContent)
}

func (p *polish) installed(ctx context.Context) updates.Installed {
	in := updates.Installed{Portplane: buildinfo.Version()}
	if s, err := p.d.local.Snapshot(ctx); err == nil {
		in.Dekit, in.Portless = s.Tools.Dekit, s.Tools.Portless
	}
	return in
}

// ---- update checks (ADR-0025) ----

type updatesService struct {
	checker   *updates.Checker
	store     *updates.Store
	installed func(context.Context) updates.Installed
	mu        sync.Mutex // one check at a time
}

func (u *updatesService) run(ctx context.Context) updates.Result {
	u.mu.Lock()
	defer u.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	r := u.checker.Check(ctx, u.installed(ctx), time.Now())
	if err := u.store.Save(r); err != nil {
		fmt.Fprintln(os.Stderr, "portplane: saving the update check:", err)
	}
	return r
}

// get is GET /api/updates: the last check, or null before the first one.
func (u *updatesService) get(w http.ResponseWriter, _ *http.Request) {
	server.WriteJSON(w, http.StatusOK, u.store.Load())
}

// check is POST /api/updates/check: "Check for updates" in Settings.
func (u *updatesService) check(w http.ResponseWriter, r *http.Request) {
	var body struct{}
	if err := server.Decode(r, &body); err != nil {
		server.WriteError(w, http.StatusBadRequest, err)
		return
	}
	server.WriteJSON(w, http.StatusOK, u.run(r.Context()))
}

// auto checks at most once a day while the user has automatic checks on.
func (u *updatesService) auto(ctx context.Context, on func() bool) {
	t := time.NewTimer(time.Minute) // not during startup
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if on() && updates.Due(u.store.Load(), time.Now()) {
			u.run(ctx)
		}
		t.Reset(time.Hour)
	}
}

// ---- diagnostic report (plan §6.4) ----

// collect gathers the report's files. Each source fails on its own: its
// file then holds the error.
func (p *polish) collect(ctx context.Context) []server.DiagnosticFile {
	var files []server.DiagnosticFile
	addJSON := func(name string, v any) {
		b, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			b = []byte(err.Error())
		}
		files = append(files, server.DiagnosticFile{Name: name, Data: b})
	}
	addText := func(name, text string, err error) {
		if err != nil {
			text = strings.TrimSpace(text + "\n\n" + "error: " + err.Error())
		}
		files = append(files, server.DiagnosticFile{Name: name, Data: []byte(text)})
	}

	local, _ := p.d.local.Snapshot(ctx)
	orNone := func(v string) string {
		if v == "" {
			return "not installed"
		}
		return v
	}
	addJSON("versions.json", map[string]any{
		"portplane":    buildinfo.Get(),
		"dekit":        orNone(local.Tools.Dekit),
		"portless":     orNone(local.Tools.Portless),
		"tools":        local.Tools,
		"os":           runtime.GOOS,
		"arch":         runtime.GOARCH,
		"nativeWindow": window.Supported(),
		"tray":         tray.Available(),
	})
	addJSON("snapshot.json", p.d.hub.Snapshot())
	if p.d.dekit.Available() {
		recs, err := p.d.dekit.Runners(ctx)
		if err != nil {
			addText("dekit-runners.json", "", err)
		} else {
			addJSON("dekit-runners.json", recs)
		}
	} else {
		addText("dekit-runners.json", "dekit is not installed", nil)
	}
	if bin := p.d.portless.Path(); bin != "" {
		out, err := runTool(ctx, bin, "doctor")
		addText("portless-doctor.txt", out, err)
		st, err := p.d.portless.ServiceStatus(ctx)
		addText("portless-service.txt", st.Raw, err)
	} else {
		addText("portless-doctor.txt", "portless is not installed", nil)
	}
	addJSON("jobs.json", p.d.jobs.List())
	prefs := p.prefs()
	addJSON("preferences.json", map[string]any{
		"theme": prefs.Theme, "density": prefs.Density, "favorites": len(prefs.Favorites),
		"notifications": prefs.Notifications, "updateCheck": prefs.UpdateCheck,
		"onboarding": prefs.Onboarding,
	})
	return files
}

// homes are the folders the report shows as ~: $HOME, and the account's
// home when Portplane runs with another HOME.
func homes() []string {
	var out []string
	if h, err := os.UserHomeDir(); err == nil {
		out = append(out, h)
	}
	if u, err := user.Current(); err == nil && u.HomeDir != "" {
		out = append(out, u.HomeDir)
	}
	return out
}

var ansiRE = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)

// runTool runs a read-only command and returns its output, colours
// removed, also when it fails.
func runTool(ctx context.Context, bin string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = append(os.Environ(), "NO_COLOR=1", "FORCE_COLOR=0")
	cmd.WaitDelay = 2 * time.Second
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return ansiRE.ReplaceAllString(out.String(), ""), err
}

// saveReport asks where to save the report: the window's own save dialog
// (Linux), the desktop's (zenity, kdialog, AppleScript, Windows Forms), or,
// with none, the downloads folder, shown in the file manager.
func saveReport(ctx context.Context, name string, data []byte) (server.SavedReport, error) {
	write := func(path string, dialog bool) (server.SavedReport, error) {
		if err := os.WriteFile(path, data, 0o600); err != nil {
			return server.SavedReport{}, err
		}
		return server.SavedReport{Path: path, Dialog: dialog}, nil
	}
	path, err := window.SaveFile(ctx, name)
	switch {
	case err == nil && path == "":
		return server.SavedReport{}, server.ErrSaveCancelled
	case err == nil:
		return write(path, true)
	case !errors.Is(err, window.ErrNoWindow):
		return server.SavedReport{}, err
	}
	path, err = desktop.SaveFile(ctx, name)
	switch {
	case errors.Is(err, desktop.ErrCancelled):
		return server.SavedReport{}, server.ErrSaveCancelled
	case err == nil:
		return write(path, true)
	case !errors.Is(err, desktop.ErrUnsupported):
		return server.SavedReport{}, err
	}
	dir := desktop.DownloadsDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return server.SavedReport{}, err
	}
	saved, err := write(freeName(dir, name), false)
	if err != nil {
		return saved, err
	}
	saved.Revealed = desktop.Reveal(dir) == nil
	return saved, nil
}

// freeName is dir/name, or dir/name (2), (3)… when that file exists.
func freeName(dir, name string) string {
	p := filepath.Join(dir, name)
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 2; i < 100; i++ {
		if _, err := os.Stat(p); errors.Is(err, os.ErrNotExist) {
			break
		}
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
	}
	return p
}
