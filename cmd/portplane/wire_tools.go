package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"time"

	"github.com/akamachinecode/portplane/internal/browsertrust"
	"github.com/akamachinecode/portplane/internal/envpath"
	"github.com/akamachinecode/portplane/internal/installer"
	"github.com/akamachinecode/portplane/internal/osinfo"
	"github.com/akamachinecode/portplane/internal/portless"
	"github.com/akamachinecode/portplane/internal/privileged"
	"github.com/akamachinecode/portplane/internal/server"
	"github.com/akamachinecode/portplane/internal/setup"
	"github.com/akamachinecode/portplane/internal/tray"
)

// toolsHandlers serves the guided setup: system check, installing dekit, Node and portless, the proxy service, browser trust (M5.1, ADR-0019, ADR-0020).
//
// GET /api/setup/check replaces the M2 route of the same name with the
// extended check; its JSON keeps the old fields.
func toolsHandlers(d deps) map[string]http.HandlerFunc {
	in := installer.New()
	// Tools Portplane installs are found at once, even before ~/.local/bin
	// is on PATH; a private Node is found after the user's own folders.
	envpath.WatchDir(in.BinDir)
	ictx, cancel := context.WithTimeout(d.ctx, 10*time.Second)
	in.UsePrivateNode(ictx)
	cancel()

	sys := &setup.System{
		GOOS: runtime.GOOS, Installer: in, Portless: d.portless,
		Version: setup.VersionOf,
		Browsers: func(ctx context.Context, ca portless.CA) browsertrust.Report {
			return browsertrust.Discover(ctx, browsertrust.LocalEnv(runtime.GOOS), ca.Path, ca.Trusted)
		},
		OS:                osinfo.System{},
		AnswersAsPortless: setup.AnswersAsPortless,
		Tray:              tray.Visible,
		HostsFile:         hostsFile(),
	}
	return server.ToolsHandlers(server.ToolsDeps{
		Jobs: d.jobs, GOOS: runtime.GOOS,
		Check: func(ctx context.Context, only []string) setup.Check {
			return setup.Evaluate(sys.Gather(ctx, only))
		},
		Steps: func(tool, method string) ([]string, error) { return installSteps(d.ctx, in, tool, method) },
		Install: func(ctx context.Context, tool, method string, p installer.Progress) (any, error) {
			switch tool {
			case installer.Dekit:
				return in.InstallDekit(ctx, p)
			case installer.Node:
				return in.InstallNode(ctx, p, method)
			default:
				return in.InstallPortless(ctx, p, method)
			}
		},
		Refresh: func() {
			envpath.Refresh()
			d.local.RefreshTools()
		},
		ServiceCommand: d.portless.ServiceInstallCommand,
		RunPrivileged:  privileged.Run,
		AdminMethod:    privileged.Method,
		ProxyStart:     d.portless.ProxyStart,
		VerifyProxy: func(ctx context.Context, o portless.ProxyOptions, p installer.Progress) (server.ProxyResult, error) {
			return verifyProxy(ctx, d, o, p)
		},
		Browsers: func(ctx context.Context) browsertrust.Report {
			ca := d.portless.CA()
			return browsertrust.Discover(ctx, browsertrust.LocalEnv(runtime.GOOS), ca.Path, ca.Trusted)
		},
		TrustBrowser: func(ctx context.Context, browser, profile string, out io.Writer) (browsertrust.Profile, error) {
			ca := d.portless.CA()
			return browsertrust.Add(ctx, browsertrust.LocalEnv(runtime.GOOS), ca.Path, ca.Trusted, browser, profile, out)
		},
		TrustCommand: d.portless.TrustCommand,
		RunAsUser:    runAsUser,
		PathStatus:   in.PathStatus,
		AddToPath:    in.AddToPath,
		Suggestions:  func() []setup.FolderSuggestion { return setup.SuggestFolders(in.Home) },
	})
}

func init() { areas = append(areas, toolsHandlers) }

func hostsFile() string {
	if runtime.GOOS == "windows" {
		return os.Getenv("SystemRoot") + `\System32\drivers\etc\hosts`
	}
	return "/etc/hosts"
}

// installSteps lists an install's stages and refuses a method the tool
// does not have.
func installSteps(ctx context.Context, in *installer.Installer, tool, method string) ([]string, error) {
	switch tool {
	case installer.Dekit:
		if method != "" && method != "script" {
			return nil, fmt.Errorf("unknown way to install dekit: %q", method)
		}
		return installer.DekitSteps(), nil
	case installer.Node:
		switch method {
		case "", "private", "mise", "fnm", "volta":
			return installer.NodeSteps(method), nil
		}
		return nil, fmt.Errorf("unknown way to install Node.js: %q", method)
	case installer.Portless:
		switch method {
		case "npm", "private":
		case "":
			ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
			method, _ = in.PortlessMethod(ctx, in.FindNode(ctx))
		default:
			return nil, fmt.Errorf("unknown way to install portless: %q", method)
		}
		return installer.PortlessSteps(method), nil
	}
	return nil, fmt.Errorf("unknown tool %q", tool)
}

// runAsUser runs a portless step that needs no administrator here, such
// as `portless trust` on macOS (the keychain asks on its own) and Windows.
func runAsUser(ctx context.Context, argv []string, env map[string]string, out io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = os.Environ()
	for k, v := range env {
		if k != "SUDO_USER" && k != "SUDO_UID" && k != "SUDO_GID" {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
	}
	cmd.Env = append(cmd.Env, "NO_COLOR=1")
	cmd.Stdout, cmd.Stderr = out, out
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return fmt.Errorf("portless exited with status %d", exit.ExitCode())
		}
		return err
	}
	return nil
}

// verifyProxy checks the proxy after it was installed or started: it
// answers like portless, the system trusts its CA, and
// https://portplane.localhost loads with a certificate that CA signed.
func verifyProxy(ctx context.Context, d deps, o portless.ProxyOptions, p installer.Progress) (server.ProxyResult, error) {
	url := portless.Proxy{Running: true, Port: o.Port, HTTPS: o.HTTPS}.URL(server.StableHost)
	res := server.ProxyResult{URL: url}

	p.Step("Check that the proxy answers")
	for i := 0; i < 40 && !res.Answers; i++ {
		if res.Answers = setup.AnswersAsPortless(ctx, o.Port); res.Answers {
			break
		}
		select {
		case <-ctx.Done():
			return res, ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	if !res.Answers {
		return res, fmt.Errorf("the proxy did not answer on port %d", o.Port)
	}
	p.Logf("The proxy answers on port %d.", o.Port)

	p.Step("Check the certificate")
	ca := d.portless.CA()
	res.CATrusted = ca.Trusted
	switch {
	case !o.HTTPS:
		p.Logf("Plain HTTP: no certificate to trust.")
		res.CATrusted = true
	case ca.Trusted:
		p.Logf("Your system trusts the local certificate (%s).", ca.Fingerprint)
	default:
		p.Logf("Your system doesn't trust the local certificate yet: browsers will warn until it does.")
	}

	p.Step("Open https://portplane.localhost")
	if port := loopbackPort(d.rawURL); port > 0 {
		actx, cancel := context.WithTimeout(ctx, 15*time.Second)
		if err := d.portless.Alias(actx, aliasName, port); err != nil {
			p.Logf("Could not name this window https://portplane.localhost: %v", err)
		}
		cancel()
	}
	if err := loads(ctx, url, o.Port, ca.Path); err != nil {
		p.Logf("%s does not load yet: %v", url, err)
		return res, nil
	}
	res.Loads = true
	p.Logf("%s loads.", url)
	return res, nil
}

func loopbackPort(raw string) int {
	u, err := url.Parse(raw)
	if err != nil {
		return 0
	}
	port, _ := strconv.Atoi(u.Port())
	return port
}

// loads fetches url through the proxy on port, trusting only portless's
// CA, so a success means the proxy routes the name and serves a valid
// certificate for it.
func loads(ctx context.Context, rawURL string, port int, caPath string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	pool := x509.NewCertPool()
	if pem, err := os.ReadFile(caPath); err == nil {
		pool.AppendCertsFromPEM(pem)
	}
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	tr := &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var dl net.Dialer
			return dl.DialContext(ctx, network, addr)
		},
		DisableKeepAlives: true,
	}
	defer tr.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	resp, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	if resp.StatusCode >= 500 {
		return fmt.Errorf("the proxy answered %s", resp.Status)
	}
	return nil
}
