package installer

import (
	"archive/tar"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// These tests install into a temporary home from an httptest server, with
// shell scripts standing in for node, npm and dekit's installer.

func unixOnly(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fakes are shell scripts")
	}
}

func testInstaller(t *testing.T, srv *httptest.Server) *Installer {
	t.Helper()
	home := t.TempDir()
	in := &Installer{
		GOOS: runtime.GOOS, GOARCH: "amd64",
		Home:    home,
		BinDir:  filepath.Join(home, ".local", "bin"),
		DataDir: filepath.Join(home, ".local", "share", "portplane"),
		Run:     RunProcess,
		Environ: func() []string {
			return []string{"HOME=" + home, "PATH=/usr/bin:/bin", "XDG_DATA_HOME=" + filepath.Join(home, ".local", "share")}
		},
		Lookup: func(string) string { return "" },
	}
	if srv != nil {
		in.HTTP = local(srv)
		in.Sources = Sources{DekitScripts: srv.URL, NodeDist: srv.URL + "/dist"}
	}
	return in
}

const fakeNode = `#!/bin/sh
# a stand-in for node: --version, or run a "script" that prints its own version
if [ "$1" = "--version" ]; then echo v24.9.1; exit 0; fi
if [ -f "$1" ]; then script="$1"; shift; exec sh "$script" "$@"; fi
exit 0
`

func nodeServer(t *testing.T, tamper bool) *httptest.Server {
	t.Helper()
	archive := tarGz(t, []entry{
		{name: "node-v24.9.1-" + plat() + "/bin/node", body: fakeNode, mode: 0o755},
		{name: "node-v24.9.1-" + plat() + "/bin/npm", body: "#!/bin/sh\n", mode: 0o755},
	})
	listed := archive
	if tamper {
		listed = []byte("something else")
	}
	sums := fmt.Sprintf("%s  node-v24.8.0-%s.tar.gz\n%s  node-v24.9.1-%s.tar.gz\n%s  node-v24.9.1-win-x64.zip\n",
		sum([]byte("old")), plat(), sum(listed), plat(), sum([]byte("zip")))
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/dist/latest-v24.x/SHASUMS256.txt":
			_, _ = w.Write([]byte(sums))
		case "/dist/v24.9.1/node-v24.9.1-" + plat() + ".tar.gz":
			_, _ = w.Write(archive)
		default:
			http.NotFound(w, r)
		}
	}))
}

func plat() string {
	if runtime.GOOS == "darwin" {
		return "darwin-x64"
	}
	return "linux-x64"
}

func TestInstallPrivateNode(t *testing.T) {
	unixOnly(t)
	srv := nodeServer(t, false)
	defer srv.Close()
	in := testInstaller(t, srv)
	var used []string
	in.UseDir = func(dir string, first bool) {
		if first {
			t.Error("Portplane's Node never goes before the user's folders on PATH")
		}
		used = append(used, dir)
	}
	p := &progress{}
	got, err := in.InstallNode(context.Background(), p, "")
	if err != nil {
		t.Fatalf("%v\n%s", err, p.text())
	}
	want := filepath.Join(in.DataDir, "node", "v24.9.1", "bin", "node")
	if got.Path != want || got.Version != "v24.9.1" || !got.Private {
		t.Errorf("got %+v", got)
	}
	if len(used) != 1 || used[0] != filepath.Dir(want) {
		t.Errorf("node's folder is added to PATH: %v", used)
	}
	if strings.Join(p.steps, "|") != strings.Join(NodeSteps(""), "|") {
		t.Errorf("steps: %v", p.steps)
	}
	if path, v := in.PrivateNode(); path != want || v != "v24.9.1" {
		t.Errorf("PrivateNode: %s %s", path, v)
	}
	// Leftovers of the download are gone.
	entries, _ := os.ReadDir(in.NodeDir())
	if len(entries) != 1 {
		t.Errorf("node dir: %v", entries)
	}

	// Again: nothing to download.
	p2 := &progress{}
	if _, err := in.InstallNode(context.Background(), p2, "private"); err != nil {
		t.Fatal(err)
	}
	if len(p2.skips) != 3 {
		t.Errorf("second install skips download, verify and unpack: %v", p2.skips)
	}
}

func TestInstallPrivateNodeRefusesBadChecksum(t *testing.T) {
	unixOnly(t)
	srv := nodeServer(t, true)
	defer srv.Close()
	in := testInstaller(t, srv)
	p := &progress{}
	_, err := in.InstallNode(context.Background(), p, "")
	var mm *MismatchError
	if !errors.As(err, &mm) {
		t.Fatalf("want a checksum mismatch, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(in.NodeDir(), "v24.9.1")); !os.IsNotExist(err) {
		t.Error("nothing is unpacked")
	}
	if p.steps[len(p.steps)-1] != StepNodeVerify {
		t.Errorf("fails at the verify step: %v", p.steps)
	}
}

func TestLatestNodeMissingEntry(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "%s  node-v24.9.1-aix-ppc64.tar.gz\n", sum([]byte("x")))
	}))
	defer srv.Close()
	in := testInstaller(t, srv)
	in.GOOS = "linux"
	if _, err := in.LatestNode(context.Background()); !errors.Is(err, ErrNoChecksum) {
		t.Errorf("no build for this machine: %v", err)
	}
	in.GOOS, in.GOARCH = "plan9", "amd64"
	if _, err := in.LatestNode(context.Background()); err == nil {
		t.Error("an OS without Node builds")
	}
}

func TestLatestNodeWindowsArmFallsBack(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "%s  node-v24.9.1-win-x64.zip\n", sum([]byte("x")))
	}))
	defer srv.Close()
	in := testInstaller(t, srv)
	in.GOOS, in.GOARCH = "windows", "arm64"
	rel, err := in.LatestNode(context.Background())
	if err != nil || rel.File != "node-v24.9.1-win-x64.zip" || !strings.HasSuffix(rel.URL, "/dist/v24.9.1/node-v24.9.1-win-x64.zip") {
		t.Errorf("%+v %v", rel, err)
	}
}

// fakeDekitInstaller does what dekit's install.sh does, without a network.
const fakeDekitInstaller = `#!/bin/sh
set -eu
install_dir=${DEKIT_INSTALL_DIR:-"$HOME/.local/bin"}
mkdir -p "$install_dir"
printf '#!/bin/sh\necho "dekit 0.10.3"\n' > "$install_dir/dekit"
chmod 755 "$install_dir/dekit"
data_dir=${XDG_DATA_HOME:-"$HOME/.local/share"}/dekit
mkdir -p "$data_dir"
printf '%s\n' "$install_dir/dekit" > "$data_dir/install"
echo "dekit 0.10.3 installed to $install_dir/dekit"
`

func TestInstallDekit(t *testing.T) {
	unixOnly(t)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/install.sh" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(fakeDekitInstaller))
	}))
	defer srv.Close()
	in := testInstaller(t, srv)
	p := &progress{}
	got, err := in.InstallDekit(context.Background(), p)
	if err != nil {
		t.Fatalf("%v\n%s", err, p.text())
	}
	if got.Path != filepath.Join(in.BinDir, "dekit") || got.Version != "0.10.3" {
		t.Errorf("got %+v", got)
	}
	out := p.text()
	for _, want := range []string{"installed to", "SHA-256", "Install receipt"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	o := DetectOrigin(Dekit, got.Path, in.OriginEnv())
	if o.Kind != "script" {
		t.Errorf("origin after install: %+v", o)
	}
}

func TestInstallDekitFailures(t *testing.T) {
	unixOnly(t)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/fails/install.sh":
			_, _ = w.Write([]byte("#!/bin/sh\necho 'dekit: checksum mismatch for dekit.tar.gz' >&2\nexit 1\n"))
		case "/html/install.sh":
			_, _ = w.Write([]byte("<html>not a script</html>"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	for name, want := range map[string]string{"fails": "installer failed", "html": "did not return an installer script", "missing": "404"} {
		in := testInstaller(t, srv)
		in.Sources.DekitScripts = srv.URL + "/" + name
		p := &progress{}
		_, err := in.InstallDekit(context.Background(), p)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", name, err)
		}
		if name == "fails" && !strings.Contains(p.text(), "checksum mismatch") {
			t.Errorf("the installer's output reaches the job:\n%s", p.text())
		}
	}
}

// fakeNPM handles `npm prefix -g` and `npm install -g [--prefix P] portless`.
func fakeNPM(globalPrefix string) string {
	return `#!/bin/sh
if [ "$1" = "prefix" ]; then echo "` + globalPrefix + `"; exit 0; fi
prefix="` + globalPrefix + `"
if [ "$3" = "--prefix" ]; then prefix="$4"; fi
pkg="$prefix/lib/node_modules/portless"
mkdir -p "$pkg/dist" "$prefix/bin"
printf '{"name":"portless","bin":{"portless":"./dist/cli.js"}}' > "$pkg/package.json"
printf 'echo 0.16.0\n' > "$pkg/dist/cli.js"
printf '#!/bin/sh\necho 0.16.0\n' > "$prefix/bin/portless"
chmod 755 "$prefix/bin/portless"
echo "added 1 package"
`
}

func setupNode(t *testing.T, dir, npmScript string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	node := filepath.Join(dir, "node")
	if err := os.WriteFile(node, []byte(fakeNode), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "npm"), []byte(npmScript), 0o755); err != nil {
		t.Fatal(err)
	}
	return node
}

func TestInstallPortlessPrivate(t *testing.T) {
	unixOnly(t)
	in := testInstaller(t, nil)
	// Portplane's private Node, as InstallNode leaves it.
	setupNode(t, filepath.Join(in.NodeDir(), "v24.9.1", "bin"), fakeNPM("/nonexistent"))
	p := &progress{}
	got, err := in.InstallPortless(context.Background(), p, "")
	if err != nil {
		t.Fatalf("%v\n%s", err, p.text())
	}
	if got.Method != "private" || got.Path != filepath.Join(in.BinDir, "portless") || got.Version != "0.16.0" {
		t.Errorf("got %+v", got)
	}
	shim, _ := os.ReadFile(got.Path)
	if !strings.Contains(string(shim), ShimMarker) || !strings.Contains(string(shim), filepath.Join(in.PortlessPrefix(), "lib", "node_modules", "portless", "dist", "cli.js")) {
		t.Errorf("shim:\n%s", shim)
	}
	if o := DetectOrigin(Portless, got.Path, in.OriginEnv()); o.Kind != "portplane" {
		t.Errorf("origin: %+v", o)
	}
	// Installing again rewrites Portplane's own launcher.
	if _, err := in.InstallPortless(context.Background(), &progress{}, "private"); err != nil {
		t.Errorf("reinstall: %v", err)
	}
}

func TestInstallPortlessWithUserNPM(t *testing.T) {
	unixOnly(t)
	in := testInstaller(t, nil)
	prefix := filepath.Join(in.Home, ".npm-global")
	node := setupNode(t, filepath.Join(in.Home, "nodejs", "bin"), fakeNPM(prefix))
	in.Lookup = func(name string) string {
		if name == "node" {
			return node
		}
		return ""
	}
	p := &progress{}
	got, err := in.InstallPortless(context.Background(), p, "")
	if err != nil {
		t.Fatalf("%v\n%s", err, p.text())
	}
	if got.Method != "npm" || got.Path != filepath.Join(prefix, "bin", "portless") {
		t.Errorf("got %+v", got)
	}
	if _, err := os.Stat(filepath.Join(in.BinDir, "portless")); !os.IsNotExist(err) {
		t.Error("no launcher with the user's own npm")
	}
}

func TestInstallPortlessNeedsNode(t *testing.T) {
	unixOnly(t)
	in := testInstaller(t, nil)
	old := filepath.Join(in.Home, "old")
	_ = os.MkdirAll(old, 0o755)
	_ = os.WriteFile(filepath.Join(old, "node"), []byte("#!/bin/sh\necho v20.11.0\n"), 0o755)
	in.Lookup = func(name string) string {
		if name == "node" {
			return filepath.Join(old, "node")
		}
		return ""
	}
	_, err := in.InstallPortless(context.Background(), &progress{}, "")
	if err == nil || !strings.Contains(err.Error(), "v20.11.0") {
		t.Errorf("an old Node is named: %v", err)
	}
	info := in.FindNode(context.Background())
	if info.OK() || info.UserVersion != "v20.11.0" {
		t.Errorf("FindNode: %+v", info)
	}
}

func TestWriteShimLeavesOthersAlone(t *testing.T) {
	in := testInstaller(t, nil)
	_ = os.MkdirAll(in.BinDir, 0o755)
	name := "portless"
	if in.GOOS == "windows" {
		name += ".cmd"
	}
	theirs := filepath.Join(in.BinDir, name)
	_ = os.WriteFile(theirs, []byte("#!/bin/sh\n# installed by hand\n"), 0o755)
	if _, err := in.WriteShim("/usr/bin/node", "/x/cli.js"); err == nil {
		t.Error("a portless Portplane did not write is never replaced")
	}
	b, _ := os.ReadFile(theirs)
	if !strings.Contains(string(b), "by hand") {
		t.Error("left as it was")
	}
}

func TestPlans(t *testing.T) {
	in := testInstaller(t, nil)
	in.Sources = OfficialSources()
	in.Lookup = func(name string) string {
		if name == "mise" {
			return "/usr/bin/mise"
		}
		return ""
	}
	d := in.DekitPlan()
	if d.Password || !strings.Contains(d.Source, "https://dekit.run/install.") || !strings.Contains(d.Checksum, "SHA256SUMS") || !strings.HasPrefix(d.Destination, "~") || len(d.Manual) != 1 {
		t.Errorf("dekit plan: %+v", d)
	}
	n := in.NodePlan()
	if n.Version != "24" || len(n.Alternatives) != 1 || n.Alternatives[0].Commands[0] != "mise use -g node@24" || n.Manual[0] != "mise use -g node@24" {
		t.Errorf("node plan: %+v", n)
	}
	p := in.PortlessPlan(context.Background(), NodeInfo{})
	if p.Method != "private" || !strings.Contains(p.Destination, "launcher") {
		t.Errorf("portless plan without Node: %+v", p)
	}
}

func TestTarEntriesForNode(t *testing.T) {
	// The shape of a real Node archive: one top folder, stripped.
	data := tarGz(t, []entry{{name: "node-v24.9.1-linux-x64/", typ: tar.TypeDir}, {name: "node-v24.9.1-linux-x64/README.md", body: "hi"}})
	dest := t.TempDir()
	f := filepath.Join(dest, "a.tgz")
	_ = os.WriteFile(f, data, 0o600)
	r, _ := os.Open(f)
	defer func() { _ = r.Close() }()
	if err := ExtractTarGz(r, filepath.Join(dest, "out"), 1); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dest, "out", "README.md")); err != nil {
		t.Error(err)
	}
}
