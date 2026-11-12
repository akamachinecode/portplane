//go:build darwin

package privileged

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"strings"
)

// On macOS an AppleScript `do shell script … with administrator privileges`
// shows the system's password dialog. Each argument reaches osascript as an
// argument of its own, and the fixed script quotes it with `quoted form of`
// (ADR-0020), so Portplane never builds the shell string.

func method() string { return "osascript" }

const appleScript = `on run argv
set cmd to ""
repeat with i from 2 to count of argv
set cmd to cmd & quoted form of (item i of argv) & " "
end repeat
do shell script cmd with prompt (item 1 of argv) with administrator privileges
end run`

func run(ctx context.Context, c Command, out io.Writer) error {
	return runViaHelper(ctx, c, out, func(ctx context.Context, self string, args []string) error {
		prompt := c.Reason
		if prompt == "" {
			prompt = "Portplane needs your password to continue."
		}
		osaArgs := append([]string{"-e", appleScript, prompt, self}, args...)
		var errb bytes.Buffer
		cmd := exec.CommandContext(ctx, "/usr/bin/osascript", osaArgs...)
		cmd.Stderr = &errb
		err := cmd.Run()
		if err == nil {
			return nil
		}
		msg := errb.String()
		var exit *exec.ExitError
		switch {
		case strings.Contains(msg, "-128") || strings.Contains(msg, "User canceled"):
			return ErrDenied
		case errors.As(err, &exit):
			// The helper ran and failed: its status file says how. An
			// AppleScript error before that leaves no status.
			return nil
		}
		return err
	})
}
