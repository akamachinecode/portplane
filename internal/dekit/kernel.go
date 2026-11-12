package dekit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// KernelStatus is `dekit kernel status --json`: which dekit binary runs a
// project (config/kernel), which one its runner runs now, and the user's
// registered default.
type KernelStatus struct {
	Selected        string  `json:"selected"`
	Active          *string `json:"active"`
	Default         *string `json:"default"`
	RestartRequired bool    `json:"restart_required"`
	SelectionError  *string `json:"selection_error"`
}

// ParseKernelStatus reads `dekit kernel status --json`.
func ParseKernelStatus(b []byte) (KernelStatus, error) {
	var k KernelStatus
	if err := json.Unmarshal(b, &k); err != nil {
		return k, fmt.Errorf("dekit kernel status: %w", err)
	}
	return k, nil
}

// Kernel returns the kernel status, for a project root or, with "", for
// wherever dekit runs (the user default and the dekit on PATH).
func (c *CLI) Kernel(ctx context.Context, root string) (KernelStatus, error) {
	args := []string{"kernel", "status", "--json"}
	if root != "" {
		args = append([]string{"-C", root}, args...)
	} else if home, err := os.UserHomeDir(); err == nil {
		// Outside a project dekit refuses; the home folder is neutral.
		args = append([]string{"-C", home}, args...)
	}
	out, err := c.run(ctx, 5*time.Second, args...)
	if err != nil {
		return KernelStatus{}, err
	}
	return ParseKernelStatus(out)
}

// SetDefaultKernel registers a dekit binary as the user default; "" clears it.
func (c *CLI) SetDefaultKernel(ctx context.Context, path string) error {
	if path == "" {
		_, err := c.run(ctx, 5*time.Second, "kernel", "clear-default")
		return err
	}
	if !filepath.IsAbs(path) {
		return errors.New("use the binary's full path")
	}
	if fi, err := os.Stat(path); err != nil || fi.IsDir() {
		return fmt.Errorf("%s is not a file", path)
	}
	_, err := c.run(ctx, 5*time.Second, "kernel", "set-default", path)
	return err
}

// Origin is how dekit was installed, which decides how it updates.
type Origin struct {
	Kind string `json:"kind"` // script, homebrew, npm, pip, cargo, other
	// Receipt is the install script's record of the binary it installed,
	// when Kind is script.
	Receipt string `json:"receipt,omitempty"`
	// Update is the command that updates this dekit, as argv.
	Update []string `json:"update"`
	// UpgradeRunners: after Update, the running runners still run the old
	// binary until `dekit runner upgrade --all` (dekit update does it itself).
	UpgradeRunners bool `json:"upgradeRunners"`
}

// receiptFile is where dekit's install script records what it installed:
// $XDG_DATA_HOME/dekit/install (~/.local/share), %LOCALAPPDATA%\dekit\install.
func receiptFile(goos string, getenv func(string) string, home string) string {
	if goos == "windows" {
		if d := getenv("LOCALAPPDATA"); d != "" {
			return filepath.Join(d, "dekit", "install")
		}
		return ""
	}
	// Unix paths use forward slashes whatever the host, so a goos other
	// than the host's (tests) still gives the path dekit would use.
	if d := getenv("XDG_DATA_HOME"); d != "" {
		return path.Join(d, "dekit", "install")
	}
	if home == "" {
		return ""
	}
	return path.Join(home, ".local", "share", "dekit", "install")
}

// DetectOrigin works out how the dekit at bin was installed. version is
// what `dekit update` installs: latest (""), canary or a version.
func DetectOrigin(bin, version string) Origin {
	home, _ := os.UserHomeDir()
	return detectOrigin(bin, version, runtime.GOOS, os.Getenv, home, os.ReadFile, filepath.EvalSymlinks)
}

func detectOrigin(bin, version, goos string, getenv func(string) string, home string, read func(string) ([]byte, error), resolve func(string) (string, error)) Origin {
	real := bin
	if r, err := resolve(bin); err == nil {
		real = r
	}
	if rf := receiptFile(goos, getenv, home); rf != "" {
		if b, err := read(rf); err == nil {
			rec := strings.TrimSpace(string(b))
			if rec != "" && (sameFile(rec, bin) || sameFile(rec, real)) {
				args := []string{"update"}
				if version != "" {
					args = append(args, version)
				}
				return Origin{Kind: "script", Receipt: rec, Update: append([]string{bin}, args...)}
			}
		}
	}
	p := filepath.ToSlash(real)
	switch {
	case strings.Contains(p, "/Cellar/") || strings.Contains(p, "/homebrew/") || strings.Contains(p, "/linuxbrew/"):
		return Origin{Kind: "homebrew", Update: []string{"brew", "upgrade", "dekit"}, UpgradeRunners: true}
	case strings.Contains(p, "/node_modules/"):
		pkg := "@dekit/cli"
		if version != "" {
			pkg += "@" + version
		} else {
			pkg += "@latest"
		}
		return Origin{Kind: "npm", Update: []string{"npm", "install", "-g", pkg}, UpgradeRunners: true}
	case strings.Contains(p, "/site-packages/") || strings.Contains(p, "/pipx/") || strings.Contains(p, "/Python"):
		spec := "dekit-cli"
		if version != "" && version != "canary" {
			spec += "==" + version
		}
		return Origin{Kind: "pip", Update: []string{"pip", "install", "--upgrade", spec}, UpgradeRunners: true}
	case strings.Contains(p, "/.cargo/bin/"):
		return Origin{Kind: "cargo", UpgradeRunners: true}
	}
	return Origin{Kind: "other", UpgradeRunners: true}
}

func sameFile(a, b string) bool {
	if a == b {
		return true
	}
	fa, err1 := os.Stat(a)
	fb, err2 := os.Stat(b)
	return err1 == nil && err2 == nil && os.SameFile(fa, fb)
}

// ValidUpdateVersion checks what `dekit update` takes: "", latest, canary
// or a version like 1.2.3.
func ValidUpdateVersion(v string) error {
	if v == "" || v == "latest" || v == "canary" {
		return nil
	}
	parts := strings.Split(strings.TrimPrefix(v, "v"), ".")
	if len(parts) != 3 {
		return fmt.Errorf("%q: use latest, canary or a version like 1.2.3", v)
	}
	for _, p := range parts {
		if p == "" || strings.Trim(p, "0123456789") != "" {
			return fmt.Errorf("%q: use latest, canary or a version like 1.2.3", v)
		}
	}
	return nil
}

// helpCache keeps `dekit help --json` per dekit version: it is large and
// changes only with dekit.
var helpCache struct {
	sync.Mutex
	version string
	body    []byte
}

// Help returns `dekit help --json` as it came: the topics, the CLI and the
// config fields, so forms show the installed version's own help.
func (c *CLI) Help(ctx context.Context) (json.RawMessage, error) {
	v, err := c.Version(ctx)
	if err != nil {
		return nil, err
	}
	helpCache.Lock()
	defer helpCache.Unlock()
	if helpCache.version == v && helpCache.body != nil {
		return helpCache.body, nil
	}
	out, err := c.run(ctx, 10*time.Second, "help", "--json")
	if err != nil {
		return nil, err
	}
	if !json.Valid(out) {
		return nil, errors.New("dekit help --json did not print JSON")
	}
	helpCache.version, helpCache.body = v, out
	return out, nil
}

// HelpField is one entry of `fields[]` in `dekit help --json`.
type HelpField struct {
	Kind    string `json:"kind"` // config, cli-flag, js
	Key     string `json:"key"`  // "tasks.*.cmd", "--json", ...
	Desc    string `json:"desc"`
	Topic   string `json:"topic"`
	Type    string `json:"type,omitempty"`
	Default string `json:"default,omitempty"`
}

// ParseHelpFields reads the fields of `dekit help --json`.
func ParseHelpFields(b []byte) ([]HelpField, error) {
	var h struct {
		Fields []HelpField `json:"fields"`
	}
	if err := json.Unmarshal(b, &h); err != nil {
		return nil, fmt.Errorf("dekit help: %w", err)
	}
	return h.Fields, nil
}
