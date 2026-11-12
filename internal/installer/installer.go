// Package installer installs dekit, a private Node.js and portless for the
// current user, without a password, from their official sources only, and
// checks every download it runs (ADR-0019, ADR-0025):
//
//   - dekit through its own installer script, which checks the release
//     against SHA256SUMS and leaves the receipt `dekit update` reads;
//   - Node.js 24 from nodejs.org/dist, checked against SHASUMS256.txt, into
//     Portplane's data folder, only when the user has no Node 24 or later;
//   - portless with npm, into the user's own global prefix or a private one
//     with a `portless` launcher next to dekit.
//
// Each install reports its stages and output through a Progress, which a
// jobs.Run satisfies.
package installer

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/envpath"
)

// The tools Portplane installs.
const (
	Dekit    = "dekit"
	Node     = "node"
	Portless = "portless"
)

// NodeMajor is the Node.js major version portless needs.
const NodeMajor = 24

// Progress receives an install's stages and output. *jobs.Run is one.
type Progress interface {
	io.Writer
	Step(name string)
	Skip(name string)
	Logf(format string, args ...any)
}

// Runner runs argv (never through a shell) with env, in dir when it is not
// empty, writing stdout and stderr to out.
type Runner func(ctx context.Context, dir string, env []string, out io.Writer, argv ...string) error

// RunProcess is the real Runner.
func RunProcess(ctx context.Context, dir string, env []string, out io.Writer, argv ...string) error {
	if len(argv) == 0 {
		return errors.New("nothing to run")
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Env = env
	cmd.Stdout, cmd.Stderr = out, out
	cmd.WaitDelay = 3 * time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return fmt.Errorf("%s exited with status %d", filepath.Base(argv[0]), exit.ExitCode())
		}
		return err
	}
	return nil
}

// Sources are the base URLs of the official sources. Tests point them at
// an httptest server.
type Sources struct {
	DekitScripts string // https://dekit.run (install.sh, install.ps1)
	NodeDist     string // https://nodejs.org/dist
}

// OfficialSources are the real ones.
func OfficialSources() Sources {
	return Sources{DekitScripts: "https://dekit.run", NodeDist: "https://nodejs.org/dist"}
}

// Installer installs tools for the user running Portplane.
type Installer struct {
	GOOS, GOARCH string
	Home         string
	// BinDir is where dekit and the portless launcher go: ~/.local/bin.
	BinDir string
	// DataDir is Portplane's data folder: the private Node and portless.
	DataDir string
	Sources Sources
	HTTP    *Downloader
	Run     Runner
	// Lookup finds a program on PATH (envpath.Lookup).
	Lookup func(name string) string
	// Environ is the environment programs start with (os.Environ).
	Environ func() []string
	// UseDir is told about a folder with programs Portplane just installed
	// or found (envpath.Prepend for Node, envpath.Add otherwise).
	UseDir func(dir string, first bool)
}

// New returns the installer for this machine and user.
func New() *Installer {
	home, _ := os.UserHomeDir()
	return &Installer{
		GOOS: runtime.GOOS, GOARCH: runtime.GOARCH,
		Home:    home,
		BinDir:  BinDir(home),
		DataDir: DataDir(runtime.GOOS, home, os.Getenv),
		Sources: OfficialSources(),
		HTTP:    &Downloader{},
		Run:     RunProcess,
		Lookup:  envpath.Lookup,
		Environ: os.Environ,
		UseDir: func(dir string, first bool) {
			if first {
				envpath.Prepend(dir)
			} else {
				envpath.Add(dir)
			}
		},
	}
}

// BinDir is ~/.local/bin, where dekit's installer puts dekit on every OS.
func BinDir(home string) string {
	return filepath.Join(home, ".local", "bin")
}

// DataDir is Portplane's data folder: $XDG_DATA_HOME/portplane or
// ~/.local/share/portplane on Linux, ~/Library/Application Support/portplane
// on macOS, %LocalAppData%\portplane on Windows.
func DataDir(goos, home string, getenv func(string) string) string {
	switch goos {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "portplane")
	case "windows":
		if d := getenv("LOCALAPPDATA"); d != "" {
			return filepath.Join(d, "portplane")
		}
		return filepath.Join(home, "AppData", "Local", "portplane")
	default:
		if d := getenv("XDG_DATA_HOME"); d != "" && filepath.IsAbs(d) {
			return filepath.Join(d, "portplane")
		}
		return filepath.Join(home, ".local", "share", "portplane")
	}
}

func (in *Installer) exe(name string) string {
	if in.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func (in *Installer) environ() []string {
	if in.Environ != nil {
		return in.Environ()
	}
	return os.Environ()
}

func (in *Installer) lookup(name string) string {
	if in.Lookup != nil {
		return in.Lookup(name)
	}
	p, _ := exec.LookPath(name)
	return p
}

func (in *Installer) useDir(dir string, first bool) {
	if in.UseDir != nil {
		in.UseDir(dir, first)
	}
}

// output runs argv and returns what it printed, for version checks.
func (in *Installer) output(ctx context.Context, env []string, argv ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var b bytes.Buffer
	run := in.Run
	if run == nil {
		run = RunProcess
	}
	if env == nil {
		env = in.environ()
	}
	err := run(ctx, "", env, &b, argv...)
	return strings.TrimSpace(b.String()), err
}

// Tilde shows a path under home as ~/…, for the cards in the UI.
func Tilde(home, p string) string {
	if home == "" || p == "" {
		return p
	}
	rel, err := filepath.Rel(home, p)
	if err != nil || !filepath.IsLocal(rel) {
		return p
	}
	return "~" + string(filepath.Separator) + rel
}

// withEnv returns env with the given variables set (replacing old values).
func withEnv(env []string, kv ...string) []string {
	out := make([]string, 0, len(env)+len(kv))
	set := map[string]bool{}
	for _, p := range kv {
		k, _, _ := strings.Cut(p, "=")
		set[strings.ToUpper(k)] = true
	}
	for _, e := range env {
		k, _, _ := strings.Cut(e, "=")
		if !set[strings.ToUpper(k)] {
			out = append(out, e)
		}
	}
	return append(out, kv...)
}

// pathWith returns env with dir first on PATH.
func pathWith(env []string, dir string) []string {
	key, cur := "PATH", ""
	for _, e := range env {
		k, v, _ := strings.Cut(e, "=")
		if strings.EqualFold(k, "PATH") {
			key, cur = k, v
		}
	}
	val := dir
	if cur != "" {
		val = dir + string(os.PathListSeparator) + cur
	}
	return withEnv(env, key+"="+val)
}
