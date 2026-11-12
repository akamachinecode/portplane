package installer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Steps of a portless install.
const (
	StepPortlessNode    = "Find Node.js 24"
	StepPortlessInstall = "Install portless with npm (npm checks each package)"
	StepPortlessLaunch  = "Write the portless launcher"
	StepPortlessCheck   = "Check that portless runs"
)

// PortlessSteps are the stages InstallPortless reports for a method.
func PortlessSteps(method string) []string {
	if method == "private" {
		return []string{StepPortlessNode, StepPortlessInstall, StepPortlessLaunch, StepPortlessCheck}
	}
	return []string{StepPortlessNode, StepPortlessInstall, StepPortlessCheck}
}

// ShimMarker is the line that marks a launcher Portplane wrote.
const ShimMarker = "Written by Portplane"

// PortlessPrefix is the private npm prefix portless goes into when the
// user's own npm cannot take it.
func (in *Installer) PortlessPrefix() string { return filepath.Join(in.DataDir, "portless") }

// npmFor returns the npm that belongs to node.
func (in *Installer) npmFor(node string) string {
	dir := filepath.Dir(node)
	name := "npm"
	if in.GOOS == "windows" {
		name = "npm.cmd"
	}
	p := filepath.Join(dir, name)
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return in.lookup("npm")
}

// npmEnv quiets npm and puts node's folder first on PATH, so npm's
// `#!/usr/bin/env node` and portless's install scripts find that node.
func (in *Installer) npmEnv(node string) []string {
	env := pathWith(in.environ(), filepath.Dir(node))
	return withEnv(env, "npm_config_update_notifier=false", "npm_config_fund=false", "npm_config_audit=false", "NO_COLOR=1")
}

// PortlessMethod decides how portless goes in with node: "npm" when the
// user's own Node is 24 or later and npm's global prefix is theirs to
// write; "private" otherwise (Portplane's Node, or a root-owned prefix like
// a system Node in /usr). It also returns npm's global prefix.
func (in *Installer) PortlessMethod(ctx context.Context, node NodeInfo) (method, prefix string) {
	if node.Path == "" || node.Private {
		return "private", ""
	}
	npm := in.npmFor(node.Path)
	if npm == "" {
		return "private", ""
	}
	out, err := in.output(ctx, in.npmEnv(node.Path), npm, "prefix", "-g")
	if err != nil {
		return "private", ""
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	prefix = strings.TrimSpace(lines[len(lines)-1])
	if prefix == "" || !writable(in.globalModules(prefix)) {
		return "private", prefix
	}
	return "npm", prefix
}

// globalModules is where `npm install -g` writes under a prefix.
func (in *Installer) globalModules(prefix string) string {
	if in.GOOS == "windows" {
		return filepath.Join(prefix, "node_modules")
	}
	return filepath.Join(prefix, "lib", "node_modules")
}

// globalBin is where npm links global commands under a prefix.
func (in *Installer) globalBin(prefix string) string {
	if in.GOOS == "windows" {
		return prefix
	}
	return filepath.Join(prefix, "bin")
}

// writable reports whether this user can create files in dir, or in the
// nearest folder above it that exists.
func writable(dir string) bool {
	for d := dir; ; d = filepath.Dir(d) {
		if fi, err := os.Stat(d); err == nil {
			return fi.IsDir() && canWrite(d)
		}
		if filepath.Dir(d) == d {
			return false
		}
	}
}

// PortlessResult is what an install leaves.
type PortlessResult struct {
	Path    string `json:"path"`
	Version string `json:"version"`
	Method  string `json:"method"`
}

// InstallPortless installs portless with npm: into the user's global
// prefix ("npm"), or into Portplane's private prefix with a `portless`
// launcher in ~/.local/bin ("private"). An empty method picks with
// PortlessMethod. It needs a Node 24 or later (InstallNode first).
func (in *Installer) InstallPortless(ctx context.Context, p Progress, method string) (PortlessResult, error) {
	p.Step(StepPortlessNode)
	node := in.FindNode(ctx)
	if !node.OK() {
		if node.UserVersion != "" {
			return PortlessResult{}, fmt.Errorf("portless needs Node.js %d or later, and this computer has %s: install Node.js %d first", NodeMajor, node.UserVersion, NodeMajor)
		}
		return PortlessResult{}, fmt.Errorf("portless needs Node.js %d or later: install it first", NodeMajor)
	}
	auto, prefix := in.PortlessMethod(ctx, node)
	if method == "" {
		method = auto
	}
	if method == "npm" && auto != "npm" {
		method = "private" // the user's prefix cannot take it
	}
	p.Logf("Node.js %s at %s", node.Version, Tilde(in.Home, node.Path))
	npm := in.npmFor(node.Path)
	if npm == "" {
		return PortlessResult{}, errors.New("npm was not found next to Node.js")
	}
	env := in.npmEnv(node.Path)
	run := in.Run
	if run == nil {
		run = RunProcess
	}

	p.Step(StepPortlessInstall)
	var bin string
	switch method {
	case "npm":
		p.Logf("$ npm install -g portless   (into %s)", Tilde(in.Home, prefix))
		if err := run(ctx, in.Home, env, p, npm, "install", "-g", "portless"); err != nil {
			return PortlessResult{}, fmt.Errorf("npm could not install portless: %w", err)
		}
		bin = filepath.Join(in.globalBin(prefix), "portless")
		if in.GOOS == "windows" {
			bin += ".cmd"
		}
		in.useDir(in.globalBin(prefix), false)
	case "private":
		pre := in.PortlessPrefix()
		if err := os.MkdirAll(pre, 0o755); err != nil {
			return PortlessResult{}, err
		}
		p.Logf("$ npm install -g --prefix %s portless", Tilde(in.Home, pre))
		if err := run(ctx, in.Home, env, p, npm, "install", "-g", "--prefix", pre, "portless"); err != nil {
			return PortlessResult{}, fmt.Errorf("npm could not install portless: %w", err)
		}
		p.Step(StepPortlessLaunch)
		cli, err := in.portlessCLI(filepath.Join(in.globalModules(pre), "portless"))
		if err != nil {
			return PortlessResult{}, err
		}
		bin, err = in.WriteShim(node.Path, cli)
		if err != nil {
			return PortlessResult{}, err
		}
		p.Logf("Wrote %s, which runs portless with %s", Tilde(in.Home, bin), Tilde(in.Home, node.Path))
		in.useDir(in.BinDir, false)
	default:
		return PortlessResult{}, fmt.Errorf("unknown way to install portless: %q", method)
	}

	p.Step(StepPortlessCheck)
	out, err := in.output(ctx, env, bin, "--version")
	if err != nil {
		return PortlessResult{}, fmt.Errorf("portless was installed but does not run: %w", err)
	}
	p.Logf("$ portless --version\n%s", out)
	return PortlessResult{Path: bin, Version: CleanVersion(out), Method: method}, nil
}

// portlessCLI reads the package's bin entry (dist/cli.js in 0.16).
func (in *Installer) portlessCLI(pkgDir string) (string, error) {
	b, err := os.ReadFile(filepath.Join(pkgDir, "package.json"))
	if err != nil {
		return "", fmt.Errorf("npm finished, but portless is not in %s", Tilde(in.Home, pkgDir))
	}
	var pkg struct {
		Bin json.RawMessage `json:"bin"`
	}
	if err := json.Unmarshal(b, &pkg); err != nil {
		return "", fmt.Errorf("portless's package.json: %w", err)
	}
	rel := ""
	var one string
	var many map[string]string
	switch {
	case json.Unmarshal(pkg.Bin, &one) == nil:
		rel = one
	case json.Unmarshal(pkg.Bin, &many) == nil:
		rel = many["portless"]
	}
	if rel == "" || !filepath.IsLocal(filepath.FromSlash(rel)) {
		return "", errors.New("portless's package.json names no command")
	}
	return filepath.Join(pkgDir, filepath.FromSlash(rel)), nil
}

// WriteShim writes the `portless` launcher in BinDir: a small sh script
// (a .cmd file on Windows) that runs cli with node. It replaces only a
// launcher Portplane wrote, never a portless installed another way.
func (in *Installer) WriteShim(node, cli string) (string, error) {
	if err := os.MkdirAll(in.BinDir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(in.BinDir, "portless")
	content := "#!/bin/sh\n# " + ShimMarker + ": runs portless with the Node.js it was installed with.\n" +
		"exec " + shQuote(node) + " " + shQuote(cli) + ` "$@"` + "\n"
	mode := os.FileMode(0o755)
	if in.GOOS == "windows" {
		path += ".cmd"
		content = "@echo off\r\nrem " + ShimMarker + ": runs portless with the Node.js it was installed with.\r\n" +
			`"` + node + `" "` + cli + `" %*` + "\r\n"
		mode = 0o644
	}
	if old, err := os.ReadFile(path); err == nil && !strings.Contains(string(old), ShimMarker) {
		return "", fmt.Errorf("%s already exists and was not written by Portplane; leaving it alone", Tilde(in.Home, path))
	}
	tmp := path + ".portplane-new"
	if err := os.WriteFile(tmp, []byte(content), mode); err != nil {
		return "", err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return path, nil
}

// shQuote quotes s for the launcher's /bin/sh.
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
