package dekit

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"go.yaml.in/yaml/v3"
)

// PortplaneFragment is Portplane's own fragment, relative to the project
// root (ADR-0009; the same file internal/setup writes).
const PortplaneFragment = ".portplane/tasks.yaml"

// ConfigFileInfo is one file of a project's configuration, as the editor
// shows it.
type ConfigFileInfo struct {
	Path    string `json:"path"` // absolute
	Rel     string `json:"rel"`  // relative to the project root, with /
	Role    string `json:"role"` // main, fragment, portplane
	At      string `json:"at,omitempty"`
	Exists  bool   `json:"exists"`
	Digest  string `json:"digest"` // of Content; "" for a file that does not exist
	Content string `json:"content"`
	// Editable: Portplane can change entries of this file one by one.
	// Otherwise (flow style, not a mapping, invalid YAML) only the raw
	// text editor can change it.
	Editable bool   `json:"editable"`
	Problem  string `json:"problem,omitempty"`
}

// TaskEntry is one entry under tasks: as written in its file.
type TaskEntry struct {
	Path   string `json:"path"`   // full task path, mount included
	Key    string `json:"key"`    // the key in File (path ["tasks", Key])
	File   string `json:"file"`   // absolute
	Folder bool   `json:"folder"` // a key that ends in /
	Line   int    `json:"line"`
	// Values are the entry's keys as written; a !js value is {"$js": source}.
	Values *omap `json:"values"`
	// Editable: the form may change it. Otherwise Problem says why (an
	// anchor, a merge key, a flow mapping, !js for the whole entry).
	Editable bool   `json:"editable"`
	Problem  string `json:"problem,omitempty"`
}

// LoadEntry is one item of load: in the main file.
type LoadEntry struct {
	File string `json:"file"`
	At   string `json:"at,omitempty"`
	Line int    `json:"line"`
}

// ProjectConfig is everything the project editor shows (plan §4.5).
type ProjectConfig struct {
	Root  string           `json:"root"`
	File  string           `json:"file"` // the main dekit.yaml
	Files []ConfigFileInfo `json:"files"`
	Tasks []TaskEntry      `json:"tasks"`
	Load  []LoadEntry      `json:"load"`
	// Settings are the main file's other top-level keys as written
	// (defaults, vars, kernel, log, on_init, on_idle), and Text the same
	// entries as they appear in the file, for editing as text.
	Settings *omap             `json:"settings"`
	Text     map[string]string `json:"text"`
	// Fragment is Portplane's fragment, whether it exists or not.
	Fragment string   `json:"fragment"`
	Warnings []string `json:"warnings"`
}

// Digest is the SHA-256 of a file's bytes, for "has it changed since".
func Digest(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// ReadProject reads a project's configuration for the editor. root is a
// project folder; file overrides the main file (the host runner's).
func ReadProject(root, file string) (*ProjectConfig, error) {
	if file == "" {
		file = filepath.Join(root, ConfigFile)
	}
	pc := &ProjectConfig{Root: root, File: file, Fragment: filepath.Join(root, filepath.FromSlash(PortplaneFragment)), Settings: &omap{vals: map[string]any{}}, Text: map[string]string{}, Files: []ConfigFileInfo{}, Tasks: []TaskEntry{}, Load: []LoadEntry{}, Warnings: []string{}}
	files := []string{file}
	ats := map[string]string{}
	if cfg, err := loadConfigFile(root, file); err == nil {
		files = cfg.Files
		pc.Warnings = append(pc.Warnings, cfg.Warnings...)
		for _, t := range cfg.Tasks {
			ats[t.File] = mountOf(t.Path, t.Key)
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		pc.Warnings = append(pc.Warnings, err.Error())
	}
	hasFragment := false
	for _, f := range files {
		if sameFile(f, pc.Fragment) {
			hasFragment = true
		}
	}
	if !hasFragment {
		files = append(files, pc.Fragment)
	}
	for i, f := range files {
		info := ConfigFileInfo{Path: f, Rel: relSlash(root, f), Role: "fragment", At: ats[f]}
		switch {
		case i == 0:
			info.Role = "main"
		case sameFile(f, pc.Fragment) || f == pc.Fragment:
			info.Role = "portplane"
		}
		b, err := os.ReadFile(f)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			info.Editable = true
		case err != nil:
			info.Problem = err.Error()
		default:
			info.Exists = true
			info.Content = string(b)
			info.Digest = Digest(b)
			if _, perr := parseDoc(b); perr != nil {
				info.Problem = editProblem(perr)
			} else {
				info.Editable = true
			}
		}
		pc.Files = append(pc.Files, info)
		if info.Exists && info.Content != "" {
			pc.readEntries(f, []byte(info.Content), info.At, i == 0)
		}
	}
	return pc, nil
}

// loadConfigFile is LoadConfig for a main file that may live elsewhere
// (the host runner's).
func loadConfigFile(root, file string) (*Config, error) {
	if filepath.Join(root, ConfigFile) == file {
		return LoadConfig(root)
	}
	return LoadConfig(filepath.Dir(file))
}

func mountOf(path, key string) string {
	if strings.HasSuffix(path, "/"+key) {
		return strings.TrimSuffix(path, "/"+key)
	}
	return ""
}

func relSlash(root, f string) string {
	if r, err := filepath.Rel(root, f); err == nil && !strings.HasPrefix(r, "..") {
		return filepath.ToSlash(r)
	}
	return filepath.ToSlash(f)
}

func editProblem(err error) string {
	if errors.Is(err, ErrNotEditable) {
		return "written in a style Portplane doesn't rewrite (flow style or not a mapping): edit it as text or in your editor"
	}
	return "not valid YAML: " + strings.TrimPrefix(err.Error(), "yaml: ")
}

func (pc *ProjectConfig) readEntries(file string, src []byte, mount string, main bool) {
	var doc yaml.Node
	if yaml.Unmarshal(src, &doc) != nil || len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return
	}
	top := doc.Content[0]
	lines := splitLines(src)
	for i := 0; i+1 < len(top.Content); i += 2 {
		k, v := top.Content[i], top.Content[i+1]
		switch {
		case k.Value == "tasks" && v.Kind == yaml.MappingNode:
			for j := 0; j+1 < len(v.Content); j += 2 {
				tk, tv := v.Content[j], v.Content[j+1]
				e := TaskEntry{Key: tk.Value, Path: joinPath(mount, tk.Value), File: file, Line: tk.Line, Folder: strings.HasSuffix(tk.Value, "/")}
				val := nodeValue(tv, "", nil)
				if m, ok := val.(*omap); ok {
					e.Values = m
				} else {
					e.Values = &omap{vals: map[string]any{}}
				}
				switch {
				case v.Style&yaml.FlowStyle != 0 || top.Style&yaml.FlowStyle != 0:
					e.Problem = "the tasks are written in flow style ({…})"
				case editable(tv) != nil && isJS(tv):
					e.Problem = "the whole task is written with !js"
				case tk.Anchor != "" || tv.Anchor != "" || tv.Kind == yaml.AliasNode:
					e.Problem = "the task uses a YAML anchor or alias"
				case tv.Kind != yaml.MappingNode && (tv.Kind != yaml.ScalarNode || tv.Tag != "!!null"):
					e.Problem = "the task isn't a mapping"
				case tv.Style&yaml.FlowStyle != 0:
					e.Problem = "the task is written in flow style ({…}): edit it as text"
				default:
					e.Editable = true
				}
				pc.Tasks = append(pc.Tasks, e)
			}
		case main && k.Value == "load" && v.Kind == yaml.SequenceNode:
			for _, it := range v.Content {
				le := LoadEntry{Line: it.Line}
				switch it.Kind {
				case yaml.ScalarNode:
					le.File = it.Value
				case yaml.MappingNode:
					if f := mapGet(it, "file"); f != nil {
						le.File = f.Value
					}
					if a := mapGet(it, "at"); a != nil {
						le.At = a.Value
					}
				}
				pc.Load = append(pc.Load, le)
			}
		case main && k.Value != "tasks" && k.Value != "load":
			pc.Settings.keys = append(pc.Settings.keys, k.Value)
			pc.Settings.vals[k.Value] = nodeValue(v, "", nil)
			start := k.Line - 1
			end := blockEnd(lines, top, i)
			if start >= 0 && end <= len(lines) && start < end {
				pc.Text[k.Value] = string(bytes.Join(lines[start:end], nil))
			}
		}
	}
}
