//go:build !windows

package selfupdate

import (
	"strconv"
	"syscall"
)

func detached() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }

func waitThen(pid int, argv []string) []string {
	return append([]string{"/bin/sh", "-c", waitScript, "portplane-restart", strconv.Itoa(pid)}, argv...)
}
