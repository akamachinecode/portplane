package installer

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
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// progress records what an install reports.
type progress struct {
	mu    sync.Mutex
	steps []string
	skips []string
	out   bytes.Buffer
}

func (p *progress) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.out.Write(b)
}
func (p *progress) Step(n string) { p.mu.Lock(); p.steps = append(p.steps, n); p.mu.Unlock() }
func (p *progress) Skip(n string) { p.mu.Lock(); p.skips = append(p.skips, n); p.mu.Unlock() }
func (p *progress) Logf(f string, a ...any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	fmt.Fprintf(&p.out, f+"\n", a...)
}
func (p *progress) text() string { p.mu.Lock(); defer p.mu.Unlock(); return p.out.String() }

func sum(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func local(srv *httptest.Server) *Downloader {
	return &Downloader{Client: srv.Client(), Allow: func(u *url.URL) bool { return strings.HasPrefix(u.String(), srv.URL) }}
}

// ---- checksums and downloads ----

func TestParseSums(t *testing.T) {
	text := strings.Join([]string{
		sum([]byte("a")) + "  node-v24.1.0-linux-x64.tar.gz",
		strings.ToUpper(sum([]byte("b"))) + " *dekit-x86_64-unknown-linux-musl.tar.gz",
		"not a line",
		"abc  short-hash.txt",
		"",
	}, "\n")
	sums := ParseSums(text)
	if len(sums) != 2 {
		t.Fatalf("want 2 entries, got %v", sums)
	}
	if got, err := Expected(sums, "node-v24.1.0-linux-x64.tar.gz"); err != nil || got != sum([]byte("a")) {
		t.Errorf("node: %q %v", got, err)
	}
	if got, _ := Expected(sums, "dekit-x86_64-unknown-linux-musl.tar.gz"); got != sum([]byte("b")) {
		t.Errorf("binary-mode entry, lower-cased: %q", got)
	}
	if _, err := Expected(sums, "node-v24.1.0-win-x64.zip"); !errors.Is(err, ErrNoChecksum) {
		t.Errorf("missing entry: %v", err)
	}
}

func TestVerify(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(p, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Verify(p, sum([]byte("hello"))); err != nil {
		t.Errorf("good: %v", err)
	}
	var mm *MismatchError
	if err := Verify(p, sum([]byte("other"))); !errors.As(err, &mm) {
		t.Errorf("bad: %v", err)
	}
	if err := Verify(p, ""); !errors.Is(err, ErrNoChecksum) {
		t.Errorf("no checksum: %v", err)
	}
}

func TestDownloadFileChecksum(t *testing.T) {
	body := []byte("archive bytes")
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	}))
	defer srv.Close()
	d := local(srv)
	dir := t.TempDir()
	ctx := context.Background()

	good := filepath.Join(dir, "good")
	if err := d.File(ctx, srv.URL+"/x", good, sum(body), nil); err != nil {
		t.Fatalf("good: %v", err)
	}
	bad := filepath.Join(dir, "bad")
	var mm *MismatchError
	if err := d.File(ctx, srv.URL+"/x", bad, sum([]byte("tampered")), nil); !errors.As(err, &mm) {
		t.Fatalf("bad: %v", err)
	}
	if _, err := os.Stat(bad); !os.IsNotExist(err) {
		t.Error("a file that does not match is removed")
	}
	if err := d.File(ctx, srv.URL+"/x", filepath.Join(dir, "none"), "", nil); err == nil {
		t.Error("a download without a checksum is refused")
	}
}

func TestOfficialSourcesOnly(t *testing.T) {
	for _, c := range []struct {
		url string
		ok  bool
	}{
		{"https://dekit.run/install.sh", true},
		{"https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt", true},
		{"https://github.com/pvolok/dekit/releases/latest/download/SHA256SUMS", true},
		{"http://nodejs.org/dist/", false},
		{"https://nodejs.org.example.com/dist/", false},
		{"https://example.com/install.sh", false},
	} {
		u, _ := url.Parse(c.url)
		if Official(u) != c.ok {
			t.Errorf("%s: want %v", c.url, c.ok)
		}
	}
	var d Downloader
	if _, err := d.Fetch(context.Background(), "https://example.com/x", &bytes.Buffer{}, nil); !errors.Is(err, ErrNotOfficial) {
		t.Errorf("unofficial host: %v", err)
	}
}

func TestDownloadRefusesRedirectElsewhere(t *testing.T) {
	other := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("x")) }))
	defer other.Close()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/evil", http.StatusFound)
	}))
	defer srv.Close()
	d := local(srv)
	d.Client = &http.Client{Transport: srv.Client().Transport}
	if _, err := d.Fetch(context.Background(), srv.URL+"/x", &bytes.Buffer{}, nil); !errors.Is(err, ErrNotOfficial) {
		t.Errorf("redirect to another host: %v", err)
	}
}

// ---- archives ----

type entry struct {
	name, body, link string
	typ              byte
	mode             int64
}

func tarGz(t *testing.T, entries []entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		h := &tar.Header{Name: e.name, Typeflag: e.typ, Mode: e.mode, Linkname: e.link, Size: int64(len(e.body))}
		if h.Typeflag == 0 {
			h.Typeflag = tar.TypeReg
		}
		if h.Typeflag != tar.TypeReg {
			h.Size = 0
		}
		if h.Mode == 0 {
			h.Mode = 0o644
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			_, _ = tw.Write([]byte(e.body))
		}
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

func TestExtractTarGz(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	dest := t.TempDir()
	data := tarGz(t, []entry{
		{name: "node-v24.1.0-linux-x64/", typ: tar.TypeDir, mode: 0o755},
		{name: "node-v24.1.0-linux-x64/bin/node", body: "#!/bin/sh\n", mode: 0o755},
		{name: "node-v24.1.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js", body: "cli"},
		{name: "node-v24.1.0-linux-x64/bin/npm", typ: tar.TypeSymlink, link: "../lib/node_modules/npm/bin/npm-cli.js"},
		{name: "node-v24.1.0-linux-x64/bin/nodejs", typ: tar.TypeLink, link: "node-v24.1.0-linux-x64/bin/node"},
	})
	if err := ExtractTarGz(bytes.NewReader(data), dest, 1); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(dest, "bin", "node"))
	if err != nil || fi.Mode()&0o111 == 0 {
		t.Fatalf("node is executable: %v %v", fi, err)
	}
	if b, err := os.ReadFile(filepath.Join(dest, "bin", "npm")); err != nil || string(b) != "cli" {
		t.Errorf("npm link: %q %v", b, err)
	}
	if b, err := os.ReadFile(filepath.Join(dest, "bin", "nodejs")); err != nil || string(b) != "#!/bin/sh\n" {
		t.Errorf("hard link: %q %v", b, err)
	}
}

func TestExtractRefusesTraversal(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	cases := map[string][]entry{
		"dot-dot":         {{name: "top/../../evil", body: "x"}},
		"absolute":        {{name: "/tmp/evil", body: "x"}},
		"absolute link":   {{name: "top/l", typ: tar.TypeSymlink, link: "/etc"}},
		"link out":        {{name: "top/l", typ: tar.TypeSymlink, link: "../../.."}},
		"link chain":      {{name: "top/a", typ: tar.TypeSymlink, link: "."}, {name: "top/a/b", typ: tar.TypeSymlink, link: ".."}, {name: "top/a/b/evil", body: "x"}},
		"through a link":  {{name: "top/a", typ: tar.TypeSymlink, link: "."}, {name: "top/a/b", typ: tar.TypeSymlink, link: ".."}},
		"hard link out":   {{name: "top/h", typ: tar.TypeLink, link: "../../etc/passwd"}},
		"windows drive":   {{name: `C:\evil`, body: "x"}},
		"backslash climb": {{name: `top\..\..\evil`, body: "x"}},
	}
	for name, entries := range cases {
		t.Run(name, func(t *testing.T) {
			parent := t.TempDir()
			dest := filepath.Join(parent, "dest")
			err := ExtractTarGz(bytes.NewReader(tarGz(t, entries)), dest, 1)
			if !errors.Is(err, ErrUnsafePath) {
				t.Fatalf("want ErrUnsafePath, got %v", err)
			}
			if _, err := os.Stat(filepath.Join(parent, "evil")); err == nil {
				t.Error("a file landed outside the destination")
			}
		})
	}
}

func TestExtractZip(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, files map[string]string) string {
		p := filepath.Join(dir, name)
		f, _ := os.Create(p)
		zw := zip.NewWriter(f)
		for n, body := range files {
			w, _ := zw.Create(n)
			_, _ = w.Write([]byte(body))
		}
		_ = zw.Close()
		_ = f.Close()
		return p
	}
	good := write("good.zip", map[string]string{"node-v24.1.0-win-x64/node.exe": "MZ", "node-v24.1.0-win-x64/npm.cmd": "@echo"})
	dest := filepath.Join(dir, "out")
	if err := ExtractZip(good, dest, 1); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "node.exe")); string(b) != "MZ" {
		t.Errorf("node.exe: %q", b)
	}
	bad := write("bad.zip", map[string]string{"top/../../evil.txt": "x"})
	if err := ExtractZip(bad, filepath.Join(dir, "out2"), 1); !errors.Is(err, ErrUnsafePath) {
		t.Errorf("zip slip: %v", err)
	}
}

// ---- origins ----

func TestDetectOrigin(t *testing.T) {
	home := "/home/dev"
	links := map[string]string{
		"/home/linuxbrew/.linuxbrew/bin/dekit":      "/home/linuxbrew/.linuxbrew/Cellar/dekit/0.10.3/bin/dekit",
		"/opt/homebrew/bin/portless":                "/opt/homebrew/Cellar/portless/0.16.0/libexec/lib/node_modules/portless/dist/cli.js",
		"/home/dev/.local/share/mise/shims/node":    "/home/dev/.local/share/mise/installs/node/24.1.0/bin/node",
		"/home/dev/.npm-global/bin/portless":        "/home/dev/.npm-global/lib/node_modules/portless/dist/cli.js",
		"/home/dev/.nvm/versions/node/v24/bin/node": "/home/dev/.nvm/versions/node/v24/bin/node",
	}
	files := map[string]string{
		"/home/dev/.local/share/dekit/install": "/home/dev/.local/bin/dekit\n",
		"/home/dev/.local/bin/portless":        "#!/bin/sh\n# " + ShimMarker + ": runs portless\n",
		"/home/dev/.local/bin/dekit-pip":       "#!/usr/bin/python3\nimport dekit\n",
	}
	env := OriginEnv{
		GOOS: "linux", Home: home, DataDir: "/home/dev/.local/share/portplane",
		DekitReceipt: "/home/dev/.local/share/dekit/install",
		Resolve: func(p string) (string, error) {
			if t, ok := links[p]; ok {
				return t, nil
			}
			return p, nil
		},
		ReadFile: func(p string) ([]byte, error) {
			if b, ok := files[p]; ok {
				return []byte(b), nil
			}
			return nil, os.ErrNotExist
		},
	}
	for _, c := range []struct {
		tool, path, kind string
		update           string
	}{
		{Dekit, "/home/dev/.local/bin/dekit", "script", "dekit update"},
		{Dekit, "/home/linuxbrew/.linuxbrew/bin/dekit", "homebrew", "brew upgrade dekit"},
		{Dekit, "/home/dev/.local/bin/dekit-pip", "pip", "pip install --upgrade dekit"},
		{Portless, "/opt/homebrew/bin/portless", "homebrew", "brew upgrade portless"},
		{Portless, "/home/dev/.npm-global/bin/portless", "npm", "npm install -g portless@latest"},
		{Portless, "/home/dev/.local/bin/portless", "portplane", ""},
		{Node, "/home/dev/.local/share/mise/shims/node", "mise", "mise use -g node@24"},
		{Node, "/home/dev/.nvm/versions/node/v24/bin/node", "nvm", "nvm install 24"},
		{Node, "/home/dev/.local/share/portplane/node/v24.1.0/bin/node", "portplane", ""},
		{Node, "/usr/bin/node", "system", ""},
		{Node, "/opt/odd/node", "other", ""},
	} {
		o := DetectOrigin(c.tool, c.path, env)
		if o.Kind != c.kind || strings.Join(o.Update, " ") != c.update || o.Label == "" {
			t.Errorf("%s %s: got %+v, want %s (%q)", c.tool, c.path, o, c.kind, c.update)
		}
	}
	if o := DetectOrigin(Dekit, "", env); o.Kind != "" {
		t.Errorf("missing tool: %+v", o)
	}
	win := OriginEnv{GOOS: "windows", Home: `C:\Users\dev`, DataDir: `C:\Users\dev\AppData\Local\portplane`, Resolve: func(p string) (string, error) { return p, nil }, ReadFile: func(string) ([]byte, error) { return nil, os.ErrNotExist }}
	if o := DetectOrigin(Node, `C:\Program Files\nodejs\node.exe`, win); o.Kind != "system" {
		t.Errorf("windows node: %+v", o)
	}
	if o := DetectOrigin(Node, `C:\Users\dev\AppData\Local\portplane\node\v24.1.0\node.exe`, win); o.Kind != "portplane" {
		t.Errorf("windows private node: %+v", o)
	}
}

// ---- PATH ----

func TestProfileFor(t *testing.T) {
	home := "/home/dev"
	dir := "/home/dev/.local/bin"
	for _, c := range []struct{ goos, shell, file, line string }{
		{"linux", "/bin/zsh", "/home/dev/.zshrc", `export PATH="$HOME/.local/bin:$PATH"`},
		{"linux", "/bin/bash", "/home/dev/.bashrc", `export PATH="$HOME/.local/bin:$PATH"`},
		{"darwin", "/bin/bash", "/home/dev/.bash_profile", `export PATH="$HOME/.local/bin:$PATH"`},
		{"linux", "/usr/bin/fish", "/home/dev/.config/fish/conf.d/portplane.fish", "contains -- $HOME/.local/bin $PATH; or set -gx PATH $HOME/.local/bin $PATH"},
		{"linux", "/bin/dash", "/home/dev/.profile", `export PATH="$HOME/.local/bin:$PATH"`},
	} {
		_, file, line := ProfileFor(c.goos, c.shell, home, dir)
		if filepath.ToSlash(file) != c.file || line != c.line {
			t.Errorf("%s %s: %s %q", c.goos, c.shell, file, line)
		}
	}
}

func TestAddLineIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, ".zshrc")
	original := "alias ll='ls -l'\nexport EDITOR=vim" // no final newline
	if err := os.WriteFile(file, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	line := `export PATH="$HOME/.local/bin:$PATH"`
	changed, err := AddLine(file, line)
	if err != nil || !changed {
		t.Fatalf("first add: %v %v", changed, err)
	}
	changed, err = AddLine(file, line)
	if err != nil || changed {
		t.Fatalf("second add changes nothing: %v %v", changed, err)
	}
	b, _ := os.ReadFile(file)
	want := original + "\n\n" + ProfileMarker + "\n" + line + "\n"
	if string(b) != want {
		t.Errorf("content:\n%s\nwant:\n%s", b, want)
	}
	if strings.Count(string(b), line) != 1 {
		t.Error("the line is there once")
	}
	if fi, _ := os.Stat(file); runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
		t.Errorf("mode kept: %v", fi.Mode())
	}

	// A user who already has the line (written by hand) gets nothing new.
	own := filepath.Join(dir, ".bashrc")
	_ = os.WriteFile(own, []byte("  "+line+"  \n"), 0o644)
	if changed, _ := AddLine(own, line); changed {
		t.Error("an existing line is recognised")
	}

	// A missing fish conf.d file is created with its folder.
	fish := filepath.Join(dir, ".config", "fish", "conf.d", "portplane.fish")
	if changed, err := AddLine(fish, "set -gx PATH x $PATH"); err != nil || !changed {
		t.Fatalf("new file: %v %v", changed, err)
	}
	b, _ = os.ReadFile(fish)
	if string(b) != ProfileMarker+"\nset -gx PATH x $PATH\n" {
		t.Errorf("new file content: %q", b)
	}
}

func TestOnPathList(t *testing.T) {
	if !onPathList("linux", "/usr/bin:/home/dev/.local/bin/:/bin", "/home/dev/.local/bin", "/home/dev") {
		t.Error("trailing slash")
	}
	if !onPathList("linux", "~/.local/bin:/bin", "/home/dev/.local/bin", "/home/dev") {
		t.Error("tilde")
	}
	if onPathList("linux", "/usr/bin:/bin", "/home/dev/.local/bin", "/home/dev") {
		t.Error("absent")
	}
	if !onPathList("windows", `C:\Windows;c:\users\dev\.local\bin`, `C:\Users\dev\.local\bin`, "") {
		t.Error("windows is case-insensitive")
	}
}

// ---- versions ----

func TestVersions(t *testing.T) {
	if Major("v24.11.0") != 24 || Major("dekit 0.10.3") != 0 || Major("node") != 0 {
		t.Error("Major")
	}
	if CompareVersions("dekit 0.10.3", "0.9.9") != 1 || CompareVersions("0.16.0", "portless 0.16.0") != 0 || CompareVersions("", "0.1.0") != -1 {
		t.Error("CompareVersions")
	}
	if CleanVersion("dekit 0.10.3\n") != "0.10.3" || CleanVersionV("24.1.0") != "v24.1.0" {
		t.Error("CleanVersion")
	}
}

func TestDataDir(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if got := filepath.ToSlash(DataDir("linux", "/home/dev", env(nil))); got != "/home/dev/.local/share/portplane" {
		t.Error(got)
	}
	if got := filepath.ToSlash(DataDir("linux", "/home/dev", env(map[string]string{"XDG_DATA_HOME": "/data"}))); got != "/data/portplane" {
		t.Error(got)
	}
	if got := filepath.ToSlash(DataDir("darwin", "/Users/dev", env(nil))); got != "/Users/dev/Library/Application Support/portplane" {
		t.Error(got)
	}
	if got := DataDir("windows", `C:\Users\dev`, env(map[string]string{"LOCALAPPDATA": `C:\Users\dev\AppData\Local`})); !strings.HasSuffix(got, "portplane") {
		t.Error(got)
	}
}
