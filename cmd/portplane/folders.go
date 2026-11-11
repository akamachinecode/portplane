package main

import (
	"fmt"
	"io"

	"github.com/akamachinecode/portplane/internal/settings"
)

func cmdFolders(args []string, stdout, stderr io.Writer) int {
	store, err := openSettings()
	if err != nil {
		fmt.Fprintln(stderr, "portplane:", err)
		return 1
	}
	if len(args) == 0 || args[0] == "ls" || args[0] == "list" {
		st, err := store.Load()
		if err != nil {
			fmt.Fprintln(stderr, "portplane:", err)
			return 1
		}
		if len(st.Folders) == 0 {
			fmt.Fprintln(stdout, "No folders yet. Add one with: portplane folders add <path>")
		}
		for _, f := range st.Folders {
			fmt.Fprintln(stdout, f)
		}
		return 0
	}
	if len(args) != 2 || (args[0] != "add" && args[0] != "rm" && args[0] != "remove") {
		fmt.Fprintln(stderr, "Usage: portplane folders [ls | add <path> | rm <path>]")
		return 2
	}
	path, err := absFolder(args[1])
	if args[0] == "add" && err != nil {
		fmt.Fprintln(stderr, "portplane:", err)
		return 1
	}
	if err != nil {
		path = args[1]
	}
	_, err = store.Update(func(st *settings.Settings) error {
		out := st.Folders[:0]
		for _, f := range st.Folders {
			if f != path {
				out = append(out, f)
			}
		}
		if args[0] == "add" {
			out = append(out, path)
		}
		st.Folders = out
		return nil
	})
	if err != nil {
		fmt.Fprintln(stderr, "portplane:", err)
		return 1
	}
	fmt.Fprintf(stdout, "%s %s\n", map[bool]string{true: "added", false: "removed"}[args[0] == "add"], path)
	return 0
}
