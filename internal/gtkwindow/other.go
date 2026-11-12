//go:build !linux

package gtkwindow

import (
	"fmt"
	"io"

	"github.com/akamachinecode/portplane/internal/window"
)

// Main reports that this system has no GTK window.
func Main(_ []string, stderr io.Writer) int {
	fmt.Fprintln(stderr, "portplane-window: only on Linux")
	return window.ExitUnavailable
}
