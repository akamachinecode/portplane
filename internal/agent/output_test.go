package agent

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akamachinecode/portplane/internal/dekit"
)

// screenDekit is a fakeDekit whose screen a test sets, counting the reads.
type screenDekit struct {
	*fakeDekit
	mu     sync.Mutex
	screen string
	err    error
	calls  int
	gate   chan struct{} // when set, reads wait for it
}

func (s *screenDekit) Screen(ctx context.Context, _, _ string) (string, error) {
	s.mu.Lock()
	s.calls++
	gate, screen, err := s.gate, s.screen, s.err
	s.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	return screen, err
}

func (s *screenDekit) reads() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

// A real `dekit screen --json` answer (dekit 0.10.3): rows end in "\r\n",
// colours are SGR codes and the unused rows of the 24-row screen are empty.
const dekitScreen = "\x1b[32mgreen\x1b[0m \x1b[1;31mbold red\x1b[0m \x1b[38;5;208morange256\x1b[0m \x1b[4munder\x1b[0m <b>&amp;\r\n" +
	"progress 99%\r\n" +
	"a very long line that goes past the width of the terminal so that we can see if \r\n" +
	"dekit wraps it\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n"

func TestCleanScreen(t *testing.T) {
	for _, tc := range []struct {
		name, in, want string
	}{
		{"real dekit screen", dekitScreen, "\x1b[32mgreen\x1b[0m \x1b[1;31mbold red\x1b[0m \x1b[38;5;208morange256\x1b[0m \x1b[4munder\x1b[0m <b>&amp;\n" +
			"progress 99%\n" +
			"a very long line that goes past the width of the terminal so that we can see if\n" +
			"dekit wraps it"},
		{"empty screen of a task that never ran", strings.Repeat("\r\n", 23), ""},
		{"colour codes with colons and truecolour stay", "\x1b[38:5:12mx\x1b[38;2;10;20;30my\x1b[m", "\x1b[38:5:12mx\x1b[38;2;10;20;30my\x1b[m"},
		{"cursor and screen codes go", "\x1b[2J\x1b[1;1H\x1b[?25lready\x1b[K\x1b[?2004h", "ready"},
		{"private and intermediate CSI codes that end in m go", "\x1b[?1mA\x1b[>4;2mB\x1b[1 mC", "ABC"},
		{"OSC titles and hyperlinks go", "\x1b]0;my title\x07a \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ b", "a link b"},
		{"an unterminated OSC ends with its row", "\x1b]0;oops\nnext row", "\nnext row"},
		{"DCS and APC strings go", "\x1bPq#0;2;0;0;0\x1b\\x\x1b_secret\x1b\\y", "xy"},
		{"charset and keypad codes go", "\x1b(Bplain\x1b=\x1b>", "plain"},
		{"a lone ESC goes without eating the row break", "a\x1b\nb\x1b", "a\nb"},
		{"C0 controls go, tabs stay", "a\x07b\x08c\x00d\te\x7f", "abcd\te"},
		{"C1 controls go, other text stays", "a\u009b31mb ü → 日本", "a31mb ü → 日本"},
		{"invalid UTF-8 becomes U+FFFD", "a\xffb", "a�b"},
		{"trailing spaces and blank styled rows go", "row   \r\n\x1b[0m  \r\n\x1b[m\r\n", "row"},
		{"leading blank rows stay", "\r\n\r\nlate", "\n\nlate"},
		{"a cut CSI at the end goes", "text\x1b[3", "text"},
	} {
		got, cut := cleanScreen(tc.in, outputMax)
		if got != tc.want || cut {
			t.Errorf("%s: got %q (cut %v), want %q", tc.name, got, cut, tc.want)
		}
	}
}

func TestCleanScreenKeepsTheEndUnderTheCap(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 100; i++ {
		b.WriteString("row ")
		b.WriteString(strings.Repeat("x", 6))
		b.WriteString("\r\n")
	}
	b.WriteString("last row")
	got, cut := cleanScreen(b.String(), 64)
	if !cut || len(got) > 64 || !strings.HasSuffix(got, "\nlast row") || !strings.HasPrefix(got, "row ") {
		t.Fatalf("got %q (cut %v)", got, cut)
	}
	// One row longer than the cap is cut on a character boundary.
	got, cut = cleanScreen(strings.Repeat("é", 50), 9)
	if !cut || got != "éééé" {
		t.Fatalf("got %q (cut %v)", got, cut)
	}
}

func newOutputAgent(t *testing.T, dk *screenDekit) (*Local, string) {
	t.Helper()
	root := t.TempDir()
	writeFile(t, root+"/dekit.yaml", "tasks:\n  shop/web:\n    cmd: [\"pnpm\", \"dev\"]\n  shop/api:\n    cmd: [\"node\", \"api.js\"]\n")
	dk.fakeDekit = &fakeDekit{
		runners: []dekit.RunnerRecord{{PID: 100, Root: root, Running: true}},
		states:  map[string][]dekit.TaskState{root: {{Path: "shop/web", Kind: "service", State: "ready"}, {Path: "shop/api", Kind: "service", State: "idle"}}},
	}
	l := NewLocal(Options{Folders: []string{root}, Dekit: dk, Portless: fakeRouter{}, OS: fakeOS{}})
	t.Cleanup(func() { _ = l.Close() })
	return l, root
}

func TestOutput(t *testing.T) {
	dk := &screenDekit{screen: dekitScreen}
	l, root := newOutputAgent(t, dk)
	ctx := context.Background()

	out, err := l.Output(ctx, root, "shop/web")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.Screen, "\x1b[32mgreen") || !strings.HasSuffix(out.Screen, "dekit wraps it") || out.Truncated || out.RunnerDown {
		t.Fatalf("output %+v", out)
	}
	if want := "dekit -C " + quoteArg(root) + " attach shop/web"; out.Command != want {
		t.Fatalf("command %q, want %q", out.Command, want)
	}

	// Only apps of watched projects, and never something dekit would read as a flag.
	for _, c := range []struct{ runner, task string }{
		{root, "shop/nope"},
		{"/elsewhere", "shop/web"},
		{root, "--help"},
		{root, ""},
	} {
		if _, err := l.Output(ctx, c.runner, c.task); err == nil {
			t.Errorf("%q %q must be refused", c.runner, c.task)
		}
	}

	// dekit's own errors reach the caller.
	dk.mu.Lock()
	dk.err = errors.New("dekit screen: boom")
	dk.mu.Unlock()
	if _, err := l.Output(ctx, root, "shop/api"); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("error %v", err)
	}
}

func TestOutputWhileTheRunnerIsDown(t *testing.T) {
	dk := &screenDekit{err: dekit.ErrRunnerDown}
	l, root := newOutputAgent(t, dk)
	out, err := l.Output(context.Background(), root, "shop/web")
	if err != nil || !out.RunnerDown || out.Screen != "" || out.Command == "" {
		t.Fatalf("output %+v, %v", out, err)
	}
}

func TestOutputSharesReads(t *testing.T) {
	dk := &screenDekit{screen: "hello\r\n"}
	l, root := newOutputAgent(t, dk)
	l.screens.ttl = time.Hour
	ctx := context.Background()
	if _, err := l.Output(ctx, root, "shop/web"); err != nil {
		t.Fatal(err)
	}
	before := dk.reads()

	// Another panel asking within the TTL gets the same answer.
	if out, err := l.Output(ctx, root, "shop/web"); err != nil || out.Screen != "hello" {
		t.Fatalf("output %+v, %v", out, err)
	}
	if got := dk.reads(); got != before {
		t.Fatalf("reads %d, want %d", got, before)
	}
	// Another app has its own screen.
	if _, err := l.Output(ctx, root, "shop/api"); err != nil {
		t.Fatal(err)
	}
	if got := dk.reads(); got != before+1 {
		t.Fatalf("reads %d, want %d", got, before+1)
	}

	// Once the answer is old, the next call reads again.
	l.screens.ttl = time.Nanosecond
	time.Sleep(time.Millisecond)
	if _, err := l.Output(ctx, root, "shop/web"); err != nil {
		t.Fatal(err)
	}
	if got := dk.reads(); got != before+2 {
		t.Fatalf("reads %d, want %d", got, before+2)
	}
}

func TestOutputCallersShareAReadInFlight(t *testing.T) {
	dk := &screenDekit{screen: "slow\r\n"}
	l, root := newOutputAgent(t, dk)
	ctx := context.Background()
	if _, err := l.Output(ctx, root, "shop/web"); err != nil { // fills the snapshot
		t.Fatal(err)
	}
	l.screens.ttl = time.Nanosecond
	time.Sleep(time.Millisecond)
	before := dk.reads()
	gate := make(chan struct{})
	dk.mu.Lock()
	dk.gate = gate
	dk.mu.Unlock()

	// The first caller's request ends early: the read goes on for the others.
	first, cancel := context.WithCancel(ctx)
	firstDone := make(chan struct{})
	go func() {
		_, _ = l.Output(first, root, "shop/web")
		close(firstDone)
	}()
	waitFor(t, func() bool { return dk.reads() == before+1 })
	l.screens.mu.Lock()
	l.screens.ttl = time.Hour // a waiter that arrives late reuses the answer
	l.screens.mu.Unlock()
	errs := make(chan error, 3)
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out, err := l.Output(ctx, root, "shop/web")
			if err == nil && out.Screen != "slow" {
				err = errors.New("screen " + out.Screen)
			}
			errs <- err
		}()
	}
	cancel()
	time.Sleep(20 * time.Millisecond) // the waiters join the read in flight
	close(gate)
	wg.Wait()
	<-firstDone
	for i := 0; i < 3; i++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if got := dk.reads(); got != before+1 {
		t.Fatalf("reads %d, want %d", got, before+1)
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(time.Millisecond)
	}
}
