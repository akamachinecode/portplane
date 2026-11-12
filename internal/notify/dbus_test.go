//go:build !darwin && !windows

package notify

import (
	"context"
	"reflect"
	"testing"

	"github.com/godbus/dbus/v5"
)

// fakeBus records Notify calls and answers with increasing ids.
type fakeBus struct {
	dbus.BusObject
	calls [][]any
}

func (f *fakeBus) CallWithContext(_ context.Context, method string, _ dbus.Flags, args ...any) *dbus.Call {
	f.calls = append(f.calls, append([]any{method}, args...))
	return &dbus.Call{Body: []any{uint32(len(f.calls) + 40)}}
}

func TestDBusSend(t *testing.T) {
	bus := &fakeBus{}
	var clicked []string
	s := newDBusSender(bus, Options{DesktopEntry: "dev.portplane.app", Icon: "portplane", OnClick: func(r string) { clicked = append(clicked, r) }})
	n := Notification{ID: "app|local|x", Kind: KindFailure, Title: "web crashed", Body: "my-monorepo: exit code 1", Route: "#/apps/local/x"}
	if err := s.Send(context.Background(), n); err != nil {
		t.Fatal(err)
	}
	c := bus.calls[0]
	if c[0] != "org.freedesktop.Notifications.Notify" || c[1] != "Portplane" || c[2] != uint32(0) || c[3] != "portplane" || c[4] != "web crashed" || c[5] != "my-monorepo: exit code 1" {
		t.Fatalf("call %v", c)
	}
	if !reflect.DeepEqual(c[6], []string{"default", "Show"}) {
		t.Fatalf("actions %v", c[6])
	}
	hints := c[7].(map[string]dbus.Variant)
	if hints["desktop-entry"].Value() != "dev.portplane.app" || hints["category"].Value() != "device.error" {
		t.Fatalf("hints %v", hints)
	}
	// The same subject again replaces the first notification.
	if err := s.Send(context.Background(), n); err != nil {
		t.Fatal(err)
	}
	if bus.calls[1][2] != uint32(41) {
		t.Fatalf("replaces %v, want 41", bus.calls[1][2])
	}

	s.signal(&dbus.Signal{Name: "org.freedesktop.Notifications.ActionInvoked", Body: []any{uint32(42), "default"}})
	s.signal(&dbus.Signal{Name: "org.freedesktop.Notifications.ActionInvoked", Body: []any{uint32(99), "default"}}) // not ours
	if !reflect.DeepEqual(clicked, []string{"#/apps/local/x"}) {
		t.Fatalf("clicked %v", clicked)
	}
	s.signal(&dbus.Signal{Name: "org.freedesktop.Notifications.NotificationClosed", Body: []any{uint32(42), uint32(2)}})
	s.signal(&dbus.Signal{Name: "org.freedesktop.Notifications.ActionInvoked", Body: []any{uint32(42), "default"}})
	if len(clicked) != 1 {
		t.Fatal("a closed notification still opened")
	}
}
