//go:build !darwin || !cgo

package tray

import "context"

func watchReopen(context.Context, func()) {}
