//go:build darwin && !cgo

package tray

import "context"

// Available is false: the macOS menu bar needs a CGO build (ADR-0004).
func Available() bool { return false }

func run(context.Context, Options) {}
