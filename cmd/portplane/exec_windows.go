//go:build windows

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
)

// execProgram runs argv as a child and passes its exit code on. Windows has
// no exec(); Ctrl+C reaches the whole console group, so the child sees it too.
func execProgram(argv []string, stderr io.Writer) int {
	cmd := exec.Command(argv[0], argv[1:]...) //nolint:noctx // runs for the life of the task
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	signal.Ignore(os.Interrupt)
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode()
		}
		fmt.Fprintln(stderr, "portplane port-exec:", err)
		return 127
	}
	return 0
}
