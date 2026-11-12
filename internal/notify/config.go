package notify

import (
	"os"
	"path/filepath"
	"time"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/window"
)

// ConfigWatch notices dekit files that change on disk while their runner
// runs: dekit only applies them on a reload. Only this computer's runners
// are watched.
type ConfigWatch struct {
	// Files lists a project's config files (dekit.yaml and what it loads);
	// Stat reports a file's change time. Both are replaceable in tests.
	Files func(root string) []string
	Stat  func(path string) (time.Time, bool)

	known map[string]map[string]time.Time // root -> file -> modification time
}

// NewConfigWatch returns a watch on the real file system.
func NewConfigWatch() *ConfigWatch {
	return &ConfigWatch{
		Files: func(root string) []string {
			if cfg, err := dekit.LoadConfig(root); err == nil && len(cfg.Files) > 0 {
				return cfg.Files
			}
			return []string{filepath.Join(root, dekit.ConfigFile)}
		},
		Stat: func(p string) (time.Time, bool) {
			fi, err := os.Stat(p)
			if err != nil {
				return time.Time{}, false
			}
			return fi.ModTime(), true
		},
	}
}

// Check looks at the local machine's running projects and returns a
// notification for each one whose files changed since the last check. The
// first look at a project only records its files.
func (w *ConfigWatch) Check(ms model.MachineSnapshot) []Notification {
	if !ms.Machine.Local {
		return nil
	}
	if w.known == nil {
		w.known = map[string]map[string]time.Time{}
	}
	var out []Notification
	live := map[string]bool{}
	for _, r := range ms.Runners {
		if !r.Up || r.Error != "" {
			continue
		}
		live[r.Root] = true
		before, ok := w.known[r.Root]
		if !ok {
			w.known[r.Root] = w.snapshot(r.Root)
			continue
		}
		changed := false
		for f, t := range before {
			if now, exists := w.Stat(f); !exists || !now.Equal(t) {
				changed = true
				break
			}
		}
		if !changed {
			continue
		}
		w.known[r.Root] = w.snapshot(r.Root) // the files may have changed too
		name := r.Name
		if name == "" {
			name = filepath.Base(r.Root)
		}
		out = append(out, Notification{
			ID:    "config|" + ms.Machine.ID + "|" + r.Root,
			Kind:  KindConfig,
			Title: "dekit.yaml changed in " + name,
			Body:  "dekit applies the change on a reload. Open the project to review and reload it.",
			Route: window.ProjectRoute(ms.Machine.ID, r.Root),
		})
	}
	for root := range w.known {
		if !live[root] {
			delete(w.known, root) // a runner that comes back starts afresh
		}
	}
	return out
}

func (w *ConfigWatch) snapshot(root string) map[string]time.Time {
	m := map[string]time.Time{}
	for _, f := range w.Files(root) {
		if t, ok := w.Stat(f); ok {
			m[f] = t
		}
	}
	return m
}
