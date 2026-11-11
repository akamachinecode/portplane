package main

import "golang.org/x/sys/windows"

var procAllowSetForegroundWindow = windows.NewLazySystemDLL("user32.dll").NewProc("AllowSetForegroundWindow")

// allowForeground lets the running Portplane bring its window to the front:
// Windows only lets the process the user just started do that, and passes
// the right on when asked.
func allowForeground(pid int) {
	_, _, _ = procAllowSetForegroundWindow.Call(uintptr(pid))
}
