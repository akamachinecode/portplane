package selfupdate

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/installer"
	"github.com/akamachinecode/portplane/internal/privileged"
)

// binaries are the files an archive update replaces: portplane, and on
// Linux the window next to it (ADR-0018).
func (u *Updater) binaries() []string {
	if u.GOOS == "windows" {
		return []string{"portplane.exe"}
	}
	if u.GOOS == "linux" {
		return []string{"portplane", "portplane-window"}
	}
	return []string{"portplane"}
}

// swap is one file or folder put in place, and how to undo it.
type swap struct {
	final, backup string
}

// replace moves staged to final, keeping what was at final as a backup.
// Renaming works on a running binary on every OS, Windows included.
func replace(staged, final string) (swap, error) {
	s := swap{final: final}
	if _, err := os.Lstat(final); err == nil {
		s.backup = fmt.Sprintf("%s.old-%d", hiddenPath(final), time.Now().UnixNano())
		if err := os.Rename(final, s.backup); err != nil {
			return s, fmt.Errorf("couldn't move the old %s aside: %w", filepath.Base(final), err)
		}
	}
	if err := os.Rename(staged, final); err != nil {
		if s.backup != "" {
			_ = os.Rename(s.backup, final)
		}
		return s, fmt.Errorf("couldn't put the new %s in place: %w", filepath.Base(final), err)
	}
	return s, nil
}

// undo puts the backup back.
func (s swap) undo() {
	_ = os.RemoveAll(s.final)
	if s.backup != "" {
		_ = os.Rename(s.backup, s.final)
	}
}

// done removes the backup. A running Windows binary can't be removed: it
// stays until Cleanup at the next start.
func (s swap) done() {
	if s.backup != "" {
		_ = os.RemoveAll(s.backup)
	}
}

// hiddenPath is dir/.name, so leftovers don't show in a listing.
func hiddenPath(p string) string {
	return filepath.Join(filepath.Dir(p), "."+filepath.Base(p))
}

func (u *Updater) applyArchive(ctx context.Context, p Plan, version, archive string, pr installer.Progress) (string, error) {
	dir := p.target
	staged, err := u.extract(archive, dir)
	defer func() {
		for _, s := range staged {
			_ = os.Remove(s)
		}
	}()
	if err != nil {
		return "", err
	}
	main := u.binaries()[0]
	if staged[main] == "" {
		return "", fmt.Errorf("%s has no %s", filepath.Base(archive), main)
	}
	var swaps []swap
	undo := func() {
		for i := len(swaps) - 1; i >= 0; i-- {
			swaps[i].undo()
		}
	}
	for _, name := range u.binaries() {
		if staged[name] == "" {
			continue
		}
		s, err := replace(staged[name], filepath.Join(dir, name))
		if err != nil {
			undo()
			return "", err
		}
		delete(staged, name)
		swaps = append(swaps, s)
		pr.Logf("Replaced %s", filepath.Join(dir, name))
	}
	exe := filepath.Join(dir, main)
	pr.Step(Steps(p, version)[2])
	if err := u.checkVersion(ctx, exe, version, pr); err != nil {
		undo()
		pr.Logf("Put the previous version back.")
		return "", err
	}
	for _, s := range swaps {
		s.done()
	}
	return exe, nil
}

// extract writes the binaries of a release archive into dir as hidden
// files, ready to be renamed into place, and returns them by name.
func (u *Updater) extract(archive, dir string) (map[string]string, error) {
	want := map[string]bool{}
	for _, b := range u.binaries() {
		want[b] = true
	}
	out := map[string]string{}
	write := func(name string, r io.Reader) error {
		f, err := os.CreateTemp(dir, "."+name+".new-*")
		if err != nil {
			return fmt.Errorf("couldn't write to %s: %w", dir, err)
		}
		out[name] = f.Name()
		if _, err := io.Copy(f, io.LimitReader(r, 500<<20)); err != nil {
			_ = f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
		return os.Chmod(f.Name(), 0o755)
	}
	if strings.HasSuffix(archive, ".zip") {
		zr, err := zip.OpenReader(archive)
		if err != nil {
			return out, err
		}
		defer func() { _ = zr.Close() }()
		for _, f := range zr.File {
			name := filepath.Base(f.Name)
			if !want[name] || f.FileInfo().IsDir() || out[name] != "" {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return out, err
			}
			err = write(name, rc)
			_ = rc.Close()
			if err != nil {
				return out, err
			}
		}
		return out, nil
	}
	f, err := os.Open(archive)
	if err != nil {
		return out, err
	}
	defer func() { _ = f.Close() }()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return out, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return out, err
		}
		name := filepath.Base(h.Name)
		if h.Typeflag != tar.TypeReg || !want[name] || out[name] != "" {
			continue
		}
		if err := write(name, tr); err != nil {
			return out, err
		}
	}
}

// applyApp swaps Portplane.app for the one in the release's .dmg. What
// Portplane downloads is not quarantined, so Gatekeeper doesn't ask again.
func (u *Updater) applyApp(ctx context.Context, p Plan, version, dmg, work string, pr installer.Progress) (string, error) {
	mnt := filepath.Join(work, "mnt")
	if err := os.Mkdir(mnt, 0o700); err != nil {
		return "", err
	}
	if err := u.Run(ctx, "", os.Environ(), pr, "/usr/bin/hdiutil", "attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt, dmg); err != nil {
		return "", fmt.Errorf("couldn't open %s: %w", filepath.Base(dmg), err)
	}
	defer func() {
		dctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if u.Run(dctx, "", os.Environ(), io.Discard, "/usr/bin/hdiutil", "detach", mnt) != nil {
			_ = u.Run(dctx, "", os.Environ(), io.Discard, "/usr/bin/hdiutil", "detach", "-force", mnt)
		}
	}()
	src := filepath.Join(mnt, "Portplane.app")
	if _, err := os.Stat(filepath.Join(src, "Contents", "MacOS", "portplane")); err != nil {
		return "", fmt.Errorf("%s has no Portplane.app", filepath.Base(dmg))
	}
	parent := filepath.Dir(p.target)
	stage, err := os.MkdirTemp(parent, ".portplane-update-")
	if err != nil {
		return "", fmt.Errorf("couldn't write to %s: %w", parent, err)
	}
	defer func() { _ = os.RemoveAll(stage) }()
	staged := filepath.Join(stage, "Portplane.app")
	if err := u.Run(ctx, "", os.Environ(), pr, "/usr/bin/ditto", src, staged); err != nil {
		return "", fmt.Errorf("couldn't copy the new Portplane.app: %w", err)
	}
	s, err := replace(staged, p.target)
	if err != nil {
		return "", err
	}
	pr.Logf("Replaced %s", p.target)
	exe := filepath.Join(p.target, "Contents", "MacOS", "portplane")
	pr.Step(Steps(p, version)[2])
	if err := u.checkVersion(ctx, exe, version, pr); err != nil {
		s.undo()
		pr.Logf("Put the previous version back.")
		return "", err
	}
	s.done()
	return exe, nil
}

// applyPackage installs the release's .deb or .rpm as administrator.
func (u *Updater) applyPackage(ctx context.Context, p Plan, version, pkg string, pr installer.Progress) (string, error) {
	cmd := privileged.Command{Argv: []string{"/usr/bin/dpkg", "-i", pkg}, Reason: "Portplane needs your password to install its new version."}
	if p.Method == RPM {
		cmd.Argv = []string{"/usr/bin/rpm", "-U", pkg}
	}
	pr.Logf("$ %s", privileged.Terminal(cmd, u.GOOS))
	if err := u.Privileged(ctx, cmd, pr); err != nil {
		if errors.Is(err, privileged.ErrDenied) {
			return "", errors.New("the password wasn't given, so nothing changed")
		}
		return "", err
	}
	pr.Step(Steps(p, version)[2])
	if err := u.checkVersion(ctx, p.exe, version, pr); err != nil {
		return "", err
	}
	return p.exe, nil
}

// Cleanup removes what an update left next to the binary: backups a
// running Windows binary kept, and files of an update that stopped half
// way. It runs at start, and ignores errors.
func Cleanup(exe string) {
	if exe == "" {
		return
	}
	dirs := []string{filepath.Dir(exe)}
	if app := bundleOf(exe); app != "" {
		dirs = append(dirs, filepath.Dir(app))
	}
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			n := e.Name()
			if !strings.HasPrefix(n, ".portplane") && !strings.HasPrefix(n, ".Portplane.app") {
				continue
			}
			if strings.Contains(n, ".old-") || strings.Contains(n, ".new-") || strings.HasPrefix(n, ".portplane-update-") {
				_ = os.RemoveAll(filepath.Join(dir, n))
			}
		}
	}
}
