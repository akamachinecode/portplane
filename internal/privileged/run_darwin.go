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
// shows the system's password dialog. It runs the helper with a quoted
// argv, and the script gets both strings as arguments, so nothing is
// spliced into AppleScript source.

func method() string { return "osascript" }

const appleScript = `on run argv
do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges
end run`

func run(ctx context.Context, c Command, out io.Writer) error {
	return runViaHelper(ctx, c, out, func(ctx context.Context, self string, args []string) error {
		words := []string{ShellQuote(self)}
		for _, a := range args {
			words = append(words, ShellQuote(a))
		}
		prompt := c.Reason
		if prompt == "" {
			prompt = "Portplane needs your password to continue."
		}
		var errb bytes.Buffer
		cmd := exec.CommandContext(ctx, "/usr/bin/osascript", "-e", appleScript, strings.Join(words, " "), prompt)
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
