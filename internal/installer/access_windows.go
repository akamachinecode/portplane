//go:build windows

package installer

// canWrite is true on Windows, where npm's global prefix is in the user's
// AppData unless an administrator moved it; npm itself says so otherwise.
func canWrite(string) bool { return true }
