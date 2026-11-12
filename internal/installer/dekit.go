package installer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Steps of a dekit install.
const (
	StepDekitDownload = "Download dekit's installer"
	StepDekitRun      = "Install dekit (its installer checks the SHA-256)"
	StepDekitCheck    = "Check that dekit runs"
)

// DekitSteps are the stages InstallDekit reports.
func DekitSteps() []string { return []string{StepDekitDownload, StepDekitRun, StepDekitCheck} }

// DekitScript is the name of dekit's installer for this OS.
func (in *Installer) DekitScript() string {
	if in.GOOS == "windows" {
		return "install.ps1"
	}
	return "install.sh"
}

// DekitScriptURL is where the installer comes from.
func (in *Installer) DekitScriptURL() string {
	return strings.TrimRight(in.Sources.DekitScripts, "/") + "/" + in.DekitScript()
}

// DekitManual is the command dekit documents, for doing it by hand.
func (in *Installer) DekitManual() string {
	if in.GOOS == "windows" {
		return "irm " + in.DekitScriptURL() + " | iex"
	}
	return "curl -fsSL " + in.DekitScriptURL() + " | sh"
}

// DekitReceipt is where dekit's installer records the binary it installed,
// so `dekit update` can replace it.
func DekitReceipt(goos, home string, getenv func(string) string) string {
	if goos == "windows" {
		base := getenv("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(base, "dekit", "install")
	}
	base := getenv("XDG_DATA_HOME")
	if base == "" || !filepath.IsAbs(base) {
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "dekit", "install")
}

// DekitResult is what an install leaves.
type DekitResult struct {
	Path    string `json:"path"`
	Version string `json:"version"`
}

// InstallDekit downloads dekit's official installer into a temporary file
// and runs that file (argv, never a pipe into a shell). The installer
// downloads the release from GitHub, checks it against SHA256SUMS, puts it
// in ~/.local/bin and writes the receipt `dekit update` reads.
func (in *Installer) InstallDekit(ctx context.Context, p Progress) (DekitResult, error) {
	p.Step(StepDekitDownload)
	tmp, err := os.MkdirTemp("", "portplane-dekit-")
	if err != nil {
		return DekitResult{}, err
	}
	defer func() { _ = os.RemoveAll(tmp) }()
	script := filepath.Join(tmp, in.DekitScript())
	var body bytes.Buffer
	p.Logf("Downloading %s", in.DekitScriptURL())
	if _, err := in.HTTP.Fetch(ctx, in.DekitScriptURL(), &body, nil); err != nil {
		return DekitResult{}, err
	}
	if body.Len() == 0 || (in.GOOS != "windows" && !bytes.HasPrefix(body.Bytes(), []byte("#!"))) {
		return DekitResult{}, fmt.Errorf("%s did not return an installer script", in.DekitScriptURL())
	}
	sum := sha256.Sum256(body.Bytes())
	p.Logf("Saved %d bytes, SHA-256 %s", body.Len(), hex.EncodeToString(sum[:]))
	if err := os.WriteFile(script, body.Bytes(), 0o600); err != nil {
		return DekitResult{}, err
	}

	p.Step(StepDekitRun)
	if err := os.MkdirAll(in.BinDir, 0o755); err != nil {
		return DekitResult{}, err
	}
	env := withEnv(in.environ(), "DEKIT_INSTALL_DIR="+in.BinDir, "NO_COLOR=1")
	argv := []string{"sh", script}
	if in.GOOS == "windows" {
		argv = []string{"powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script}
	} else if sh := in.lookup("sh"); sh != "" {
		argv[0] = sh
	} else {
		argv[0] = "/bin/sh"
	}
	run := in.Run
	if run == nil {
		run = RunProcess
	}
	if err := run(ctx, tmp, env, p, argv...); err != nil {
		return DekitResult{}, fmt.Errorf("dekit's installer failed: %w", err)
	}

	p.Step(StepDekitCheck)
	bin := filepath.Join(in.BinDir, in.exe("dekit"))
	if _, err := os.Stat(bin); err != nil {
		return DekitResult{}, fmt.Errorf("dekit's installer finished, but %s is not there", Tilde(in.Home, bin))
	}
	out, err := in.output(ctx, nil, bin, "--version")
	if err != nil {
		return DekitResult{}, fmt.Errorf("dekit was installed but does not run: %w", err)
	}
	p.Logf("$ dekit --version\n%s", out)
	receipt := DekitReceipt(in.GOOS, in.Home, envFrom(in.environ()))
	if b, err := os.ReadFile(receipt); err == nil {
		p.Logf("Install receipt for `dekit update`: %s -> %s", Tilde(in.Home, receipt), strings.TrimSpace(string(b)))
	}
	in.useDir(in.BinDir, false)
	return DekitResult{Path: bin, Version: CleanVersion(out)}, nil
}

// envFrom turns an environment list into a getenv function.
func envFrom(env []string) func(string) string {
	m := map[string]string{}
	for _, e := range env {
		k, v, _ := strings.Cut(e, "=")
		m[strings.ToUpper(k)] = v
	}
	return func(k string) string { return m[strings.ToUpper(k)] }
}
