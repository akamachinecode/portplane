//go:build !windows

package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"
)

// execProgram replaces this process with argv, so signals and the exit code
// belong to the program itself.
func execProgram(argv []string, stderr io.Writer) int {
	path, err := exec.LookPath(argv[0])
	if err != nil {
		fmt.Fprintln(stderr, "portplane port-exec:", err)
		return 127
	}
	if err := syscall.Exec(path, argv, os.Environ()); err != nil {
		fmt.Fprintln(stderr, "portplane port-exec:", err)
		return 126
	}
	return 0
}
