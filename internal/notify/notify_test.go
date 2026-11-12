package notify

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/settings"
)

func local(apps ...model.App) model.MachineSnapshot {
	return model.MachineSnapshot{Machine: model.Machine{ID: "local", Name: "This computer", Local: true, Status: "online"}, Apps: apps}
}

func remote(status string, apps ...model.App) model.MachineSnapshot {
	return model.MachineSnapshot{Machine: model.Machine{ID: "box", Name: "box", Status: status}, Apps: apps}
}

func app(task string, state model.State) model.App {
	return model.App{ID: "/home/dev/code#" + task, Task: task, Label: task, Kind: "service", Project: "my-monorepo", State: state}
}

func snap(ms ...model.MachineSnapshot) model.Snapshot { return model.Snapshot{Machines: ms} }

func titles(ns []Notification) []string {
	var out []string
	for _, n := range ns {
		out = append(out, string(n.Kind)+": "+n.Title)
	}
	return out
}

func TestTrackerTransitions(t *testing.T) {
	var tr Tracker
	// Already failed at start: the baseline, no notification.
	if got := tr.Update(snap(local(app("web", model.StateOn), app("api", model.StateFailed), app("docs", model.StateStarting)))); len(got) != 0 {
		t.Fatalf("baseline notified %v", titles(got))
	}
	got := tr.Update(snap(local(app("web", model.StateFailed), app("api", model.StateOn), app("docs", model.StateFailed))))
	want := []string{"failure: web crashed", "recovery: api is running again", "failure: docs didn't start"}
	if !reflect.DeepEqual(titles(got), want) {
		t.Fatalf("got %v, want %v", titles(got), want)
	}
	if got[0].Route != "#/apps/local/%2Fhome%2Fdev%2Fcode%23web" || got[0].ID != "app|local|/home/dev/code#web" {
		t.Fatalf("route %q id %q", got[0].Route, got[0].ID)
	}
	// Nothing changed: nothing to say.
	if got := tr.Update(snap(local(app("web", model.StateFailed), app("api", model.StateOn), app("docs", model.StateFailed)))); len(got) != 0 {
		t.Fatalf("repeat notified %v", titles(got))
	}
	// A stop by the user is not a failure; starting is not a recovery.
	if got := tr.Update(snap(local(app("web", model.StateStarting), app("api", model.StateOff), app("docs", model.StateFailed)))); len(got) != 0 {
		t.Fatalf("stop/start notified %v", titles(got))
	}
}

func TestTrackerDetailJobsAndNewApps(t *testing.T) {
	var tr Tracker
	install := app("install", model.StateStarting)
	install.Kind = "job"
	tr.Update(snap(local(install)))
	install.State = model.StateFailed
	install.Detail = "exit code 1"
	added := app("new", model.StateFailed) // appeared failed after a reload: no history, no notification
	got := tr.Update(snap(local(install, added)))
	if !reflect.DeepEqual(titles(got), []string{"failure: install failed in my-monorepo"}) || got[0].Body != "my-monorepo: exit code 1" {
		t.Fatalf("got %v %q", titles(got), got[0].Body)
	}
}

func TestTrackerRemoteOffline(t *testing.T) {
	var tr Tracker
	web := app("web", model.StateOn)
	web.Worktree = "checkout"
	tr.Update(snap(remote("online", web)))
	// Offline: no apps reported, nothing notified, history kept.
	if got := tr.Update(snap(remote("offline"))); len(got) != 0 {
		t.Fatalf("offline notified %v", titles(got))
	}
	web.State = model.StateFailed
	got := tr.Update(snap(remote("online", web)))
	if !reflect.DeepEqual(titles(got), []string{"failure: web crashed"}) || got[0].Body != "my-monorepo (checkout) · box" {
		t.Fatalf("got %v %q", titles(got), got)
	}
}

func TestJobTracker(t *testing.T) {
	var jt JobTracker
	if _, ok := jt.Update(jobs.Job{ID: "a", Title: "Install dekit", State: jobs.Running}); ok {
		t.Fatal("running job notified")
	}
	n, ok := jt.Update(jobs.Job{ID: "a", Title: "Install dekit", State: jobs.Succeeded})
	if !ok || n.Kind != KindJob || n.Title != "Install dekit: done" {
		t.Fatalf("%+v %v", n, ok)
	}
	if _, ok := jt.Update(jobs.Job{ID: "a", Title: "Install dekit", State: jobs.Succeeded}); ok {
		t.Fatal("same end notified twice")
	}
	n, ok = jt.Update(jobs.Job{ID: "b", Title: "Install portless", State: jobs.Failed, Error: "npm exited with code 1"})
	if !ok || n.Kind != KindFailure || n.Body != "npm exited with code 1" {
		t.Fatalf("%+v %v", n, ok)
	}
	if _, ok := jt.Update(jobs.Job{ID: "c", State: jobs.Cancelled}); ok {
		t.Fatal("cancelled job notified")
	}
}

func TestLimiter(t *testing.T) {
	l := Limiter{Window: time.Minute}
	t0 := time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC)
	n := Notification{ID: "app|local|x", Kind: KindFailure}
	if !l.Allow(n, t0) || l.Allow(n, t0.Add(30*time.Second)) || !l.Allow(n, t0.Add(61*time.Second)) {
		t.Fatal("limiter window")
	}
	if !l.Allow(Notification{ID: "app|local|x", Kind: KindRecovery}, t0.Add(62*time.Second)) {
		t.Fatal("a recovery is not a repeat of the failure")
	}
}

func TestEnabled(t *testing.T) {
	p := settings.Notifications{Failures: true}
	if !Enabled(p, KindFailure) || Enabled(p, KindRecovery) || Enabled(p, KindJob) || Enabled(p, KindConfig) || Enabled(p, "other") {
		t.Fatal("Enabled")
	}
}

func TestConfigWatch(t *testing.T) {
	times := map[string]time.Time{"/code/dekit.yaml": time.Unix(1, 0), "/code/.portplane/tasks.yaml": time.Unix(1, 0)}
	w := &ConfigWatch{
		Files: func(root string) []string { return []string{root + "/dekit.yaml", root + "/.portplane/tasks.yaml"} },
		Stat: func(p string) (time.Time, bool) {
			t, ok := times[p]
			return t, ok
		},
	}
	ms := local()
	ms.Runners = []model.Runner{{Root: "/code", Name: "code", Up: true}, {Root: "/down", Name: "down"}}
	if got := w.Check(ms); len(got) != 0 {
		t.Fatalf("first look notified %v", titles(got))
	}
	if got := w.Check(ms); len(got) != 0 {
		t.Fatalf("no change notified %v", titles(got))
	}
	times["/code/.portplane/tasks.yaml"] = time.Unix(2, 0)
	got := w.Check(ms)
	if !reflect.DeepEqual(titles(got), []string{"config: dekit.yaml changed in code"}) || got[0].Route != "#/projects/local/%2Fcode" {
		t.Fatalf("got %v", got)
	}
	if got := w.Check(ms); len(got) != 0 {
		t.Fatalf("same change notified twice: %v", titles(got))
	}
	// Other machines' files are not this computer's to read.
	if got := w.Check(remote("online")); got != nil {
		t.Fatal("remote checked")
	}
}

type fakeSender struct {
	mu   sync.Mutex
	sent []Notification
	err  error
}

func (f *fakeSender) Send(_ context.Context, n Notification) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, n)
	return f.err
}

func (f *fakeSender) Close() error { return nil }

func (f *fakeSender) titles() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return titles(f.sent)
}

func TestWatchFollowsPreferences(t *testing.T) {
	snaps := make(chan model.Snapshot)
	jobCh := make(chan jobs.Job)
	var mu sync.Mutex
	prefs := settings.Notifications{Failures: true}
	s := &fakeSender{err: errors.New("no notification daemon")}
	var reported int
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		Watch(ctx, WatchOptions{
			Snapshots: snaps,
			Jobs:      jobCh,
			Prefs: func() settings.Notifications {
				mu.Lock()
				defer mu.Unlock()
				return prefs
			},
			Sender: s,
			Report: func(error) { reported++ },
		})
	}()
	snaps <- snap(local(app("web", model.StateOn)))
	snaps <- snap(local(app("web", model.StateFailed)))
	snaps <- snap(local(app("web", model.StateOn))) // recoveries are off
	jobCh <- jobs.Job{ID: "j", Title: "Install dekit", State: jobs.Succeeded}
	snaps <- snap(local(app("web", model.StateOn))) // the job has been handled once this is taken
	mu.Lock()
	prefs.Jobs = true
	mu.Unlock()
	jobCh <- jobs.Job{ID: "k", Title: "Install portless", State: jobs.Succeeded}
	snaps <- snap(local(app("web", model.StateFailed))) // within the repeat window
	snaps <- snap(local(app("web", model.StateFailed)))
	cancel()
	<-done
	if got, want := s.titles(), []string{"failure: web crashed", "job: Install portless: done"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sent %v, want %v", got, want)
	}
	if reported != 2 {
		t.Fatalf("reported %d errors, want 2", reported)
	}
}
