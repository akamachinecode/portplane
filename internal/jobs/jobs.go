// Package jobs runs Portplane's long operations (installs, the proxy
// service, upgrades) in the background and reports their progress. The UI
// follows them over the event stream as `event: job` (ADR-0024).
package jobs

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// State is where a job or a step stands.
type State string

const (
	Pending   State = "pending" // steps only
	Running   State = "running"
	Succeeded State = "succeeded"
	Failed    State = "failed"
	Cancelled State = "cancelled"
	Skipped   State = "skipped" // steps only
)

// MaxOutput is how many output lines a job keeps.
const MaxOutput = 500

// Step is one stage of a job, such as "Download" or "Verify checksum".
type Step struct {
	Name  string `json:"name"`
	State State  `json:"state"`
}

// Job is what the UI shows. It is a copy: changing it changes nothing.
type Job struct {
	ID         string     `json:"id"`
	Kind       string     `json:"kind"`
	Title      string     `json:"title"`
	State      State      `json:"state"`
	Steps      []Step     `json:"steps"`
	Output     []string   `json:"output"`
	Error      string     `json:"error,omitempty"`
	Result     any        `json:"result,omitempty"`
	Privileged bool       `json:"privileged,omitempty"`
	StartedAt  time.Time  `json:"startedAt"`
	EndedAt    *time.Time `json:"endedAt,omitempty"`
}

// Done reports whether the job has finished.
func (j Job) Done() bool { return j.State != Running }

// Spec describes a job to start.
type Spec struct {
	Kind  string
	Title string
	// Key makes the job unique while it runs: starting a second job with
	// the same key returns the running one. Empty: no uniqueness.
	Key        string
	Steps      []string
	Privileged bool
}

// Func is the work. It reports progress through r; returning an error
// fails the job, and returning after ctx is cancelled cancels it.
type Func func(ctx context.Context, r *Run) error

// Manager keeps the jobs of this Portplane run.
type Manager struct {
	mu      sync.Mutex
	jobs    map[string]*entry
	subs    map[chan Job]struct{}
	keep    time.Duration
	maxDone int
	now     func() time.Time
}

type entry struct {
	job     Job
	key     string
	cancel  context.CancelFunc
	done    chan struct{}
	partial []byte // output not ended by a newline yet
}

// NewManager returns an empty manager. Finished jobs are kept for an hour,
// and at most 50 of them.
func NewManager() *Manager {
	return &Manager{
		jobs:    map[string]*entry{},
		subs:    map[chan Job]struct{}{},
		keep:    time.Hour,
		maxDone: 50,
		now:     time.Now,
	}
}

// ErrNotFound means no job has that id.
var ErrNotFound = errors.New("no such job")

// Start runs fn in the background and returns the job as it starts. With a
// Spec.Key that a running job already holds, it returns that job instead.
func (m *Manager) Start(spec Spec, fn Func) Job {
	m.mu.Lock()
	if spec.Key != "" {
		for _, e := range m.jobs {
			if e.key == spec.Key && e.job.State == Running {
				j := e.job.clone()
				m.mu.Unlock()
				return j
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	e := &entry{
		key:    spec.Key,
		cancel: cancel,
		done:   make(chan struct{}),
		job: Job{
			ID:         newID(),
			Kind:       spec.Kind,
			Title:      spec.Title,
			State:      Running,
			Steps:      make([]Step, len(spec.Steps)),
			Output:     []string{},
			Privileged: spec.Privileged,
			StartedAt:  m.now(),
		},
	}
	for i, s := range spec.Steps {
		e.job.Steps[i] = Step{Name: s, State: Pending}
	}
	m.jobs[e.job.ID] = e
	m.prune()
	j := e.job.clone()
	m.mu.Unlock()
	m.publish(j)

	r := &Run{m: m, e: e}
	go func() {
		defer close(e.done)
		defer cancel()
		err := safely(ctx, r, fn)
		m.finish(e, ctx, err)
	}()
	return j
}

func safely(ctx context.Context, r *Run, fn Func) (err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("internal error: %v", p)
		}
	}()
	return fn(ctx, r)
}

func (m *Manager) finish(e *entry, ctx context.Context, err error) {
	m.mu.Lock()
	if len(e.partial) > 0 {
		e.job.appendOutput(string(e.partial))
		e.partial = nil
	}
	end := m.now()
	e.job.EndedAt = &end
	switch {
	case err == nil:
		e.job.State = Succeeded
	case ctx.Err() != nil && (errors.Is(err, context.Canceled) || errors.Is(err, ctx.Err())):
		e.job.State = Cancelled
		e.job.Error = "Cancelled."
	default:
		e.job.State = Failed
		e.job.Error = err.Error()
	}
	for i := range e.job.Steps {
		switch e.job.Steps[i].State {
		case Running:
			if e.job.State == Succeeded {
				e.job.Steps[i].State = Succeeded
			} else {
				e.job.Steps[i].State = Failed
			}
		case Pending:
			if e.job.State == Succeeded {
				e.job.Steps[i].State = Succeeded
			} else {
				e.job.Steps[i].State = Skipped
			}
		}
	}
	j := e.job.clone()
	m.mu.Unlock()
	m.publish(j)
}

// prune drops the oldest finished jobs. Callers hold m.mu.
func (m *Manager) prune() {
	var done []*entry
	cutoff := m.now().Add(-m.keep)
	for id, e := range m.jobs {
		if e.job.State == Running {
			continue
		}
		if e.job.EndedAt != nil && e.job.EndedAt.Before(cutoff) {
			delete(m.jobs, id)
			continue
		}
		done = append(done, e)
	}
	if len(done) <= m.maxDone {
		return
	}
	sort.Slice(done, func(a, b int) bool { return done[a].job.StartedAt.Before(done[b].job.StartedAt) })
	for _, e := range done[:len(done)-m.maxDone] {
		delete(m.jobs, e.job.ID)
	}
}

// Get returns one job.
func (m *Manager) Get(id string) (Job, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.jobs[id]
	if !ok {
		return Job{}, false
	}
	return e.job.clone(), true
}

// List returns every job, newest first.
func (m *Manager) List() []Job {
	m.mu.Lock()
	m.prune()
	out := make([]Job, 0, len(m.jobs))
	for _, e := range m.jobs {
		out = append(out, e.job.clone())
	}
	m.mu.Unlock()
	sort.Slice(out, func(a, b int) bool { return out[a].StartedAt.After(out[b].StartedAt) })
	return out
}

// Cancel asks a running job to stop. A finished job is left as it is.
func (m *Manager) Cancel(id string) error {
	m.mu.Lock()
	e, ok := m.jobs[id]
	m.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	e.cancel()
	return nil
}

// Wait blocks until the job ends or ctx is done, and returns it.
func (m *Manager) Wait(ctx context.Context, id string) (Job, error) {
	m.mu.Lock()
	e, ok := m.jobs[id]
	m.mu.Unlock()
	if !ok {
		return Job{}, ErrNotFound
	}
	select {
	case <-e.done:
	case <-ctx.Done():
		return Job{}, ctx.Err()
	}
	j, _ := m.Get(id)
	return j, nil
}

// Subscribe returns every change to every job until ctx is done. A slow
// reader misses intermediate changes, never the last one of a job: the
// channel holds the latest copy of each job not yet read.
func (m *Manager) Subscribe(ctx context.Context) <-chan Job {
	in := make(chan Job, 64)
	m.mu.Lock()
	m.subs[in] = struct{}{}
	m.mu.Unlock()
	out := make(chan Job)
	go func() {
		defer close(out)
		defer func() {
			m.mu.Lock()
			delete(m.subs, in)
			m.mu.Unlock()
		}()
		var queue []Job // latest copy per job, in order of first change
		for {
			var send chan Job
			var next Job
			if len(queue) > 0 {
				send, next = out, queue[0]
			}
			select {
			case <-ctx.Done():
				return
			case j := <-in:
				replaced := false
				for i := range queue {
					if queue[i].ID == j.ID {
						queue[i], replaced = j, true
						break
					}
				}
				if !replaced {
					queue = append(queue, j)
				}
			case send <- next:
				queue = queue[1:]
			}
		}
	}()
	return out
}

func (m *Manager) publish(j Job) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for c := range m.subs {
		select {
		case c <- j:
		default: // the subscriber's goroutine keeps up; never block a job
		}
	}
}

func (j *Job) clone() Job {
	c := *j
	c.Steps = append([]Step(nil), j.Steps...)
	c.Output = append([]string{}, j.Output...)
	if j.EndedAt != nil {
		t := *j.EndedAt
		c.EndedAt = &t
	}
	return c
}

func (j *Job) appendOutput(line string) {
	j.Output = append(j.Output, strings.TrimRight(line, "\r"))
	if over := len(j.Output) - MaxOutput; over > 0 {
		j.Output = append([]string(nil), j.Output[over:]...)
	}
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Run is the job's handle for reporting progress.
type Run struct {
	m *Manager
	e *entry

	mu      sync.Mutex
	pending bool // a change waits to be published
	timer   *time.Timer
}

// ID is the job's id.
func (r *Run) ID() string { return r.e.job.ID }

// Step marks the named step running, and the steps before it that are
// still running as succeeded. A name not in the spec is added.
func (r *Run) Step(name string) {
	r.update(func(j *Job) {
		found := -1
		for i := range j.Steps {
			if j.Steps[i].Name == name {
				found = i
				break
			}
		}
		if found < 0 {
			j.Steps = append(j.Steps, Step{Name: name, State: Pending})
			found = len(j.Steps) - 1
		}
		for i := range j.Steps {
			if i < found && (j.Steps[i].State == Running || j.Steps[i].State == Pending) {
				if j.Steps[i].State == Running {
					j.Steps[i].State = Succeeded
				} else {
					j.Steps[i].State = Skipped
				}
			}
		}
		j.Steps[found].State = Running
	}, true)
}

// Skip marks a step skipped, such as a download that was not needed.
func (r *Run) Skip(name string) {
	r.update(func(j *Job) {
		for i := range j.Steps {
			if j.Steps[i].Name == name && j.Steps[i].State == Pending {
				j.Steps[i].State = Skipped
			}
		}
	}, true)
}

// Logf adds one line of output.
func (r *Run) Logf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	r.update(func(j *Job) {
		for _, l := range strings.Split(line, "\n") {
			j.appendOutput(l)
		}
	}, false)
}

// Write adds output; it makes Run an io.Writer for a command's stdout and
// stderr. Lines appear when they end.
func (r *Run) Write(p []byte) (int, error) {
	n := len(p)
	r.update(func(j *Job) {
		buf := append(append([]byte(nil), r.e.partial...), p...)
		for {
			i := bytes.IndexByte(buf, '\n')
			if i < 0 {
				break
			}
			j.appendOutput(stripANSI(string(buf[:i])))
			buf = buf[i+1:]
		}
		if len(buf) > 4096 { // a progress bar without newlines
			j.appendOutput(stripANSI(string(buf)))
			buf = nil
		}
		r.e.partial = append([]byte(nil), buf...)
	}, false)
	return n, nil
}

// SetResult attaches a value the UI reads when the job succeeds.
func (r *Run) SetResult(v any) {
	r.update(func(j *Job) { j.Result = v }, true)
}

// update changes the job and publishes it: at once for steps, and at most
// four times a second for output.
func (r *Run) update(fn func(*Job), now bool) {
	r.m.mu.Lock()
	fn(&r.e.job)
	r.m.mu.Unlock()
	if now {
		r.flush()
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.pending {
		return
	}
	r.pending = true
	r.timer = time.AfterFunc(250*time.Millisecond, r.flush)
}

func (r *Run) flush() {
	r.mu.Lock()
	r.pending = false
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
	r.mu.Unlock()
	r.m.mu.Lock()
	j := r.e.job.clone()
	r.m.mu.Unlock()
	r.m.publish(j)
}

// isST reports whether s[i:] starts with the string terminator: ESC and a backslash.
func isST(s string, i int) bool { return s[i] == 0x1b && i+1 < len(s) && s[i+1] == '\\' }

// stripANSI removes terminal colour and cursor sequences.
func stripANSI(s string) string {
	if !strings.ContainsRune(s, 0x1b) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != 0x1b {
			b.WriteByte(s[i])
			continue
		}
		if i+1 < len(s) && s[i+1] == '[' {
			i += 2
			for i < len(s) && (s[i] < 0x40 || s[i] > 0x7e) {
				i++
			}
			continue
		}
		if i+1 < len(s) && s[i+1] == ']' { // OSC: up to BEL or ST
			i += 2
			for i < len(s) && s[i] != 0x07 && !isST(s, i) {
				i++
			}
			if i < len(s) && s[i] == 0x1b {
				i++
			}
			continue
		}
		i++ // a two-byte escape
	}
	return b.String()
}
