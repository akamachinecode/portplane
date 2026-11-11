package main

import (
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
	"strconv"
	"syscall"
	"time"

	"github.com/akamachinecode/portplane/internal/agent"
	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/desktop"
	"github.com/akamachinecode/portplane/internal/envpath"
	"github.com/akamachinecode/portplane/internal/hub"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/portless"
	"github.com/akamachinecode/portplane/internal/remote"
	"github.com/akamachinecode/portplane/internal/server"
	"github.com/akamachinecode/portplane/internal/settings"
	"github.com/akamachinecode/portplane/internal/setup"
	"github.com/akamachinecode/portplane/internal/webui"
)

// aliasName is the portless name of the UI: https://portplane.localhost.
const aliasName = "portplane"

func cmdServe(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	listen := fs.String("listen", "127.0.0.1:0", "loopback address to listen on")
	open := fs.Bool("open", false, "open the UI when ready")
	noAlias := fs.Bool("no-alias", false, "do not register https://portplane.localhost with portless")
	dev := fs.Bool("dev", false, "development only: accept any *.localhost host and no token (for the Vite dev server)")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	envpath.Enrich()

	// One Portplane per user: a second start opens the first one's window.
	if inst, ok := runningInstance(); ok {
		fmt.Fprintf(stdout, "Portplane is already running at %s\n", inst.URL)
		if *open {
			_ = desktop.OpenApp(inst.URL)
		}
		return 0
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

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
	local := agent.NewLocal(agent.Options{Folders: st.Folders})
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
	pl := portless.New()
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

	srv := &server.Server{
		Hub:       h,
		UI:        webui.FS(),
		Token:     server.NewToken(),
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
	dk := dekit.NewCLI()
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
	defer fwd.Close()
	machines := &remote.Manager{Hub: h, Store: store, Forward: fwd, Binaries: remote.ReleaseBinary}
	if err := machines.Start(); err != nil {
		fmt.Fprintln(stderr, "portplane: machines:", err)
	}
	for pattern, handler := range server.MachineHandlers(machines, remote.Candidates) {
		srv.Extra[pattern] = handler
	}
	httpSrv := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}

	url := rawURL
	if publicURL != "" {
		url = publicURL
	}
	if err := writeInstance(instance{PID: os.Getpid(), Port: port, URL: url}); err != nil {
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
		if err := desktop.OpenApp(url); err != nil {
			fmt.Fprintln(stderr, "portplane: could not open a browser:", err)
		}
	}

	errc := make(chan error, 1)
	go func() { errc <- httpSrv.Serve(ln) }()
	select {
	case <-ctx.Done():
	case err := <-errc:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintln(stderr, "portplane:", err)
			return 1
		}
	}
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(sctx)
	return 0
}

// instance records the running Portplane so a second start can find it.
type instance struct {
	PID  int    `json:"pid"`
	Port int    `json:"port"`
	URL  string `json:"url"`
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
