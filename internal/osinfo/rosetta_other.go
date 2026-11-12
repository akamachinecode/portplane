//go:build !darwin

package osinfo

// Translated reports whether this process is an Intel binary running
// through Rosetta on an Apple silicon Mac: never, off macOS.
func Translated() bool { return false }
