package portless

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/akamachinecode/portplane/internal/envpath"
)

// How portless was installed, from where its program really lives (plan
// §5.8), so updating and uninstalling use the same tool that installed it.

// Origins.
const (
	OriginNPM       = "npm"       // npm install -g portless
	OriginHomebrew  = "homebrew"  // brew install portless
	OriginPortplane = "portplane" // Portplane's private prefix (ADR-0019)
	OriginPNPM      = "pnpm"
	OriginBun       = "bun"
	OriginVolta     = "volta"
	OriginUnknown   = "unknown"
)

// ToolCommand is a command that updates or removes portless.
type ToolCommand struct {
	Argv []string          `json:"argv"`
	Env  map[string]string `json:"env,omitempty"`
	// Admin: the install folder belongs to the administrator (a system
	// npm, say), so the command needs the password.
	Admin bool `json:"admin"`
}

// Install says where portless lives and how to update or remove it.
type Install struct {
	Origin string `json:"origin"`
	Bin    string `json:"bin"`              // portless on PATH
	Script string `json:"script,omitempty"` // portless's dist/cli.js, symlinks resolved
	// Prefix is the npm prefix, or Homebrew's prefix.
	Prefix    string       `json:"prefix,omitempty"`
	Update    *ToolCommand `json:"update,omitempty"`
	Uninstall *ToolCommand `json:"uninstall,omitempty"`
}

var cliPathRe = regexp.MustCompile(`([A-Za-z]:)?[^\s"'=]*node_modules[/\\]portless[/\\]dist[/\\]cli\.js`)

// DetectInstall works out how the portless at bin was installed. lookup
// finds other programs (npm, brew); nil uses envpath.Lookup.
func DetectInstall(bin string, lookup func(string) string) Install {
	if lookup == nil {
		lookup = envpath.Lookup
	}
	in := Install{Origin: OriginUnknown, Bin: bin}
	if bin == "" {
		return in
	}
	script := bin
	if real, err := filepath.EvalSymlinks(bin); err == nil {
		script = real
	}
	// A shim (Portplane's, or a Windows .cmd) names the script inside.
	if !strings.HasSuffix(filepath.ToSlash(script), "/dist/cli.js") {
		if b, err := os.ReadFile(script); err == nil && len(b) < 64<<10 {
			if m := cliPathRe.Find(b); m != nil {
				p := string(m)
				if !filepath.IsAbs(p) {
					p = filepath.Join(filepath.Dir(script), p)
				}
				if real, err := filepath.EvalSymlinks(p); err == nil {
					p = real
				}
				script = p
			}
		}
	}
	if strings.HasSuffix(filepath.ToSlash(script), "/dist/cli.js") {
		in.Script = script
	}
	slash := filepath.ToSlash(script)
	lower := strings.ToLower(slash)
	binSlash := strings.ToLower(filepath.ToSlash(bin))
	switch {
	case strings.Contains(slash, "/Cellar/portless/"):
		in.Origin = OriginHomebrew
		before, _, _ := strings.Cut(slash, "/Cellar/")
		in.Prefix = filepath.FromSlash(before)
		brew := filepath.Join(in.Prefix, "bin", "brew")
		if !exists(brew) {
			brew = lookup("brew")
		}
		if brew != "" {
			in.Update = &ToolCommand{Argv: []string{brew, "upgrade", "portless"}}
			in.Uninstall = &ToolCommand{Argv: []string{brew, "uninstall", "portless"}}
		}
	case strings.Contains(lower, "/portplane/") && strings.Contains(lower, "/node_modules/portless/"):
		in.Origin = OriginPortplane
		in.Prefix = npmPrefix(script)
		if npm, nodeBin := privateNPM(in.Prefix); npm != "" {
			env := map[string]string{"PATH": nodeBin + string(os.PathListSeparator) + os.Getenv("PATH")}
			in.Update = &ToolCommand{Argv: []string{npm, "install", "--global", "--prefix", in.Prefix, "portless@latest"}, Env: env}
			in.Uninstall = &ToolCommand{Argv: []string{npm, "uninstall", "--global", "--prefix", in.Prefix, "portless"}, Env: env}
		}
	case strings.Contains(lower, "/pnpm/global/") || strings.Contains(lower, "/.pnpm-global/"):
		in.Origin = OriginPNPM
		if pnpm := lookup("pnpm"); pnpm != "" {
			in.Update = &ToolCommand{Argv: []string{pnpm, "add", "--global", "portless@latest"}}
			in.Uninstall = &ToolCommand{Argv: []string{pnpm, "remove", "--global", "portless"}}
		}
	case strings.Contains(lower, "/.bun/"):
		in.Origin = OriginBun
		if bun := lookup("bun"); bun != "" {
			in.Update = &ToolCommand{Argv: []string{bun, "add", "--global", "portless@latest"}}
			in.Uninstall = &ToolCommand{Argv: []string{bun, "remove", "--global", "portless"}}
		}
	case strings.Contains(lower, "/.volta/") || strings.Contains(binSlash, "/.volta/"):
		in.Origin = OriginVolta
		if volta := lookup("volta"); volta != "" {
			in.Update = &ToolCommand{Argv: []string{volta, "install", "portless@latest"}}
			in.Uninstall = &ToolCommand{Argv: []string{volta, "uninstall", "portless"}}
		}
	case strings.Contains(slash, "/node_modules/portless/"):
		in.Origin = OriginNPM
		in.Prefix = npmPrefix(script)
		npm := filepath.Join(in.Prefix, "bin", "npm")
		if !exists(npm) {
			npm = filepath.Join(in.Prefix, "npm.cmd") // Windows: %APPDATA%\npm
		}
		if !exists(npm) {
			npm = lookup("npm")
		}
		if npm != "" {
			// <prefix>/lib/node_modules/portless/dist/cli.js
			admin := !writable(filepath.Dir(filepath.Dir(filepath.Dir(script))))
			in.Update = &ToolCommand{Argv: []string{npm, "install", "--global", "portless@latest"}, Admin: admin}
			in.Uninstall = &ToolCommand{Argv: []string{npm, "uninstall", "--global", "portless"}, Admin: admin}
		}
	}
	return in
}

// npmPrefix is the prefix of a global npm install: the folder holding
// lib/node_modules (or node_modules on Windows).
func npmPrefix(script string) string {
	slash := filepath.ToSlash(script)
	i := strings.LastIndex(slash, "/node_modules/portless/")
	if i < 0 {
		return ""
	}
	p := strings.TrimSuffix(slash[:i], "/lib")
	return filepath.FromSlash(p)
}

// privateNPM finds the npm of Portplane's private Node next to the private
// prefix: <data>/portplane/node/<version>/bin/npm, the newest version.
func privateNPM(prefix string) (string, string) {
	root := filepath.ToSlash(prefix)
	i := strings.LastIndex(strings.ToLower(root), "/portplane/")
	if i < 0 {
		return "", ""
	}
	base := filepath.FromSlash(root[:i+len("/portplane")])
	matches, _ := filepath.Glob(filepath.Join(base, "node", "*", "bin", "npm"))
	if len(matches) == 0 {
		matches, _ = filepath.Glob(filepath.Join(base, "node", "*", "npm.cmd"))
	}
	if len(matches) == 0 {
		return "", ""
	}
	sort.Strings(matches)
	npm := matches[len(matches)-1]
	return npm, filepath.Dir(npm)
}

// writable reports whether this user can create files in dir.
func writable(dir string) bool {
	f, err := os.CreateTemp(dir, ".portplane-check-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

// CleanRemoves is what `portless clean` deletes, in plain words (portless
// 0.16's handleClean), for the confirmation before uninstalling.
func CleanRemoves(stateDir, hostsPath string) []string {
	return []string{
		"Stops the proxy and removes its startup service, if installed.",
		"Removes portless's local certificate authority from your system's trusted certificates.",
		"Deletes portless's files in " + stateDir + ": routes, proxy settings and certificates.",
		"Removes portless's block from " + hostsPath + ".",
	}
}
