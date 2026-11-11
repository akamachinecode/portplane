//go:build darwin || windows

package privileged

import (
	"context"
	"io"
	"os"
)

// runViaHelper starts the helper through elevate, follows its output, and
// turns its status into an error.
func runViaHelper(ctx context.Context, c Command, out io.Writer, elevate func(ctx context.Context, self string, args []string) error) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	dir, outPath, codePath, err := helperFiles()
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(dir) }()
	done := make(chan struct{})
	followed := make(chan struct{})
	go func() {
		follow(outPath, out, done)
		close(followed)
	}()
	err = elevate(ctx, self, helperArgs(c, outPath, codePath))
	close(done)
	<-followed
	if err != nil {
		return err
	}
	return statusError(helperStatus(codePath))
}
