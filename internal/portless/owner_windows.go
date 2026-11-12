//go:build windows

package portless

func ownedByRoot(string) bool { return true }
