package installer

import (
	"context"
	"path/filepath"
	"strconv"
	"strings"
)

// Plan is what an install will do, shown on its card before the click
// (ADR-0019): where it downloads from, how the download is checked, where
// it goes, and the command to do it by hand.
type Plan struct {
	Tool   string `json:"tool"`
	Method string `json:"method"`
	// Version is known ahead only for Node ("24").
	Version     string `json:"version,omitempty"`
	Source      string `json:"source"`
	Checksum    string `json:"checksum"`
	Destination string `json:"destination"`
	// Password is always false: installs never need an administrator.
	Password bool     `json:"password"`
	Steps    []string `json:"steps"`
	// Manual are the commands to do the same by hand, in order.
	Manual []string `json:"manual"`
	Docs   string   `json:"docs,omitempty"`
	// Alternatives are other ways the user has (Node: mise, fnm, volta).
	Alternatives []Alternative `json:"alternatives,omitempty"`
}

// Alternative is another way to install a tool.
type Alternative struct {
	Method   string   `json:"method"`
	Label    string   `json:"label"`
	Commands []string `json:"commands"`
}

// DekitPlan describes InstallDekit.
func (in *Installer) DekitPlan() Plan {
	return Plan{
		Tool: Dekit, Method: "script",
		Source:      "dekit's official installer (" + in.DekitScriptURL() + "), which downloads the latest release from github.com/pvolok/dekit",
		Checksum:    "The installer checks the release against its published SHA256SUMS before installing it.",
		Destination: Tilde(in.Home, filepath.Join(in.BinDir, in.exe("dekit"))),
		Steps:       DekitSteps(),
		Manual:      []string{in.DekitManual()},
		Docs:        "https://dekit.run",
	}
}

// NodePlan describes InstallNode with the private method, and offers the
// version managers this machine has.
func (in *Installer) NodePlan() Plan {
	v := strconv.Itoa(NodeMajor)
	p := Plan{
		Tool: Node, Method: "private", Version: v,
		Source:      "nodejs.org/dist (the latest Node.js " + v + " for this computer)",
		Checksum:    "Checked against the release's SHASUMS256.txt before it is unpacked.",
		Destination: Tilde(in.Home, filepath.Join(in.NodeDir(), "v"+v+".x.y")),
		Steps:       NodeSteps("private"),
		Docs:        "https://nodejs.org/en/download",
	}
	for _, m := range in.NodeManagers() {
		var cmds []string
		for _, c := range NodeManagerCommands(m) {
			cmds = append(cmds, strings.Join(c, " "))
		}
		p.Alternatives = append(p.Alternatives, Alternative{Method: m, Label: "Use " + m, Commands: cmds})
		if len(p.Manual) == 0 {
			p.Manual = cmds
		}
	}
	return p
}

// PortlessPlan describes InstallPortless for the Node that will run it.
func (in *Installer) PortlessPlan(ctx context.Context, node NodeInfo) Plan {
	method, prefix := "private", ""
	if node.OK() {
		method, prefix = in.PortlessMethod(ctx, node)
	}
	p := Plan{
		Tool: Portless, Method: method,
		Source:   "The npm registry (registry.npmjs.org, or the registry your npm is set to)",
		Checksum: "npm checks every package against the integrity hash the registry publishes.",
		Steps:    PortlessSteps(method),
		Manual:   []string{"npm install -g portless"},
		Docs:     "https://github.com/vercel-labs/portless",
	}
	if method == "npm" {
		p.Destination = Tilde(in.Home, in.globalBin(prefix))
	} else {
		launcher := filepath.Join(in.BinDir, "portless")
		if in.GOOS == "windows" {
			launcher += ".cmd"
		}
		p.Destination = Tilde(in.Home, in.PortlessPrefix()) + ", with a launcher at " + Tilde(in.Home, launcher)
	}
	return p
}
