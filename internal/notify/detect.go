package notify

import (
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/window"
)

// Tracker turns successive snapshots into notifications: it remembers each
// app's last state and reports the changes worth a notification.
type Tracker struct {
	seeded bool
	apps   map[string]seen // by machine id + "|" + app id
}

type seen struct {
	state model.State
}

// Update compares s with the snapshot before and returns what changed. The
// first snapshot only sets the baseline: nothing that was already broken
// when Portplane started notifies.
func (t *Tracker) Update(s model.Snapshot) []Notification {
	next := map[string]seen{}
	var out []Notification
	for _, ms := range s.Machines {
		m := ms.Machine
		// A machine that is not online reports no apps: keep what it had,
		// so its return is not mistaken for every app starting.
		if !m.Local && m.Status != "online" {
			for k, v := range t.apps {
				if strings.HasPrefix(k, m.ID+"|") {
					next[k] = v
				}
			}
			continue
		}
		for _, a := range ms.Apps {
			key := m.ID + "|" + a.ID
			next[key] = seen{state: a.State}
			prev, ok := t.apps[key]
			if !t.seeded || !ok || prev.state == a.State {
				continue
			}
			if n, ok := transition(ms, a, prev.state); ok {
				out = append(out, n)
			}
		}
	}
	t.apps = next
	t.seeded = true
	return out
}

func transition(ms model.MachineSnapshot, a model.App, before model.State) (Notification, bool) {
	where := place(ms, a)
	id := "app|" + ms.Machine.ID + "|" + a.ID
	route := window.AppRoute(ms.Machine.ID, a.ID)
	switch {
	case a.State == model.StateFailed && before != model.StateFailed:
		title := a.Label + " failed"
		switch {
		case a.Kind == "job":
			title = a.Label + " failed in " + a.Project
		case before == model.StateOn || before == model.StateStopping:
			title = a.Label + " crashed"
		case before == model.StateStarting:
			title = a.Label + " didn't start"
		}
		body := where
		if a.Detail != "" {
			body += ": " + a.Detail
		}
		return Notification{ID: id, Kind: KindFailure, Title: title, Body: body, Route: route}, true
	case before == model.StateFailed && a.State == model.StateOn:
		return Notification{ID: id, Kind: KindRecovery, Title: a.Label + " is running again", Body: where, Route: route}, true
	}
	return Notification{}, false
}

// place is "my-monorepo (checkout) · box": the project, its worktree, and
// the machine when it is not this computer.
func place(ms model.MachineSnapshot, a model.App) string {
	s := a.Project
	if a.Worktree != "" {
		s += " (" + a.Worktree + ")"
	}
	if !ms.Machine.Local {
		s += " · " + ms.Machine.Name
	}
	return s
}

// JobTracker notifies each job's end once.
type JobTracker struct {
	done map[string]bool
}

// Update returns the notification for a job that just ended, if any. A
// cancelled job says nothing: the user cancelled it.
func (t *JobTracker) Update(j jobs.Job) (Notification, bool) {
	if !j.Done() || j.State == jobs.Cancelled {
		return Notification{}, false
	}
	if t.done == nil {
		t.done = map[string]bool{}
	}
	if t.done[j.ID] {
		return Notification{}, false
	}
	t.done[j.ID] = true
	if j.State == jobs.Failed {
		body := j.Error
		if body == "" {
			body = "Open Portplane to see what happened."
		}
		return Notification{ID: "job|" + j.ID, Kind: KindFailure, Title: j.Title + " failed", Body: body}, true
	}
	return Notification{ID: "job|" + j.ID, Kind: KindJob, Title: j.Title + ": done", Body: "Finished successfully."}, true
}

// Limiter holds back a notification whose ID was shown less than Window
// ago, so an app that keeps crashing does not flood the screen.
type Limiter struct {
	Window time.Duration
	last   map[string]time.Time
}

// Allow reports whether n may show at now, and records it if so.
func (l *Limiter) Allow(n Notification, now time.Time) bool {
	if l.last == nil {
		l.last = map[string]time.Time{}
	}
	key := n.ID + "|" + string(n.Kind)
	if t, ok := l.last[key]; ok && now.Sub(t) < l.Window {
		return false
	}
	l.last[key] = now
	for k, t := range l.last { // forget old entries
		if now.Sub(t) > 4*l.Window {
			delete(l.last, k)
		}
	}
	return true
}
