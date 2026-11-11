//go:build windows

package autostart

import (
	"errors"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`

func enabled() (bool, error) {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return false, err
	}
	defer k.Close() //nolint:errcheck
	_, _, err = k.GetStringValue("Portplane")
	if errors.Is(err, registry.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func enable(exe string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close() //nolint:errcheck
	return k.SetStringValue("Portplane", `"`+exe+`" `+strings.Join(Args, " "))
}

func disable() error {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close() //nolint:errcheck
	if err := k.DeleteValue("Portplane"); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}
