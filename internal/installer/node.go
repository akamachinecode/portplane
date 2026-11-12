package installer

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// NodeInfo is the Node.js portless would run on.
type NodeInfo struct {
	Path    string `json:"path,omitempty"`
	Version string `json:"version,omitempty"` // v24.11.0
	// Private is Portplane's own copy, in its data folder.
	Private bool `json:"private"`
	// UserVersion is the Node on PATH when it is too old (or the same
	// as Version when it is the one used).
	UserVersion string `json:"userVersion,omitempty"`
	UserPath    string `json:"userPath,omitempty"`
}

// OK reports whether portless can run on it.
func (n NodeInfo) OK() bool { return Major(n.Version) >= NodeMajor }

// Major returns the major version of "v24.1.0", "24.1.0" or "dekit 0.10.3"
// style strings' first number; 0 when there is none.
func Major(v string) int {
	m := versionRe.FindStringSubmatch(v)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

var versionRe = regexp.MustCompile(`(\d+)\.(\d+)(?:\.(\d+))?`)

// CompareVersions compares two dotted versions found anywhere in a and b
// ("dekit 0.10.3", "v24.1.0"): -1, 0 or 1. A string without a version
// sorts first.
func CompareVersions(a, b string) int {
	pa, pb := versionParts(a), versionParts(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

func versionParts(v string) [3]int {
	var out [3]int
	m := versionRe.FindStringSubmatch(v)
	if m == nil {
		return [3]int{-1, -1, -1}
	}
	for i := 0; i < 3; i++ {
		out[i], _ = strconv.Atoi(m[i+1])
	}
	return out
}

// CleanVersion returns the dotted version in s ("dekit 0.10.3" -> "0.10.3").
func CleanVersion(s string) string {
	if m := versionRe.FindString(s); m != "" {
		return m
	}
	return strings.TrimSpace(s)
}

// NodeDir is where Portplane keeps its private Node versions.
func (in *Installer) NodeDir() string { return filepath.Join(in.DataDir, "node") }

// nodeBin is the folder with node (and npm) inside a Node install.
func (in *Installer) nodeBin(root string) string {
	if in.GOOS == "windows" {
		return root
	}
	return filepath.Join(root, "bin")
}

// PrivateNode returns the newest Node Portplane installed, if any.
func (in *Installer) PrivateNode() (path, version string) {
	entries, err := os.ReadDir(in.NodeDir())
	if err != nil {
		return "", ""
	}
	var versions []string
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "v") && Major(e.Name()) > 0 {
			versions = append(versions, e.Name())
		}
	}
	sort.Slice(versions, func(i, j int) bool { return CompareVersions(versions[i], versions[j]) > 0 })
	for _, v := range versions {
		p := filepath.Join(in.nodeBin(filepath.Join(in.NodeDir(), v)), in.exe("node"))
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p, v
		}
	}
	return "", ""
}

// FindNode reports the Node portless would use: the user's when it is 24 or
// later, else Portplane's private one when there is one.
func (in *Installer) FindNode(ctx context.Context) NodeInfo {
	var info NodeInfo
	if p := in.lookup("node"); p != "" {
		if out, err := in.output(ctx, nil, p, "--version"); err == nil {
			info.UserPath, info.UserVersion = p, CleanVersion(out)
			if !strings.HasPrefix(info.UserVersion, "v") && info.UserVersion != "" {
				info.UserVersion = "v" + info.UserVersion
			}
		}
	}
	if Major(info.UserVersion) >= NodeMajor {
		info.Path, info.Version = info.UserPath, info.UserVersion
		if in.isPrivate(info.UserPath) {
			info.Private = true
		}
		return info
	}
	if p, v := in.PrivateNode(); p != "" {
		info.Path, info.Version, info.Private = p, v, true
	}
	return info
}

func (in *Installer) isPrivate(p string) bool {
	if p == "" {
		return false
	}
	if real, err := filepath.EvalSymlinks(p); err == nil {
		p = real
	}
	dir := in.NodeDir()
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		dir = real
	}
	rel, err := filepath.Rel(dir, p)
	return err == nil && filepath.IsLocal(rel)
}

// UsePrivateNode makes the private Node, when there is one and the user's
// is too old or missing, findable from Portplane: after the user's own
// folders on PATH, never before them, so the dev servers dekit starts keep
// the user's Node (ADR-0019). The portless launcher and npm call it by its
// full path anyway. Call it at start.
func (in *Installer) UsePrivateNode(ctx context.Context) {
	n := in.FindNode(ctx)
	if n.Private && n.Path != "" {
		in.useDir(filepath.Dir(n.Path), false)
	}
}

// nodePlatform is the os-arch part of Node's archive names.
func (in *Installer) nodePlatform() (string, string, error) {
	osName := map[string]string{"linux": "linux", "darwin": "darwin", "windows": "win"}[in.GOOS]
	arch := map[string]string{"amd64": "x64", "arm64": "arm64"}[in.GOARCH]
	if osName == "" || arch == "" {
		return "", "", fmt.Errorf("no official Node.js build for %s/%s", in.GOOS, in.GOARCH)
	}
	ext := "tar.gz"
	if in.GOOS == "windows" {
		ext = "zip"
	}
	return osName + "-" + arch, ext, nil
}

// NodeRelease is one Node build to download.
type NodeRelease struct {
	Version string // v24.22.3
	File    string // node-v24.22.3-linux-x64.tar.gz
	URL     string
	SHA256  string
	SumsURL string
}

// LatestNode finds the newest Node 24 build for this machine in the
// release's SHASUMS256.txt. Windows on Arm falls back to the x64 build.
func (in *Installer) LatestNode(ctx context.Context) (NodeRelease, error) {
	plat, ext, err := in.nodePlatform()
	if err != nil {
		return NodeRelease{}, err
	}
	base := strings.TrimRight(in.Sources.NodeDist, "/")
	sumsURL := fmt.Sprintf("%s/latest-v%d.x/SHASUMS256.txt", base, NodeMajor)
	text, err := in.HTTP.Text(ctx, sumsURL)
	if err != nil {
		return NodeRelease{}, err
	}
	sums := ParseSums(text)
	rel, err := pickNode(sums, plat, ext)
	if err != nil && plat == "win-arm64" {
		rel, err = pickNode(sums, "win-x64", ext)
	}
	if err != nil {
		return NodeRelease{}, err
	}
	rel.URL = fmt.Sprintf("%s/%s/%s", base, rel.Version, rel.File)
	rel.SumsURL = sumsURL
	return rel, nil
}

func pickNode(sums map[string]string, plat, ext string) (NodeRelease, error) {
	re := regexp.MustCompile(`^node-(v` + strconv.Itoa(NodeMajor) + `\.\d+\.\d+)-` + regexp.QuoteMeta(plat) + `\.` + regexp.QuoteMeta(ext) + `$`)
	var best NodeRelease
	for name, sum := range sums {
		m := re.FindStringSubmatch(name)
		if m == nil {
			continue
		}
		if best.Version == "" || CompareVersions(m[1], best.Version) > 0 {
			best = NodeRelease{Version: m[1], File: name, SHA256: sum}
		}
	}
	if best.Version == "" {
		return best, fmt.Errorf("%w: SHASUMS256.txt lists no Node.js %d build for %s", ErrNoChecksum, NodeMajor, plat)
	}
	return best, nil
}

// Steps of a private Node install.
const (
	StepNodeFind     = "Find the latest Node.js 24"
	StepNodeDownload = "Download"
	StepNodeVerify   = "Verify the SHA-256 checksum"
	StepNodeUnpack   = "Unpack"
	StepNodeCheck    = "Check that node runs"
)

// NodeSteps are the stages InstallNode reports for a method.
func NodeSteps(method string) []string {
	if method != "" && method != "private" {
		return []string{"Install with " + method, StepNodeCheck}
	}
	return []string{StepNodeFind, StepNodeDownload, StepNodeVerify, StepNodeUnpack, StepNodeCheck}
}

// InstallNode installs Node.js 24: by default a private copy in Portplane's
// data folder (it changes nothing else: only portless uses it), or with a
// version manager the user has ("mise", "fnm", "volta").
func (in *Installer) InstallNode(ctx context.Context, p Progress, method string) (NodeInfo, error) {
	switch method {
	case "", "private":
		return in.installPrivateNode(ctx, p)
	case "mise", "fnm", "volta":
		return in.installNodeWith(ctx, p, method)
	default:
		return NodeInfo{}, fmt.Errorf("unknown way to install Node.js: %q", method)
	}
}

func (in *Installer) installPrivateNode(ctx context.Context, p Progress) (NodeInfo, error) {
	p.Step(StepNodeFind)
	rel, err := in.LatestNode(ctx)
	if err != nil {
		return NodeInfo{}, err
	}
	p.Logf("Node.js %s for this computer: %s", rel.Version, rel.File)
	p.Logf("Published SHA-256: %s (%s)", rel.SHA256, rel.SumsURL)

	dest := filepath.Join(in.NodeDir(), rel.Version)
	bin := filepath.Join(in.nodeBin(dest), in.exe("node"))
	if _, err := os.Stat(bin); err == nil {
		p.Logf("Node.js %s is already in %s", rel.Version, Tilde(in.Home, dest))
		p.Skip(StepNodeDownload)
		p.Skip(StepNodeVerify)
		p.Skip(StepNodeUnpack)
	} else {
		if err := os.MkdirAll(in.NodeDir(), 0o755); err != nil {
			return NodeInfo{}, err
		}
		tmp, err := os.MkdirTemp(in.NodeDir(), ".download-")
		if err != nil {
			return NodeInfo{}, err
		}
		defer func() { _ = os.RemoveAll(tmp) }()

		p.Step(StepNodeDownload)
		p.Logf("Downloading %s", rel.URL)
		archive := filepath.Join(tmp, rel.File)
		if err := in.HTTP.File(ctx, rel.URL, archive, rel.SHA256, progressLogger(p.Logf)); err != nil {
			var mm *MismatchError
			if errors.As(err, &mm) {
				p.Step(StepNodeVerify)
			}
			return NodeInfo{}, err
		}
		p.Step(StepNodeVerify)
		p.Logf("SHA-256 %s matches SHASUMS256.txt", rel.SHA256)

		p.Step(StepNodeUnpack)
		unpacked := filepath.Join(tmp, "node")
		if strings.HasSuffix(rel.File, ".zip") {
			err = ExtractZip(archive, unpacked, 1)
		} else {
			var f *os.File
			if f, err = os.Open(archive); err == nil {
				err = ExtractTarGz(f, unpacked, 1)
				_ = f.Close()
			}
		}
		if err != nil {
			return NodeInfo{}, fmt.Errorf("could not unpack Node.js: %w", err)
		}
		_ = os.RemoveAll(dest) // a half-written folder from an earlier try
		if err := os.Rename(unpacked, dest); err != nil {
			return NodeInfo{}, err
		}
		p.Logf("Unpacked into %s", Tilde(in.Home, dest))
	}

	p.Step(StepNodeCheck)
	out, err := in.output(ctx, nil, bin, "--version")
	if err != nil {
		return NodeInfo{}, fmt.Errorf("the Node.js that was installed does not run on this computer: %w", err)
	}
	p.Logf("$ node --version\n%s", out)
	in.useDir(filepath.Dir(bin), false)
	return NodeInfo{Path: bin, Version: CleanVersionV(out), Private: true}, nil
}

// CleanVersionV is CleanVersion with a leading v.
func CleanVersionV(s string) string {
	v := CleanVersion(s)
	if v != "" && !strings.HasPrefix(v, "v") {
		v = "v" + v
	}
	return v
}

// NodeManagers are the version managers found on this machine that can
// install Node 24 for the user, in order of preference.
func (in *Installer) NodeManagers() []string {
	var out []string
	for _, m := range []string{"mise", "fnm", "volta"} {
		if in.lookup(m) != "" {
			out = append(out, m)
		}
	}
	return out
}

// NodeManagerCommands are the commands a manager runs to install Node 24
// as the user's default, for the card and for doing it by hand.
func NodeManagerCommands(m string) [][]string {
	v := strconv.Itoa(NodeMajor)
	switch m {
	case "mise":
		return [][]string{{"mise", "use", "-g", "node@" + v}}
	case "fnm":
		return [][]string{{"fnm", "install", v}, {"fnm", "default", v}}
	case "volta":
		return [][]string{{"volta", "install", "node@" + v}}
	}
	return nil
}

// nodeWhich asks a manager where its Node 24 is.
func nodeWhich(m string) []string {
	v := strconv.Itoa(NodeMajor)
	switch m {
	case "mise":
		return []string{"mise", "which", "node"}
	case "fnm":
		return []string{"fnm", "exec", "--using=" + v, "node", "-p", "process.execPath"}
	case "volta":
		return []string{"volta", "which", "node"}
	}
	return nil
}

func (in *Installer) installNodeWith(ctx context.Context, p Progress, m string) (NodeInfo, error) {
	bin := in.lookup(m)
	if bin == "" {
		return NodeInfo{}, fmt.Errorf("%s is not installed", m)
	}
	p.Step("Install with " + m)
	run := in.Run
	if run == nil {
		run = RunProcess
	}
	for _, argv := range NodeManagerCommands(m) {
		argv = append([]string{bin}, argv[1:]...)
		p.Logf("$ %s", strings.Join(append([]string{m}, argv[1:]...), " "))
		if err := run(ctx, in.Home, in.environ(), p, argv...); err != nil {
			return NodeInfo{}, fmt.Errorf("%s could not install Node.js %d: %w", m, NodeMajor, err)
		}
	}
	p.Step(StepNodeCheck)
	which := nodeWhich(m)
	out, err := in.output(ctx, nil, append([]string{bin}, which[1:]...)...)
	if err != nil {
		return NodeInfo{}, fmt.Errorf("could not find the Node.js %s installed: %w", m, err)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	node := strings.TrimSpace(lines[len(lines)-1])
	ver, err := in.output(ctx, nil, node, "--version")
	if err != nil {
		return NodeInfo{}, fmt.Errorf("the Node.js %s installed does not run: %w", m, err)
	}
	p.Logf("%s\n$ node --version\n%s", node, ver)
	in.useDir(filepath.Dir(node), true)
	return NodeInfo{Path: node, Version: CleanVersionV(ver), UserPath: node, UserVersion: CleanVersionV(ver)}, nil
}
