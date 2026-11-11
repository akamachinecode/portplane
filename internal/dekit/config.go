package dekit

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"
)

// ConfigFile is the name of a dekit project file.
const ConfigFile = "dekit.yaml"

// Task is one task as declared in dekit.yaml or a fragment. Values written
// with !js cannot be evaluated here and are left empty (ADR-0006).
type Task struct {
	Path      string            // full task path, e.g. "shop/web"
	Label     string            // display label, empty when not set
	Kind      string            // "service" or "job"
	Cmd       []string          // argv; nil when unknown (!js or script)
	Script    string            // script: file, when the task runs JavaScript
	Dir       string            // absolute working directory; empty when unknown
	Deps      []string          // full task paths
	ReadyTCP  string            // ready.tcp, as written
	ReadyHTTP string            // ready.http, as written
	Autostart bool              // started by `dekit up`
	Env       map[string]string // string values from the task's env (and defaults when it has none)
	File      string            // the file that declares the task
	Order     int               // declaration order across files
}

// Config is a dekit project's parsed configuration.
type Config struct {
	Root    string   // the folder that holds dekit.yaml
	File    string   // absolute path of dekit.yaml
	Tasks   []Task   // in declaration order
	Folders []string // folder entries (paths without the trailing /)
	// FolderFiles lists, per folder, the files that declare it.
	FolderFiles map[string][]string
	Files       []string // dekit.yaml followed by every loaded fragment
	Warnings    []string // problems that did not stop parsing
}

// Task returns the task at path, or nil.
func (c *Config) Task(p string) *Task {
	for i := range c.Tasks {
		if c.Tasks[i].Path == p {
			return &c.Tasks[i]
		}
	}
	return nil
}

type defaults struct {
	dir    string
	dirSet bool
	env    map[string]string
}

type loader struct {
	cfg      *Config
	defaults defaults
	order    int
	seen     map[string]bool
}

// LoadConfig reads root/dekit.yaml and its fragments.
func LoadConfig(root string) (*Config, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	file := filepath.Join(root, ConfigFile)
	cfg := &Config{Root: root, File: file}
	l := &loader{cfg: cfg, seen: map[string]bool{}}
	doc, err := readYAML(file)
	if err != nil {
		return nil, err
	}
	if doc == nil {
		return cfg, nil
	}
	if d := mapGet(doc, "defaults"); d != nil {
		l.defaults = parseDefaults(d, root)
	}
	if err := l.file(file, doc, ""); err != nil {
		return nil, err
	}
	return cfg, nil
}

func readYAML(file string) (*yaml.Node, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(b, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	if doc.Kind == 0 || len(doc.Content) == 0 {
		return nil, nil
	}
	top := doc.Content[0]
	if top.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%s: top level is not a mapping", file)
	}
	return top, nil
}

func (l *loader) file(file string, top *yaml.Node, mount string) error {
	if l.seen[file] {
		return nil
	}
	l.seen[file] = true
	l.cfg.Files = append(l.cfg.Files, file)
	dir := filepath.Dir(file)

	if tasks := mapGet(top, "tasks"); tasks != nil && tasks.Kind == yaml.MappingNode {
		for i := 0; i+1 < len(tasks.Content); i += 2 {
			key := tasks.Content[i].Value
			full := joinPath(mount, key)
			if strings.HasSuffix(key, "/") {
				f := strings.TrimSuffix(full, "/")
				l.cfg.Folders = append(l.cfg.Folders, f)
				if l.cfg.FolderFiles == nil {
					l.cfg.FolderFiles = map[string][]string{}
				}
				l.cfg.FolderFiles[f] = append(l.cfg.FolderFiles[f], file)
				continue
			}
			l.cfg.Tasks = append(l.cfg.Tasks, l.task(full, tasks.Content[i+1], dir, mount, file))
		}
	}
	load := mapGet(top, "load")
	if load == nil || load.Kind != yaml.SequenceNode {
		return nil
	}
	for _, entry := range load.Content {
		pattern, at := "", ""
		switch entry.Kind {
		case yaml.ScalarNode:
			pattern = entry.Value
		case yaml.MappingNode:
			if f := mapGet(entry, "file"); f != nil {
				pattern = f.Value
			}
			if a := mapGet(entry, "at"); a != nil {
				at = a.Value
			}
		}
		if pattern == "" {
			continue
		}
		matches, err := globFiles(dir, pattern)
		if err != nil {
			l.cfg.Warnings = append(l.cfg.Warnings, fmt.Sprintf("%s: load %q: %v", file, pattern, err))
			continue
		}
		if len(matches) == 0 {
			l.cfg.Warnings = append(l.cfg.Warnings, fmt.Sprintf("%s: load %q matches no file", file, pattern))
		}
		for _, m := range matches {
			frag, err := readYAML(m)
			if err != nil {
				l.cfg.Warnings = append(l.cfg.Warnings, err.Error())
				continue
			}
			if frag == nil {
				l.seen[m] = true
				l.cfg.Files = append(l.cfg.Files, m)
				continue
			}
			if err := l.file(m, frag, joinPath(mount, at)); err != nil {
				return err
			}
		}
	}
	return nil
}

func (l *loader) task(full string, n *yaml.Node, declDir, mount, file string) Task {
	t := Task{Path: full, Kind: "service", File: file, Order: l.order}
	l.order++
	if n.Kind != yaml.MappingNode {
		return t
	}
	if v := mapGet(n, "label"); v != nil && !isJS(v) {
		t.Label = v.Value
	}
	if v := mapGet(n, "type"); v != nil && !isJS(v) && v.Value == "job" {
		t.Kind = "job"
	}
	if v := mapGet(n, "autostart"); v != nil && !isJS(v) && v.Value == "true" {
		t.Autostart = true
	}
	if v := mapGet(n, "script"); v != nil && !isJS(v) {
		t.Script = v.Value
	}
	if v := mapGet(n, "cmd"); v != nil && !isJS(v) {
		t.Cmd = argv(v)
	}
	switch v := mapGet(n, "cwd"); {
	case v != nil && !isJS(v):
		t.Dir = resolveDir(declDir, v.Value)
	case v != nil:
		// !js: unknown
	case l.defaults.dirSet:
		t.Dir = l.defaults.dir
	default:
		t.Dir = l.cfg.Root
	}
	if v := mapGet(n, "deps"); v != nil && v.Kind == yaml.SequenceNode {
		for _, d := range v.Content {
			if d.Kind != yaml.ScalarNode || isJS(d) {
				continue
			}
			if strings.HasPrefix(d.Value, "/") {
				t.Deps = append(t.Deps, strings.TrimPrefix(d.Value, "/"))
			} else {
				t.Deps = append(t.Deps, joinPath(mount, d.Value))
			}
		}
	}
	if r := mapGet(n, "ready"); r != nil && r.Kind == yaml.MappingNode {
		if v := mapGet(r, "tcp"); v != nil && !isJS(v) {
			t.ReadyTCP = v.Value
		}
		if v := mapGet(r, "http"); v != nil && !isJS(v) {
			t.ReadyHTTP = v.Value
		}
	}
	t.Env = map[string]string{}
	if e := mapGet(n, "env"); e != nil && e.Kind == yaml.MappingNode {
		// A task's own env replaces the defaults env (field notes).
		for i := 0; i+1 < len(e.Content); i += 2 {
			k, v := e.Content[i].Value, e.Content[i+1]
			if v.Kind == yaml.ScalarNode && !isJS(v) && v.Tag != "!!null" {
				t.Env[k] = v.Value
			}
		}
	} else {
		for k, v := range l.defaults.env {
			t.Env[k] = v
		}
	}
	return t
}

func parseDefaults(d *yaml.Node, root string) defaults {
	var out defaults
	if d.Kind != yaml.MappingNode {
		return out
	}
	if v := mapGet(d, "cwd"); v != nil && !isJS(v) {
		out.dir, out.dirSet = resolveDir(root, v.Value), true
	}
	out.env = map[string]string{}
	if e := mapGet(d, "env"); e != nil && e.Kind == yaml.MappingNode {
		for i := 0; i+1 < len(e.Content); i += 2 {
			k, v := e.Content[i].Value, e.Content[i+1]
			if v.Kind == yaml.ScalarNode && !isJS(v) && v.Tag != "!!null" {
				out.env[k] = v.Value
			}
		}
	}
	return out
}

func argv(v *yaml.Node) []string {
	switch v.Kind {
	case yaml.SequenceNode:
		out := make([]string, 0, len(v.Content))
		for _, c := range v.Content {
			if c.Kind != yaml.ScalarNode || isJS(c) {
				return nil
			}
			out = append(out, c.Value)
		}
		return out
	case yaml.ScalarNode:
		words, err := SplitWords(v.Value)
		if err != nil {
			return nil
		}
		return words
	}
	return nil
}

func isJS(n *yaml.Node) bool { return n.Tag == "!js" }

func mapGet(m *yaml.Node, key string) *yaml.Node {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

func joinPath(mount, p string) string {
	mount = strings.Trim(mount, "/")
	if mount == "" {
		return p
	}
	return mount + "/" + p
}

func resolveDir(base, p string) string {
	if p == "" {
		return base
	}
	if strings.HasPrefix(p, "~/") || p == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			p = filepath.Join(home, strings.TrimPrefix(p, "~"))
		}
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(base, filepath.FromSlash(p))
	}
	return filepath.Clean(p)
}

// globFiles expands a load pattern relative to dir. It supports *, ?, [...]
// within a segment and ** across segments.
func globFiles(dir, pattern string) ([]string, error) {
	pattern = filepath.ToSlash(pattern)
	if !strings.ContainsAny(pattern, "*?[") {
		p := resolveDir(dir, pattern)
		if _, err := os.Stat(p); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil, nil
			}
			return nil, err
		}
		return []string{p}, nil
	}
	re, err := globRegexp(pattern)
	if err != nil {
		return nil, err
	}
	var out []string
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if name := d.Name(); p != dir && (name == "node_modules" || name == ".git") {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return nil
		}
		if re.MatchString(filepath.ToSlash(rel)) {
			out = append(out, p)
		}
		return nil
	})
	sort.Strings(out)
	return out, err
}

func globRegexp(pattern string) (*regexp.Regexp, error) {
	pattern = path.Clean(strings.TrimPrefix(pattern, "./"))
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(pattern); i++ {
		c := pattern[i]
		switch c {
		case '*':
			if i+1 < len(pattern) && pattern[i+1] == '*' {
				i++
				if i+1 < len(pattern) && pattern[i+1] == '/' {
					i++
					b.WriteString("(?:.*/)?")
				} else {
					b.WriteString(".*")
				}
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		case '[':
			j := strings.IndexByte(pattern[i:], ']')
			if j < 0 {
				return nil, fmt.Errorf("unterminated [ in %q", pattern)
			}
			b.WriteString(pattern[i : i+j+1])
			i += j
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}
