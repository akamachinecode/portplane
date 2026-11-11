//go:build darwin || windows

package tray

func statusNotifierHost() bool { return true }

// Visible reports whether the tray icon can be seen: always, where there is
// a tray.
func Visible() bool { return Available() }
