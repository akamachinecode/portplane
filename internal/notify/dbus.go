//go:build !darwin && !windows

package notify

import (
	"context"
	"errors"
	"sync"

	"github.com/godbus/dbus/v5"
)

// The freedesktop notification service.
const (
	busName   = "org.freedesktop.Notifications"
	busPath   = "/org/freedesktop/Notifications"
	busIface  = "org.freedesktop.Notifications"
	actionKey = "default" // the click on the notification itself
)

// dbusSender talks to the desktop's notification server (GNOME Shell,
// KDE, dunst, mako…).
type dbusSender struct {
	conn    *dbus.Conn
	obj     dbus.BusObject
	o       Options
	mu      sync.Mutex
	routes  map[uint32]string // notification id -> route, until it closes
	replace map[string]uint32 // Notification.ID -> the server's id, so a newer one replaces it
}

func newSender(o Options) (Sender, error) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, err
	}
	s := newDBusSender(conn.Object(busName, busPath), o)
	s.conn = conn
	if o.OnClick != nil {
		if err := conn.AddMatchSignal(dbus.WithMatchObjectPath(busPath), dbus.WithMatchInterface(busIface)); err == nil {
			ch := make(chan *dbus.Signal, 16)
			conn.Signal(ch)
			go func() {
				for sig := range ch {
					s.signal(sig)
				}
			}()
		}
	}
	return s, nil
}

func newDBusSender(obj dbus.BusObject, o Options) *dbusSender {
	if o.AppName == "" {
		o.AppName = "Portplane"
	}
	return &dbusSender{obj: obj, o: o, routes: map[uint32]string{}, replace: map[string]uint32{}}
}

func (s *dbusSender) Send(ctx context.Context, n Notification) error {
	hints := map[string]dbus.Variant{
		"urgency": dbus.MakeVariant(byte(1)), // normal: a critical one would stay until dismissed
	}
	if s.o.DesktopEntry != "" {
		hints["desktop-entry"] = dbus.MakeVariant(s.o.DesktopEntry)
	}
	if n.Kind == KindFailure {
		hints["category"] = dbus.MakeVariant("device.error")
	}
	var actions []string
	if s.o.OnClick != nil {
		actions = []string{actionKey, "Show"}
	}
	s.mu.Lock()
	replaces := s.replace[n.ID]
	s.mu.Unlock()
	var id uint32
	err := s.obj.CallWithContext(ctx, busIface+".Notify", 0,
		s.o.AppName, replaces, s.o.Icon, n.Title, n.Body, actions, hints, int32(-1)).Store(&id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if n.ID != "" {
		s.replace[n.ID] = id
	}
	s.routes[id] = n.Route
	s.mu.Unlock()
	return nil
}

// signal handles the server's ActionInvoked and NotificationClosed.
func (s *dbusSender) signal(sig *dbus.Signal) {
	if len(sig.Body) < 2 {
		return
	}
	id, ok := sig.Body[0].(uint32)
	if !ok {
		return
	}
	switch sig.Name {
	case busIface + ".ActionInvoked":
		key, _ := sig.Body[1].(string)
		s.mu.Lock()
		route, known := s.routes[id]
		s.mu.Unlock()
		if known && key == actionKey && s.o.OnClick != nil {
			s.o.OnClick(route)
		}
	case busIface + ".NotificationClosed":
		s.mu.Lock()
		delete(s.routes, id)
		for k, v := range s.replace {
			if v == id {
				delete(s.replace, k)
			}
		}
		s.mu.Unlock()
	}
}

func (s *dbusSender) Close() error {
	if s.conn == nil {
		return errors.New("not connected")
	}
	return s.conn.Close()
}
