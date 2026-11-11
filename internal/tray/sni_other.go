//go:build darwin || windows

package tray

func statusNotifierHost() bool { return true }
