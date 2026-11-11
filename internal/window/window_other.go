//go:build !linux && !windows && (!darwin || !cgo)

package window

import (
	"context"
	"errors"
)

// Supported reports whether Show opens a native window in this build.
func Supported() bool { return false }

// NeedsTray is false: there is no native window in this build.
func NeedsTray() bool { return false }

// Start does nothing: there is no native window in this build.
func Start(context.Context, Options) {}

// Show fails: there is no native window in this build.
func Show(string) error { return errors.New("no native window in this build") }

// Close does nothing.
func Close() {}

// CanPick is false.
func CanPick() bool { return false }

func pickFolder(context.Context) (string, error) { return "", ErrNoWindow }
