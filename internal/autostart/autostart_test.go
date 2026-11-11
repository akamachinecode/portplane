//go:build !windows

package autostart

import (
	"os"
	"runtime"
	"strings"
	"testing"
)

func TestEnableDisable(t *testing.T) {
	home := t.TempDir()
	Home = func() (string, error) { return home, nil }
	Executable = func() (string, error) { return "/opt/Port Plane/portplane", nil }
	t.Setenv("XDG_CONFIG_HOME", "")
	defer func() { Home = os.UserHomeDir }()

	if on, err := Enabled(); err != nil || on {
		t.Fatalf("initially %v %v", on, err)
	}
	if err := Enable(); err != nil {
		t.Fatal(err)
	}
	p, _ := entryPath()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "darwin" {
		if !strings.Contains(string(b), "<string>/opt/Port Plane/portplane</string>") {
			t.Fatalf("plist:\n%s", b)
		}
	} else if !strings.Contains(string(b), `Exec="/opt/Port Plane/portplane" serve`) {
		t.Fatalf("desktop entry:\n%s", b)
	}
	if on, _ := Enabled(); !on {
		t.Fatal("should be enabled")
	}
	if err := Disable(); err != nil {
		t.Fatal(err)
	}
	if on, _ := Enabled(); on {
		t.Fatal("should be disabled")
	}
	Executable = func() (string, error) { return "/tmp/go-build123/exe/portplane", nil }
	if err := Enable(); err == nil {
		t.Fatal("go run builds must be refused")
	}
}
