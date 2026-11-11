package main

import (
	"fmt"
	"io"

	"github.com/akamachinecode/portplane/internal/autostart"
)

func cmdAutostart(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "status" {
		on, err := autostart.Enabled()
		if err != nil {
			fmt.Fprintln(stderr, "portplane:", err)
			return 1
		}
		fmt.Fprintln(stdout, map[bool]string{true: "Portplane starts at login.", false: "Portplane does not start at login."}[on])
		return 0
	}
	var err error
	switch args[0] {
	case "on":
		err = autostart.Enable()
	case "off":
		err = autostart.Disable()
	default:
		fmt.Fprintln(stderr, "Usage: portplane autostart [status | on | off]")
		return 2
	}
	if err != nil {
		fmt.Fprintln(stderr, "portplane:", err)
		return 1
	}
	return cmdAutostart(nil, stdout, stderr)
}
