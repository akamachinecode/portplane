// Package selfupdate replaces the running Portplane with a newer release
// when the user clicks "Update and restart" (ADR-0031). It finds out how
// this copy was installed and updates it the same way:
//
//   - an archive (install.sh, install.ps1, an unpacked .tar.gz or .zip): the
//     binaries in their folder are swapped for the release's;
//   - Portplane.app on macOS: the whole bundle is swapped for the one in the
//     release's .dmg;
//   - a .deb or .rpm: the release's package is installed with the system's
//     password dialog;
//   - Homebrew, a development build or a folder the user can't write to:
//     Portplane says how to update and does nothing itself.
//
// Every download is checked against the release's checksums.txt. After a
// swap, the new binary must run and report the new version, or the old one
// is put back.
package selfupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/akamachinecode/portplane/internal/installer"
	"github.com/akamachinecode/portplane/internal/privileged"
)

// Where releases come from (ADR-0025: GitHub, Portplane's releases).
const (
	Repo         = "akamachinecode/portplane"
	ReleasesBase = "https://github.com/" + Repo + "/releases/download"
	ReleasesPage = "https://github.com/" + Repo + "/releases"
	installSh    = "curl -fsSL https://akamachinecode.github.io/portplane/install.sh | sh"
	installPs1   = "irm https://akamachinecode.github.io/portplane/install.ps1 | iex"
)

// Method is how this copy of Portplane was installed, and so how it updates.
type Method string

const (
	Archive  Method = "archive"  // binaries in a folder: swap them
	App      Method = "app"      // Portplane.app on macOS: swap the bundle
	Deb      Method = "deb"      // the .deb: dpkg installs the new one
	RPM      Method = "rpm"      // the .rpm: rpm installs the new one
	Homebrew Method = "homebrew" // brew upgrades it
	Manual   Method = "manual"   // Portplane can't: the user downloads it
)

// Plan says how the running Portplane gets a new version.
type Plan struct {
	Method Method `json:"method"`
	// Auto is true when "Update and restart" can do it.
	Auto bool `json:"auto"`
	// Password is true when it asks for the administrator password.
	Password bool `json:"password,omitempty"`
	// Where is what gets replaced: a folder, an app or a package.
	Where string `json:"where,omitempty"`
	// Reason says why Portplane can't update itself; empty when Auto.
	Reason string `json:"reason,omitempty"`
	// Command updates Portplane from a terminal, when there is one.
	Command string `json:"command,omitempty"`

	exe    string // the running binary, symlinks resolved
	target string // the folder (Archive) or the bundle (App)
}

// Env is what Detect looks at. Tests fake it.
type Env struct {
	GOOS, GOARCH string
	// Exe is the running binary with symlinks resolved.
	Exe string
	// Version is the running version (buildinfo).
	Version string
	// Writable reports whether Portplane can create files in dir.
	Writable func(dir string) bool
	// Exists reports whether a file exists.
	Exists func(path string) bool
	// RPMOwns reports whether an rpm package installed path.
	RPMOwns func(path string) bool
	// CanAskPassword is privileged.Available.
	CanAskPassword bool
}

// LocalEnv is this computer and this binary.
func LocalEnv(ctx context.Context, version string) Env {
	exe, err := os.Executable()
	if err == nil {
		if r, rerr := filepath.EvalSymlinks(exe); rerr == nil {
			exe = r
		}
	} else {
		exe = ""
	}
	return Env{
		GOOS: runtime.GOOS, GOARCH: runtime.GOARCH,
		Exe:      exe,
		Version:  version,
		Writable: Writable,
		Exists: func(p string) bool {
			_, err := os.Stat(p)
			return err == nil
		},
		RPMOwns: func(p string) bool {
			if _, err := os.Stat("/usr/bin/rpm"); err != nil {
				return false
			}
			return installer.RunProcess(ctx, "", os.Environ(), io.Discard, "/usr/bin/rpm", "-qf", p) == nil
		},
		CanAskPassword: privileged.Available(),
	}
}

// Writable reports whether files can be created in dir, by creating one.
func Writable(dir string) bool {
	f, err := os.CreateTemp(dir, ".portplane-write-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

var releaseVersion = regexp.MustCompile(`^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`)

// IsRelease reports whether v is a release version, not a development build.
func IsRelease(v string) bool {
	return releaseVersion.MatchString(v) && !strings.Contains(v, "SNAPSHOT")
}

// Detect works out how the running Portplane updates.
func Detect(e Env) Plan {
	if !IsRelease(e.Version) {
		return Plan{Method: Manual, Reason: "This is a development build (" + e.Version + "): build it again, or install a release."}
	}
	if e.Exe == "" {
		return Plan{Method: Manual, Reason: "Portplane couldn't find where it is installed.", Command: installCommand(e.GOOS)}
	}
	exe := filepath.ToSlash(e.Exe)
	if strings.Contains(exe, "/Cellar/") || strings.HasPrefix(exe, "/opt/homebrew/") || strings.HasPrefix(exe, "/home/linuxbrew/") {
		return Plan{Method: Homebrew, Where: e.Exe, Reason: "Homebrew installed Portplane, so Homebrew updates it.", Command: "brew upgrade portplane", exe: e.Exe}
	}
	if e.GOOS == "darwin" {
		if app := bundleOf(e.Exe); app != "" {
			p := Plan{Method: App, Where: app, exe: e.Exe, target: app}
			if e.Writable(filepath.Dir(app)) && e.Writable(app) {
				p.Auto = true
			} else {
				p.Reason = "You can't change " + filepath.Dir(app) + ": download the new version and drag it there yourself."
			}
			return p
		}
	}
	if e.GOOS == "linux" && strings.HasPrefix(exe, "/usr/") && !strings.HasPrefix(exe, "/usr/local/") {
		switch {
		case e.Exists("/var/lib/dpkg/info/portplane.list"):
			return packagePlan(e, Deb, "sudo dpkg -i "+PackageName(Deb, "<version>", e.GOARCH))
		case e.RPMOwns(e.Exe):
			return packagePlan(e, RPM, "sudo rpm -U "+PackageName(RPM, "<version>", e.GOARCH))
		}
		return Plan{Method: Manual, Where: e.Exe, Reason: "Your system manages " + filepath.Dir(e.Exe) + ": update Portplane the way you installed it.", exe: e.Exe}
	}
	dir := filepath.Dir(e.Exe)
	p := Plan{Method: Archive, Where: dir, exe: e.Exe, target: dir}
	if e.Writable(dir) {
		p.Auto = true
	} else {
		p.Reason = "You can't change " + dir + "."
		p.Command = installCommand(e.GOOS)
	}
	return p
}

func packagePlan(e Env, m Method, command string) Plan {
	p := Plan{Method: m, Password: true, Where: "the portplane package", Command: command, exe: e.Exe}
	if e.CanAskPassword {
		p.Auto = true
	} else {
		p.Reason = "This system can't show a password dialog: download the package from the release and install it from a terminal."
	}
	return p
}

func installCommand(goos string) string {
	if goos == "windows" {
		return installPs1
	}
	return installSh
}

// bundleOf returns the .app that holds exe (…/X.app/Contents/MacOS/exe),
// or "".
func bundleOf(exe string) string {
	macos := filepath.Dir(exe)
	contents := filepath.Dir(macos)
	app := filepath.Dir(contents)
	if filepath.Base(macos) == "MacOS" && filepath.Base(contents) == "Contents" && strings.HasSuffix(app, ".app") {
		return app
	}
	return ""
}

// Asset is the release file a method installs from.
func Asset(m Method, version, goos, goarch string) string {
	switch m {
	case App:
		return fmt.Sprintf("portplane_%s_darwin_%s.dmg", version, goarch)
	case Deb, RPM:
		return PackageName(m, version, goarch)
	}
	ext := "tar.gz"
	if goos == "windows" {
		ext = "zip"
	}
	return fmt.Sprintf("portplane_%s_%s_%s.%s", version, goos, goarch, ext)
}

// PackageName is the name nfpm gives the .deb or .rpm of a release.
func PackageName(m Method, version, goarch string) string {
	if m == RPM {
		arch := map[string]string{"amd64": "x86_64", "arm64": "aarch64"}[goarch]
		if arch == "" {
			arch = goarch
		}
		return fmt.Sprintf("portplane-%s-1.%s.rpm", version, arch)
	}
	return fmt.Sprintf("portplane_%s_%s.deb", version, goarch)
}

// Steps are the stages of an update, for the job's progress.
func Steps(p Plan, version string) []string {
	steps := []string{"Download Portplane " + version}
	switch p.Method {
	case Deb, RPM:
		steps = append(steps, "Install the package")
	default:
		steps = append(steps, "Replace Portplane")
	}
	return append(steps, "Check the new version", "Restart Portplane")
}

// StepRestart is the last step, which the caller runs.
const StepRestart = "Restart Portplane"

// Updater installs a release. The zero value is not usable; see New.
type Updater struct {
	GOOS, GOARCH string
	// Base is where release files are: ReleasesBase.
	Base string
	HTTP *installer.Downloader
	// Run runs a program (hdiutil, ditto, the new binary).
	Run installer.Runner
	// Privileged runs a command as administrator (privileged.Run).
	Privileged func(ctx context.Context, c privileged.Command, out io.Writer) error
	// Work is a private folder for downloads.
	Work string
}

// New returns the updater for this computer.
func New() *Updater {
	cache, err := os.UserCacheDir()
	if err != nil {
		cache = os.TempDir()
	}
	return &Updater{
		GOOS: runtime.GOOS, GOARCH: runtime.GOARCH,
		Base:       ReleasesBase,
		HTTP:       &installer.Downloader{},
		Run:        installer.RunProcess,
		Privileged: privileged.Run,
		Work:       filepath.Join(cache, "portplane", "update"),
	}
}

// Apply installs version following p and returns the binary to start. It
// reports its stages through pr, except the last one (StepRestart), which
// the caller runs.
func (u *Updater) Apply(ctx context.Context, p Plan, version string, pr installer.Progress) (string, error) {
	if !p.Auto {
		return "", errors.New(p.Reason)
	}
	version = strings.TrimPrefix(version, "v")
	if !IsRelease(version) {
		return "", fmt.Errorf("%q is not a release version", version)
	}
	steps := Steps(p, version)
	pr.Step(steps[0])
	if err := os.MkdirAll(u.Work, 0o700); err != nil {
		return "", err
	}
	work, err := os.MkdirTemp(u.Work, "v"+version+"-")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.RemoveAll(work) }()
	asset := Asset(p.Method, version, u.GOOS, u.GOARCH)
	file, err := u.download(ctx, version, asset, work, pr)
	if err != nil {
		return "", err
	}

	pr.Step(steps[1])
	switch p.Method {
	case Archive:
		return u.applyArchive(ctx, p, version, file, pr)
	case App:
		return u.applyApp(ctx, p, version, file, work, pr)
	case Deb, RPM:
		return u.applyPackage(ctx, p, version, file, pr)
	}
	return "", fmt.Errorf("no way to update an install made with %s", p.Method)
}

// download fetches checksums.txt and asset, and checks the asset against it.
func (u *Updater) download(ctx context.Context, version, asset, dir string, pr installer.Progress) (string, error) {
	base := strings.TrimSuffix(u.Base, "/") + "/v" + version + "/"
	pr.Logf("Downloading %s from %s", asset, base)
	sums, err := u.HTTP.Text(ctx, base+"checksums.txt")
	if err != nil {
		return "", err
	}
	want := checksumOf(sums, asset)
	if want == "" {
		return "", fmt.Errorf("the release v%s has no %s", version, asset)
	}
	path := filepath.Join(dir, asset)
	if err := u.HTTP.File(ctx, base+asset, path, want, logProgress(pr)); err != nil {
		return "", err
	}
	pr.Logf("SHA-256 matches checksums.txt: %s", want)
	return path, nil
}

func checksumOf(sums, name string) string {
	for _, line := range strings.Split(sums, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			return f[0]
		}
	}
	return ""
}

func logProgress(pr installer.Progress) installer.ProgressFunc {
	next := int64(0)
	return func(done, total int64) {
		if total <= 0 {
			return
		}
		pct := done * 100 / total
		if pct >= next {
			pr.Logf("%d%% of %.1f MB", pct, float64(total)/(1<<20))
			next = pct - pct%25 + 25
		}
	}
}

// checkVersion runs the new binary and makes sure it is version.
func (u *Updater) checkVersion(ctx context.Context, exe, version string, pr installer.Progress) error {
	var out strings.Builder
	if err := u.Run(ctx, "", os.Environ(), &out, exe, "version", "--json"); err != nil {
		return fmt.Errorf("the new Portplane didn't run: %w", err)
	}
	var info struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(out.String())), &info); err != nil {
		return fmt.Errorf("the new Portplane answered something unexpected: %q", strings.TrimSpace(out.String()))
	}
	if strings.TrimPrefix(info.Version, "v") != version {
		return fmt.Errorf("the new Portplane says it is %s, not %s", info.Version, version)
	}
	pr.Logf("%s runs and is version %s", exe, info.Version)
	return nil
}
