package setup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
)

// ErrStale means the folder changed since the proposal was reviewed.
var ErrStale = errors.New("the folder changed since this proposal was made: scan again and review the new changes")

// Result says what Apply wrote.
type Result struct {
	Written []string `json:"written"`
	Root    string   `json:"root"` // the dekit project to reload
}

// Apply writes the proposal for folder, but only if it is still exactly the
// one the user reviewed (same digest).
func Apply(ctx context.Context, folder, digest string, ov Overrides, opt Options) (*Result, error) {
	p, err := Propose(ctx, folder, ov, opt)
	if err != nil {
		return nil, err
	}
	if digest == "" || p.Digest != digest {
		return nil, ErrStale
	}
	res := &Result{Written: []string{}, Root: p.Root}
	for _, f := range p.Files {
		if !f.Changed {
			continue
		}
		if err := writeAtomic(f.Path, []byte(f.After)); err != nil {
			return res, err
		}
		res.Written = append(res.Written, f.Path)
	}
	return res, nil
}

func writeAtomic(path string, b []byte) error {
	// A symlinked dekit.yaml (kept in dotfiles, say) stays a symlink: write
	// to the file it points to.
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	mode := os.FileMode(0o644)
	if fi, err := os.Stat(path); err == nil {
		mode = fi.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := os.Chmod(tmp.Name(), mode); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}
