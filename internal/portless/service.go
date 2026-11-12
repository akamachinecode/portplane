package portless

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"github.com/akamachinecode/portplane/internal/privileged"
)

// The proxy and its startup service (ADR-0023). Actions go through the
// portless CLI; the ones that need an administrator are returned as a
// privileged.Command for the caller to run on the user's click (ADR-0020).

// Ports the proxy usually listens on.
const (
	DefaultPort      = 443
	UnprivilegedPort = 1355 // portless's own fallback, no administrator needed
)

// ProxyOptions are the proxy's settings, as `portless service install` and
// `portless proxy start` take them.
type ProxyOptions struct {
	Port  int  `json:"port"`
	HTTPS bool `json:"https"`
	// TLDs, the first one the main one; empty means localhost.
	TLDs     []string `json:"tlds,omitempty"`
	Wildcard bool     `json:"wildcard"`
	// LAN publishes the names over mDNS as .local, for phones and other
	// computers on the network.
	LAN   bool   `json:"lan"`
	LANIP string `json:"lanIp,omitempty"`
	// Unprivileged binds the wildcard address for loopback peers only.
	Unprivileged bool   `json:"unprivileged"`
	CertPath     string `json:"certPath,omitempty"`
	KeyPath      string `json:"keyPath,omitempty"`
}

// DefaultProxyOptions is HTTPS on port 443 with .localhost names.
func DefaultProxyOptions() ProxyOptions {
	return ProxyOptions{Port: DefaultPort, HTTPS: true, TLDs: []string{"localhost"}}
}

// UnprivilegedProxyOptions is HTTPS on port 1355, which needs no
// administrator anywhere; URLs carry the port.
func UnprivilegedProxyOptions() ProxyOptions {
	return ProxyOptions{Port: UnprivilegedPort, HTTPS: true, TLDs: []string{"localhost"}}
}

var tldRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// Validate rejects options portless would refuse.
func (o ProxyOptions) Validate() error {
	if o.Port < 1 || o.Port > 65535 {
		return fmt.Errorf("port %d is not between 1 and 65535", o.Port)
	}
	for _, t := range o.TLDs {
		if !tldRe.MatchString(strings.TrimPrefix(t, ".")) {
			return fmt.Errorf("%q is not a valid top-level domain", t)
		}
	}
	if (o.CertPath == "") != (o.KeyPath == "") {
		return errors.New("a custom certificate needs both the certificate and its key")
	}
	if o.CertPath != "" && !o.HTTPS {
		return errors.New("a custom certificate needs HTTPS")
	}
	if o.LANIP != "" && !o.LAN {
		return errors.New("a LAN IP needs LAN mode")
	}
	return nil
}

// Args are the flags for these options.
func (o ProxyOptions) Args() []string {
	args := []string{"--port", strconv.Itoa(o.Port)}
	switch {
	case o.HTTPS && o.CertPath != "":
		args = append(args, "--cert", o.CertPath, "--key", o.KeyPath)
	case o.HTTPS:
		args = append(args, "--https")
	default:
		args = append(args, "--no-tls")
	}
	if o.LAN {
		args = append(args, "--lan")
		if o.LANIP != "" {
			args = append(args, "--ip", o.LANIP)
		}
	} else if tlds := o.tlds(); len(tlds) > 1 || tlds[0] != "localhost" {
		for _, t := range tlds {
			args = append(args, "--tld", t)
		}
	}
	if o.Wildcard {
		args = append(args, "--wildcard")
	}
	if o.Unprivileged {
		args = append(args, "--unprivileged")
	}
	return args
}

func (o ProxyOptions) tlds() []string {
	var out []string
	seen := map[string]bool{}
	for _, t := range o.TLDs {
		t = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(t)), ".")
		if t != "" && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return []string{"localhost"}
	}
	return out
}

// NeedsAdmin reports whether starting a proxy with these options by hand
// needs an administrator: only on Linux, for a port below the kernel's
// unprivileged start (1024 unless changed). macOS and Windows let anyone
// bind low ports.
func (o ProxyOptions) NeedsAdmin() bool {
	return needsAdminToBind(o.Port, runtime.GOOS, readUnprivilegedPortStart)
}

func needsAdminToBind(port int, goos string, start func() (int, error)) bool {
	if goos != "linux" || port >= 1024 {
		return false
	}
	s, err := start()
	if err != nil {
		return true
	}
	return port < s
}

func readUnprivilegedPortStart() (int, error) {
	b, err := os.ReadFile("/proc/sys/net/ipv4/ip_unprivileged_port_start")
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(b)))
}

// command builds a privileged run of portless with the user's environment,
// so portless keeps its state in the user's home.
func (c *Client) command(reason string, args ...string) (privileged.Command, error) {
	bin := c.Path()
	if bin == "" {
		return privileged.Command{}, errors.New("portless is not installed")
	}
	env := privileged.UserEnv()
	if c.StateDir != "" && c.StateDir != StateDir() {
		env["PORTLESS_STATE_DIR"] = c.StateDir
	}
	return privileged.Command{Argv: append([]string{bin}, args...), Env: env, Reason: reason}, nil
}

// ServiceInstallCommand installs (or reinstalls with new options) the
// service that starts the proxy with the computer: systemd on Linux, a
// LaunchDaemon on macOS, a SYSTEM task on Windows. It needs an
// administrator everywhere.
func (c *Client) ServiceInstallCommand(o ProxyOptions) (privileged.Command, error) {
	if err := o.Validate(); err != nil {
		return privileged.Command{}, err
	}
	return c.command("Portplane needs your password to install the portless proxy service, which serves your apps at .localhost addresses.",
		append([]string{"service", "install"}, o.Args()...)...)
}

// ServiceUninstallCommand stops and removes the startup service.
func (c *Client) ServiceUninstallCommand() (privileged.Command, error) {
	return c.command("Portplane needs your password to remove the portless proxy service.", "service", "uninstall")
}

// ProxyStartArgs are the arguments of `portless proxy start` for o.
func ProxyStartArgs(o ProxyOptions) []string {
	return append([]string{"proxy", "start"}, o.Args()...)
}

// ProxyStart starts the proxy in the background without an administrator.
// Callers check o.NeedsAdmin first and use ProxyStartCommand when it does.
func (c *Client) ProxyStart(ctx context.Context, o ProxyOptions) (string, error) {
	if err := o.Validate(); err != nil {
		return "", err
	}
	return c.runLong(ctx, ProxyStartArgs(o)...)
}

// ProxyStartCommand starts the proxy as administrator.
func (c *Client) ProxyStartCommand(o ProxyOptions) (privileged.Command, error) {
	if err := o.Validate(); err != nil {
		return privileged.Command{}, err
	}
	return c.command("Portplane needs your password to start the portless proxy on port "+strconv.Itoa(o.Port)+".", ProxyStartArgs(o)...)
}

// ProxyStop stops the proxy on port.
func (c *Client) ProxyStop(ctx context.Context, port int) (string, error) {
	return c.runLong(ctx, "proxy", "stop", "--port", strconv.Itoa(port))
}

// ProxyStopCommand stops a proxy that runs as root.
func (c *Client) ProxyStopCommand(port int) (privileged.Command, error) {
	return c.command("Portplane needs your password to stop the portless proxy.", "proxy", "stop", "--port", strconv.Itoa(port))
}

// TrustCommand adds the portless CA to the system's trust store. Linux
// needs an administrator to write the system store; macOS adds it to the
// login keychain and asks on its own, Windows to the user's store.
func (c *Client) TrustCommand() (cmd privileged.Command, admin bool, err error) {
	cmd, err = c.command("Portplane needs your password to trust the local certificate that makes .localhost addresses secure.", "trust")
	return cmd, runtime.GOOS == "linux", err
}

// HostsCommand runs `portless hosts sync` or `portless hosts clean`, which
// edit /etc/hosts (needed only for TLDs other than .localhost).
func (c *Client) HostsCommand(action string) (privileged.Command, error) {
	if action != "sync" && action != "clean" {
		return privileged.Command{}, fmt.Errorf("unknown hosts action %q", action)
	}
	return c.command("Portplane needs your password to update /etc/hosts for your local addresses.", "hosts", action)
}

// ServiceStatus is `portless service status`, plus whether the Node it
// starts with still exists.
type ServiceStatus struct {
	Installed    bool     `json:"installed"`
	ManagerState string   `json:"managerState"` // "active", "running", "installed", "not installed", …
	Responding   bool     `json:"responding"`
	Port         int      `json:"port"`
	HTTPS        bool     `json:"https"`
	TLDs         []string `json:"tlds"`
	LAN          bool     `json:"lan"`
	LANIP        string   `json:"lanIp,omitempty"`
	Wildcard     bool     `json:"wildcard"`
	Unprivileged bool     `json:"unprivileged"`
	StateDir     string   `json:"stateDir,omitempty"`
	Entry        string   `json:"entry,omitempty"` // the unit, plist or task
	// NodePath is the Node the service starts with, and NodeMissing that
	// it is gone, as after a Node upgrade that removed a versioned folder.
	NodePath    string `json:"nodePath,omitempty"`
	NodeMissing bool   `json:"nodeMissing"`
	// Parsed is false when the output was not understood; Raw has it.
	Parsed bool   `json:"parsed"`
	Raw    string `json:"raw"`
}

var proxyOnRe = regexp.MustCompile(`^Proxy on (\d+):\s*(.+)$`)

// ParseServiceStatus reads the output of `portless service status`
// (checked against portless 0.16).
func ParseServiceStatus(text string) ServiceStatus {
	st := ServiceStatus{Raw: text, TLDs: []string{}}
	fields := 0
	for _, line := range strings.Split(stripANSI(text), "\n") {
		line = strings.TrimSpace(line)
		if m := proxyOnRe.FindStringSubmatch(line); m != nil {
			st.Port, _ = strconv.Atoi(m[1])
			st.Responding = strings.TrimSpace(m[2]) == "responding"
			fields++
			continue
		}
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		val = strings.TrimSpace(val)
		yes := val == "yes"
		switch key {
		case "Manager state":
			st.ManagerState = val
		case "Installed":
			st.Installed = yes
		case "HTTPS":
			st.HTTPS = yes
		case "TLDs":
			for _, t := range strings.Split(val, ",") {
				if t = strings.TrimPrefix(strings.TrimSpace(t), "."); t != "" {
					st.TLDs = append(st.TLDs, t)
				}
			}
		case "LAN mode":
			st.LAN = yes
		case "LAN IP":
			st.LANIP = val
		case "Wildcard":
			st.Wildcard = yes
		case "Unprivileged":
			st.Unprivileged = yes
		case "State directory":
			st.StateDir = val
		case "Service entry":
			st.Entry = val
		default:
			continue
		}
		fields++
	}
	st.Parsed = fields >= 3 && st.ManagerState != ""
	return st
}

// ServiceStatus asks portless how its service stands. It needs no
// administrator.
func (c *Client) ServiceStatus(ctx context.Context) (ServiceStatus, error) {
	out, err := c.runLong(ctx, "service", "status")
	if err != nil {
		return ServiceStatus{Raw: out}, err
	}
	st := ParseServiceStatus(out)
	if st.Installed && st.Entry != "" {
		if b, err := os.ReadFile(st.Entry); err == nil {
			st.NodePath = ServiceNode(string(b))
			if st.NodePath != "" {
				if _, err := os.Stat(st.NodePath); err != nil {
					st.NodeMissing = true
				}
			}
		}
	}
	return st, nil
}

var plistStringRe = regexp.MustCompile(`<string>([^<]*)</string>`)

// ServiceNode returns the program a systemd unit or a launchd plist starts
// (portless writes Node's path there), or "".
func ServiceNode(entry string) string {
	for _, line := range strings.Split(entry, "\n") {
		if rest, ok := strings.CutPrefix(strings.TrimSpace(line), "ExecStart="); ok {
			rest = strings.TrimSpace(rest)
			if strings.HasPrefix(rest, `"`) {
				if end := strings.Index(rest[1:], `"`); end >= 0 {
					return rest[1 : end+1]
				}
			}
			word, _, _ := strings.Cut(rest, " ")
			return word
		}
	}
	if i := strings.Index(entry, "<key>ProgramArguments</key>"); i >= 0 {
		if m := plistStringRe.FindStringSubmatch(entry[i:]); m != nil {
			return m[1]
		}
	}
	return ""
}

// stripANSI removes colour codes from portless's output.
func stripANSI(s string) string {
	return ansiRe.ReplaceAllString(s, "")
}

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)
