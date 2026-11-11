// Package portless reads portless routes and names (ADR-0007) and registers
// aliases through its CLI.
package portless

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/envpath"
)

// Route is one active portless route.
type Route struct {
	Hostname     string `json:"hostname"`
	Port         int    `json:"port"`
	PID          int    `json:"pid"`
	RegisteredAt int64  `json:"registeredAt,omitempty"`
}

// Static reports whether the route is an alias rather than a wrapped process.
func (r Route) Static() bool { return r.PID == 0 }

// Proxy describes the running proxy.
type Proxy struct {
	Running bool
	Port    int
	HTTPS   bool
}

// URL returns the public URL for a hostname behind this proxy.
func (p Proxy) URL(hostname string) string {
	if hostname == "" {
		return ""
	}
	scheme, defPort := "http", 80
	if p.HTTPS || p.Port == 0 {
		scheme, defPort = "https", 443
	}
	port := p.Port
	if port == 0 {
		port = 443
	}
	if port == defPort {
		return scheme + "://" + hostname
	}
	return fmt.Sprintf("%s://%s:%d", scheme, hostname, port)
}

// Client reads portless state and calls its CLI.
type Client struct {
	// Bin is portless's path. Empty: it is looked up on PATH, again every
	// few seconds, so one installed while Portplane runs is found.
	Bin      string
	StateDir string
}

// New returns a client that finds portless on PATH, and its state directory.
func New() *Client {
	return &Client{StateDir: StateDir()}
}

// Path is portless's path now, or "" when it is not installed.
func (c *Client) Path() string {
	if c.Bin != "" {
		return c.Bin
	}
	return envpath.Lookup("portless")
}

// Available reports whether the portless CLI was found.
func (c *Client) Available() bool { return c.Path() != "" }

// StateDir is PORTLESS_STATE_DIR, else ~/.portless.
func StateDir() string {
	if d := os.Getenv("PORTLESS_STATE_DIR"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".portless")
}

// Routes reads routes.json. A missing or unreadable file means no routes.
func (c *Client) Routes() []Route {
	if c.StateDir == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(c.StateDir, "routes.json"))
	if err != nil {
		return nil
	}
	var routes []Route
	if err := json.Unmarshal(b, &routes); err != nil {
		return nil
	}
	out := routes[:0]
	for _, r := range routes {
		if r.Hostname != "" && r.Port > 0 {
			out = append(out, r)
		}
	}
	return out
}

// Proxy reads proxy.port and proxy.tls. Running means the proxy's pid file
// names a live process; the caller can refine it with a listening check.
func (c *Client) Proxy() Proxy {
	var p Proxy
	if c.StateDir == "" {
		return p
	}
	if b, err := os.ReadFile(filepath.Join(c.StateDir, "proxy.port")); err == nil {
		p.Port, _ = strconv.Atoi(strings.TrimSpace(string(b)))
	}
	if b, err := os.ReadFile(filepath.Join(c.StateDir, "proxy.tls")); err == nil {
		p.HTTPS = strings.TrimSpace(string(b)) == "1"
	}
	if b, err := os.ReadFile(filepath.Join(c.StateDir, "proxy.pid")); err == nil {
		if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && pid > 0 {
			p.Running = processAlive(pid)
		}
	}
	if p.Port == 0 {
		p.Port, p.HTTPS = 443, true
	}
	return p
}

// Version returns the portless version, such as "0.16.0".
func (c *Client) Version(ctx context.Context) (string, error) {
	out, err := c.run(ctx, "--version")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(out), "portless ")), nil
}

// Alias registers a static route name -> 127.0.0.1:port.
func (c *Client) Alias(ctx context.Context, name string, port int) error {
	_, err := c.run(ctx, "alias", name, strconv.Itoa(port), "--force")
	return err
}

// RemoveAlias removes a static route.
func (c *Client) RemoveAlias(ctx context.Context, name string) error {
	_, err := c.run(ctx, "alias", "--remove", name)
	return err
}

// runLong runs a portless command that may take a while (proxy start,
// service status) and returns its output, colours removed, also when it
// fails.
func (c *Client) runLong(ctx context.Context, args ...string) (string, error) {
	bin := c.Path()
	if bin == "" {
		return "", fmt.Errorf("portless is not installed")
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = append(os.Environ(), "NO_COLOR=1", "FORCE_COLOR=0")
	if c.StateDir != "" && c.StateDir != StateDir() {
		cmd.Env = append(cmd.Env, "PORTLESS_STATE_DIR="+c.StateDir)
	}
	cmd.WaitDelay = 2 * time.Second
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	text := stripANSI(out.String())
	if err != nil {
		msg := strings.TrimSpace(text)
		if msg == "" {
			msg = err.Error()
		}
		if i := strings.LastIndex(msg, "Error:"); i >= 0 {
			msg = strings.TrimSpace(msg[i+len("Error:"):])
		}
		return text, fmt.Errorf("portless %s: %s", strings.Join(args, " "), msg)
	}
	return text, nil
}

func (c *Client) run(ctx context.Context, args ...string) (string, error) {
	bin := c.Path()
	if bin == "" {
		return "", fmt.Errorf("portless is not installed")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("portless %s: %s", strings.Join(args, " "), msg)
	}
	return out.String(), nil
}
