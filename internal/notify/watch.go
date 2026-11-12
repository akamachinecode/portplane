package notify

import (
	"context"
	"time"

	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/settings"
)

// WatchOptions say what Watch follows and where notifications go.
type WatchOptions struct {
	Snapshots <-chan model.Snapshot
	Jobs      <-chan jobs.Job // may be nil
	// Prefs returns the user's notification switches, read at each
	// notification so a change applies at once.
	Prefs  func() settings.Notifications
	Sender Sender
	// Config watches dekit files; nil turns the "config changed" kind off.
	// Snapshots only come when something changes, so the files are also
	// looked at every ConfigEvery (default 5 seconds).
	Config      *ConfigWatch
	ConfigEvery time.Duration
	// Repeat is how long a repeat of the same notification is held back
	// (default 2 minutes).
	Repeat time.Duration
	Now    func() time.Time
	Report func(error)
}

// Watch shows notifications until ctx ends.
func Watch(ctx context.Context, o WatchOptions) {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Repeat == 0 {
		o.Repeat = 2 * time.Minute
	}
	if o.ConfigEvery == 0 {
		o.ConfigEvery = 5 * time.Second
	}
	var (
		apps    Tracker
		jobList JobTracker
		limit   = Limiter{Window: o.Repeat}
		last    model.Snapshot
	)
	var tick <-chan time.Time
	if o.Config != nil {
		t := time.NewTicker(o.ConfigEvery)
		defer t.Stop()
		tick = t.C
	}
	configs := func() []Notification {
		if o.Config == nil || !o.Prefs().Config {
			return nil
		}
		var ns []Notification
		for _, ms := range last.Machines {
			ns = append(ns, o.Config.Check(ms)...)
		}
		return ns
	}
	send := func(ns []Notification) {
		if len(ns) == 0 {
			return
		}
		prefs := o.Prefs()
		for _, n := range ns {
			if !Enabled(prefs, n.Kind) || !limit.Allow(n, o.Now()) {
				continue
			}
			sctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := o.Sender.Send(sctx, n)
			cancel()
			if err != nil && o.Report != nil {
				o.Report(err)
			}
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case s, ok := <-o.Snapshots:
			if !ok {
				return
			}
			last = s
			send(append(apps.Update(s), configs()...))
		case <-tick:
			send(configs())
		case j, ok := <-o.Jobs:
			if !ok {
				o.Jobs = nil
				continue
			}
			if n, ok := jobList.Update(j); ok {
				send([]Notification{n})
			}
		}
	}
}
