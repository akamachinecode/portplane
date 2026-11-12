// Package privileged runs the few commands that need an administrator, such
// as installing the portless proxy service, through the system's own
// password dialog (ADR-0020): pkexec on Linux, an AppleScript prompt on
// macOS, UAC on Windows. It runs an argv, never a shell string (ADR-0010),
// and only when the user clicked for it.
package privileged

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"runtime"
	"sort"
	"strings"
	"sync/atomic"
)

// Command is what to run as administrator.
type Command struct {
	// Argv is the program, with an absolute path, and its arguments.
	Argv []string `json:"argv"`
	// Env is added to the program's environment, such as HOME, so the
	// state of a tool stays in the user's home and not in root's.
	Env map[string]string `json:"env,omitempty"`
	// Reason is shown in the password dialog where the system allows it.
	Reason string `json:"reason,omitempty"`
}

// ErrDenied means the user closed the password dialog or the password was
// refused.
var ErrDenied = errors.New("administrator permission was not given")

// ErrUnavailable means this system has no way to ask for the password
// here; the user can run Terminal(cmd) instead.
var ErrUnavailable = errors.New("cannot ask for an administrator password here")

// Method names how this system asks: "pkexec", "osascript", "uac", or ""
// when it cannot.
func Method() string {
	if headless.Load() {
		return ""
	}
	return method()
}

// Available reports whether Run can ask for a password here.
func Available() bool { return Method() != "" }

var headless atomic.Bool

// Headless says nobody sits at this machine's screen, as on a machine
// reached over SSH (ADR-0026): Run never asks for a password and returns
// ErrUnavailable, so the user runs Terminal(cmd) over SSH instead.
func Headless() { headless.Store(true) }

// Run runs c as administrator after the system asked for a password. The
// program's output goes to out as it comes. It returns ErrDenied when the
// user declined, ErrUnavailable when there is no dialog to show, and an
// error naming the exit status when the program failed.
func Run(ctx context.Context, c Command, out io.Writer) error {
	if len(c.Argv) == 0 {
		return errors.New("nothing to run")
	}
	if !isAbs(c.Argv[0]) {
		return fmt.Errorf("run %q with its absolute path", c.Argv[0])
	}
	for k := range c.Env {
		if k == "" || strings.ContainsAny(k, "=\x00") {
			return fmt.Errorf("bad environment variable name %q", k)
		}
	}
	if headless.Load() {
		return ErrUnavailable
	}
	if out == nil {
		out = io.Discard
	}
	return run(ctx, c, out)
}

func isAbs(p string) bool {
	if runtime.GOOS == "windows" {
		return len(p) > 2 && p[1] == ':' && (p[2] == '\\' || p[2] == '/') || strings.HasPrefix(p, `\\`)
	}
	return strings.HasPrefix(p, "/")
}

// UserEnv returns the variables that keep a tool's per-user state in this
// user's home when it runs as root: HOME, the user's name and ids (portless
// and npm read SUDO_USER, SUDO_UID and SUDO_GID to give files back), PATH
// (so `#!/usr/bin/env node` finds the same Node), and PORTLESS_STATE_DIR
// when it is set.
func UserEnv() map[string]string {
	env := map[string]string{}
	if home, err := os.UserHomeDir(); err == nil {
		env["HOME"] = home
	}
	if p := os.Getenv("PATH"); p != "" {
		env["PATH"] = p
	}
	if d := os.Getenv("PORTLESS_STATE_DIR"); d != "" {
		env["PORTLESS_STATE_DIR"] = d
	}
	if runtime.GOOS != "windows" {
		if u, err := user.Current(); err == nil {
			env["SUDO_USER"] = u.Username
			env["SUDO_UID"] = u.Uid
			env["SUDO_GID"] = u.Gid
		}
	}
	return env
}

// Terminal returns what a user can paste into a terminal to do the same by
// hand: `sudo env K=V … argv` on macOS and Linux, and the command line for
// an Administrator terminal on Windows.
func Terminal(c Command, goos string) string {
	if goos == "windows" {
		parts := make([]string, 0, len(c.Env)+len(c.Argv))
		for _, k := range sortedKeys(c.Env) {
			if k == "PATH" {
				continue
			}
			parts = append(parts, "$env:"+k+"="+psQuote(c.Env[k])+";")
		}
		args := make([]string, len(c.Argv))
		for i, a := range c.Argv {
			args[i] = psQuote(a)
		}
		parts = append(parts, "&", strings.Join(args, " "))
		return strings.Join(parts, " ")
	}
	parts := []string{"sudo"}
	if len(c.Env) > 0 {
		parts = append(parts, "env")
		for _, k := range sortedKeys(c.Env) {
			if k == "PATH" || k == "SUDO_USER" || k == "SUDO_UID" || k == "SUDO_GID" {
				continue // sudo sets the user's own; PATH is the terminal's
			}
			parts = append(parts, ShellQuote(k+"="+c.Env[k]))
		}
		if len(parts) == 2 {
			parts = parts[:1]
		}
	}
	for _, a := range c.Argv {
		parts = append(parts, ShellQuote(a))
	}
	return strings.Join(parts, " ")
}

// ShellQuote quotes s for a POSIX shell, leaving plain words as they are.
func ShellQuote(s string) string {
	if s == "" {
		return "''"
	}
	plain := true
	for _, r := range s {
		if !safeRune(r) {
			plain = false
			break
		}
	}
	if plain {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func safeRune(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-_./:=@%+,", r)
}

func psQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// envList turns Env into K=V pairs, sorted.
func envList(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for _, k := range sortedKeys(env) {
		out = append(out, k+"="+env[k])
	}
	return out
}
