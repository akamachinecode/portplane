package main

import (
	"errors"
	"net/http"
	"os"
	"os/exec"
	"runtime"

	"github.com/akamachinecode/portplane/internal/server"
)

// dekitHandlers serves the dekit center: runners, why, config editing, reload review, spawn, add an app, dekit itself (M5.3, ADR-0022). Output (M5.4) adds its own routes.
func dekitHandlers(d deps) map[string]http.HandlerFunc {
	return server.DekitHandlers(server.DekitDeps{
		CLI:          d.dekit,
		Jobs:         d.jobs,
		Folders:      d.local.Folders,
		Refresh:      d.local.RefreshTools, // also collects again soon
		RefreshTools: d.local.RefreshTools,
		OpenFile:     openFile,
	})
}

// openFile opens a config file in the user's default app for it.
func openFile(path string) error {
	if _, err := os.Stat(path); err != nil {
		return err
	}
	var argv []string
	switch runtime.GOOS {
	case "darwin":
		argv = []string{"open", path}
	case "windows":
		argv = []string{"rundll32", "url.dll,FileProtocolHandler", path}
	default:
		argv = []string{"xdg-open", path}
	}
	cmd := exec.Command(argv[0], argv[1:]...) //nolint:noctx // detached: the editor outlives the request
	if err := cmd.Start(); err != nil {
		return errors.New("no app to open it with: " + err.Error())
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func init() { areas = append(areas, dekitHandlers) }
