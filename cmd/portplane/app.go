package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/akamachinecode/portplane/internal/agent"
	"github.com/akamachinecode/portplane/internal/settings"
)

// stringList is a repeatable flag.
type stringList []string

func (s *stringList) String() string     { return fmt.Sprint(*s) }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }

func openSettings() (*settings.Store, error) {
	p, err := settings.DefaultPath()
	if err != nil {
		return nil, err
	}
	return settings.Open(p), nil
}

// localAgent builds the local agent from saved folders, or from --folder
// flags when given (which are not saved).
func localAgent(flagFolders []string) (*agent.Local, error) {
	store, err := openSettings()
	if err != nil {
		return nil, err
	}
	folders := flagFolders
	if len(folders) == 0 {
		st, err := store.Load()
		if err != nil {
			return nil, fmt.Errorf("reading %s: %w", store.Path(), err)
		}
		folders = st.Folders
	}
	return agent.NewLocal(agent.Options{Folders: folders}), nil
}

func absFolder(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if !fi.IsDir() {
		return "", errors.New(abs + " is not a folder")
	}
	return abs, nil
}

func background() context.Context { return context.Background() }
