// Command portplane shows every dev server, on every machine, in one window.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/akamachinecode/portplane/internal/buildinfo"
)

const usage = `Portplane: every dev server, on every machine, in one window.

Usage:
  portplane [command] [flags]

Commands:
  (none)        Start Portplane and open its window (same as "serve --open")
  serve         Serve the UI on loopback (https://portplane.localhost with portless)
  ls            List apps and their state on this machine
  start <app>   Start an app, or every app of a project ("shop/")
  stop <app>    Stop an app or a project
  restart <app> Restart an app or a project
  folders       List, add or remove the folders Portplane watches
  setup <dir>   Find the dev servers in a folder and write dekit config for them
  port-exec     Run a command with {PORT} and {HOST} filled from the environment
  version       Print the version
  help          Show this help

Run "portplane <command> -h" for a command's flags.
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		return cmdServe([]string{"--open"}, stdout, stderr)
	}
	switch args[0] {
	case "serve":
		return cmdServe(args[1:], stdout, stderr)
	case "ls", "list":
		return cmdList(args[1:], stdout, stderr)
	case "start", "stop", "restart":
		return cmdAct(args[0], args[1:], stdout, stderr)
	case "folders":
		return cmdFolders(args[1:], stdout, stderr)
	case "setup":
		return cmdSetup(args[1:], stdout, stderr)
	case "port-exec":
		return cmdPortExec(args[1:], stderr)
	case "version", "--version", "-v":
		return cmdVersion(args[1:], stdout, stderr)
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
		return 0
	default:
		fmt.Fprintf(stderr, "portplane: unknown command %q\n\n%s", args[0], usage)
		return 2
	}
}

func cmdVersion(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("version", flag.ContinueOnError)
	fs.SetOutput(stderr)
	asJSON := fs.Bool("json", false, "print as JSON")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	info := buildinfo.Get()
	if *asJSON {
		if err := json.NewEncoder(stdout).Encode(info); err != nil {
			return 1
		}
		return 0
	}
	fmt.Fprintf(stdout, "portplane %s (%s/%s)\n", info.Version, info.OS, info.Arch)
	return 0
}
