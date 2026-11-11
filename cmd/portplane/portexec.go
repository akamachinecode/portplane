package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// cmdPortExec implements `portplane port-exec -- <program> <args…>`
// (ADR-0010): {PORT} and {HOST} in the arguments are replaced with the PORT
// and HOST environment variables, then the program runs in this process's
// place (Unix) or as a child whose exit code is passed on (Windows).
func cmdPortExec(args []string, stderr io.Writer) int {
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	if len(args) == 0 {
		fmt.Fprintln(stderr, "Usage: portplane port-exec -- <program> [args…]   ({PORT} and {HOST} are replaced from the environment)")
		return 2
	}
	argv, err := expandPlaceholders(args, os.Getenv)
	if err != nil {
		fmt.Fprintln(stderr, "portplane port-exec:", err)
		return 2
	}
	return execProgram(argv, stderr)
}

func expandPlaceholders(args []string, getenv func(string) string) ([]string, error) {
	out := make([]string, len(args))
	for i, a := range args {
		for _, name := range []string{"PORT", "HOST"} {
			ph := "{" + name + "}"
			if !strings.Contains(a, ph) {
				continue
			}
			v := getenv(name)
			if v == "" {
				if name == "HOST" {
					v = "127.0.0.1"
				} else {
					return nil, fmt.Errorf("%s is not set; run this through portless", name)
				}
			}
			a = strings.ReplaceAll(a, ph, v)
		}
		out[i] = a
	}
	return out, nil
}
