package agent

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

// TestLiveSnapshot prints a real snapshot of PORTPLANE_LIVE_FOLDER. It only
// runs when that variable is set: a manual check against a real machine.
func TestLiveSnapshot(t *testing.T) {
	folder := os.Getenv("PORTPLANE_LIVE_FOLDER")
	if folder == "" {
		t.Skip("set PORTPLANE_LIVE_FOLDER to run")
	}
	l := NewLocal(Options{Folders: []string{folder}})
	s, err := l.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	t.Log(string(b))
}
