package setup

import (
	"context"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Requirement is one thing setup needs, with how to get it (P5: Portplane
// guides, it never installs or runs privileged steps on its own).
type Requirement struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Why       string   `json:"why"`
	OK        bool     `json:"ok"`
	Version   string   `json:"version,omitempty"`
	Problem   string   `json:"problem,omitempty"`
	Commands  []string `json:"commands,omitempty"` // copyable, in order
	Docs      string   `json:"docs,omitempty"`
	Privilege bool     `json:"privilege"` // the command needs sudo or an elevated terminal
}

// Check is the dependency report.
type Check struct {
	Requirements []Requirement `json:"requirements"`
	Ready        bool          `json:"ready"` // everything needed to write and run config
}

// Facts are the inputs of a check, so it can be tested.
type Facts struct {
	GOOS            string
	Dekit           string // version, empty when missing
	Portless        string
	Node            string // "v24.1.0"
	ProxyRunning    bool
	PortplaneOnPATH bool
}

// GatherFacts reads them from this machine.
func GatherFacts(ctx context.Context, dekitVersion, portlessVersion string, proxyRunning bool) Facts {
	f := Facts{GOOS: runtime.GOOS, Dekit: dekitVersion, Portless: portlessVersion, ProxyRunning: proxyRunning}
	if node, err := exec.LookPath("node"); err == nil {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if out, err := exec.CommandContext(ctx, node, "--version").Output(); err == nil {
			f.Node = strings.TrimSpace(string(out))
		}
	}
	_, err := exec.LookPath("portplane")
	f.PortplaneOnPATH = err == nil
	return f
}

// Evaluate turns facts into requirements with instructions per OS.
func Evaluate(f Facts) Check {
	win := f.GOOS == "windows"
	var reqs []Requirement

	nodeOK := nodeMajor(f.Node) >= 24
	node := Requirement{ID: "node", Name: "Node.js 24 or later", Why: "portless runs on Node.js 24+.", OK: nodeOK, Version: f.Node, Docs: "https://nodejs.org"}
	if !nodeOK {
		if f.Node == "" {
			node.Problem = "Node.js was not found on PATH."
		} else {
			node.Problem = "Node.js " + f.Node + " is too old."
		}
		node.Commands = []string{"mise use -g node@24"}
	}
	reqs = append(reqs, node)

	dk := Requirement{ID: "dekit", Name: "dekit", Why: "Runs and supervises your dev servers; Portplane writes its config and starts and stops tasks through it.", OK: f.Dekit != "", Version: f.Dekit, Docs: "https://dekit.run"}
	if !dk.OK {
		dk.Problem = "dekit was not found on PATH."
		if win {
			dk.Commands = []string{"irm https://dekit.run/install.ps1 | iex"}
		} else {
			dk.Commands = []string{"curl -fsSL https://dekit.run/install.sh | sh"}
		}
	}
	reqs = append(reqs, dk)

	pl := Requirement{ID: "portless", Name: "portless", Why: "Gives every dev server a stable https://<name>.localhost URL, whatever port it lands on.", OK: f.Portless != "", Version: f.Portless, Docs: "https://github.com/vercel-labs/portless"}
	if !pl.OK {
		pl.Problem = "portless was not found on PATH."
		pl.Commands = []string{"npm install -g portless"}
	}
	reqs = append(reqs, pl)

	px := Requirement{ID: "proxy", Name: "portless proxy on port 443", Why: "Serves the .localhost URLs over HTTPS with a trusted local certificate, and starts with your computer.", OK: f.ProxyRunning, Privilege: true}
	if !px.OK {
		px.Problem = "The portless proxy is not running."
		if win {
			px.Commands = []string{"portless service install   # in a terminal opened as Administrator"}
		} else {
			px.Commands = []string{"sudo portless service install"}
		}
	}
	reqs = append(reqs, px)

	pp := Requirement{ID: "portplane", Name: "portplane on PATH", Why: "A few generated tasks (Sanity, Remotion) call `portplane port-exec` to pass the port.", OK: f.PortplaneOnPATH}
	if !pp.OK {
		pp.Problem = "The portplane binary is not on PATH; tasks that use port-exec would not start."
	}
	reqs = append(reqs, pp)

	ready := dk.OK && pl.OK && nodeOK
	return Check{Requirements: reqs, Ready: ready}
}

func nodeMajor(v string) int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	major, _, _ := strings.Cut(v, ".")
	n, err := strconv.Atoi(major)
	if err != nil {
		return 0
	}
	return n
}
