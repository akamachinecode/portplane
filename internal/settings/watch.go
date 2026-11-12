package settings

import (
	"context"
	"os"
	"time"
)

// Watch calls changed with the settings whenever the file changes on disk,
// such as after `portplane folders add` in a terminal, until ctx is done.
// It checks every interval; Portplane's own saves are reported too, and
// callers compare with what they have.
func (s *Store) Watch(ctx context.Context, interval time.Duration, changed func(Settings)) {
	stamp := func() (time.Time, int64) {
		fi, err := os.Stat(s.path)
		if err != nil {
			return time.Time{}, -1
		}
		return fi.ModTime(), fi.Size()
	}
	lastMod, lastSize := stamp()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			mod, size := stamp()
			if mod.Equal(lastMod) && size == lastSize {
				continue
			}
			lastMod, lastSize = mod, size
			st, err := s.Load()
			if err != nil {
				continue // half-written by another program: try on the next tick
			}
			changed(st)
		}
	}
}
