package main

import (
	"flag"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/akamachinecode/portplane/internal/model"
)

func cmdAct(verb string, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet(verb, flag.ContinueOnError)
	fs.SetOutput(stderr)
	var folders stringList
	fs.Var(&folders, "folder", "folder to look in instead of the saved ones (repeatable)")
	fs.Usage = func() {
		fmt.Fprintf(stderr, "Usage: portplane %s <app>\n\n<app> is a task path (shop/web), a label, a hostname (web.shop.localhost)\nor a project or worktree folder ending in / (shop/).\n", verb)
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return 2
	}
	l, err := localAgent(folders)
	if err != nil {
		fmt.Fprintln(stderr, "portplane:", err)
		return 1
	}
	defer func() { _ = l.Close() }()
	snap, err := l.Snapshot(background())
	if err != nil {
		fmt.Fprintln(stderr, "portplane:", err)
		return 1
	}
	target, err := resolveTarget(snap, fs.Arg(0))
	if err != nil {
		fmt.Fprintln(stderr, "portplane:", err)
		return 1
	}
	if err := l.Act(background(), target, model.Verb(verb)); err != nil {
		fmt.Fprintln(stderr, "portplane:", err)
		return 1
	}
	name := target.Task
	if name == "" {
		name = target.Prefix
	}
	fmt.Fprintf(stdout, "%s: %s\n", verb, name)
	return 0
}

// resolveTarget finds what a name refers to: an exact task path, a folder
// prefix, a hostname or a unique label.
func resolveTarget(snap model.MachineSnapshot, name string) (model.Target, error) {
	machine := snap.Machine.ID
	if strings.HasSuffix(name, "/") {
		runners := map[string]bool{}
		for _, a := range snap.Apps {
			if strings.HasPrefix(a.Task, name) {
				runners[a.Runner] = true
			}
		}
		switch len(runners) {
		case 0:
			return model.Target{}, fmt.Errorf("no apps under %s", name)
		case 1:
			for r := range runners {
				return model.Target{Machine: machine, Runner: r, Prefix: name}, nil
			}
		}
		return model.Target{}, fmt.Errorf("%s exists in several dekit projects; run it from that folder with --folder", name)
	}
	var matches []model.App
	for _, pass := range []func(model.App) bool{
		func(a model.App) bool { return a.Task == name },
		func(a model.App) bool {
			return a.Hostname == name || strings.TrimSuffix(a.Hostname, ".localhost") == name
		},
		func(a model.App) bool { return a.Label == name },
	} {
		for _, a := range snap.Apps {
			if pass(a) {
				matches = append(matches, a)
			}
		}
		if len(matches) > 0 {
			break
		}
	}
	switch len(matches) {
	case 0:
		return model.Target{}, fmt.Errorf("no app called %q (see portplane ls)", name)
	case 1:
		return model.Target{Machine: machine, Runner: matches[0].Runner, Task: matches[0].Task}, nil
	}
	var names []string
	for _, a := range matches {
		names = append(names, a.Task)
	}
	sort.Strings(names)
	return model.Target{}, fmt.Errorf("%q matches several apps: %s", name, strings.Join(names, ", "))
}
