//go:build !windows && !darwin

package privileged

import (
	"errors"
	"os/exec"
	"strings"
	"testing"
)

func TestPkexecArgs(t *testing.T) {
	got := pkexecArgs("/usr/bin/env", Command{Argv: []string{"/opt/portless", "service", "install"}, Env: map[string]string{"HOME": "/home/dev", "A": "1"}})
	if strings.Join(got, " ") != "/usr/bin/env A=1 HOME=/home/dev /opt/portless service install" {
		t.Errorf("got %v", got)
	}
}

func TestPkexecError(t *testing.T) {
	exitWith := func(code string) error {
		return exec.Command("/bin/sh", "-c", "exit "+code).Run()
	}
	if err := pkexecError(exitWith("126"), ""); !errors.Is(err, ErrDenied) {
		t.Errorf("126: %v", err)
	}
	if err := pkexecError(exitWith("127"), "Error executing command as another user: No authentication agent found."); !errors.Is(err, ErrUnavailable) {
		t.Errorf("127 without agent: %v", err)
	}
	if err := pkexecError(exitWith("1"), ""); err == nil || errors.Is(err, ErrDenied) {
		t.Errorf("1: %v", err)
	}
	if pkexecError(nil, "") != nil {
		t.Error("nil")
	}
}
