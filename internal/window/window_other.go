//go:build !darwin || !cgo

package window

import "context"

// Supported reports whether Show opens a native window in this build.
func Supported() bool { return false }

// Show does nothing: there is no native window in this build.
func Show(string) {}

// OnQuit does nothing: there is no window menu in this build.
func OnQuit(context.Context, func()) {}
