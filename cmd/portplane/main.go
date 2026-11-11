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
  portplane <command> [flags]

Commands:
  version     Print the version
  help        Show this help

Run "portplane <command> -h" for a command's flags.
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	switch args[0] {
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
		enc := json.NewEncoder(stdout)
		if err := enc.Encode(info); err != nil {
			return 1
		}
		return 0
	}
	fmt.Fprintf(stdout, "portplane %s (%s/%s)\n", info.Version, info.OS, info.Arch)
	return 0
}
