//go:build !darwin && !windows

package tray

import (
	"os"

	"github.com/godbus/dbus/v5"
)

// statusNotifierHost reports whether a desktop shows tray icons: a session
// bus we can reach, with someone owning org.kde.StatusNotifierWatcher.
// Checking the environment alone is not enough: an inherited but dead bus
// address makes the tray library crash on exit.
func statusNotifierHost() bool {
	if os.Getenv("DBUS_SESSION_BUS_ADDRESS") == "" || (os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "") {
		return false
	}
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return false
	}
	defer func() { _ = conn.Close() }()
	var has bool
	if err := conn.BusObject().Call("org.freedesktop.DBus.NameHasOwner", 0, "org.kde.StatusNotifierWatcher").Store(&has); err != nil {
		return false
	}
	return has
}
