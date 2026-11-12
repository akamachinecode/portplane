//go:build !windows && !darwin

package privileged

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// On Linux and the BSDs pkexec asks through the desktop's polkit agent and
// keeps the program's output on its own pipes.

func method() string {
	if _, err := exec.LookPath("pkexec"); err != nil {
		return ""
	}
	if os.Getenv("WAYLAND_DISPLAY") == "" && os.Getenv("DISPLAY") == "" {
		return "" // no desktop session for the polkit agent to show a dialog in
	}
	return "pkexec"
}

func run(ctx context.Context, c Command, out io.Writer) error {
	if method() == "" {
		return ErrUnavailable
	}
	pkexec, _ := exec.LookPath("pkexec")
	env := "/usr/bin/env"
	if _, err := os.Stat(env); err != nil {
		if p, err := exec.LookPath("env"); err == nil {
			env = p
		}
	}
	cmd := exec.CommandContext(ctx, pkexec, pkexecArgs(env, c)...)
	var errb bytes.Buffer
	cmd.Stdout = out
	cmd.Stderr = io.MultiWriter(out, &errb)
	err := cmd.Run()
	return pkexecError(err, errb.String())
}

// pkexecArgs runs the program through env, so its environment is the one
// asked for: pkexec itself keeps almost none.
func pkexecArgs(env string, c Command) []string {
	args := []string{env}
	args = append(args, envList(c.Env)...)
	return append(args, c.Argv...)
}

// pkexecError maps pkexec's own exit statuses: 126 when the dialog was
// dismissed or the password refused, 127 when no agent could ask.
func pkexecError(err error, stderr string) error {
	var exit *exec.ExitError
	if err == nil {
		return nil
	}
	if !errors.As(err, &exit) {
		return err
	}
	switch exit.ExitCode() {
	case 126:
		return ErrDenied
	case 127:
		if strings.Contains(stderr, "authentication agent") || strings.Contains(stderr, "Not authorized") {
			return ErrUnavailable
		}
	}
	return fmt.Errorf("the command failed with exit status %d", exit.ExitCode())
}
