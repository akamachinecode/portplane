package portless

import (
	"path/filepath"
	"strings"
)

// Wrapped describes a task command that runs through portless.
type Wrapped struct {
	Name string // the name given to portless ("" when portless infers it)
	Run  bool   // `portless run`, which adds the worktree prefix itself
	// AppPort is --app-port, when the command pins the app's port.
	AppPort string
	Inner   []string // the wrapped command
}

// commands that are portless subcommands, not app names.
var subcommands = map[string]bool{
	"proxy": true, "mcp": true, "service": true, "get": true, "alias": true, "compose": true,
	"list": true, "doctor": true, "trust": true, "clean": true, "prune": true, "hosts": true,
}

// ParseCommand recognises `portless <name> <cmd…>` and
// `portless run [--name n] [--app-port p] <cmd…>`, also behind
// `npx`/`pnpm exec`/`cmd /c`. It returns nil for anything else.
func ParseCommand(argv []string) *Wrapped {
	// Windows: dekit runs .cmd shims through `cmd /c "<command>"` (ADR-0010).
	if len(argv) >= 3 && strings.EqualFold(strings.TrimSuffix(strings.ToLower(filepath.Base(argv[0])), ".exe"), "cmd") && strings.EqualFold(argv[1], "/c") {
		if len(argv) == 3 {
			argv = strings.Fields(argv[2])
		} else {
			argv = argv[2:]
		}
	}
	i := indexOfPortless(argv)
	if i < 0 || i+1 >= len(argv) {
		return nil
	}
	rest := argv[i+1:]
	if rest[0] == "run" {
		w := &Wrapped{Run: true}
		j := 1
		for j < len(rest) {
			a := rest[j]
			switch {
			case a == "--name" && j+1 < len(rest):
				w.Name, j = rest[j+1], j+2
			case strings.HasPrefix(a, "--name="):
				w.Name, j = strings.TrimPrefix(a, "--name="), j+1
			case a == "--app-port" && j+1 < len(rest):
				w.AppPort, j = rest[j+1], j+2
			case strings.HasPrefix(a, "--app-port="):
				w.AppPort, j = strings.TrimPrefix(a, "--app-port="), j+1
			case a == "--":
				j++
				w.Inner = rest[j:]
				return w
			case strings.HasPrefix(a, "-"):
				j++ // other flags without values (--tailscale, --funnel…)
			default:
				w.Inner = rest[j:]
				return w
			}
		}
		return w
	}
	if strings.HasPrefix(rest[0], "-") || subcommands[rest[0]] {
		return nil
	}
	w := &Wrapped{Name: rest[0]}
	j := 1
	for j < len(rest) && strings.HasPrefix(rest[j], "-") {
		if rest[j] == "--app-port" && j+1 < len(rest) {
			w.AppPort = rest[j+1]
			j += 2
			continue
		}
		j++
	}
	w.Inner = rest[j:]
	return w
}

func indexOfPortless(argv []string) int {
	for i, a := range argv {
		if i > 3 {
			break
		}
		base := strings.ToLower(filepath.Base(strings.ReplaceAll(a, `\`, "/")))
		base = strings.TrimSuffix(strings.TrimSuffix(base, ".cmd"), ".exe")
		if base == "portless" {
			return i
		}
	}
	return -1
}

// Hostname predicts the hostname portless gives a wrapped command run in a
// checkout. Named mode uses the name as is; `portless run` prefixes the
// worktree name for linked worktrees (field notes). tld is usually
// "localhost".
func (w *Wrapped) Hostname(worktree, tld string) string {
	if w == nil || w.Name == "" {
		return ""
	}
	if tld == "" {
		tld = "localhost"
	}
	name := strings.TrimSuffix(w.Name, "."+tld)
	if w.Run && worktree != "" {
		name = worktree + "." + name
	}
	return name + "." + tld
}
