//go:build !windows

package installer

import "errors"

func userPath() (string, error) { return "", errors.New("only on Windows") }

func addUserPath(string) error { return errors.New("only on Windows") }
