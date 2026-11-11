//go:build !windows

package main

// allowForeground is a Windows matter (see foreground_windows.go).
func allowForeground(int) {}
