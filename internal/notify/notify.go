// Package notify shows system notifications for what happens while the
// user looks elsewhere: an app crashed, a failed app recovered, a job
// ended, a dekit.yaml changed (plan §6.5). It watches the hub's snapshots
// in Portplane itself, so it works with the window closed. Linux uses
// org.freedesktop.Notifications over D-Bus, macOS osascript and Windows a
// toast through PowerShell; arguments always travel as argv or
// environment, never inside a script.
package notify

import (
	"context"

	"github.com/akamachinecode/portplane/internal/settings"
)

// Kind is what a notification is about; each has its own switch in the
// preferences.
type Kind string

const (
	KindFailure  Kind = "failure"  // an app crashed, or a job failed
	KindRecovery Kind = "recovery" // a failed app runs again
	KindJob      Kind = "job"      // a job finished
	KindConfig   Kind = "config"   // a dekit.yaml changed and needs a reload
	// KindUpdate is a new Portplane, sent only after an automatic check,
	// which the user turned on (ADR-0031); it has no switch of its own.
	KindUpdate Kind = "update"
)

// Notification is one system notification.
type Notification struct {
	// ID is stable for its subject ("app|local|/home/dev/code#web"): a newer
	// notification about the same thing replaces the older one where the
	// platform allows, and repeats are held back for a while.
	ID    string
	Kind  Kind
	Title string
	Body  string
	// Route is the UI route a click opens, such as "#/health"; "" opens
	// the window as it was.
	Route string
}

// Enabled reports whether the user wants notifications of kind k.
func Enabled(p settings.Notifications, k Kind) bool {
	switch k {
	case KindFailure:
		return p.Failures
	case KindRecovery:
		return p.Recoveries
	case KindJob:
		return p.Jobs
	case KindConfig:
		return p.Config
	}
	return false
}

// Sender shows notifications on this system.
type Sender interface {
	Send(ctx context.Context, n Notification) error
	Close() error
}

// Options configure the platform's sender.
type Options struct {
	// AppName is the name the notification shows as its source.
	AppName string
	// DesktopEntry names the .desktop file (Linux), so the desktop shows
	// the app's icon and groups its notifications.
	DesktopEntry string
	// Icon is an icon name from the theme (Linux).
	Icon string
	// LaunchBase is the UI's address: a click on a Windows toast opens it
	// at the route in the browser.
	LaunchBase string
	// OnClick runs with the notification's route when the user clicks it,
	// where the platform reports clicks (Linux).
	OnClick func(route string)
}

// New returns the sender for this system, or an error when notifications
// cannot be shown here.
func New(o Options) (Sender, error) { return newSender(o) }
