package portless

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// A project's portless config (plan §5.5): portless.json, or the "portless"
// key of package.json. portless 0.16 reads portless.json in the folder it
// runs in and, only when there is none, package.json's "portless" key (a
// name as a string, or an object). The checks below are portless's own
// (validateConfig), so the editor refuses what portless would refuse.

// Config file names.
const (
	ConfigFile  = "portless.json"
	PackageFile = "package.json"
)

// Known keys, in the order the form writes them.
var (
	configKeys    = []string{"name", "script", "appPort", "proxy", "turbo", "apps"}
	configAppKeys = []string{"name", "script", "appPort", "proxy"}
)

// AppConfig is one entry of "apps", or the top-level settings of one app.
type AppConfig struct {
	Name    string `json:"name,omitempty"`
	Script  string `json:"script,omitempty"`
	AppPort int    `json:"appPort,omitempty"`
	Proxy   *bool  `json:"proxy,omitempty"`
}

// ProjectConfig is a parsed portless config.
type ProjectConfig struct {
	AppConfig
	Turbo *bool                `json:"turbo,omitempty"`
	Apps  map[string]AppConfig `json:"apps,omitempty"`
}

// ConfigSource is one of the two places a config can live.
type ConfigSource struct {
	Path   string `json:"path"`
	Exists bool   `json:"exists"`
	// HasConfig: portless.json exists, or package.json has a "portless" key.
	HasConfig bool `json:"hasConfig"`
	// Text is the config as JSON: the whole portless.json, or the value of
	// package.json's "portless" key.
	Text   string         `json:"text,omitempty"`
	Config *ProjectConfig `json:"config,omitempty"`
	// Problems are portless's own objections; Warnings are unknown keys,
	// which portless ignores with a warning.
	Problems []string `json:"problems"`
	Warnings []string `json:"warnings"`
	// Digest is the SHA-256 of the file as read, to refuse saving over a
	// change made since.
	Digest string `json:"digest,omitempty"`
}

// ProjectConfigs is what a folder holds and which one portless uses.
type ProjectConfigs struct {
	Dir      string       `json:"dir"`
	Portless ConfigSource `json:"portless"`
	Package  ConfigSource `json:"package"`
	// Wins: "portless.json", "package.json" or "" when neither has one.
	Wins string `json:"wins"`
	// PackageName is package.json's "name", which portless falls back to.
	PackageName string `json:"packageName,omitempty"`
}

// ReadProjectConfigs reads both sources in dir. It changes nothing.
func ReadProjectConfigs(dir string) ProjectConfigs {
	pc := ProjectConfigs{Dir: dir}
	pc.Portless = readSource(filepath.Join(dir, ConfigFile), false)
	pc.Package = readSource(filepath.Join(dir, PackageFile), true)
	if b, err := os.ReadFile(pc.Package.Path); err == nil {
		var pkg struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(b, &pkg) == nil {
			pc.PackageName = pkg.Name
		}
	}
	switch {
	case pc.Portless.Exists:
		pc.Wins = ConfigFile
	case pc.Package.HasConfig:
		pc.Wins = PackageFile
	}
	return pc
}

func readSource(path string, pkgKey bool) ConfigSource {
	src := ConfigSource{Path: path, Problems: []string{}, Warnings: []string{}}
	b, err := os.ReadFile(path)
	if err != nil {
		return src
	}
	src.Exists = true
	src.Digest = digest(b)
	if !pkgKey {
		src.HasConfig = true
		src.Text = string(b)
		src.Config, src.Problems, src.Warnings = ValidateConfig(b)
		return src
	}
	var pkg map[string]json.RawMessage
	if err := json.Unmarshal(b, &pkg); err != nil {
		src.Problems = []string{"package.json is not valid JSON."}
		return src
	}
	raw, ok := pkg["portless"]
	if !ok {
		return src
	}
	src.HasConfig = true
	src.Text = string(raw)
	src.Config, src.Problems, src.Warnings = ValidateConfig(raw)
	return src
}

func digest(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// ValidateConfig checks a config the way portless 0.16 does. A string is
// accepted as a name, as in package.json's "portless" key.
func ValidateConfig(raw []byte) (*ProjectConfig, []string, []string) {
	problems, warnings := []string{}, []string{}
	var v any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		return nil, []string{"This isn't valid JSON: " + jsonError(err)}, warnings
	}
	if s, ok := v.(string); ok {
		if strings.TrimSpace(s) == "" {
			return nil, problems, warnings // portless treats an empty string as no config
		}
		return &ProjectConfig{AppConfig: AppConfig{Name: strings.TrimSpace(s)}}, problems, warnings
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return nil, []string{"The config must be a JSON object, like {\"name\": \"web\"}."}, warnings
	}
	cfg := &ProjectConfig{}
	cfg.AppConfig = checkApp(obj, "", &problems)
	if t, ok := obj["turbo"]; ok {
		if b, isBool := t.(bool); isBool {
			cfg.Turbo = &b
		} else {
			problems = append(problems, `"turbo" must be true or false.`)
		}
	}
	if a, ok := obj["apps"]; ok {
		apps, isObj := a.(map[string]any)
		if !isObj {
			problems = append(problems, `"apps" must be an object of folder → settings.`)
		} else {
			cfg.Apps = map[string]AppConfig{}
			for _, k := range sortedKeys(apps) {
				app, isObj := apps[k].(map[string]any)
				if !isObj {
					problems = append(problems, fmt.Sprintf(`"apps.%s" must be an object.`, k))
					continue
				}
				cfg.Apps[k] = checkApp(app, "apps."+k+".", &problems)
				warnings = append(warnings, unknownKeys(app, configAppKeys, "apps."+k+".")...)
			}
		}
	}
	warnings = append(warnings, unknownKeys(obj, configKeys, "")...)
	return cfg, problems, warnings
}

func checkApp(obj map[string]any, prefix string, problems *[]string) AppConfig {
	var a AppConfig
	if v, ok := obj["name"]; ok {
		s, isStr := v.(string)
		switch {
		case !isStr || strings.TrimSpace(s) == "":
			*problems = append(*problems, fmt.Sprintf(`"%sname" must be a non-empty string.`, prefix))
		default:
			a.Name = s
			if p := NameProblem(s, ""); p != "" {
				*problems = append(*problems, fmt.Sprintf(`"%sname": %s`, prefix, p))
			}
		}
	}
	if v, ok := obj["script"]; ok {
		if s, isStr := v.(string); isStr && strings.TrimSpace(s) != "" {
			a.Script = s
		} else {
			*problems = append(*problems, fmt.Sprintf(`"%sscript" must be a non-empty string.`, prefix))
		}
	}
	if v, ok := obj["appPort"]; ok {
		n, isNum := v.(json.Number)
		port, err := n.Int64()
		if !isNum || err != nil || port < 1 || port > 65535 {
			*problems = append(*problems, fmt.Sprintf(`"%sappPort" must be a whole number between 1 and 65535.`, prefix))
		} else {
			a.AppPort = int(port)
		}
	}
	if v, ok := obj["proxy"]; ok {
		if b, isBool := v.(bool); isBool {
			a.Proxy = &b
		} else {
			*problems = append(*problems, fmt.Sprintf(`"%sproxy" must be true or false.`, prefix))
		}
	}
	return a
}

func unknownKeys(obj map[string]any, known []string, prefix string) []string {
	var out []string
	for _, k := range sortedKeys(obj) {
		ok := false
		for _, kk := range known {
			if k == kk {
				ok = true
				break
			}
		}
		if !ok {
			out = append(out, fmt.Sprintf(`portless ignores "%s%s"; it knows %s.`, prefix, k, strings.Join(known, ", ")))
		}
	}
	return out
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func jsonError(err error) string {
	var se *json.SyntaxError
	if errors.As(err, &se) {
		return fmt.Sprintf("%s (at character %d)", se.Error(), se.Offset)
	}
	return err.Error()
}

// ConfigEdit is a proposed change to one file.
type ConfigEdit struct {
	Path    string `json:"path"`
	Before  string `json:"before"`
	After   string `json:"after"`
	Created bool   `json:"created"`
	Changed bool   `json:"changed"`
}

// ErrConfigChanged means the file changed since it was read.
var ErrConfigChanged = errors.New("the file changed since Portplane read it: review the new version and try again")

// PlanConfigText replaces the whole config with text: portless.json's
// content, or the value of package.json's "portless" key. It refuses text
// portless would refuse.
func PlanConfigText(dir, target, text string) (ConfigEdit, error) {
	_, problems, _ := ValidateConfig([]byte(text))
	if len(problems) > 0 {
		return ConfigEdit{}, errors.New(problems[0])
	}
	switch target {
	case ConfigFile:
		path := filepath.Join(dir, ConfigFile)
		before, err := readOptional(path)
		if err != nil {
			return ConfigEdit{}, err
		}
		after := strings.TrimRight(text, " \t\r\n") + "\n"
		return ConfigEdit{Path: path, Before: before, After: after, Created: before == "" && !exists(path), Changed: before != after}, nil
	case PackageFile:
		path := filepath.Join(dir, PackageFile)
		b, err := os.ReadFile(path)
		if err != nil {
			return ConfigEdit{}, errors.New("this folder has no package.json")
		}
		var v any
		if err := json.Unmarshal([]byte(text), &v); err != nil {
			return ConfigEdit{}, err
		}
		after, err := SetJSONPath(b, []string{"portless"}, v)
		if err != nil {
			return ConfigEdit{}, err
		}
		return ConfigEdit{Path: path, Before: string(b), After: string(after), Changed: !bytes.Equal(b, after)}, nil
	}
	return ConfigEdit{}, fmt.Errorf("unknown config file %q", target)
}

// PlanConfigName sets the name portless reads in dir: in portless.json when
// it exists, else in package.json's "portless" key when it has one, else in
// a new portless.json. app is the app's folder relative to dir when the
// name belongs in "apps" (a monorepo root's config), else "".
func PlanConfigName(dir, app, name string) (ConfigEdit, error) {
	pc := ReadProjectConfigs(dir)
	path := []string{"name"}
	if app != "" {
		path = []string{"apps", app, "name"}
	}
	switch pc.Wins {
	case PackageFile:
		b, err := os.ReadFile(pc.Package.Path)
		if err != nil {
			return ConfigEdit{}, err
		}
		var after []byte
		var cur any
		_ = json.Unmarshal([]byte(pc.Package.Text), &cur)
		if _, isStr := cur.(string); isStr && app == "" {
			after, err = SetJSONPath(b, []string{"portless"}, name) // "portless": "<name>"
		} else {
			after, err = SetJSONPath(b, append([]string{"portless"}, path...), name)
		}
		if err != nil {
			return ConfigEdit{}, err
		}
		return ConfigEdit{Path: pc.Package.Path, Before: string(b), After: string(after), Changed: !bytes.Equal(b, after)}, nil
	default:
		before, err := readOptional(pc.Portless.Path)
		if err != nil {
			return ConfigEdit{}, err
		}
		src := []byte(before)
		if strings.TrimSpace(before) == "" {
			src = []byte("{}\n")
		}
		after, err := SetJSONPath(src, path, name)
		if err != nil {
			return ConfigEdit{}, err
		}
		out := strings.TrimRight(string(after), " \t\r\n") + "\n"
		return ConfigEdit{Path: pc.Portless.Path, Before: before, After: out, Created: !pc.Portless.Exists, Changed: before != out}, nil
	}
}

func readOptional(path string) (string, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	return string(b), err
}

// WriteEdit writes an edit, only when the file is still what it was when
// the edit was planned (its before).
func WriteEdit(e ConfigEdit) error {
	cur, err := readOptional(e.Path)
	if err != nil {
		return err
	}
	if cur != e.Before {
		return ErrConfigChanged
	}
	return WriteFileAtomic(e.Path, []byte(e.After))
}

// WriteFileAtomic writes through a temporary file in the same folder, so a
// crash never leaves half a file, and keeps the old file's mode. A symlink
// stays a symlink: the file it points to is written.
func WriteFileAtomic(path string, b []byte) error {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	mode := os.FileMode(0o644)
	if fi, err := os.Stat(path); err == nil {
		mode = fi.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := os.Chmod(tmp.Name(), mode); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}
