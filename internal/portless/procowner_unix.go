//go:build !windows

package portless

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// processUID is the user id a process runs as: /proc on Linux, ps
// elsewhere. ok is false when it can't be told.
func processUID(pid int) (int, bool) {
	if fi, err := os.Stat("/proc/" + strconv.Itoa(pid)); err == nil {
		if st, ok := fi.Sys().(*syscall.Stat_t); ok {
			return int(st.Uid), true
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-o", "uid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0, false
	}
	uid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	return uid, err == nil
}
