package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strconv"
	"syscall"
	"time"

	"github.com/akamachinecode/portplane/internal/agent"
	"github.com/akamachinecode/portplane/internal/autostart"
	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/desktop"
	"github.com/akamachinecode/portplane/internal/envpath"
	"github.com/akamachinecode/portplane/internal/hub"
	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/portless"
	"github.com/akamachinecode/portplane/internal/remote"
	"github.com/akamachinecode/portplane/internal/selfupdate"
	"github.com/akamachinecode/portplane/internal/server"
	"github.com/akamachinecode/portplane/internal/settings"
	"github.com/akamachinecode/portplane/internal/setup"
	"github.com/akamachinecode/portplane/internal/tray"
	"github.com/akamachinecode/portplane/internal/webui"
	"github.com/akamachinecode/portplane/internal/window"
)

// aliasName is the portless name of the UI: https://portplane.localhost.
const aliasName = "portplane"

func cmdServe(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	listen := fs.String("listen", "127.0.0.1:0", "loopback address to listen on")
	open := fs.Bool("open", false, "open the UI when ready")
	noAlias := fs.Bool("no-alias", false, "do not register https://portplane.localhost with portless")
	noTray := fs.Bool("no-tray", false, "do not show the menu-bar or tray icon")
	dev := fs.Bool("dev", false, "development only: accept any *.localhost host and no token (for the Vite dev server)")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	detachOwnConsole()
	envpath.Enrich()
	activation := takeActivationToken()
	// Started by an update: wait for the Portplane it replaces to quit
	// (ADR-0031). Never rename this variable: older versions set it.
	if pid, err := strconv.Atoi(os.Getenv(selfupdate.AfterPIDEnv)); err == nil && pid > 0 {
		_ = os.Unsetenv(selfupdate.AfterPIDEnv)
		waitForQuit(pid, 30*time.Second)
	}

	// One Portplane per user: a second start opens the first one's window.
	if inst, ok := runningInstance(); ok {
		fmt.Fprintf(stdout, "Portplane is already running at %s\n", inst.URL)
		if *open && !showRunning(inst, activation) {
			_ = desktop.OpenApp(inst.URL)
		}
		return 0
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, quit := context.WithCancel(ctx)
	defer quit()
	go selfupdate.Cleanup(executable()) // what an update left next to the binary

	store, err := openSettings()
	if err != nil {
		fmt.Fprintln(stderr, "portplane:", err)
		return 1
	}
	st, err := store.Load()
	if err != nil {
		fmt.Fprintf(stderr, "portplane: reading %s: %v\n", store.Path(), err)
		return 1
	}
	dk := dekit.NewCLI()
	pl := portless.New()
	local := agent.NewLocal(agent.Options{Folders: st.Folders, Dekit: dk, Portless: pl})
	jobManager := jobs.NewManager()
	// Folders changed from a terminal (`portplane folders add`) show up
	// without a restart.
	go store.Watch(ctx, 2*time.Second, func(s settings.Settings) {
		if !slices.Equal(s.Folders, local.Folders()) {
			if err := local.SetFolders(ctx, s.Folders); err != nil {
				fmt.Fprintln(stderr, "portplane: folders changed on disk:", err)
			}
		}
	})
	h := hub.New()
	h.Add("local", local, model.Machine{ID: "local", Local: true})
	defer h.Close()

	ln, port, err := server.Listen(ctx, *listen)
	if err != nil {
		fmt.Fprintln(stderr, "portplane:", err)
		return 1
	}
	rawURL := "http://127.0.0.1:" + strconv.Itoa(port)
	publicURL := ""
	if !*noAlias && pl.Available() {
		actx, cancel := context.WithTimeout(ctx, 15*time.Second)
		if err := pl.Alias(actx, aliasName, port); err != nil {
			fmt.Fprintln(stderr, "portplane: could not register https://portplane.localhost:", err)
		} else {
			publicURL = pl.Proxy().URL(server.StableHost)
			defer func() {
				rctx, rcancel := context.WithTimeout(context.Background(), 10*time.Second)
				_ = pl.RemoveAlias(rctx, aliasName)
				rcancel()
			}()
		}
		cancel()
	}

	url := rawURL
	if publicURL != "" {
		url = publicURL
	}
	// The window: native on macOS (ADR-0017), where it lives in the tray's
	// run loop, and on Linux (ADR-0018), where it is its own process; the
	// browser elsewhere, and whenever the native one cannot open (ADR-0004).
	// The native window loads the loopback address, which needs neither the
	// portless CA nor .localhost name resolution.
	trayOn := !*noTray && tray.Available()
	native := window.Supported() && (trayOn || !window.NeedsTray())
	if native {
		window.Start(ctx, window.Options{
			URL:        rawURL,
			BrowserURL: url,
			StatePath:  filepath.Join(filepath.Dir(store.Path()), "window.json"),
			Quit:       quit, // Quit Portplane in the window's menu
			// Closing the window ends a Portplane that started with it,
			// unless a tray icon is on screen to bring it back. Started
			// without a window (at login), it keeps running as before.
			Closed: func() {
				if *open && (!trayOn || !tray.Visible()) {
					quit()
				}
			},
		})
		defer window.Close()
	}
	showUI := func(activationToken string) {
		if native && window.Supported() {
			err := window.Show(activationToken)
			if err == nil {
				return
			}
			fmt.Fprintln(stderr, "portplane: the window did not open, using the browser:", err)
		}
		if err := desktop.OpenApp(url); err != nil {
			fmt.Fprintln(stderr, "portplane: could not open a browser:", err)
		}
	}

	srv := &server.Server{
		Hub:        h,
		UI:         webui.FS(),
		Token:      server.NewToken(),
		ShowWindow: showUI,
		// The folder picker opens over the window when it is open; the
		// desktop's own (zenity, kdialog, AppleScript) otherwise.
		PickFolder: func(c context.Context) (string, error) {
			p, err := window.PickFolder(c)
			switch {
			case errors.Is(err, window.ErrNoWindow):
				return desktop.PickFolder(c)
			case errors.Is(err, context.Canceled): // Portplane is quitting
				return "", desktop.ErrCancelled
			case err != nil:
				return "", err
			case p == "":
				return "", desktop.ErrCancelled
			}
			return p, nil
		},
		CanPick:   func() bool { return window.CanPick() || desktop.CanPickFolder() },
		Jobs:      jobManager,
		Port:      port,
		PublicURL: publicURL,
		Dev:       *dev,
		GetFolders: func() []string {
			return local.Folders()
		},
		SetFolders: func(c context.Context, folders []string) error {
			if err := local.SetFolders(c, folders); err != nil {
				return err
			}
			_, err := store.Update(func(s *settings.Settings) error {
				s.Folders = local.Folders()
				return nil
			})
			return err
		},
	}
	srv.Extra = server.SetupHandlers(server.SetupDeps{
		Folders: local.Folders,
		Facts: func(c context.Context) setup.Facts {
			snap, _ := local.Snapshot(c)
			return setup.GatherFacts(c, snap.Tools.Dekit, snap.Tools.Portless, snap.Tools.ProxyRunning)
		},
		Reload: func(c context.Context, root string) (bool, error) {
			err := dk.Reload(c, root)
			if errors.Is(err, dekit.ErrRunnerDown) {
				return false, nil
			}
			return err == nil, err
		},
	})
	fwd := remote.NewForwarder(pl)
	// Agents stop before their forwards close, so no snapshot reopens one.
	defer func() {
		h.Close()
		fwd.Close()
	}()
	machines := &remote.Manager{Hub: h, Store: store, Forward: fwd, Binaries: remote.ReleaseBinary}
	if err := machines.Start(); err != nil {
		fmt.Fprintln(stderr, "portplane: machines:", err)
	}
	for pattern, handler := range server.MachineHandlers(machines, remote.Candidates) {
		srv.Extra[pattern] = handler
	}
	for pattern, handler := range server.AutostartHandlers(autostart.Enabled, setAutostart) {
		srv.Extra[pattern] = handler
	}
	for pattern, handler := range server.PreferencesHandlers(store) {
		srv.Extra[pattern] = handler
	}
	areaHandlers(deps{
		ctx: ctx, local: local, hub: h, jobs: jobManager, store: store,
		dekit: dk, portless: pl, publicURL: publicURL, rawURL: rawURL, quit: quit,
	}, srv.Extra)
	httpSrv := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}

	if err := writeInstance(instance{PID: os.Getpid(), Port: port, URL: url, Token: srv.Token}); err != nil {
		fmt.Fprintln(stderr, "portplane: warning:", err)
	}
	defer removeInstance()

	fmt.Fprintf(stdout, "Portplane %s\n  %s\n", "is running at", url)
	if publicURL != "" {
		fmt.Fprintf(stdout, "  %s (direct)\n", rawURL)
	}
	if *dev {
		fmt.Fprintln(stdout, "  development mode: no token, any *.localhost host")
	}
	if *open {
		showUI(activation)
	}

	errc := make(chan error, 1)
	go func() {
		err := httpSrv.Serve(ln)
		errc <- err
		quit()
	}()
	// The tray needs the main goroutine (macOS); without one, just wait.
	shown := !*noTray && tray.Run(ctx, tray.Options{
		Updates:      h.Observe(ctx),
		Open:         func() { showUI("") },
		Quit:         quit,
		Autostart:    autostart.Enabled,
		SetAutostart: setAutostart,
		ReportFailure: func(err error) {
			fmt.Fprintln(stderr, "portplane:", err)
		},
	})
	if !shown {
		<-ctx.Done()
	}
	select {
	case err := <-errc:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintln(stderr, "portplane:", err)
			return 1
		}
	default:
	}
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(sctx)
	return 0
}

// instance records the running Portplane so a second start can find it.
// The file is private to the user (0600), like the page that carries the
// same token (ADR-0008).
type instance struct {
	PID   int    `json:"pid"`
	Port  int    `json:"port"`
	URL   string `json:"url"`
	Token string `json:"token,omitempty"`
}

func instancePath() string {
	dir, err := os.UserCacheDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "portplane", "instance.json")
}

func writeInstance(i instance) error {
	p := instancePath()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(i)
	return os.WriteFile(p, b, 0o600)
}

func removeInstance() {
	if i, ok := readInstance(); ok && i.PID == os.Getpid() {
		_ = os.Remove(instancePath())
	}
}

func readInstance() (instance, bool) {
	var i instance
	b, err := os.ReadFile(instancePath())
	if err != nil || json.Unmarshal(b, &i) != nil || i.Port == 0 {
		return i, false
	}
	return i, true
}

// runningInstance reports a live Portplane: its port answers like one.
func runningInstance() (instance, bool) {
	i, ok := readInstance()
	if !ok || i.PID == os.Getpid() {
		return i, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(i.Port)+"/", nil)
	if err != nil {
		return i, false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return i, false
	}
	_ = resp.Body.Close()
	return i, resp.StatusCode == http.StatusOK && resp.Header.Get("Content-Security-Policy") != ""
}

// waitForQuit waits until the Portplane with process id pid no longer
// answers, so the one that replaces it after an update doesn't just show
// the old one's window.
func waitForQuit(pid int, limit time.Duration) {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if i, ok := runningInstance(); !ok || i.PID != pid {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// executable is the running binary with symlinks resolved, or "".
func executable() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		return r
	}
	return exe
}

// showRunning asks the running Portplane to bring up its own window,
// passing this start's activation token so Wayland lets it take focus. It
// reports false when that one cannot, such as a version without the route,
// so the caller opens the browser instead.
func showRunning(i instance, activationToken string) bool {
	if i.Token == "" {
		return false
	}
	allowForeground(i.PID)
	body, _ := json.Marshal(server.WindowRequest{Token: activationToken})
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://127.0.0.1:"+strconv.Itoa(i.Port)+"/api/window", bytes.NewReader(body))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Portplane-Token", i.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusNoContent
}

// takeActivationToken returns the token the desktop gave this start
// (XDG activation on Wayland, startup notification on X11) and removes it
// from the environment, so nothing started later reuses it.
func takeActivationToken() string {
	t := os.Getenv("XDG_ACTIVATION_TOKEN")
	if t == "" {
		t = os.Getenv("DESKTOP_STARTUP_ID")
	}
	_ = os.Unsetenv("XDG_ACTIVATION_TOKEN")
	_ = os.Unsetenv("DESKTOP_STARTUP_ID")
	return t
}

func setAutostart(on bool) error {
	if on {
		return autostart.Enable()
	}
	return autostart.Disable()
}
