//go:build darwin

package notify

import (
	"reflect"
	"testing"
)

func TestOsascriptArgs(t *testing.T) {
	got := osascriptArgs(Options{AppName: "Portplane"}, Notification{Title: "web crashed", Body: "-n my-monorepo"})
	want := []string{"-e", "on run argv", "-e", "display notification (item 3 of argv) with title (item 2 of argv)", "-e", "end run", "portplane", "Portplane: web crashed", "-n my-monorepo"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%q", got)
	}
}
