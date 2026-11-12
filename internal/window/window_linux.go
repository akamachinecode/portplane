//go:build linux

package window

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// On Linux the window is its own process, portplane-window: it loads GTK
// and WebKitGTK, which this binary must not link so that it keeps starting
// on machines without a desktop (ADR-0018). Closing the window ends that
// process, and with it the web view's memory.

var (
	mu          sync.Mutex
	opts        Options
	cur         *helper // the open window, nil when closed
	nextPick    int
	unavailable bool   // the helper said it cannot show a window here
	theme       string // ThemeSystem, ThemeLight or ThemeDark; "" is the system's
)

// lookPath finds portplane-window; a variable so tests can swap it.
var lookPath = helperPath

// Supported reports whether Show can open a native window: a graphical
// session and portplane-window next to this binary. It turns false once the
// helper reports that GTK 4 or WebKitGTK 6.0 is missing.
func Supported() bool {
	mu.Lock()
	defer mu.Unlock()
	return !unavailable && (os.Getenv("WAYLAND_DISPLAY") != "" || os.Getenv("DISPLAY") != "") && lookPath() != ""
}

// NeedsTray is false: the window does not live in the tray's run loop.
func NeedsTray() bool { return false }

// Start keeps the options for the window. Close closes it.
func Start(_ context.Context, o Options) {
	mu.Lock()
	opts = o
	mu.Unlock()
}

// Show opens the window, or brings it to the front. token is an XDG
// activation token, which lets Wayland give the window focus; it may be "".
// It waits until the window is on screen and fails when it cannot open.
func Show(token string) error {
	mu.Lock()
	if h := cur; h != nil {
		mu.Unlock()
		h.send(Message{Op: OpPresent, Token: token})
		return nil
	}
	path := lookPath()
	if path == "" {
		mu.Unlock()
		return errors.New(HelperName + " not found")
	}
	h, err := spawn(path, opts, token, theme)
	if err != nil {
		mu.Unlock()
		return err
	}
	cur = h
	mu.Unlock()

	select {
	case <-h.ready:
		return nil
	case <-h.done:
		if h.code == ExitUnavailable {
			mu.Lock()
			unavailable = true
			mu.Unlock()
		}
		return fmt.Errorf("%s exited with code %d", HelperName, h.code)
	case <-time.After(30 * time.Second):
		return nil // slow to start, but running: it shows up when ready
	}
}

// Close closes the window and waits briefly for its process to end.
func Close() {
	mu.Lock()
	h := cur
	mu.Unlock()
	if h == nil {
		return
	}
	h.mu.Lock()
	h.closing = true
	h.mu.Unlock()
	h.send(Message{Op: OpClose})
	_ = h.in.Close() // the helper also closes on end of input
	select {
	case <-h.done:
	case <-time.After(3 * time.Second):
		_ = h.cmd.Process.Kill()
		<-h.done
	}
}

// CanPick reports whether the window can show the folder picker: it is open.
func CanPick() bool {
	mu.Lock()
	defer mu.Unlock()
	return cur != nil
}

func pickFolder(ctx context.Context) (string, error) {
	return ask(ctx, Message{Op: OpPick})
}

func saveFile(ctx context.Context, name string) (string, error) {
	return ask(ctx, Message{Op: OpSave, Path: name})
}

// ask shows a file dialog over the window and waits for its answer (the
// picks map holds folder pickers and save dialogs alike, by id).
func ask(ctx context.Context, m Message) (string, error) {
	mu.Lock()
	h := cur
	if h == nil {
		mu.Unlock()
		return "", ErrNoWindow
	}
	nextPick++
	id := nextPick
	ch := make(chan Message, 1)
	h.mu.Lock()
	h.picks[id] = ch
	h.mu.Unlock()
	mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.picks, id)
		h.mu.Unlock()
	}()

	m.ID = id
	h.send(m)
	select {
	case m := <-ch:
		if m.Error == ErrPickerUnsupported {
			return "", ErrNoWindow
		}
		if m.Error != "" {
			return "", errors.New(m.Error)
		}
		return m.Path, nil
	case <-h.done:
		return "", nil // the window closed: as if cancelled
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func setTheme(t string) {
	mu.Lock()
	theme = t
	h := cur
	mu.Unlock()
	if h != nil {
		h.send(Message{Op: OpTheme, Theme: t})
	}
}

func navigate(fragment string) {
	mu.Lock()
	h := cur
	mu.Unlock()
	if h != nil {
		h.send(Message{Op: OpNavigate, Path: fragment})
	}
}

// helper is a running portplane-window.
type helper struct {
	cmd   *exec.Cmd
	in    *os.File
	ready chan struct{}
	done  chan struct{}
	code  int // exit code, set before done closes

	mu      sync.Mutex
	enc     *json.Encoder
	picks   map[int]chan Message
	closing bool // Portplane asked it to close
}

func spawn(path string, o Options, token, theme string) (*helper, error) {
	args := []string{"--ipc", "--url", o.URL, "--browser-url", o.BrowserURL, "--state", o.StatePath}
	if token != "" {
		args = append(args, "--activation-token", token)
	}
	if theme != "" && theme != ThemeSystem {
		args = append(args, "--theme", theme)
	}
	inR, inW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		_ = inR.Close()
		_ = inW.Close()
		return nil, err
	}
	cmd := exec.Command(path, args...) //nolint:noctx // lives until the window closes
	// The token goes on the command line for this window only; an
	// inherited one would be stale.
	cmd.Env = withoutEnv(os.Environ(), "XDG_ACTIVATION_TOKEN", "DESKTOP_STARTUP_ID")
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr // GTK and WebKit warnings
	cmd.ExtraFiles = []*os.File{inR, outW}        // fds 3 and 4
	err = cmd.Start()
	_ = inR.Close()
	_ = outW.Close()
	if err != nil {
		_ = inW.Close()
		_ = outR.Close()
		return nil, err
	}

	h := &helper{
		cmd:   cmd,
		in:    inW,
		ready: make(chan struct{}),
		done:  make(chan struct{}),
		enc:   json.NewEncoder(inW),
		picks: map[int]chan Message{},
	}
	read := make(chan struct{})
	go func() {
		defer close(read)
		h.read(outR, o)
	}()
	go func() {
		_ = cmd.Wait()
		<-read
		h.code = cmd.ProcessState.ExitCode()
		_ = inW.Close()
		mu.Lock()
		if cur == h {
			cur = nil
		}
		mu.Unlock()
		h.mu.Lock()
		closedByUser := !h.closing && h.code == 0
		h.mu.Unlock()
		close(h.done)
		if closedByUser && o.Closed != nil {
			o.Closed()
		}
	}()
	return h, nil
}

func (h *helper) read(r *os.File, o Options) {
	defer func() { _ = r.Close() }()
	readyOnce := sync.Once{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		var m Message
		if json.Unmarshal(sc.Bytes(), &m) != nil {
			continue
		}
		switch m.Op {
		case OpReady:
			readyOnce.Do(func() { close(h.ready) })
		case OpPicked, OpSaved:
			h.mu.Lock()
			ch := h.picks[m.ID]
			h.mu.Unlock()
			if ch != nil {
				select {
				case ch <- m:
				default:
				}
			}
		case OpQuit:
			h.mu.Lock()
			h.closing = true
			h.mu.Unlock()
			if o.Quit != nil {
				go o.Quit()
			}
		}
	}
}

func (h *helper) send(m Message) {
	h.mu.Lock()
	defer h.mu.Unlock()
	_ = h.enc.Encode(m) // fails only once the window is gone
}

func withoutEnv(env []string, names ...string) []string {
	out := env[:0:0]
	for _, kv := range env {
		drop := false
		for _, n := range names {
			if strings.HasPrefix(kv, n+"=") {
				drop = true
				break
			}
		}
		if !drop {
			out = append(out, kv)
		}
	}
	return out
}

// helperPath finds portplane-window: next to this binary (the packages,
// the archive and install.sh put both in one folder), else on PATH.
// PORTPLANE_WINDOW overrides it, for development.
func helperPath() string {
	if p := os.Getenv("PORTPLANE_WINDOW"); p != "" {
		return p
	}
	if exe, err := os.Executable(); err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		p := filepath.Join(filepath.Dir(exe), HelperName)
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			return p
		}
	}
	if p, err := exec.LookPath(HelperName); err == nil {
		return p
	}
	return ""
}
