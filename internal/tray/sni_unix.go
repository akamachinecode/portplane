//go:build !darwin && !windows

package tray

import (
	"context"
	"os"
	"time"

	"github.com/godbus/dbus/v5"
)

// statusNotifierHost reports whether a tray can be registered: a desktop
// session bus that answers. Checking the environment alone is not enough (an
// inherited but dead bus address made the tray library crash on exit). The
// tray host itself may start after Portplane at login; the library
// registers again when it appears.
func statusNotifierHost() bool {
	if os.Getenv("DBUS_SESSION_BUS_ADDRESS") == "" || (os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "") {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, err := dbus.ConnectSessionBus(dbus.WithContext(ctx))
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
