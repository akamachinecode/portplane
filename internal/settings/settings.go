// Package settings stores Portplane's own preferences in the OS config
// directory. Nothing here is dekit or portless config.
package settings

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// Machine is a remote machine reached over SSH.
type Machine struct {
	ID      string   `json:"id"`   // stable id, also the URL label
	Name    string   `json:"name"` // display name
	Host    string   `json:"host"` // ssh destination: a ~/.ssh/config alias or user@host
	Folders []string `json:"folders"`
}

// Settings is the whole file.
type Settings struct {
	Folders  []string  `json:"folders"`
	Machines []Machine `json:"machines,omitempty"`
}

// Store reads and writes the settings file.
type Store struct {
	path string
	mu   sync.Mutex
}

// DefaultPath is <user config dir>/portplane/settings.json, or the file named
// by PORTPLANE_SETTINGS.
func DefaultPath() (string, error) {
	if p := os.Getenv("PORTPLANE_SETTINGS"); p != "" {
		return p, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "portplane", "settings.json"), nil
}

// Open returns a store for path.
func Open(path string) *Store { return &Store{path: path} }

// Path is where the settings live.
func (s *Store) Path() string { return s.path }

// Load reads the file; a missing file means empty settings.
func (s *Store) Load() (Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var st Settings
	b, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return Settings{Folders: []string{}}, nil
	}
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal(b, &st); err != nil {
		return st, err
	}
	if st.Folders == nil {
		st.Folders = []string{}
	}
	return st, nil
}

// Save writes the file atomically.
func (s *Store) Save(st Settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st.Folders == nil {
		st.Folders = []string{}
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".settings-*.json")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), s.path)
}

// Update loads, applies fn and saves.
func (s *Store) Update(fn func(*Settings) error) (Settings, error) {
	st, err := s.Load()
	if err != nil {
		return st, err
	}
	if err := fn(&st); err != nil {
		return st, err
	}
	return st, s.Save(st)
}
