//go:build windows

package portless

// processUID can't be told on Windows; the proxy that runs as SYSTEM is the
// service, which the caller knows from the service status.
func processUID(int) (int, bool) { return 0, false }
