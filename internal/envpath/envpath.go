// Package envpath gives Portplane the PATH a terminal would have. A process
// started over a non-interactive SSH session, at login or from the Dock gets
// a minimal PATH without the folders where dekit, portless and node live.
package envpath

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Enrich extends PATH when dekit or portless are not found: first with the
// login shell's PATH, then with the usual install folders. It never removes
// entries and keeps the current ones first.
func Enrich() {
	if runtime.GOOS == "windows" || (found("dekit") && found("portless")) {
		return
	}
	current := filepath.SplitList(os.Getenv("PATH"))
	var extra []string
	extra = append(extra, loginShellPath()...)
	home, _ := os.UserHomeDir()
	for _, d := range []string{
		"~/.local/bin", "~/.local/share/mise/shims", "~/.cargo/bin", "~/.bun/bin", "~/.volta/bin",
		"~/.npm-global/bin", "~/.deno/bin", "~/go/bin",
		"/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", "~/.linuxbrew/bin",
	} {
		if strings.HasPrefix(d, "~/") {
			if home == "" {
				continue
			}
			d = filepath.Join(home, d[2:])
		}
		extra = append(extra, d)
	}
	_ = os.Setenv("PATH", strings.Join(merge(current, extra), string(os.PathListSeparator)))
}

func found(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// loginShellPath asks the user's shell, as a login shell, for its PATH.
func loginShellPath() []string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, shell, "-l", "-c", `printf '%s' "$PATH"`)
	cmd.Stdin = nil
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil
	}
	return filepath.SplitList(strings.TrimSpace(out.String()))
}

// merge keeps every current entry, then adds the extra ones that exist.
func merge(current, extra []string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(d string) {
		if d != "" && !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	for _, d := range current {
		add(d)
	}
	for _, d := range extra {
		if fi, err := os.Stat(d); err == nil && fi.IsDir() {
			add(d)
		}
	}
	return out
}
