package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"

	"github.com/akamachinecode/portplane/internal/model"
)

func cmdList(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("ls", flag.ContinueOnError)
	fs.SetOutput(stderr)
	asJSON := fs.Bool("json", false, "print the machine snapshot as JSON")
	all := fs.Bool("all", false, "also list jobs and other listening ports")
	var folders stringList
	fs.Var(&folders, "folder", "folder to look in instead of the saved ones (repeatable)")
	if err := fs.Parse(args); err != nil {
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
	if *asJSON {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(snap); err != nil {
			return 1
		}
		return 0
	}
	printSnapshot(stdout, snap, *all)
	return 0
}

func printSnapshot(w io.Writer, snap model.MachineSnapshot, all bool) {
	if len(snap.Folders) == 0 {
		fmt.Fprintln(w, "No folders yet. Add one with: portplane folders add <path>")
		return
	}
	if snap.Tools.Dekit == "" {
		fmt.Fprintln(w, "dekit is not installed: https://dekit.run")
	}
	for _, r := range snap.Runners {
		switch {
		case r.Error != "":
			fmt.Fprintf(w, "! %s: %s\n", r.Name, r.Error)
		case !r.Up:
			fmt.Fprintf(w, "! %s: dekit runner is not running (dekit -C %s up)\n", r.Name, r.Root)
		}
	}
	byID := map[string]model.App{}
	for _, a := range snap.Apps {
		byID[a.ID] = a
	}
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	for _, p := range snap.Projects {
		fmt.Fprintf(tw, "%s\t(%d/%d running)\t\t\n", p.Name, p.Running, countServices(p, byID))
		for _, wt := range p.Worktrees {
			if len(p.Worktrees) > 1 {
				name := wt.Name
				if name == "" {
					name = "main"
				}
				fmt.Fprintf(tw, "  [%s]\t\t\t\n", name)
			}
			for _, id := range wt.Apps {
				a := byID[id]
				if a.Kind == "job" && !all && a.State != model.StateStarting && a.State != model.StateFailed {
					continue
				}
				where := a.URL
				if where == "" && a.Hostname != "" {
					where = a.Hostname
				}
				if a.Port != 0 {
					if where != "" {
						where += " "
					}
					where += fmt.Sprintf("→ :%d", a.Port)
				}
				state := string(a.State)
				if a.Detail != "" {
					state += " (" + a.Detail + ")"
				}
				fmt.Fprintf(tw, "  %s %s\t%s\t%s\t\n", stateMark(a.State), a.Task, state, where)
			}
		}
	}
	_ = tw.Flush()
	if all && len(snap.OtherPorts) > 0 {
		fmt.Fprintln(w, "\nOther listening ports")
		tw = tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
		for _, p := range snap.OtherPorts {
			fmt.Fprintf(tw, "  :%d\t%s\t%s\t\n", p.Port, p.Process, strings.TrimSpace(p.Project+" "+p.Dir))
		}
		_ = tw.Flush()
	}
}

func countServices(p model.Project, byID map[string]model.App) int {
	n := 0
	for _, wt := range p.Worktrees {
		for _, id := range wt.Apps {
			if byID[id].Kind != "job" {
				n++
			}
		}
	}
	return n
}

func stateMark(s model.State) string {
	switch s {
	case model.StateOn:
		return "●"
	case model.StateStarting, model.StateStopping:
		return "◐"
	case model.StateFailed:
		return "✕"
	}
	return "○"
}
