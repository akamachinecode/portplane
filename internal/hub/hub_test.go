package hub

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/akamachinecode/portplane/internal/model"
)

type chanAgent struct {
	ch       chan model.MachineSnapshot
	mu       sync.Mutex
	interval time.Duration
	closed   bool
}

func (a *chanAgent) Snapshot(context.Context) (model.MachineSnapshot, error) {
	return model.MachineSnapshot{}, nil
}
func (a *chanAgent) Watch(context.Context) <-chan model.MachineSnapshot { return a.ch }
func (a *chanAgent) Act(context.Context, model.Target, model.Verb) error { return nil }
func (a *chanAgent) Up(context.Context, string) error                  { return nil }
func (a *chanAgent) Excerpt(context.Context, string, string) (model.Excerpt, error) {
	return model.Excerpt{}, nil
}
func (a *chanAgent) SetFolders(context.Context, []string) error  { return nil }
func (a *chanAgent) Dial(context.Context, int) (net.Conn, error) { return nil, errors.New("no") }
func (a *chanAgent) Close() error {
	a.mu.Lock()
	a.closed = true
	a.mu.Unlock()
	return nil
}
func (a *chanAgent) SetInterval(d time.Duration) {
	a.mu.Lock()
	a.interval = d
	a.mu.Unlock()
}

func recv(t *testing.T, c <-chan model.Snapshot) model.Snapshot {
	t.Helper()
	select {
	case s := <-c:
		return s
	case <-time.After(2 * time.Second):
		t.Fatal("no snapshot")
	}
	return model.Snapshot{}
}

func TestHubMergesAndPaces(t *testing.T) {
	h := New()
	a := &chanAgent{ch: make(chan model.MachineSnapshot, 1)}
	h.Add("local", a, model.Machine{Local: true})
	ctx, cancel := context.WithCancel(context.Background())
	sub := h.Subscribe(ctx)

	first := recv(t, sub)
	if len(first.Machines) != 1 || first.Machines[0].Machine.Status != "connecting" {
		t.Fatalf("placeholder: %+v", first)
	}
	a.mu.Lock()
	if a.interval != ActiveInterval {
		t.Fatalf("a subscriber should make agents active, got %v", a.interval)
	}
	a.mu.Unlock()

	a.ch <- model.MachineSnapshot{Machine: model.Machine{Status: "online"}, Apps: []model.App{{ID: "x"}}}
	got := recv(t, sub)
	if got.Machines[0].Machine.ID != "local" || len(got.Machines[0].Apps) != 1 || got.Version <= first.Version {
		t.Fatalf("update: %+v", got)
	}
	if _, err := h.Agent("nope"); err == nil {
		t.Fatal("unknown machine")
	}

	cancel()
	deadline := time.Now().Add(2 * time.Second)
	for {
		a.mu.Lock()
		idle := a.interval == IdleInterval
		a.mu.Unlock()
		if idle {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("agents should go idle without subscribers")
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.Remove("local")
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.closed {
		t.Fatal("removed agents are closed")
	}
}
