package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/portless"
	"github.com/akamachinecode/portplane/internal/setup"
)

func cmdSetup(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("setup", flag.ContinueOnError)
	fs.SetOutput(stderr)
	apply := fs.Bool("apply", false, "write the proposed config (asks first unless --yes)")
	yes := fs.Bool("yes", false, "with --apply, do not ask")
	showFiles := fs.Bool("files", false, "print the files that would be written")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "Usage: portplane setup [--apply [--yes]] [--files] <folder>\n\nFinds the dev servers in <folder> and proposes dekit tasks wrapped by portless,\nin <folder>/.portplane/tasks.yaml (loaded from <folder>/dekit.yaml).")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return 2
	}
	folder, err := absFolder(fs.Arg(0))
	if err != nil {
		fmt.Fprintln(stderr, "portplane:", err)
		return 1
	}
	ctx := context.Background()

	dk, pl := dekit.NewCLI(), portless.New()
	var dv, pv string
	if dk.Available() {
		dv, _ = dk.Version(ctx)
	}
	if pl.Available() {
		pv, _ = pl.Version(ctx)
	}
	check := setup.Evaluate(setup.GatherFacts(ctx, dv, pv, pl.Proxy().Running))
	for _, r := range check.Requirements {
		if r.OK {
			continue
		}
		fmt.Fprintf(stdout, "! %s: %s\n  %s\n", r.Name, r.Problem, r.Why)
		for _, c := range r.Commands {
			fmt.Fprintf(stdout, "    %s\n", c)
		}
	}

	p, err := setup.Propose(ctx, folder, setup.Overrides{}, setup.Options{})
	if err != nil {
		fmt.Fprintln(stderr, "portplane:", err)
		return 1
	}
	printProposal(stdout, p, *showFiles)
	changed := false
	for _, f := range p.Files {
		changed = changed || f.Changed
	}
	if !changed {
		fmt.Fprintln(stdout, "Nothing to change.")
		return 0
	}
	if !*apply {
		fmt.Fprintln(stdout, "\nRun again with --apply to write these files.")
		return 0
	}
	if !*yes && !confirm(stdout, os.Stdin, "Write these files?") {
		fmt.Fprintln(stdout, "Nothing written.")
		return 1
	}
	res, err := setup.Apply(ctx, folder, p.Digest, setup.Overrides{}, setup.Options{})
	if err != nil {
		fmt.Fprintln(stderr, "portplane:", err)
		return 1
	}
	for _, w := range res.Written {
		fmt.Fprintln(stdout, "wrote", w)
	}
	if dk.Available() {
		err := dk.Reload(ctx, res.Root)
		switch {
		case errors.Is(err, dekit.ErrRunnerDown):
			fmt.Fprintf(stdout, "Start the apps with: dekit -C %s up, or from Portplane.\n", res.Root)
		case err != nil:
			fmt.Fprintln(stderr, "portplane: dekit reload:", err)
			return 1
		default:
			fmt.Fprintln(stdout, "dekit picked up the new tasks.")
		}
	}
	return 0
}

func printProposal(w io.Writer, p *setup.Proposal, files bool) {
	if len(p.Apps) == 0 {
		fmt.Fprintln(w, "No dev servers found (Portplane looks for package.json files with a dev script).")
	}
	for _, a := range p.Apps {
		mark := map[string]string{"new": "+", "changed": "~", "unchanged": " ", "manual": "=", "skipped": "-"}[a.Status]
		fmt.Fprintf(w, "%s %-28s https://%-36s %s (%s)\n", mark, a.Task, a.Hostname, a.Dir, a.Framework)
		for _, n := range a.Notes {
			fmt.Fprintf(w, "    %s\n", n)
		}
	}
	for _, t := range p.Change.Removed {
		fmt.Fprintf(w, "- %s (no longer found)\n", t)
	}
	for _, warn := range p.Warnings {
		fmt.Fprintf(w, "! %s\n", warn)
	}
	if files {
		for _, f := range p.Files {
			if !f.Changed {
				continue
			}
			fmt.Fprintf(w, "\n--- %s\n%s", f.Path, f.After)
		}
	}
}

func confirm(w io.Writer, r io.Reader, q string) bool {
	fmt.Fprintf(w, "%s [y/N] ", q)
	line, _ := bufio.NewReader(r).ReadString('\n')
	line = strings.ToLower(strings.TrimSpace(line))
	return line == "y" || line == "yes"
}
