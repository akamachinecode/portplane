package portless

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/akamachinecode/portplane/internal/envpath"
)

// The programs portless shares through (Tailscale, ngrok, cloudflared) and
// what each needs before a share can work, checked the way portless 0.16
// checks them (ensureTailscaleReady, ensureTunnelAvailable). Portplane only
// reads here: `tailscale status --json`, `tailscale debug prefs` and
// ngrok's config file.

// ToolRunner runs a read-only command and returns its standard output. The
// real one is RunTool; tests use fakes.
type ToolRunner func(ctx context.Context, name string, args ...string) ([]byte, error)

// ErrToolMissing means the program is not installed.
var ErrToolMissing = errors.New("not installed")

// RunTool runs name (found on PATH) with args for at most 10 seconds,
// without a shell. A failure carries what the program printed.
func RunTool(ctx context.Context, name string, args ...string) ([]byte, error) {
	bin := envpath.Lookup(name)
	if bin == "" {
		return nil, ErrToolMissing
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = append(os.Environ(), "NO_COLOR=1")
	cmd.WaitDelay = time.Second
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = strings.TrimSpace(out.String())
		}
		if msg == "" {
			msg = err.Error()
		}
		return out.Bytes(), fmt.Errorf("%s %s: %s", name, strings.Join(args, " "), msg)
	}
	return out.Bytes(), nil
}

// ---- Tailscale ----

// TailscaleState is what a Tailscale share needs, from `tailscale status
// --json` (and, on Linux, `tailscale debug prefs`).
type TailscaleState struct {
	Installed bool `json:"installed"`
	// DaemonDown: the tailscale program is there but its service isn't
	// running.
	DaemonDown   bool   `json:"daemonDown"`
	BackendState string `json:"backendState,omitempty"` // Running, NeedsLogin, Stopped…
	// Running: logged in and connected, the state portless needs.
	Running bool `json:"running"`
	// DNSName is this computer's name on the tailnet, such as
	// workstation.tail4c2a.ts.net; shares get https://<DNSName>[:port].
	DNSName  string `json:"dnsName,omitempty"`
	NodeID   string `json:"nodeId,omitempty"`
	Tailnet  string `json:"tailnet,omitempty"`
	MagicDNS bool   `json:"magicDns"`
	// HTTPS: the tailnet issues HTTPS certificates (needed for every share).
	HTTPS bool `json:"https"`
	// Funnel: the tailnet's policy lets this computer use Funnel.
	Funnel bool `json:"funnel"`
	// Operator is the user Tailscale lets change its settings without
	// administrator rights (Linux); OperatorKnown is false when it couldn't
	// be read.
	Operator      string `json:"operator,omitempty"`
	OperatorKnown bool   `json:"operatorKnown"`
	Error         string `json:"error,omitempty"`
}

type tailscaleStatusJSON struct {
	BackendState string `json:"BackendState"`
	Self         *struct {
		ID           string         `json:"ID"`
		HostName     string         `json:"HostName"`
		DNSName      string         `json:"DNSName"`
		Capabilities []string       `json:"Capabilities"`
		CapMap       map[string]any `json:"CapMap"`
	} `json:"Self"`
	CurrentTailnet *struct {
		Name            string `json:"Name"`
		MagicDNSSuffix  string `json:"MagicDNSSuffix"`
		MagicDNSEnabled bool   `json:"MagicDNSEnabled"`
	} `json:"CurrentTailnet"`
}

// ParseTailscaleStatus reads `tailscale status --json`.
func ParseTailscaleStatus(b []byte) (TailscaleState, error) {
	st := TailscaleState{Installed: true}
	var raw tailscaleStatusJSON
	if err := json.Unmarshal(b, &raw); err != nil {
		return st, errors.New("couldn't read tailscale status --json")
	}
	st.BackendState = raw.BackendState
	st.Running = raw.BackendState == "Running"
	if raw.CurrentTailnet != nil {
		st.Tailnet = raw.CurrentTailnet.Name
		st.MagicDNS = raw.CurrentTailnet.MagicDNSEnabled
	}
	if s := raw.Self; s != nil {
		st.NodeID = s.ID
		st.DNSName = strings.TrimSuffix(s.DNSName, ".")
		if st.DNSName == "" && s.HostName != "" && raw.CurrentTailnet != nil && raw.CurrentTailnet.MagicDNSSuffix != "" {
			st.DNSName = s.HostName + "." + strings.TrimSuffix(raw.CurrentTailnet.MagicDNSSuffix, ".")
		}
		has := func(match func(string) bool) bool {
			for _, c := range s.Capabilities {
				if match(strings.ToLower(c)) {
					return true
				}
			}
			for c := range s.CapMap {
				if match(strings.ToLower(c)) {
					return true
				}
			}
			return false
		}
		// portless's isHttpsCapability and isFunnelCapability.
		st.HTTPS = has(func(c string) bool { return c == "https" || strings.HasSuffix(c, "/https") })
		st.Funnel = has(func(c string) bool { return c == "funnel" || strings.HasSuffix(c, "/funnel") })
	}
	return st, nil
}

// ParseTailscalePrefs reads the operator user from `tailscale debug prefs`.
func ParseTailscalePrefs(b []byte) (string, bool) {
	var p struct {
		OperatorUser *string `json:"OperatorUser"`
	}
	if json.Unmarshal(b, &p) != nil {
		return "", false
	}
	if p.OperatorUser == nil {
		return "", true
	}
	return *p.OperatorUser, true
}

// ReadTailscale checks Tailscale. goos decides whether the operator
// matters (only Linux runs tailscaled as root and refuses serve otherwise).
func ReadTailscale(ctx context.Context, run ToolRunner, goos string) TailscaleState {
	out, err := run(ctx, "tailscale", "status", "--json")
	if errors.Is(err, ErrToolMissing) {
		return TailscaleState{}
	}
	if len(bytes.TrimSpace(out)) > 0 && bytes.HasPrefix(bytes.TrimSpace(out), []byte("{")) {
		// status --json prints the state even when logged out.
		st, perr := ParseTailscaleStatus(out)
		if perr == nil {
			if goos == "linux" {
				if pb, err := run(ctx, "tailscale", "debug", "prefs"); err == nil {
					st.Operator, st.OperatorKnown = ParseTailscalePrefs(pb)
				}
			}
			return st
		}
	}
	st := TailscaleState{Installed: true}
	if err != nil {
		st.Error = err.Error()
		low := strings.ToLower(st.Error)
		st.DaemonDown = strings.Contains(low, "doesn't appear to be running") || strings.Contains(low, "failed to connect to local tailscale") || strings.Contains(low, "is tailscaled running")
	}
	return st
}

// TailscaleFunnelPage is where the tailnet's admin allows Funnel for this
// computer (the link portless prints).
func TailscaleFunnelPage(nodeID string) string {
	if nodeID == "" {
		return "https://login.tailscale.com/admin/acls"
	}
	return "https://login.tailscale.com/f/funnel?node=" + nodeID
}

// TailscaleOperatorArgs let user run `tailscale serve` without root.
func TailscaleOperatorArgs(user string) []string {
	return []string{"set", "--operator=" + user}
}

// ---- ngrok ----

// NgrokState is what an ngrok share needs.
type NgrokState struct {
	Installed bool   `json:"installed"`
	Path      string `json:"path,omitempty"`
	// Authtoken: ngrok's config holds an authtoken (or NGROK_AUTHTOKEN is
	// set). The token itself never leaves this computer's files.
	Authtoken  bool   `json:"authtoken"`
	ConfigPath string `json:"configPath,omitempty"`
	FromEnv    bool   `json:"fromEnv"`
}

// NgrokConfigPaths are the files ngrok reads its config from, newest
// layout first (ngrok 3), then ngrok 2's.
func NgrokConfigPaths(goos, home string, getenv func(string) string) []string {
	var out []string
	switch goos {
	case "darwin":
		out = append(out, filepath.Join(home, "Library", "Application Support", "ngrok", "ngrok.yml"))
	case "windows":
		if d := getenv("LOCALAPPDATA"); d != "" {
			out = append(out, filepath.Join(d, "ngrok", "ngrok.yml"))
		}
	default:
		cfg := getenv("XDG_CONFIG_HOME")
		if cfg == "" {
			cfg = filepath.Join(home, ".config")
		}
		out = append(out, filepath.Join(cfg, "ngrok", "ngrok.yml"))
		// The snap keeps its config in its own folder.
		if m, _ := filepath.Glob(filepath.Join(home, "snap", "ngrok", "*", ".config", "ngrok", "ngrok.yml")); len(m) > 0 {
			out = append(out, m...)
		}
	}
	return append(out, filepath.Join(home, ".ngrok2", "ngrok.yml"))
}

// HasNgrokAuthtoken reports whether an ngrok config sets an authtoken:
// agent.authtoken (ngrok 3) or authtoken (ngrok 2).
func HasNgrokAuthtoken(b []byte) bool {
	var cfg struct {
		Authtoken string `yaml:"authtoken"`
		Agent     struct {
			Authtoken string `yaml:"authtoken"`
		} `yaml:"agent"`
	}
	if yaml.Unmarshal(b, &cfg) != nil {
		return false
	}
	return strings.TrimSpace(cfg.Authtoken) != "" || strings.TrimSpace(cfg.Agent.Authtoken) != ""
}

// ReadNgrok checks ngrok: installed, and its authtoken configured.
func ReadNgrok(lookup func(string) string, goos, home string, getenv func(string) string) NgrokState {
	st := NgrokState{Path: lookup("ngrok")}
	st.Installed = st.Path != ""
	for _, p := range NgrokConfigPaths(goos, home, getenv) {
		if b, err := os.ReadFile(p); err == nil && HasNgrokAuthtoken(b) {
			st.Authtoken, st.ConfigPath = true, p
			return st
		}
	}
	if getenv("NGROK_AUTHTOKEN") != "" {
		st.Authtoken, st.FromEnv = true, true
	}
	return st
}

var ngrokTokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]{20,200}$`)

// ValidNgrokToken reports whether token looks like an ngrok authtoken.
func ValidNgrokToken(token string) bool { return ngrokTokenRe.MatchString(token) }

// NgrokAuthtokenArgs saves token in ngrok's config (`ngrok config
// add-authtoken`), the way ngrok's own setup page says.
func NgrokAuthtokenArgs(token string) []string {
	return []string{"config", "add-authtoken", token}
}

// ---- install hints ----

// InstallHint says how to install a program on an OS: a page on its
// official site and, where there is one, a command to copy. Portplane
// never runs these.
type InstallHint struct {
	Page    string `json:"page"`
	Command string `json:"command,omitempty"`
}

// ToolInstallHint is how to get tailscale, ngrok, cloudflared or docker.
func ToolInstallHint(tool, goos string) InstallHint {
	switch tool {
	case "tailscale":
		h := InstallHint{Page: "https://tailscale.com/download"}
		switch goos {
		case "darwin":
			h.Command = "brew install --cask tailscale"
		case "windows":
			h.Command = "winget install tailscale.tailscale"
		}
		return h
	case "ngrok":
		h := InstallHint{Page: "https://ngrok.com/download"}
		switch goos {
		case "darwin":
			h.Command = "brew install ngrok"
		case "windows":
			h.Command = "winget install ngrok.ngrok"
		default:
			h.Command = "sudo snap install ngrok"
		}
		return h
	case "cloudflared":
		h := InstallHint{Page: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"}
		switch goos {
		case "darwin":
			h.Command = "brew install cloudflared"
		case "windows":
			h.Command = "winget install --id Cloudflare.cloudflared"
		}
		return h
	case "docker":
		return InstallHint{Page: "https://docs.docker.com/get-started/get-docker/"}
	}
	return InstallHint{}
}
