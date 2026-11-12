//go:build !windows

package selfupdate

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Start waits for the old process to quit before it runs the new one, and
// tells the new one which process it replaces.
func TestStartWaitsForTheOldOne(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "started")
	exe := filepath.Join(dir, "portplane")
	writeFile(t, exe, "#!/bin/sh\necho \"$* $"+AfterPIDEnv+"\" > "+marker+"\n")

	old := exec.Command("sleep", "30")
	if err := old.Start(); err != nil {
		t.Fatal(err)
	}
	waited := make(chan struct{})
	go func() { _ = old.Wait(); close(waited) }()

	if err := Start(exe, []string{"serve", "--open"}, old.Process.Pid); err != nil {
		t.Fatal(err)
	}
	time.Sleep(600 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("the new one started while the old one ran")
	}
	_ = old.Process.Kill()
	<-waited
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(marker); err == nil && len(b) > 0 {
			want := "serve --open " + strconv.Itoa(old.Process.Pid)
			if got := strings.TrimSpace(string(b)); got != want {
				t.Fatalf("got %q, want %q", got, want)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the new one never started")
}
