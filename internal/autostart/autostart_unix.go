//go:build !windows

package autostart

import (
	"errors"
	"io/fs"
	"os"
	"runtime"
)

func enabled() (bool, error) {
	p, err := entryPath()
	if err != nil {
		return false, err
	}
	_, err = os.Stat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func enable(exe string) error {
	p, err := entryPath()
	if err != nil {
		return err
	}
	if runtime.GOOS == "darwin" {
		return writeFile(p, plist(exe))
	}
	return writeFile(p, desktopEntry(exe))
}

func disable() error {
	p, err := entryPath()
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
