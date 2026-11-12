package portless

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/privileged"
)

// runWith runs portless in dir (the current folder when empty) for at most
// timeout, and returns its output with colours removed, also when it fails.
// Output also goes to out when it is not nil, as it comes.
func (c *Client) runWith(ctx context.Context, dir string, timeout time.Duration, out io.Writer, args ...string) (string, error) {
	bin := c.Path()
	if bin == "" {
		return "", fmt.Errorf("portless is not installed")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "NO_COLOR=1", "FORCE_COLOR=0")
	if c.StateDir != "" && c.StateDir != StateDir() {
		cmd.Env = append(cmd.Env, "PORTLESS_STATE_DIR="+c.StateDir)
	}
	cmd.WaitDelay = 2 * time.Second
	var buf bytes.Buffer
	var w io.Writer = &buf
	if out != nil {
		w = io.MultiWriter(&buf, ansiWriter{out})
	}
	cmd.Stdout, cmd.Stderr = w, w
	err := cmd.Run()
	text := stripANSI(buf.String())
	if err != nil {
		msg := strings.TrimSpace(text)
		if msg == "" {
			msg = err.Error()
		}
		if i := strings.LastIndex(msg, "Error:"); i >= 0 {
			msg = strings.TrimSpace(msg[i+len("Error:"):])
		}
		return text, fmt.Errorf("portless %s: %s", strings.Join(args, " "), msg)
	}
	return text, nil
}

func (c *Client) runIn(ctx context.Context, dir string, args ...string) (string, error) {
	return c.runWith(ctx, dir, 15*time.Second, nil, args...)
}

// RunTo runs a portless command that needs no administrator (proxy start,
// prune, trust on macOS and Windows) and streams its output to out.
func (c *Client) RunTo(ctx context.Context, out io.Writer, timeout time.Duration, args ...string) (string, error) {
	return c.runWith(ctx, "", timeout, out, args...)
}

// ansiWriter removes colour codes from what it passes on.
type ansiWriter struct{ w io.Writer }

func (a ansiWriter) Write(p []byte) (int, error) {
	if _, err := io.WriteString(a.w, stripANSI(string(p))); err != nil {
		return 0, err
	}
	return len(p), nil
}

// CleanWriter passes output on without colour codes.
func CleanWriter(w io.Writer) io.Writer { return ansiWriter{w} }

// AdminCommand is a portless command to run as administrator, with the
// user's environment so portless keeps its state in the user's home.
func (c *Client) AdminCommand(reason string, args ...string) (privileged.Command, error) {
	return c.command(reason, args...)
}
