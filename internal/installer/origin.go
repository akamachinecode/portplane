package installer

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Origin says how a tool was installed, so it is updated the same way and
// never installed twice (ADR-0019).
type Origin struct {
	// Kind: script (dekit's installer), homebrew, npm, portplane (its
	// private copy), mise, fnm, volta, nvm, asdf, pip, cargo, system or
	// other.
	Kind string `json:"kind"`
	// Label is how the UI says it: "dekit's install script".
	Label string `json:"label"`
	Path  string `json:"path"`
	// Target is the file Path resolves to, when it is a link.
	Target string `json:"target,omitempty"`
	// Update is the command that updates the tool, when there is one.
	Update []string `json:"update,omitempty"`
}

// OriginEnv is what DetectOrigin reads, so tests can use fixtures.
type OriginEnv struct {
	GOOS    string
	Home    string
	DataDir string // Portplane's data folder
	// DekitReceipt is the file dekit's installer writes the binary's
	// path into.
	DekitReceipt string
	// Resolve follows links (filepath.EvalSymlinks when nil).
	Resolve func(string) (string, error)
	// ReadFile reads a file (os.ReadFile when nil).
	ReadFile func(string) ([]byte, error)
}

// OriginEnv returns the environment of this installer.
func (in *Installer) OriginEnv() OriginEnv {
	return OriginEnv{
		GOOS: in.GOOS, Home: in.Home, DataDir: in.DataDir,
		DekitReceipt: DekitReceipt(in.GOOS, in.Home, envFrom(in.environ())),
	}
}

func (e OriginEnv) resolve(p string) string {
	f := e.Resolve
	if f == nil {
		f = filepath.EvalSymlinks
	}
	if r, err := f(p); err == nil {
		return r
	}
	return p
}

func (e OriginEnv) read(p string) []byte {
	f := e.ReadFile
	if f == nil {
		f = os.ReadFile
	}
	b, _ := f(p)
	return b
}

// norm makes a path comparable: forward slashes, lower case on Windows.
func (e OriginEnv) norm(p string) string {
	p = strings.ReplaceAll(filepath.Clean(p), `\`, "/")
	if e.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	return p
}

func (e OriginEnv) under(p, dir string) bool {
	if dir == "" {
		return false
	}
	p, dir = e.norm(p), strings.TrimSuffix(e.norm(dir), "/")
	return strings.HasPrefix(p, dir+"/")
}

var originLabels = map[string]string{
	"script":    "dekit's install script",
	"homebrew":  "Homebrew",
	"npm":       "npm (global)",
	"portplane": "Portplane",
	"mise":      "mise",
	"fnm":       "fnm",
	"volta":     "Volta",
	"nvm":       "nvm",
	"asdf":      "asdf",
	"pip":       "pip",
	"cargo":     "Cargo",
	"system":    "your system's packages",
	"other":     "an unknown method",
}

// DetectOrigin says how tool ("dekit", "node" or "portless"), found at
// path, was installed.
func DetectOrigin(tool, path string, e OriginEnv) Origin {
	o := Origin{Path: path}
	if path == "" {
		return o
	}
	target := e.resolve(path)
	if target != path {
		o.Target = target
	}
	o.Kind = originKind(tool, path, target, e)
	o.Label = originLabels[o.Kind]
	o.Update = updateCommand(tool, o.Kind)
	return o
}

func originKind(tool, path, target string, e OriginEnv) string {
	t := e.norm(target)
	both := []string{e.norm(path), t}
	has := func(s string) bool {
		for _, p := range both {
			if strings.Contains(p, s) {
				return true
			}
		}
		return false
	}
	// Portplane's own: anything in its data folder, or the launcher it wrote.
	if e.under(target, e.DataDir) || e.under(path, e.DataDir) {
		return "portplane"
	}
	if tool == Portless && strings.Contains(string(e.read(target)), ShimMarker) {
		return "portplane"
	}
	if tool == Dekit && e.DekitReceipt != "" {
		if r := strings.TrimSpace(string(e.read(e.DekitReceipt))); r != "" && (e.norm(r) == t || e.norm(r) == e.norm(path)) {
			return "script"
		}
	}
	switch {
	case has("/cellar/") || has("/Cellar/") || has("/opt/homebrew/") || has("/home/linuxbrew/.linuxbrew/") || has("/.linuxbrew/") || has("/usr/local/homebrew/"):
		return "homebrew"
	case tool != Node && has("/node_modules/"):
		return "npm"
	case has("/mise/installs/") || has("/mise/shims/"):
		return "mise"
	case has("/fnm/") || has("/.fnm/") || has("fnm_multishells"):
		return "fnm"
	case has("/.volta/") || has("/volta/"):
		return "volta"
	case has("/.nvm/") || has("/nvm/"):
		return "nvm"
	case has("/.asdf/"):
		return "asdf"
	case has("/site-packages/") || has("/pipx/") || isPythonScript(e.read(target)):
		return "pip"
	case has("/.cargo/bin/"):
		return "cargo"
	}
	if tool == Node && e.GOOS != "windows" {
		for _, d := range []string{"/usr/bin/", "/bin/", "/usr/local/bin/"} {
			if strings.HasPrefix(t, d) && strings.Count(strings.TrimPrefix(t, d), "/") == 0 {
				return "system"
			}
		}
	}
	if e.GOOS == "windows" && (has("/program files/") || has("/programdata/")) {
		return "system"
	}
	if e.GOOS != "windows" && (strings.HasPrefix(t, "/usr/bin/") || strings.HasPrefix(t, "/usr/lib/")) {
		return "system"
	}
	return "other"
}

func isPythonScript(b []byte) bool {
	if len(b) < 2 || b[0] != '#' || b[1] != '!' {
		return false
	}
	line, _, _ := strings.Cut(string(b[:min(len(b), 200)]), "\n")
	return strings.Contains(line, "python")
}

// updateCommand is how to update a tool installed that way.
func updateCommand(tool, kind string) []string {
	node := "node@" + strconv.Itoa(NodeMajor)
	switch tool {
	case Dekit:
		switch kind {
		case "script":
			return []string{"dekit", "update"}
		case "homebrew":
			return []string{"brew", "upgrade", "dekit"}
		case "npm":
			return []string{"npm", "install", "-g", "dekit@latest"}
		case "pip":
			return []string{"pip", "install", "--upgrade", "dekit"}
		case "cargo":
			return []string{"cargo", "install", "dekit"}
		}
	case Portless:
		switch kind {
		case "homebrew":
			return []string{"brew", "upgrade", "portless"}
		case "npm", "mise", "fnm", "volta", "nvm", "asdf":
			return []string{"npm", "install", "-g", "portless@latest"}
		}
	case Node:
		switch kind {
		case "homebrew":
			return []string{"brew", "upgrade", "node"}
		case "mise":
			return []string{"mise", "use", "-g", node}
		case "fnm":
			return []string{"fnm", "install", strconv.Itoa(NodeMajor)}
		case "volta":
			return []string{"volta", "install", node}
		case "nvm":
			return []string{"nvm", "install", strconv.Itoa(NodeMajor)}
		case "asdf":
			return []string{"asdf", "install", "nodejs", "latest:" + strconv.Itoa(NodeMajor)}
		}
	}
	return nil
}
