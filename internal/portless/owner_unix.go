//go:build !windows

package portless

import (
	"os"
	"syscall"
)

func ownedByRoot(path string) bool {
	fi, err := os.Stat(path)
	if err != nil {
		return true
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	return !ok || st.Uid == 0
}
