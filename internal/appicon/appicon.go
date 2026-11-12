// Package appicon finds the image that stands for an app or a project in
// its folder: a favicon, an app icon or a logo, the way frameworks lay them
// out (ADR-0030). It only reads image files, never runs anything, and caps
// what it reads, so a folder full of large assets costs little.
package appicon

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// MaxSize is the largest image read, in bytes. Favicons and logos are far
// smaller; anything larger is a photo or a sprite, not an icon.
const MaxSize = 512 << 10

// Image is an image file's bytes and what it is.
type Image struct {
	Path string `json:"path"`
	Mime string `json:"mime"`
	Data []byte `json:"data"` // base64 in JSON
}

// ErrNotImage means the file is not an image Portplane shows (or is too big).
var ErrNotImage = errors.New("not an icon image (svg, png, ico, webp, gif or jpeg up to 512 KB)")

// Known lists, best first, where frameworks and people keep a project's
// icon, relative to an app's folder or a repository's root. A file named in
// .portplane/ is the explicit choice a team can commit.
var Known = []string{
	".portplane/icon.svg",
	".portplane/icon.png",
	// SVG first: it stays sharp at every size.
	"public/favicon.svg",
	"public/icon.svg",
	"app/icon.svg",
	"src/app/icon.svg",
	"static/favicon.svg",
	"src/favicon.svg",
	"favicon.svg",
	"icon.svg",
	"public/logo.svg",
	"static/logo.svg",
	"src/assets/logo.svg",
	"assets/logo.svg",
	"logo.svg",
	// Then images meant for app icons, which are large and square.
	"app/icon.png",
	"src/app/icon.png",
	"app/apple-icon.png",
	"src/app/apple-icon.png",
	"public/apple-touch-icon.png",
	"public/icon.png",
	"public/favicon.png",
	"public/favicon-32x32.png",
	"static/favicon.png",
	"public/logo.png",
	"assets/icon.png",
	"icon.png",
	"logo.png",
	// Then the classic favicon.
	"public/favicon.ico",
	"app/favicon.ico",
	"src/app/favicon.ico",
	"static/favicon.ico",
	"src/favicon.ico",
	"favicon.ico",
}

// Find looks for an icon in dir, then in each parent up to root (included).
// A dir outside root is searched alone. It returns false when there is none.
func Find(dir, root string) (Image, bool) {
	for _, d := range ladder(dir, root) {
		for _, rel := range Known {
			if img, err := Read(filepath.Join(d, filepath.FromSlash(rel))); err == nil {
				return img, true
			}
		}
	}
	return Image{}, false
}

// ladder is dir and its parents up to root, at most five folders.
func ladder(dir, root string) []string {
	dir = filepath.Clean(dir)
	out := []string{dir}
	if root == "" {
		return out
	}
	root = filepath.Clean(root)
	if rel, err := filepath.Rel(root, dir); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return out
	}
	for d := dir; d != root && len(out) < 5; {
		parent := filepath.Dir(d)
		if parent == d {
			break
		}
		d = parent
		out = append(out, d)
	}
	return out
}

// Read reads one image file, refusing anything that is not an icon image.
func Read(path string) (Image, error) {
	if !filepath.IsAbs(path) {
		return Image{}, fmt.Errorf("%s is not an absolute path", path)
	}
	mime := mimeOf(path)
	if mime == "" {
		return Image{}, ErrNotImage
	}
	fi, err := os.Stat(path)
	if err != nil {
		return Image{}, err
	}
	if !fi.Mode().IsRegular() || fi.Size() == 0 || fi.Size() > MaxSize {
		return Image{}, ErrNotImage
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Image{}, err
	}
	if !looksLike(mime, data) {
		return Image{}, ErrNotImage
	}
	return Image{Path: path, Mime: mime, Data: data}, nil
}

func mimeOf(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".ico":
		return "image/x-icon"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	}
	return ""
}

// looksLike checks the bytes against the extension, so a renamed file of
// another kind is never served as an image.
func looksLike(mime string, data []byte) bool {
	switch mime {
	case "image/svg+xml":
		head := strings.ToLower(string(data[:min(len(data), 1024)]))
		return strings.Contains(head, "<svg")
	case "image/x-icon":
		return len(data) > 4 && data[0] == 0 && data[1] == 0 && (data[2] == 1 || data[2] == 2) && data[3] == 0
	default:
		return http.DetectContentType(data) == mime
	}
}

// skip are folders never searched for candidates: dependencies, builds and
// caches hold thousands of images that are not the project's.
var skip = map[string]bool{
	"node_modules": true, ".git": true, "dist": true, "build": true, ".next": true, ".nuxt": true,
	".svelte-kit": true, ".turbo": true, ".cache": true, "coverage": true, "vendor": true, "out": true,
	".output": true, ".vercel": true, "target": true, ".venv": true, "venv": true, "__pycache__": true,
}

// Candidates lists the images in a project that could be its icon: every
// SVG, PNG and ICO up to MaxSize whose name says icon, logo, favicon or mark,
// at most limit, best first. It looks at most four folders deep and gives up
// after a few thousand entries.
func Candidates(root string, limit int) []Image {
	if !filepath.IsAbs(root) {
		return nil
	}
	type hit struct {
		path  string
		score int
	}
	var hits []hit
	seen := 0
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		seen++
		if seen > 20000 {
			return filepath.SkipAll
		}
		rel, _ := filepath.Rel(root, p)
		depth := strings.Count(filepath.ToSlash(rel), "/")
		if d.IsDir() {
			name := d.Name()
			if p != root && (skip[name] || (strings.HasPrefix(name, ".") && name != ".portplane" && name != ".github")) || depth > 4 {
				return filepath.SkipDir
			}
			return nil
		}
		if s := candidateScore(filepath.ToSlash(rel)); s > 0 {
			hits = append(hits, hit{p, s - depth})
		}
		return nil
	})
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].score != hits[j].score {
			return hits[i].score > hits[j].score
		}
		return hits[i].path < hits[j].path
	})
	out := []Image{}
	for _, h := range hits {
		if len(out) >= limit {
			break
		}
		if img, err := Read(h.path); err == nil {
			out = append(out, img)
		}
	}
	return out
}

// candidateScore ranks a file by its name and type; 0 means it is not one.
func candidateScore(rel string) int {
	mime := mimeOf(rel)
	if mime == "" || mime == "image/jpeg" || mime == "image/gif" {
		return 0
	}
	for i, k := range Known {
		if strings.HasSuffix(rel, k) {
			return 100 - i
		}
	}
	name := strings.ToLower(filepath.Base(rel))
	for _, word := range []string{"favicon", "icon", "logo", "mark", "brand"} {
		if strings.Contains(name, word) {
			score := 30
			if mime == "image/svg+xml" {
				score += 5
			}
			return score
		}
	}
	return 0
}
