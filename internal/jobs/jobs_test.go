package jobs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

func wait(t *testing.T, m *Manager, id string) Job {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	j, err := m.Wait(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func TestSucceeds(t *testing.T) {
	m := NewManager()
	j := m.Start(Spec{Kind: "install", Title: "Install dekit", Steps: []string{"Download", "Verify", "Install"}}, func(ctx context.Context, r *Run) error {
		r.Step("Download")
		r.Logf("got %d bytes", 42)
		r.Step("Install") // Verify was never reached
		_, _ = io.WriteString(r, "line one\nline two\npartial")
		r.SetResult(map[string]string{"version": "0.10.3"})
		return nil
	})
	if j.State != Running || len(j.Steps) != 3 || j.Steps[0].State != Pending {
		t.Fatalf("start: %+v", j)
	}
	j = wait(t, m, j.ID)
	if j.State != Succeeded || j.EndedAt == nil {
		t.Fatalf("state %s", j.State)
	}
	want := []State{Succeeded, Skipped, Succeeded}
	for i, s := range j.Steps {
		if s.State != want[i] {
			t.Errorf("step %s: %s, want %s", s.Name, s.State, want[i])
		}
	}
	if got := strings.Join(j.Output, "|"); got != "got 42 bytes|line one|line two|partial" {
		t.Errorf("output %q", got)
	}
	if j.Result == nil {
		t.Error("no result")
	}
}

func TestFailsAndCancels(t *testing.T) {
	m := NewManager()
	j := m.Start(Spec{Steps: []string{"A", "B"}}, func(ctx context.Context, r *Run) error {
		r.Step("A")
		return errors.New("checksum mismatch")
	})
	j = wait(t, m, j.ID)
	if j.State != Failed || j.Error != "checksum mismatch" || j.Steps[0].State != Failed || j.Steps[1].State != Skipped {
		t.Fatalf("failed job: %+v", j)
	}

	started := make(chan struct{})
	j = m.Start(Spec{}, func(ctx context.Context, r *Run) error {
		close(started)
		<-ctx.Done()
		return fmt.Errorf("download: %w", ctx.Err())
	})
	<-started
	if err := m.Cancel(j.ID); err != nil {
		t.Fatal(err)
	}
	if j = wait(t, m, j.ID); j.State != Cancelled {
		t.Fatalf("cancelled job: %s", j.State)
	}
	if err := m.Cancel("nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cancel unknown: %v", err)
	}
}

func TestPanicFails(t *testing.T) {
	m := NewManager()
	j := m.Start(Spec{}, func(context.Context, *Run) error { panic("boom") })
	if j = wait(t, m, j.ID); j.State != Failed || !strings.Contains(j.Error, "boom") {
		t.Fatalf("%+v", j)
	}
}

func TestKeyReturnsRunningJob(t *testing.T) {
	m := NewManager()
	release := make(chan struct{})
	a := m.Start(Spec{Key: "install:dekit"}, func(ctx context.Context, r *Run) error { <-release; return nil })
	b := m.Start(Spec{Key: "install:dekit"}, func(ctx context.Context, r *Run) error { t.Error("second job ran"); return nil })
	if a.ID != b.ID {
		t.Fatal("same key started a second job")
	}
	close(release)
	wait(t, m, a.ID)
	c := m.Start(Spec{Key: "install:dekit"}, func(ctx context.Context, r *Run) error { return nil })
	if c.ID == a.ID {
		t.Fatal("a finished job blocked a new one")
	}
	wait(t, m, c.ID)
}

func TestSubscribeSeesTheEnd(t *testing.T) {
	m := NewManager()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	updates := m.Subscribe(ctx)
	j := m.Start(Spec{Steps: []string{"A"}}, func(ctx context.Context, r *Run) error {
		for i := 0; i < 1000; i++ {
			r.Logf("line %d", i)
		}
		return nil
	})
	deadline := time.After(5 * time.Second)
	for {
		select {
		case u := <-updates:
			if u.ID == j.ID && u.State == Succeeded {
				if len(u.Output) != MaxOutput || u.Output[MaxOutput-1] != "line 999" {
					t.Fatalf("output kept %d lines, last %q", len(u.Output), u.Output[len(u.Output)-1])
				}
				return
			}
		case <-deadline:
			t.Fatal("never saw the job succeed")
		}
	}
}

func TestPruneKeepsRecent(t *testing.T) {
	m := NewManager()
	m.maxDone = 2
	var ids []string
	for i := 0; i < 4; i++ {
		j := m.Start(Spec{Title: fmt.Sprint(i)}, func(context.Context, *Run) error { return nil })
		wait(t, m, j.ID)
		ids = append(ids, j.ID)
		time.Sleep(2 * time.Millisecond)
	}
	list := m.List()
	if len(list) != 2 || list[0].ID != ids[3] || list[1].ID != ids[2] {
		t.Fatalf("kept %v", list)
	}
}

func TestStripANSI(t *testing.T) {
	for in, want := range map[string]string{
		"\x1b[32mok\x1b[0m":        "ok",
		"plain":                    "plain",
		"\x1b]8;;http://x\x07link": "link",
		"a\x1b[2Kb":                "ab",
	} {
		if got := stripANSI(in); got != want {
			t.Errorf("stripANSI(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMachineStampsJobs(t *testing.T) {
	m := NewManager()
	m.SetMachine("box")
	j := m.Start(Spec{Title: "Upgrade"}, func(context.Context, *Run) error { return nil })
	if !strings.HasPrefix(j.ID, "box:") || j.Machine != "box" {
		t.Fatalf("%+v", j)
	}
	if got := wait(t, m, j.ID); got.Machine != "box" {
		t.Fatalf("%+v", got)
	}
}

func TestMirror(t *testing.T) {
	m := NewManager()
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	updates := m.Subscribe(ctx)
	local := m.Start(Spec{Title: "Local", Steps: []string{"A"}}, func(ctx context.Context, _ *Run) error {
		<-ctx.Done()
		return ctx.Err()
	})
	cancelled := make(chan struct{}, 1)
	running := Job{ID: "box:1", Title: "Install dekit", State: Running, Machine: "box", Steps: []Step{{Name: "Download", State: Running}, {Name: "Install", State: Pending}}, Output: []string{"downloading"}}
	m.Mirror(running, func() { cancelled <- struct{}{} })
	if j, ok := m.Get("box:1"); !ok || j.State != Running || j.Machine != "box" {
		t.Fatalf("mirrored: %+v %v", j, ok)
	}
	// A mirror never replaces a local job.
	m.Mirror(Job{ID: local.ID, State: Succeeded}, nil)
	if j, _ := m.Get(local.ID); j.State != Running {
		t.Fatalf("a remote job replaced a local one: %+v", j)
	}
	// Cancelling asks the machine.
	if err := m.Cancel("box:1"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("cancel did not reach the machine")
	}
	// The connection drops: the job ends as failed, and stays so.
	m.Abandon("box", "The connection to box dropped.")
	j, _ := m.Get("box:1")
	if j.State != Failed || j.Error != "The connection to box dropped." || j.Steps[0].State != Failed || j.Steps[1].State != Skipped || j.EndedAt == nil {
		t.Fatalf("abandoned: %+v", j)
	}
	m.Mirror(Job{ID: "box:1", State: Succeeded, Machine: "box"}, nil)
	if j, _ := m.Get("box:1"); j.State != Failed {
		t.Fatalf("a finished job changed: %+v", j)
	}
	if got, err := m.Wait(ctx, "box:1"); err != nil || got.State != Failed {
		t.Fatalf("wait: %+v %v", got, err)
	}
	// Subscribers see the remote job like a local one (the latest copy).
	seen := map[State]bool{}
	timeout := time.After(time.Second)
	for !seen[Failed] {
		select {
		case u := <-updates:
			if u.ID == "box:1" {
				seen[u.State] = true
			}
		case <-timeout:
			t.Fatalf("updates: %v", seen)
		}
	}
	_ = m.Cancel(local.ID)
}
