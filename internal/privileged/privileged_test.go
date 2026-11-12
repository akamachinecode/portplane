package privileged

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestTerminal(t *testing.T) {
	c := Command{
		Argv: []string{"/home/dev/.local/bin/portless", "service", "install"},
		Env:  map[string]string{"HOME": "/home/dev", "PATH": "/usr/bin", "SUDO_UID": "1000", "PORTLESS_STATE_DIR": "/home/dev/my state"},
	}
	got := Terminal(c, "linux")
	want := "sudo env HOME=/home/dev 'PORTLESS_STATE_DIR=/home/dev/my state' /home/dev/.local/bin/portless service install"
	if got != want {
		t.Errorf("linux:\n got %s\nwant %s", got, want)
	}
	if got := Terminal(Command{Argv: []string{"/usr/bin/true"}, Env: map[string]string{"PATH": "/x"}}, "darwin"); got != "sudo /usr/bin/true" {
		t.Errorf("only PATH: %s", got)
	}
	win := Terminal(Command{Argv: []string{`C:\Program Files\nodejs\portless.cmd`, "service", "install"}, Env: map[string]string{"HOME": `C:\Users\dev`}}, "windows")
	if win != `$env:HOME='C:\Users\dev'; & 'C:\Program Files\nodejs\portless.cmd' 'service' 'install'` {
		t.Errorf("windows: %s", win)
	}
}

func TestShellQuote(t *testing.T) {
	for in, want := range map[string]string{
		"plain":       "plain",
		"":            "''",
		"a b":         "'a b'",
		"it's":        `'it'\''s'`,
		"$(rm -rf /)": "'$(rm -rf /)'",
		"K=V":         "K=V",
	} {
		if got := ShellQuote(in); got != want {
			t.Errorf("ShellQuote(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestRunRefusesRelativeAndBadEnv(t *testing.T) {
	if err := Run(context.Background(), Command{Argv: []string{"portless"}}, nil); err == nil {
		t.Error("ran a program without an absolute path")
	}
	abs := "/usr/bin/true"
	if runtime.GOOS == "windows" {
		abs = `C:\Windows\System32\whoami.exe`
	}
	if err := Run(context.Background(), Command{Argv: []string{abs}, Env: map[string]string{"A=B": "x"}}, nil); err == nil {
		t.Error("accepted an env name with =")
	}
}

// The helper is what macOS and Windows run as administrator; here it runs
// as the test user.
func TestHelperRunsAndReports(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	dir, outPath, codePath, err := helperFiles()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	c := Command{Argv: []string{"/bin/sh", "-c", `echo "home=$HOME"; echo oops >&2; exit 3`}, Env: map[string]string{"HOME": "/home/dev"}}
	args := helperArgs(c, outPath, codePath)
	if args[0] != HelperCommand {
		t.Fatalf("args %v", args)
	}
	var stderr bytes.Buffer
	if code := RunHelper(args[1:], &stderr); code != 3 {
		t.Fatalf("exit %d, stderr %s", code, stderr.String())
	}
	b, _ := os.ReadFile(outPath)
	if !strings.Contains(string(b), "home=/home/dev") || !strings.Contains(string(b), "oops") {
		t.Errorf("output %q", b)
	}
	if err := statusError(helperStatus(codePath)); err == nil || !strings.Contains(err.Error(), "3") {
		t.Errorf("status %v", err)
	}
}

func TestFollowCopiesGrowth(t *testing.T) {
	p := filepath.Join(t.TempDir(), "out")
	if err := os.WriteFile(p, []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var got bytes.Buffer
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() { follow(p, &got, done); close(finished) }()
	f, _ := os.OpenFile(p, os.O_WRONLY|os.O_APPEND, 0)
	_, _ = f.WriteString("two\n")
	_ = f.Close()
	close(done)
	<-finished
	if got.String() != "one\ntwo\n" {
		t.Errorf("followed %q", got.String())
	}
}

func TestMergeEnv(t *testing.T) {
	got := mergeEnv([]string{"HOME=/root", "PATH=/sbin", "LANG=C"}, []string{"HOME=/home/dev", "PATH=/usr/bin"})
	if strings.Join(got, ",") != "LANG=C,HOME=/home/dev,PATH=/usr/bin" {
		t.Errorf("got %v", got)
	}
}

// A headless machine (a remote agent) never asks: the user runs the
// command over SSH instead.
func TestHeadless(t *testing.T) {
	t.Cleanup(func() { headless.Store(false) })
	Headless()
	if Method() != "" || Available() {
		t.Fatal("a headless machine has no password dialog")
	}
	// Never run: a headless machine stops before starting anything.
	err := Run(context.Background(), Command{Argv: []string{filepath.Join(t.TempDir(), "true")}}, nil)
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("%v", err)
	}
}
