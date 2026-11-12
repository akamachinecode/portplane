//go:build windows

package selfupdate

import (
	"syscall"

	"golang.org/x/sys/windows"
)

func detached() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NEW_CONSOLE | windows.CREATE_NEW_PROCESS_GROUP,
		HideWindow:    true,
	}
}

// waitThen runs argv at once: Windows has no /bin/sh, and the new
// Portplane waits by itself (AfterPIDEnv).
func waitThen(_ int, argv []string) []string { return argv }
