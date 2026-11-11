// Package hub merges every machine's agent into one view and routes actions
// to the right agent (ADR-0005).
package hub

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/akamachinecode/portplane/internal/agent"
	"github.com/akamachinecode/portplane/internal/model"
)

// Pacer is implemented by agents whose collection rate can change: fast
// while someone looks at the UI, slow otherwise.
type Pacer interface {
	SetInterval(d time.Duration)
}

// Intervals between collections.
const (
	ActiveInterval = 2 * time.Second
	IdleInterval   = 15 * time.Second
)

// Hub holds the agents and the merged snapshot.
type Hub struct {
	mu      sync.Mutex
	agents  map[string]*entry
	order   []string
	version uint64
	subs    map[chan model.Snapshot]struct{}
	paceMu  sync.Mutex // serialises pacing decisions
}

type entry struct {
	agent  agent.Agent
	snap   model.MachineSnapshot
	cancel context.CancelFunc
}

// New returns an empty hub.
func New() *Hub {
	return &Hub{agents: map[string]*entry{}, subs: map[chan model.Snapshot]struct{}{}}
}

// Add registers an agent under id and starts following it. A placeholder
// snapshot marks the machine as connecting until the agent reports.
func (h *Hub) Add(id string, a agent.Agent, placeholder model.Machine) {
	ctx, cancel := context.WithCancel(context.Background())
	if placeholder.ID == "" {
		placeholder.ID = id
	}
	if placeholder.Status == "" {
		placeholder.Status = "connecting"
	}
	h.mu.Lock()
	if old, ok := h.agents[id]; ok {
		old.cancel()
		_ = old.agent.Close()
	} else {
		h.order = append(h.order, id)
	}
	h.agents[id] = &entry{agent: a, cancel: cancel, snap: emptySnapshot(placeholder)}
	h.mu.Unlock()
	h.repace()
	h.publish()
	go func() {
		for s := range a.Watch(ctx) {
			h.update(id, a, s)
		}
	}()
}

func emptySnapshot(m model.Machine) model.MachineSnapshot {
	return model.MachineSnapshot{Machine: m, Folders: []string{}, Runners: []model.Runner{}, Apps: []model.App{}, OtherPorts: []model.Port{}, Projects: []model.Project{}}
}

// Remove stops and forgets an agent.
func (h *Hub) Remove(id string) {
	h.mu.Lock()
	e, ok := h.agents[id]
	if ok {
		delete(h.agents, id)
		for i, o := range h.order {
			if o == id {
				h.order = append(h.order[:i], h.order[i+1:]...)
				break
			}
		}
	}
	h.mu.Unlock()
	if ok {
		e.cancel()
		_ = e.agent.Close()
		h.publish()
	}
}

func (h *Hub) update(id string, a agent.Agent, s model.MachineSnapshot) {
	h.mu.Lock()
	e, ok := h.agents[id]
	if !ok || e.agent != a {
		h.mu.Unlock()
		return
	}
	s.Machine.ID = id
	e.snap = s
	h.mu.Unlock()
	h.publish()
}

// Agent returns the agent for a machine.
func (h *Hub) Agent(id string) (agent.Agent, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	e, ok := h.agents[id]
	if !ok {
		return nil, fmt.Errorf("unknown machine %q", id)
	}
	return e.agent, nil
}

// Snapshot returns the merged view.
func (h *Hub) Snapshot() model.Snapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.snapshotLocked()
}

func (h *Hub) snapshotLocked() model.Snapshot {
	out := model.Snapshot{Version: h.version, Machines: make([]model.MachineSnapshot, 0, len(h.order))}
	for _, id := range h.order {
		out.Machines = append(out.Machines, h.agents[id].snap)
	}
	return out
}

func (h *Hub) publish() {
	h.mu.Lock()
	h.version++
	s := h.snapshotLocked()
	subs := make([]chan model.Snapshot, 0, len(h.subs))
	for c := range h.subs {
		subs = append(subs, c)
	}
	h.mu.Unlock()
	for _, c := range subs {
		select {
		case c <- s:
		default:
			select {
			case <-c:
			default:
			}
			select {
			case c <- s:
			default:
			}
		}
	}
}

// Subscribe delivers the merged snapshot now and on every change until ctx
// ends. While anyone is subscribed, agents collect at the active rate.
func (h *Hub) Subscribe(ctx context.Context) <-chan model.Snapshot {
	c := make(chan model.Snapshot, 1)
	h.mu.Lock()
	h.subs[c] = struct{}{}
	c <- h.snapshotLocked()
	h.mu.Unlock()
	h.repace()
	go func() {
		<-ctx.Done()
		h.mu.Lock()
		delete(h.subs, c)
		h.mu.Unlock()
		h.repace()
	}()
	return c
}

// repace sets every agent's rate from the subscribers present now. Calls are
// serialised, so a late "idle" can never undo a newer "active".
func (h *Hub) repace() {
	h.paceMu.Lock()
	defer h.paceMu.Unlock()
	h.mu.Lock()
	active := len(h.subs) > 0
	h.mu.Unlock()
	h.paceAll(active)
}

func (h *Hub) paceAll(active bool) {
	h.mu.Lock()
	var as []agent.Agent
	for _, e := range h.agents {
		as = append(as, e.agent)
	}
	h.mu.Unlock()
	for _, a := range as {
		h.pace(a, active)
	}
}

func (h *Hub) pace(a agent.Agent, active bool) {
	p, ok := a.(Pacer)
	if !ok {
		return
	}
	if active {
		p.SetInterval(ActiveInterval)
	} else {
		p.SetInterval(IdleInterval)
	}
}

// Close stops every agent.
func (h *Hub) Close() {
	h.mu.Lock()
	ids := append([]string(nil), h.order...)
	h.mu.Unlock()
	for _, id := range ids {
		h.Remove(id)
	}
}
