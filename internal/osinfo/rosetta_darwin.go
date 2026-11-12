//go:build darwin

package osinfo

import "golang.org/x/sys/unix"

// Translated reports whether this process is an Intel binary running
// through Rosetta on an Apple silicon Mac.
func Translated() bool {
	v, err := unix.SysctlUint32("sysctl.proc_translated")
	return err == nil && v == 1
}
