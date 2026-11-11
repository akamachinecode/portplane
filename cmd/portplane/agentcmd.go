package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/akamachinecode/portplane/internal/agent"
	"github.com/akamachinecode/portplane/internal/envpath"
	"github.com/akamachinecode/portplane/internal/remote"
)

// cmdAgent runs this machine's agent for a Portplane on another machine,
// speaking over stdin and stdout (ADR-0015). It opens no listener.
func cmdAgent(args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("agent", flag.ContinueOnError)
	fs.SetOutput(stderr)
	stdio := fs.Bool("stdio", false, "speak the agent protocol on stdin and stdout")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if !*stdio {
		fmt.Fprintln(stderr, "Usage: portplane agent --stdio   (started by Portplane over SSH)")
		return 2
	}
	envpath.Enrich()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	host, _ := os.Hostname()
	local := agent.NewLocal(agent.Options{ID: "remote", Name: host})
	defer func() { _ = local.Close() }()
	if err := remote.Serve(ctx, remote.Stdio(os.Stdin, os.Stdout), local); err != nil && ctx.Err() == nil {
		fmt.Fprintln(stderr, "portplane agent:", err)
		return 1
	}
	return 0
}
