package installer

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// ErrUnsafePath means an archive entry would land outside the folder it is
// unpacked into ("../", an absolute path, or a link that points out).
var ErrUnsafePath = errors.New("archive entry points outside the destination")

// entryPath turns an archive name into a path inside dest, dropping the
// first strip components. It returns "" for an entry that strip removes
// entirely (the top folder itself).
func entryPath(dest, name string, strip int) (string, error) {
	name = strings.ReplaceAll(name, `\`, "/")
	if strings.HasPrefix(name, "/") || (len(name) > 1 && name[1] == ':') {
		return "", fmt.Errorf("%w: %s", ErrUnsafePath, name)
	}
	clean := path.Clean(name)
	parts := strings.Split(clean, "/")
	for _, p := range parts {
		if p == ".." {
			return "", fmt.Errorf("%w: %s", ErrUnsafePath, name)
		}
	}
	if clean == "." || len(parts) <= strip {
		return "", nil
	}
	rel := filepath.FromSlash(strings.Join(parts[strip:], "/"))
	if !filepath.IsLocal(rel) {
		return "", fmt.Errorf("%w: %s", ErrUnsafePath, name)
	}
	return filepath.Join(dest, rel), nil
}

// inside reports whether target is dest or below it.
func inside(dest, target string) bool {
	rel, err := filepath.Rel(dest, target)
	return err == nil && (rel == "." || filepath.IsLocal(rel))
}

// prepareDir creates the folder an entry goes into, after checking that
// its real location (links resolved) is inside root: a link unpacked
// earlier must not carry a later entry out of the destination. It returns
// that real folder.
func prepareDir(root, at string) (string, error) {
	dir := filepath.Dir(at)
	existing := dir
	for {
		if _, err := os.Lstat(existing); err == nil {
			break
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			break
		}
		existing = parent
	}
	real, err := filepath.EvalSymlinks(existing)
	if err != nil {
		return "", err
	}
	if !inside(root, real) {
		return "", fmt.Errorf("%w: %s", ErrUnsafePath, at)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	real, err = filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	if !inside(root, real) {
		return "", fmt.Errorf("%w: %s", ErrUnsafePath, at)
	}
	return real, nil
}

// realDest creates dest and returns its absolute, link-free path.
func realDest(dest string) (string, string, error) {
	abs, err := filepath.Abs(dest)
	if err != nil {
		return "", "", err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return "", "", err
	}
	real, err := filepath.EvalSymlinks(abs)
	return abs, real, err
}

// ExtractTarGz unpacks a .tar.gz into dest, dropping the first strip path
// components (Node archives keep everything under node-vX-os-arch/). It
// refuses entries and links that would land outside dest, keeps the
// executable bit and skips devices and other special files.
func ExtractTarGz(r io.Reader, dest string, strip int) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("not a gzip archive: %w", err)
	}
	defer func() { _ = gz.Close() }()
	tr := tar.NewReader(gz)
	dest, root, err := realDest(dest)
	if err != nil {
		return err
	}
	type link struct{ at, target string }
	var hardlinks []link
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("reading the archive: %w", err)
		}
		at, err := entryPath(dest, h.Name, strip)
		if err != nil {
			return err
		}
		if at == "" {
			continue
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if _, err := prepareDir(root, filepath.Join(at, "x")); err != nil {
				return err
			}
		case tar.TypeReg:
			if _, err := prepareDir(root, at); err != nil {
				return err
			}
			if err := writeFile(at, tr, h.FileInfo().Mode()); err != nil {
				return err
			}
		case tar.TypeSymlink:
			target := h.Linkname
			if filepath.IsAbs(target) || strings.HasPrefix(target, "/") || strings.HasPrefix(target, `\`) {
				return fmt.Errorf("%w: %s -> %s", ErrUnsafePath, h.Name, target)
			}
			dir, err := prepareDir(root, at)
			if err != nil {
				return err
			}
			if !inside(root, filepath.Join(dir, filepath.FromSlash(target))) {
				return fmt.Errorf("%w: %s -> %s", ErrUnsafePath, h.Name, target)
			}
			_ = os.Remove(at)
			if err := os.Symlink(filepath.FromSlash(target), at); err != nil {
				return err
			}
		case tar.TypeLink:
			target, err := entryPath(dest, h.Linkname, strip)
			if err != nil || target == "" {
				return fmt.Errorf("%w: %s -> %s", ErrUnsafePath, h.Name, h.Linkname)
			}
			hardlinks = append(hardlinks, link{at: at, target: target})
		default:
			// devices, fifos and the like: nothing a Node build needs
		}
	}
	for _, l := range hardlinks {
		if _, err := prepareDir(root, l.at); err != nil {
			return err
		}
		if _, err := prepareDir(root, l.target); err != nil {
			return err
		}
		if err := copyFile(l.target, l.at); err != nil {
			return err
		}
	}
	return nil
}

// ExtractZip unpacks a .zip file into dest, like ExtractTarGz.
func ExtractZip(file, dest string, strip int) error {
	zr, err := zip.OpenReader(file)
	if err != nil {
		return fmt.Errorf("not a zip archive: %w", err)
	}
	defer func() { _ = zr.Close() }()
	dest, root, err := realDest(dest)
	if err != nil {
		return err
	}
	for _, f := range zr.File {
		at, err := entryPath(dest, f.Name, strip)
		if err != nil {
			return err
		}
		if at == "" {
			continue
		}
		mode := f.Mode()
		switch {
		case mode.IsDir():
			if _, err := prepareDir(root, filepath.Join(at, "x")); err != nil {
				return err
			}
		case mode&os.ModeSymlink != 0:
			return fmt.Errorf("%w: %s is a link", ErrUnsafePath, f.Name)
		case mode.IsRegular():
			if _, err := prepareDir(root, at); err != nil {
				return err
			}
			rc, err := f.Open()
			if err != nil {
				return err
			}
			err = writeFile(at, rc, mode)
			_ = rc.Close()
			if err != nil {
				return err
			}
		}
	}
	return nil
}

func writeFile(at string, r io.Reader, mode os.FileMode) error {
	perm := os.FileMode(0o644)
	if mode&0o111 != 0 {
		perm = 0o755
	}
	_ = os.Remove(at) // a link left by an earlier entry is never written through
	f, err := os.OpenFile(at, os.O_CREATE|os.O_WRONLY|os.O_TRUNC|os.O_EXCL, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	fi, err := in.Stat()
	if err != nil {
		return err
	}
	return writeFile(to, in, fi.Mode())
}
