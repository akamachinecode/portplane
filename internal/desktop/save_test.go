package desktop

import (
	"os"
	"path/filepath"
	"testing"
)

func TestXDGDownloadDir(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "user-dirs.dirs")
	for content, want := range map[string]string{
		"# comment\nXDG_DESKTOP_DIR=\"$HOME/Desktop\"\nXDG_DOWNLOAD_DIR=\"$HOME/Descargas\"\n": "/home/dev/Descargas",
		"XDG_DOWNLOAD_DIR=\"/data/dl\"\n": "/data/dl",
		"XDG_DOWNLOAD_DIR=\"$HOME/\"\n":   "",
		"XDG_MUSIC_DIR=\"$HOME/Music\"\n": "",
	} {
		if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := xdgDownloadDir(file, "/home/dev"); got != want {
			t.Errorf("%q: got %q, want %q", content, got, want)
		}
	}
	if got := xdgDownloadDir(filepath.Join(dir, "missing"), "/home/dev"); got != "" {
		t.Fatal(got)
	}
}
