package portless

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Every route in routes.json, stale ones included (plan §5.2). portless
// list has no --json and hides stale routes, so the file is read directly
// (ADR-0007); unknown fields are ignored and missing ones left empty.

// RouteEntry is one entry of routes.json as portless 0.16 writes it.
type RouteEntry struct {
	Hostname     string `json:"hostname"`
	Port         int    `json:"port"`
	PID          int    `json:"pid"`
	RegisteredAt int64  `json:"registeredAt,omitempty"`
	// The dev server portless started, for `prune` to stop it.
	ChildPGID int `json:"childPgid,omitempty"`
	// Where the route is shared (portless run --tailscale/--funnel/--ngrok/--cloudflare).
	TailscaleURL    string `json:"tailscaleUrl,omitempty"`
	TailscaleFunnel bool   `json:"tailscaleFunnel,omitempty"`
	NgrokURL        string `json:"ngrokUrl,omitempty"`
	CloudflareURL   string `json:"cloudflareUrl,omitempty"`
	// The Tailscale HTTPS port the share took (443, 8443…), and the
	// tunnel processes portless started.
	TailscaleHTTPSPort int `json:"tailscaleHttpsPort,omitempty"`
	NgrokPID           int `json:"ngrokPid,omitempty"`
	CloudflarePID      int `json:"cloudflarePid,omitempty"`
}

// Route kinds.
const (
	KindApp     = "app"
	KindAlias   = "alias"
	KindCompose = "compose"
)

// Shared is a public URL a route is shared at.
type Shared struct {
	Kind string `json:"kind"` // tailscale, funnel, ngrok, cloudflare
	URL  string `json:"url"`
}

// RouteState is a route with what Portplane can tell about it.
type RouteState struct {
	RouteEntry
	// Alive: an alias, or a route whose portless process still runs.
	// A dead process makes the route stale: `portless prune` removes it.
	Alive bool   `json:"alive"`
	Kind  string `json:"kind"`
	// Compose is the docker compose project that registered the alias.
	Compose string   `json:"compose,omitempty"`
	Shared  []Shared `json:"shared"`
}

// ReadRoutes returns every entry of routes.json, stale ones too. A missing
// file is no routes; an unreadable one is an error, so the UI can say so.
func (c *Client) ReadRoutes() ([]RouteEntry, error) {
	if c.StateDir == "" {
		return nil, nil
	}
	b, err := os.ReadFile(filepath.Join(c.StateDir, "routes.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ParseRoutes(b)
}

// ParseRoutes reads routes.json, keeping entries portless itself accepts
// (a hostname, a port and a pid).
func ParseRoutes(b []byte) ([]RouteEntry, error) {
	var raw []json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, errors.New("routes.json is not a list of routes; portless rewrites it on the next change")
	}
	out := []RouteEntry{}
	for _, r := range raw {
		var probe struct {
			Hostname *string  `json:"hostname"`
			Port     *float64 `json:"port"`
			PID      *float64 `json:"pid"`
		}
		if json.Unmarshal(r, &probe) != nil || probe.Hostname == nil || probe.Port == nil || probe.PID == nil {
			continue
		}
		var e RouteEntry
		if json.Unmarshal(r, &e) != nil {
			continue
		}
		out = append(out, e)
	}
	return out, nil
}

// RouteStates reads every route with its liveness, kind and shares.
func (c *Client) RouteStates() ([]RouteState, error) {
	entries, err := c.ReadRoutes()
	if err != nil {
		return nil, err
	}
	compose := c.composePorts()
	out := make([]RouteState, 0, len(entries))
	for _, e := range entries {
		s := RouteState{RouteEntry: e, Kind: KindApp, Shared: []Shared{}}
		if e.PID == 0 {
			s.Kind, s.Alive = KindAlias, true
			if p, ok := compose[e.Port]; ok {
				s.Kind, s.Compose = KindCompose, p
			}
		} else {
			s.Alive = processAlive(e.PID)
		}
		switch {
		case e.TailscaleURL != "" && e.TailscaleFunnel:
			s.Shared = append(s.Shared, Shared{Kind: "funnel", URL: e.TailscaleURL})
		case e.TailscaleURL != "":
			s.Shared = append(s.Shared, Shared{Kind: "tailscale", URL: e.TailscaleURL})
		}
		if e.NgrokURL != "" {
			s.Shared = append(s.Shared, Shared{Kind: "ngrok", URL: e.NgrokURL})
		}
		if e.CloudflareURL != "" {
			s.Shared = append(s.Shared, Shared{Kind: "cloudflare", URL: e.CloudflareURL})
		}
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Hostname < out[j].Hostname })
	return out, nil
}

// composePorts maps the ports `portless compose up` reserved to their
// project, from compose/<project>.ports.json.
func (c *Client) composePorts() map[int]string {
	out := map[int]string{}
	if c.StateDir == "" {
		return out
	}
	dir := filepath.Join(c.StateDir, "compose")
	files, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, f := range files {
		project, ok := strings.CutSuffix(f.Name(), ".ports.json")
		if !ok {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, f.Name()))
		if err != nil {
			continue
		}
		var ports map[string]any
		if json.Unmarshal(b, &ports) != nil {
			continue
		}
		for _, v := range ports {
			if n, ok := v.(float64); ok && n > 0 {
				out[int(n)] = project
			}
		}
	}
	return out
}

// AddAlias registers a static route name → 127.0.0.1:port. Without force,
// portless refuses a name another route holds.
func (c *Client) AddAlias(ctx context.Context, name string, port int, force bool) (string, error) {
	args := []string{"alias", name, strconv.Itoa(port)}
	if force {
		args = append(args, "--force")
	}
	return c.runLong(ctx, args...)
}

// RemoveAliasOutput removes a static route and returns what portless said.
func (c *Client) RemoveAliasOutput(ctx context.Context, name string) (string, error) {
	return c.runLong(ctx, "alias", "--remove", name)
}

// PruneArgs are the arguments of `portless prune`: it removes stale routes
// and stops the dev servers still holding their ports, with SIGTERM, or
// SIGKILL with force.
func PruneArgs(force bool) []string {
	if force {
		return []string{"prune", "--force"}
	}
	return []string{"prune"}
}

// PruneLine is one route `portless prune` acted on.
type PruneLine struct {
	Hostname string `json:"hostname"`
	Port     int    `json:"port,omitempty"`
	PID      int    `json:"pid,omitempty"`
	// Action: "removed" (port already free), "killed", "exited",
	// "killed-group", "tunnel" (a share it stopped).
	Action string `json:"action"`
	Signal string `json:"signal,omitempty"`
}

// PruneResult is the parsed output of `portless prune`.
type PruneResult struct {
	Routes int         `json:"routes"`
	Killed int         `json:"killed"`
	Lines  []PruneLine `json:"lines"`
	Parsed bool        `json:"parsed"`
}

var (
	pruneSummaryRe = regexp.MustCompile(`^Pruned (\d+) stale routes?, killed (\d+) orphaned process(?:es)?\.$`)
	pruneFreeRe    = regexp.MustCompile(`^(\S+) :(\d+) - route removed \(port already free\)$`)
	pruneKilledRe  = regexp.MustCompile(`^(\S+) :(\d+) - killed PID (\d+) \((\w+)\)$`)
	pruneExitedRe  = regexp.MustCompile(`^(\S+) :(\d+) - PID (\d+) already exited$`)
	pruneGroupRe   = regexp.MustCompile(`^(\S+) - killed process group (\d+) \((\w+)\)$`)
	pruneTunnelRe  = regexp.MustCompile(`^(\S+) - (?:removed tailscale serve on port \d+|stopped \S+ tunnel)$`)
)

// ParsePrune reads the output of `portless prune` (portless 0.16).
func ParsePrune(text string) PruneResult {
	res := PruneResult{Lines: []PruneLine{}}
	atoi := func(s string) int { n, _ := strconv.Atoi(s); return n }
	for _, line := range strings.Split(stripANSI(text), "\n") {
		line = strings.TrimSpace(line)
		if line == "No orphaned routes found." {
			res.Parsed = true
			continue
		}
		if m := pruneSummaryRe.FindStringSubmatch(line); m != nil {
			res.Routes, res.Killed, res.Parsed = atoi(m[1]), atoi(m[2]), true
			continue
		}
		if m := pruneFreeRe.FindStringSubmatch(line); m != nil {
			res.Lines = append(res.Lines, PruneLine{Hostname: m[1], Port: atoi(m[2]), Action: "removed"})
			continue
		}
		if m := pruneKilledRe.FindStringSubmatch(line); m != nil {
			res.Lines = append(res.Lines, PruneLine{Hostname: m[1], Port: atoi(m[2]), PID: atoi(m[3]), Action: "killed", Signal: m[4]})
			continue
		}
		if m := pruneExitedRe.FindStringSubmatch(line); m != nil {
			res.Lines = append(res.Lines, PruneLine{Hostname: m[1], Port: atoi(m[2]), PID: atoi(m[3]), Action: "exited"})
			continue
		}
		if m := pruneGroupRe.FindStringSubmatch(line); m != nil {
			res.Lines = append(res.Lines, PruneLine{Hostname: m[1], PID: atoi(m[2]), Action: "killed-group", Signal: m[3]})
			continue
		}
		if m := pruneTunnelRe.FindStringSubmatch(line); m != nil {
			res.Lines = append(res.Lines, PruneLine{Hostname: m[1], Action: "tunnel"})
		}
	}
	return res
}

// Get is `portless get <name>` run in dir: the URL portless would give an
// app with that name there, worktree prefix and top-level domain included.
// It changes nothing.
func (c *Client) Get(ctx context.Context, dir, name string) (string, error) {
	out, err := c.runIn(ctx, dir, "get", name)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}
