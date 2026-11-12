//go:build darwin

package notify

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// osascriptSender shows notifications with AppleScript's display
// notification. Clicking one opens nothing: macOS sends the click to the
// script's host, not to Portplane.
type osascriptSender struct{ o Options }

func newSender(o Options) (Sender, error) {
	if _, err := exec.LookPath("osascript"); err != nil {
		return nil, err
	}
	if o.AppName == "" {
		o.AppName = "Portplane"
	}
	return osascriptSender{o: o}, nil
}

// osascriptArgs is the fixed script and its arguments. The first argument
// is a fixed word, so osascript reads every later one as data even when it
// starts with a dash.
func osascriptArgs(o Options, n Notification) []string {
	return []string{
		"-e", "on run argv",
		"-e", "display notification (item 3 of argv) with title (item 2 of argv)",
		"-e", "end run",
		"portplane", o.AppName + ": " + n.Title, n.Body,
	}
}

func (s osascriptSender) Send(ctx context.Context, n Notification) error {
	out, err := exec.CommandContext(ctx, "osascript", osascriptArgs(s.o, n)...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("osascript: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (osascriptSender) Close() error { return nil }
