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
	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/envpath"
	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/portless"
	"github.com/akamachinecode/portplane/internal/privileged"
	"github.com/akamachinecode/portplane/internal/remote"
)

// cmdAgent runs this machine's agent for a Portplane on another machine,
// speaking over stdin and stdout (ADR-0015). It opens no listener. Besides
// snapshots and actions, it serves the setup, dekit and portless areas for
// this machine, and pushes its jobs (ADR-0026).
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
	// Nobody sits at this machine's screen: steps that need an
	// administrator are shown as commands to run over SSH instead.
	privileged.Headless()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	host, _ := os.Hostname()
	dk, pl := dekit.NewCLI(), portless.New()
	local := agent.NewLocal(agent.Options{ID: "remote", Name: host, Dekit: dk, Portless: pl})
	defer func() { _ = local.Close() }()
	jobManager := jobs.NewManager()
	d := deps{ctx: ctx, local: local, jobs: jobManager, dekit: dk, portless: pl, headless: true}
	opts := remote.ServeOptions{
		API:  agentAPI(d),
		Jobs: jobManager,
		// Portplane names this machine; the answers use that id.
		OnHello: func(h remote.Hello) {
			local.SetID(h.Machine)
			jobManager.SetMachine(h.Machine)
		},
	}
	if err := remote.ServeWith(ctx, remote.Stdio(os.Stdin, os.Stdout), local, opts); err != nil && ctx.Err() == nil {
		fmt.Fprintln(stderr, "portplane agent:", err)
		return 1
	}
	return 0
}
