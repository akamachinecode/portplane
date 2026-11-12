package agent

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/model"
)

// outputMax caps an Output's screen. A dekit screen is a few kilobytes (rows
// times columns, plus colour codes); the cap keeps one answer cheap to send
// every second, over SSH too, whatever the task's terminal size.
const outputMax = 256 << 10

// screenTTL is how long a screen is reused, so several panels or windows
// open on one app share a single `dekit screen` a second.
const screenTTL = 500 * time.Millisecond

// Output returns a task's whole terminal screen with its colours, for the
// Output panel (ADR-0021). The UI asks once a second while the panel is
// open, so this stays cheap: the task is checked against the latest
// snapshot instead of walking the folders again, and answers are shared for
// half a second.
func (l *Local) Output(ctx context.Context, runner, task string) (model.Output, error) {
	if err := l.checkTask(ctx, runner, task); err != nil {
		return model.Output{}, err
	}
	command := "dekit -C " + quoteArg(runner) + " attach " + quoteArg(task)
	return l.screens.get(ctx, runner+"\x00"+task, func(ctx context.Context) (model.Output, error) {
		raw, err := l.dekit.Screen(ctx, runner, task)
		if errors.Is(err, dekit.ErrRunnerDown) {
			return model.Output{RunnerDown: true, Command: command}, nil
		}
		if err != nil {
			return model.Output{}, err
		}
		screen, cut := cleanScreen(raw, outputMax)
		return model.Output{Screen: screen, Truncated: cut, Command: command}, nil
	})
}

// checkTask makes sure runner and task name an app this agent shows, so a
// request can only read the screens of watched projects.
func (l *Local) checkTask(ctx context.Context, runner, task string) error {
	if task == "" || strings.HasPrefix(task, "-") {
		return fmt.Errorf("unknown app %q", task)
	}
	l.mu.Lock()
	snap, at := l.last, l.lastAt
	l.mu.Unlock()
	if at.IsZero() {
		snap, _ = l.Snapshot(ctx)
	}
	for _, a := range snap.Apps {
		if a.Runner == runner && a.Task == task {
			return nil
		}
	}
	// Not in the latest snapshot (just added, say): check the folders and
	// the config, as Excerpt does.
	if !l.knownRunner(runner) {
		return fmt.Errorf("unknown project %s", runner)
	}
	if cfg, _ := l.configs.load(runner); cfg == nil || cfg.Task(task) == nil {
		return fmt.Errorf("unknown app %s", task)
	}
	return nil
}

// screenCache shares recent and in-flight screen reads. Its zero value is
// ready to use.
type screenCache struct {
	ttl     time.Duration // screenTTL when zero
	mu      sync.Mutex
	entries map[string]*screenCall
}

type screenCall struct {
	done chan struct{}
	// Set before done is closed; read only after.
	at  time.Time
	out model.Output
	err error
}

func (c *screenCall) finished() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

// get returns the answer for key from the last half second, waits for a
// read already running, or reads now with fetch.
func (c *screenCache) get(ctx context.Context, key string, fetch func(context.Context) (model.Output, error)) (model.Output, error) {
	now := time.Now()
	c.mu.Lock()
	ttl := c.ttl
	if ttl <= 0 {
		ttl = screenTTL
	}
	if c.entries == nil {
		c.entries = map[string]*screenCall{}
	}
	for k, e := range c.entries {
		if e.finished() && now.Sub(e.at) > time.Minute {
			delete(c.entries, k) // a panel closed a while ago
		}
	}
	if e := c.entries[key]; e != nil {
		if !e.finished() {
			c.mu.Unlock()
			select {
			case <-e.done:
				return e.out, e.err
			case <-ctx.Done():
				return model.Output{}, ctx.Err()
			}
		}
		if now.Sub(e.at) < ttl {
			c.mu.Unlock()
			return e.out, e.err
		}
	}
	e := &screenCall{done: make(chan struct{})}
	c.entries[key] = e
	c.mu.Unlock()

	// Other callers may wait on this read: it must not end with the request
	// that happened to start it.
	fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	e.out, e.err = fetch(fctx)
	cancel()
	e.at = time.Now()
	close(e.done)
	return e.out, e.err
}

// sgr matches one colour or style code (Select Graphic Rendition).
var sgr = regexp.MustCompile(`\x1b\[[0-9;:]*m`)

// cleanScreen prepares a dekit screen for the UI: it keeps the text and the
// colour codes, removes every other escape sequence and control character,
// joins rows with "\n", trims trailing blanks, and keeps at most max bytes
// from the end, cut at a row boundary. It reports whether it cut.
func cleanScreen(raw string, max int) (string, bool) {
	var b strings.Builder
	b.Grow(len(raw))
	for i := 0; i < len(raw); {
		c := raw[i]
		switch {
		case c == 0x1b:
			n, keep := escapeLen(raw[i:])
			if keep {
				b.WriteString(raw[i : i+n])
			}
			i += n
		case c == '\n' || c == '\t':
			b.WriteByte(c)
			i++
		case c < 0x20 || c == 0x7f:
			i++ // "\r" (rows end in "\r\n"), bells, backspaces…
		case c < utf8.RuneSelf:
			b.WriteByte(c)
			i++
		default:
			r, size := utf8.DecodeRuneInString(raw[i:])
			switch {
			case r == utf8.RuneError && size == 1:
				b.WriteRune(utf8.RuneError)
			case r >= 0x80 && r <= 0x9f:
				// C1 controls, such as the one-character CSI: dropped
			default:
				b.WriteString(raw[i : i+size])
			}
			i += size
		}
	}
	rows := strings.Split(b.String(), "\n")
	for i, row := range rows {
		rows[i] = strings.TrimRight(row, " \t")
	}
	for len(rows) > 0 && strings.TrimSpace(sgr.ReplaceAllString(rows[len(rows)-1], "")) == "" {
		rows = rows[:len(rows)-1]
	}
	out := strings.Join(rows, "\n")
	if len(out) <= max {
		return out, false
	}
	cut := len(out) - max
	if nl := strings.IndexByte(out[cut:], '\n'); nl >= 0 {
		cut += nl + 1
	}
	for cut < len(out) && !utf8.RuneStart(out[cut]) {
		cut++
	}
	return out[cut:], true
}

// escapeLen measures the escape sequence at the start of s (s[0] is ESC)
// and reports whether it is a colour code worth keeping.
func escapeLen(s string) (int, bool) {
	if len(s) < 2 {
		return len(s), false
	}
	switch s[1] {
	case '[': // CSI: parameter bytes, intermediate bytes, one final byte
		j := 2
		for j < len(s) && s[j] >= 0x30 && s[j] <= 0x3f {
			j++
		}
		k := j
		for k < len(s) && s[k] >= 0x20 && s[k] <= 0x2f {
			k++
		}
		if k >= len(s) {
			return len(s), false
		}
		if s[k] < 0x40 || s[k] > 0x7e {
			return k, false // malformed: drop what was read, keep what follows
		}
		keep := s[k] == 'm' && k == j && strings.Trim(s[2:j], "0123456789;:") == ""
		return k + 1, keep
	case ']', 'P', 'X', '^', '_':
		// OSC, DCS, SOS, PM and APC carry a string that ends with BEL or ST.
		// A rendered screen has none; if one is left open, it ends with the
		// row so it cannot hide the rest of the screen.
		for j := 2; j < len(s); j++ {
			switch s[j] {
			case 0x07:
				return j + 1, false
			case '\n':
				return j, false
			case 0x1b:
				if j+1 < len(s) && s[j+1] == '\\' {
					return j + 2, false
				}
				return j, false
			}
		}
		return len(s), false
	default: // ESC, optional intermediate bytes, one final byte
		j := 1
		for j < len(s) && s[j] >= 0x20 && s[j] <= 0x2f {
			j++
		}
		if j < len(s) && s[j] >= 0x30 && s[j] <= 0x7e {
			return j + 1, false
		}
		return j, false // a lone ESC: drop it, keep what follows
	}
}
