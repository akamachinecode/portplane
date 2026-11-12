package selfupdate

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/akamachinecode/portplane/internal/installer"
	"github.com/akamachinecode/portplane/internal/privileged"
)

func env(goos, exe string) Env {
	return Env{
		GOOS: goos, GOARCH: "amd64", Exe: exe, Version: "0.5.0",
		Writable:       func(string) bool { return true },
		Exists:         func(string) bool { return false },
		RPMOwns:        func(string) bool { return false },
		CanAskPassword: true,
	}
}

func TestDetect(t *testing.T) {
	cases := []struct {
		name   string
		e      func() Env
		method Method
		auto   bool
	}{
		{"install.sh on Linux", func() Env { return env("linux", "/home/dev/.local/bin/portplane") }, Archive, true},
		{"install.ps1", func() Env { return env("windows", `C:\Users\dev\AppData\Local\Programs\Portplane\portplane.exe`) }, Archive, true},
		{"install.sh on macOS", func() Env { return env("darwin", "/Users/dev/.local/bin/portplane") }, Archive, true},
		{"the .app", func() Env { return env("darwin", "/Applications/Portplane.app/Contents/MacOS/portplane") }, App, true},
		{"the .app, read-only", func() Env {
			e := env("darwin", "/Applications/Portplane.app/Contents/MacOS/portplane")
			e.Writable = func(string) bool { return false }
			return e
		}, App, false},
		{"the .deb", func() Env {
			e := env("linux", "/usr/bin/portplane")
			e.Exists = func(p string) bool { return p == "/var/lib/dpkg/info/portplane.list" }
			return e
		}, Deb, true},
		{"the .rpm", func() Env {
			e := env("linux", "/usr/bin/portplane")
			e.RPMOwns = func(string) bool { return true }
			return e
		}, RPM, true},
		{"the .rpm, no password dialog", func() Env {
			e := env("linux", "/usr/bin/portplane")
			e.RPMOwns = func(string) bool { return true }
			e.CanAskPassword = false
			return e
		}, RPM, false},
		{"/usr, unknown package", func() Env { return env("linux", "/usr/bin/portplane") }, Manual, false},
		{"/usr/local", func() Env { return env("linux", "/usr/local/bin/portplane") }, Archive, true},
		{"read-only folder", func() Env {
			e := env("linux", "/opt/tools/portplane")
			e.Writable = func(string) bool { return false }
			return e
		}, Archive, false},
		{"Homebrew", func() Env { return env("darwin", "/opt/homebrew/Cellar/portplane/0.5.0/bin/portplane") }, Homebrew, false},
		{"Linuxbrew", func() Env { return env("linux", "/home/linuxbrew/.linuxbrew/bin/portplane") }, Homebrew, false},
		{"development build", func() Env {
			e := env("linux", "/home/dev/go/bin/portplane")
			e.Version = "dev"
			return e
		}, Manual, false},
		{"snapshot build", func() Env {
			e := env("linux", "/home/dev/portplane")
			e.Version = "0.5.1-SNAPSHOT-abc"
			return e
		}, Manual, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := Detect(c.e())
			if p.Method != c.method || p.Auto != c.auto {
				t.Fatalf("got %s auto=%v, want %s auto=%v (%+v)", p.Method, p.Auto, c.method, c.auto, p)
			}
			if !p.Auto && p.Reason == "" {
				t.Fatal("no reason when it can't update itself")
			}
		})
	}
}

func TestAssets(t *testing.T) {
	for _, c := range []struct {
		m          Method
		goos, arch string
		want       string
	}{
		{Archive, "linux", "amd64", "portplane_0.6.0_linux_amd64.tar.gz"},
		{Archive, "darwin", "arm64", "portplane_0.6.0_darwin_arm64.tar.gz"},
		{Archive, "windows", "arm64", "portplane_0.6.0_windows_arm64.zip"},
		{App, "darwin", "arm64", "portplane_0.6.0_darwin_arm64.dmg"},
		{Deb, "linux", "arm64", "portplane_0.6.0_arm64.deb"},
		{RPM, "linux", "amd64", "portplane-0.6.0-1.x86_64.rpm"},
		{RPM, "linux", "arm64", "portplane-0.6.0-1.aarch64.rpm"},
	} {
		if got := Asset(c.m, "0.6.0", c.goos, c.arch); got != c.want {
			t.Errorf("%s %s/%s: %s, want %s", c.m, c.goos, c.arch, got, c.want)
		}
	}
}

func TestRestartArgs(t *testing.T) {
	for _, c := range []struct {
		in   []string
		want []string
	}{
		{nil, []string{"serve", "--open"}},
		{[]string{"serve"}, []string{"serve", "--open"}},
		{[]string{"serve", "--no-tray", "--open=false"}, []string{"serve", "--no-tray", "--open"}},
		{[]string{"serve", "--open", "--listen", "127.0.0.1:0"}, []string{"serve", "--open", "--listen", "127.0.0.1:0"}},
	} {
		if got := RestartArgs(c.in); !slices.Equal(got, c.want) {
			t.Errorf("%q: %q, want %q", c.in, got, c.want)
		}
	}
}

// release serves a fake release v0.6.0: checksums.txt and files.
func release(t *testing.T, files map[string][]byte, badSum bool) *httptest.Server {
	t.Helper()
	const version = "0.6.0"
	var sums strings.Builder
	for name, data := range files {
		h := sha256.Sum256(data)
		sum := hex.EncodeToString(h[:])
		if badSum {
			sum = strings.Repeat("0", 64)
		}
		fmt.Fprintf(&sums, "%s  %s\n", sum, name)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name, ok := strings.CutPrefix(r.URL.Path, "/v"+version+"/")
		if !ok {
			http.NotFound(w, r)
			return
		}
		if name == "checksums.txt" {
			_, _ = io.WriteString(w, sums.String())
			return
		}
		data, ok := files[name]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func tgz(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(tw, body)
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

func zipOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(w, body)
	}
	_ = zw.Close()
	return buf.Bytes()
}

type progress struct {
	steps []string
	bytes.Buffer
}

func (p *progress) Step(name string)                { p.steps = append(p.steps, name) }
func (p *progress) Skip(string)                     {}
func (p *progress) Logf(format string, args ...any) { fmt.Fprintf(&p.Buffer, format+"\n", args...) }
func (p *progress) String() string                  { return p.Buffer.String() }
func allowAll(*url.URL) bool                        { return true }
func (p *progress) has(step string) bool            { return slices.Contains(p.steps, step) }
func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// updater reports as its version whatever the binary it runs contains
// after "version=", as the real binary's `version --json` would.
func updater(t *testing.T, goos, base string) *Updater {
	t.Helper()
	return &Updater{
		GOOS: goos, GOARCH: "amd64", Base: base,
		HTTP: &installer.Downloader{Allow: allowAll},
		Run: func(_ context.Context, _ string, _ []string, out io.Writer, argv ...string) error {
			b, err := os.ReadFile(argv[0])
			if err != nil {
				return err
			}
			v, ok := strings.CutPrefix(string(b), "version=")
			if !ok {
				return errors.New("exec format error")
			}
			_, _ = fmt.Fprintf(out, `{"version":%q,"os":"linux","arch":"amd64"}`+"\n", v)
			return nil
		},
		Work: t.TempDir(),
	}
}

func TestApplyArchive(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "portplane"), "version=0.5.0")
	writeFile(t, filepath.Join(dir, "portplane-window"), "old window")
	writeFile(t, filepath.Join(dir, "dekit"), "someone else's")
	srv := release(t, map[string][]byte{
		"portplane_0.6.0_linux_amd64.tar.gz": tgz(t, map[string]string{"portplane": "version=0.6.0", "portplane-window": "new window", "LICENSE": "x", "README.md": "x"}),
	}, false)
	u := updater(t, "linux", srv.URL)
	plan := Detect(env("linux", filepath.Join(dir, "portplane")))
	pr := &progress{}
	exe, err := u.Apply(context.Background(), plan, "0.6.0", pr)
	if err != nil {
		t.Fatal(err, pr.String())
	}
	if exe != filepath.Join(dir, "portplane") {
		t.Fatal(exe)
	}
	if read(t, exe) != "version=0.6.0" || read(t, filepath.Join(dir, "portplane-window")) != "new window" || read(t, filepath.Join(dir, "dekit")) != "someone else's" {
		t.Fatal("not replaced as expected")
	}
	if fi, _ := os.Stat(exe); fi.Mode()&0o111 == 0 {
		t.Fatal("not executable")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 3 {
		t.Fatalf("leftovers: %v", entries)
	}
	if !pr.has("Download Portplane 0.6.0") || !pr.has("Replace Portplane") || !pr.has("Check the new version") {
		t.Fatal(pr.steps)
	}
}

func TestApplyArchiveWindows(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "portplane.exe"), "version=0.5.0")
	srv := release(t, map[string][]byte{
		"portplane_0.6.0_windows_amd64.zip": zipOf(t, map[string]string{"portplane.exe": "version=0.6.0", "LICENSE": "x"}),
	}, false)
	u := updater(t, "windows", srv.URL)
	plan := Detect(env("windows", filepath.Join(dir, "portplane.exe")))
	if _, err := u.Apply(context.Background(), plan, "v0.6.0", &progress{}); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(dir, "portplane.exe")) != "version=0.6.0" {
		t.Fatal("not replaced")
	}
}

func TestApplyRefusesABadChecksum(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "portplane"), "version=0.5.0")
	srv := release(t, map[string][]byte{
		"portplane_0.6.0_linux_amd64.tar.gz": tgz(t, map[string]string{"portplane": "version=0.6.0"}),
	}, true)
	u := updater(t, "linux", srv.URL)
	_, err := u.Apply(context.Background(), Detect(env("linux", filepath.Join(dir, "portplane"))), "0.6.0", &progress{})
	var mismatch *installer.MismatchError
	if !errors.As(err, &mismatch) {
		t.Fatalf("got %v, want a checksum mismatch", err)
	}
	if read(t, filepath.Join(dir, "portplane")) != "version=0.5.0" {
		t.Fatal("changed despite the bad checksum")
	}
}

func TestApplyPutsTheOldOneBack(t *testing.T) {
	for name, body := range map[string]string{
		"doesn't run":   "garbage",
		"wrong version": "version=0.5.9",
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			writeFile(t, filepath.Join(dir, "portplane"), "version=0.5.0")
			writeFile(t, filepath.Join(dir, "portplane-window"), "old window")
			srv := release(t, map[string][]byte{
				"portplane_0.6.0_linux_amd64.tar.gz": tgz(t, map[string]string{"portplane": body, "portplane-window": "new window"}),
			}, false)
			u := updater(t, "linux", srv.URL)
			pr := &progress{}
			if _, err := u.Apply(context.Background(), Detect(env("linux", filepath.Join(dir, "portplane"))), "0.6.0", pr); err == nil {
				t.Fatal("no error")
			}
			if read(t, filepath.Join(dir, "portplane")) != "version=0.5.0" || read(t, filepath.Join(dir, "portplane-window")) != "old window" {
				t.Fatal("the old version is not back")
			}
			if entries, _ := os.ReadDir(dir); len(entries) != 2 {
				t.Fatalf("leftovers: %v", entries)
			}
			if !strings.Contains(pr.String(), "Put the previous version back") {
				t.Fatal(pr.String())
			}
		})
	}
}

func TestApplyMissingAsset(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "portplane"), "version=0.5.0")
	srv := release(t, map[string][]byte{}, false)
	u := updater(t, "linux", srv.URL)
	_, err := u.Apply(context.Background(), Detect(env("linux", filepath.Join(dir, "portplane"))), "0.6.0", &progress{})
	if err == nil || !strings.Contains(err.Error(), "has no portplane_0.6.0_linux_amd64.tar.gz") {
		t.Fatal(err)
	}
}

func TestApplyPackage(t *testing.T) {
	data := []byte("a deb")
	srv := release(t, map[string][]byte{"portplane_0.6.0_amd64.deb": data}, false)
	u := updater(t, "linux", srv.URL)
	exe := filepath.Join(t.TempDir(), "portplane")
	writeFile(t, exe, "version=0.5.0")
	var ran []string
	u.Privileged = func(_ context.Context, c privileged.Command, _ io.Writer) error {
		ran = c.Argv
		if b, err := os.ReadFile(c.Argv[2]); err != nil || !bytes.Equal(b, data) {
			t.Errorf("package not downloaded: %v", err)
		}
		writeFile(t, exe, "version=0.6.0")
		return nil
	}
	e := env("linux", exe)
	plan := Plan{Method: Deb, Auto: true, Password: true, exe: e.Exe}
	got, err := u.Apply(context.Background(), plan, "0.6.0", &progress{})
	if err != nil {
		t.Fatal(err)
	}
	if got != exe || len(ran) != 3 || ran[0] != "/usr/bin/dpkg" || ran[1] != "-i" {
		t.Fatal(got, ran)
	}

	u.Privileged = func(context.Context, privileged.Command, io.Writer) error { return privileged.ErrDenied }
	if _, err := u.Apply(context.Background(), plan, "0.6.0", &progress{}); err == nil || !strings.Contains(err.Error(), "nothing changed") {
		t.Fatal(err)
	}
}

func TestApplyRefusesManualPlans(t *testing.T) {
	u := updater(t, "linux", "http://127.0.0.1:1")
	p := Detect(env("darwin", "/opt/homebrew/Cellar/portplane/0.5.0/bin/portplane"))
	if _, err := u.Apply(context.Background(), p, "0.6.0", &progress{}); err == nil {
		t.Fatal("updated a Homebrew install")
	}
}

func TestCleanup(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "portplane")
	writeFile(t, exe, "x")
	for _, n := range []string{".portplane.old-1", ".portplane-window.old-2", ".portplane.new-3", ".portplane-update-4", ".profile", "dekit.old-1"} {
		writeFile(t, filepath.Join(dir, n), "x")
	}
	Cleanup(exe)
	var left []string
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		left = append(left, e.Name())
	}
	if !slices.Equal(left, []string{".profile", "dekit.old-1", "portplane"}) {
		t.Fatal(left)
	}
}
