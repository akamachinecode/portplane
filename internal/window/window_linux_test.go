//go:build linux

package window

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The test binary doubles as a fake portplane-window: with
// FAKE_WINDOW set it speaks the protocol and logs what it got.
func TestMain(m *testing.M) {
	if mode := os.Getenv("FAKE_WINDOW"); mode != "" {
		os.Exit(fakeWindow(mode))
	}
	os.Exit(m.Run())
}

func fakeWindow(mode string) int {
	if mode == "unavailable" {
		return ExitUnavailable
	}
	logf, _ := os.OpenFile(os.Getenv("FAKE_WINDOW_LOG"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	defer func() { _ = logf.Close() }()
	_, _ = logf.WriteString("args " + strings.Join(os.Args[1:], " ") + "\n")
	out := json.NewEncoder(os.NewFile(4, "out"))
	_ = out.Encode(Message{Op: OpReady})
	switch mode {
	case "quit": // the user chose Quit Portplane
		_ = out.Encode(Message{Op: OpQuit})
		return 0
	case "user-close": // the user closed the window
		return 0
	}
	sc := bufio.NewScanner(os.NewFile(3, "in"))
	for sc.Scan() {
		var m Message
		_ = json.Unmarshal(sc.Bytes(), &m)
		_, _ = logf.WriteString(m.Op + " " + m.Token + "\n")
		switch m.Op {
		case OpPick:
			_ = out.Encode(Message{Op: OpPicked, ID: m.ID, Path: "/home/you/code"})
		case OpClose:
			return 0
		}
	}
	return 0
}

func useFake(t *testing.T, mode string) (log string) {
	t.Helper()
	log = t.TempDir() + "/log"
	t.Setenv("FAKE_WINDOW", mode)
	t.Setenv("FAKE_WINDOW_LOG", log)
	t.Setenv("WAYLAND_DISPLAY", "wayland-test")
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	old := lookPath
	lookPath = func() string { return self }
	t.Cleanup(func() {
		Close()
		lookPath = old
		mu.Lock()
		cur, unavailable = nil, false
		mu.Unlock()
	})
	return log
}

func readLog(t *testing.T, path string) string {
	t.Helper()
	b, _ := os.ReadFile(path)
	return string(b)
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestShowPresentPickClose(t *testing.T) {
	log := useFake(t, "normal")
	var closed atomic.Int32
	Start(context.Background(), Options{URL: "http://127.0.0.1:4799", StatePath: "/tmp/w.json", Closed: func() { closed.Add(1) }})

	if !Supported() {
		t.Fatal("Supported: false with a helper and a display")
	}
	if err := Show("token-1"); err != nil {
		t.Fatal("Show:", err)
	}
	if !strings.Contains(readLog(t, log), "--url http://127.0.0.1:4799") || !strings.Contains(readLog(t, log), "--activation-token token-1") {
		t.Fatalf("helper started with %q", readLog(t, log))
	}
	if !CanPick() {
		t.Fatal("CanPick: false with the window open")
	}

	// A second Show brings the same window to the front.
	if err := Show("token-2"); err != nil {
		t.Fatal("second Show:", err)
	}
	waitFor(t, "present", func() bool { return strings.Contains(readLog(t, log), "present token-2") })
	if n := strings.Count(readLog(t, log), "args "); n != 1 {
		t.Fatalf("%d helpers started, want 1", n)
	}

	p, err := PickFolder(context.Background())
	if err != nil || p != "/home/you/code" {
		t.Fatalf("PickFolder: %q, %v", p, err)
	}

	Close()
	if CanPick() {
		t.Fatal("CanPick: true after Close")
	}
	if closed.Load() != 0 {
		t.Fatal("Closed ran when Portplane closed the window itself")
	}
	if _, err := PickFolder(context.Background()); !errors.Is(err, ErrNoWindow) {
		t.Fatalf("PickFolder with no window: %v, want ErrNoWindow", err)
	}
}

func TestUnavailable(t *testing.T) {
	useFake(t, "unavailable")
	Start(context.Background(), Options{URL: "http://127.0.0.1:4799"})
	if err := Show(""); err == nil {
		t.Fatal("Show: no error from a helper that cannot show a window")
	}
	if Supported() {
		t.Fatal("Supported: still true after the helper reported no GTK")
	}
}

func TestQuitFromWindow(t *testing.T) {
	useFake(t, "quit")
	var quits, closed atomic.Int32
	Start(context.Background(), Options{URL: "http://127.0.0.1:4799", Quit: func() { quits.Add(1) }, Closed: func() { closed.Add(1) }})
	if err := Show(""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "quit", func() bool { return quits.Load() == 1 })
	waitFor(t, "the helper to exit", func() bool { return !CanPick() })
	if closed.Load() != 0 {
		t.Fatal("Closed ran on Quit")
	}
}

func TestUserClosesWindow(t *testing.T) {
	useFake(t, "user-close")
	var closed atomic.Int32
	Start(context.Background(), Options{URL: "http://127.0.0.1:4799", Closed: func() { closed.Add(1) }})
	if err := Show(""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "Closed", func() bool { return closed.Load() == 1 })
}

func TestWithoutEnv(t *testing.T) {
	got := withoutEnv([]string{"A=1", "XDG_ACTIVATION_TOKEN=x", "DESKTOP_STARTUP_ID=y", "B=2"}, "XDG_ACTIVATION_TOKEN", "DESKTOP_STARTUP_ID")
	if strings.Join(got, ",") != "A=1,B=2" {
		t.Fatalf("got %v", got)
	}
}
