package envpath

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Tools are looked up again every few seconds, and at once after Refresh,
// so a dekit or portless installed while Portplane runs shows up without a
// restart.
const lookupTTL = 5 * time.Second

var (
	lookupMu    sync.Mutex
	lookupCache = map[string]lookupEntry{}
	extraDirs   []string // folders Portplane installs tools into
)

type lookupEntry struct {
	path string
	at   time.Time
}

// Lookup finds a program on PATH, then in the folders Portplane installs
// tools into, which it then adds to PATH. It returns "" when the program
// is nowhere. The answer is cached for a few seconds.
func Lookup(name string) string {
	lookupMu.Lock()
	if e, ok := lookupCache[name]; ok && time.Since(e.at) < lookupTTL {
		lookupMu.Unlock()
		return e.path
	}
	dirs := append([]string(nil), extraDirs...)
	lookupMu.Unlock()

	p, err := exec.LookPath(name)
	if err != nil {
		p = ""
		for _, d := range dirs {
			if c := executableIn(d, name); c != "" {
				Add(d)
				p = c
				break
			}
		}
	}
	lookupMu.Lock()
	lookupCache[name] = lookupEntry{path: p, at: time.Now()}
	lookupMu.Unlock()
	return p
}

func executableIn(dir, name string) string {
	names := []string{name}
	if runtime.GOOS == "windows" {
		names = []string{name + ".exe", name + ".cmd", name + ".bat", name}
	}
	for _, n := range names {
		p := filepath.Join(dir, n)
		fi, err := os.Stat(p)
		if err != nil || fi.IsDir() {
			continue
		}
		if runtime.GOOS != "windows" && fi.Mode()&0o111 == 0 {
			continue
		}
		return p
	}
	return ""
}

// Refresh forgets every cached lookup; call it after installing a tool.
func Refresh() {
	lookupMu.Lock()
	lookupCache = map[string]lookupEntry{}
	lookupMu.Unlock()
}

// WatchDir makes Lookup also search dir, a folder Portplane installs tools
// into (such as ~/.local/bin), even before it exists.
func WatchDir(dir string) {
	if dir == "" {
		return
	}
	lookupMu.Lock()
	defer lookupMu.Unlock()
	for _, d := range extraDirs {
		if d == dir {
			return
		}
	}
	extraDirs = append(extraDirs, dir)
	lookupCache = map[string]lookupEntry{}
}

// Add appends dir to this process's PATH when it is not there yet, so the
// programs Portplane starts find what it installed. It forgets cached
// lookups.
func Add(dir string) {
	if dir == "" {
		return
	}
	current := filepath.SplitList(os.Getenv("PATH"))
	for _, d := range current {
		if samePath(d, dir) {
			return
		}
	}
	_ = os.Setenv("PATH", strings.Join(append(current, dir), string(os.PathListSeparator)))
	Refresh()
}

// Prepend puts dir first on this process's PATH, such as Portplane's own
// Node when the system one is too old.
func Prepend(dir string) {
	if dir == "" {
		return
	}
	current := filepath.SplitList(os.Getenv("PATH"))
	out := []string{dir}
	for _, d := range current {
		if !samePath(d, dir) {
			out = append(out, d)
		}
	}
	_ = os.Setenv("PATH", strings.Join(out, string(os.PathListSeparator)))
	Refresh()
}

func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}
