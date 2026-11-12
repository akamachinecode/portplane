package portless

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/akamachinecode/portplane/internal/dekit"
)

// Docker Compose projects (plan §5.9). `portless compose up` reads the
// project with `docker compose config`, gives every service that publishes
// an HTTP port <service>.<project>.<tld> (the portless.name label replaces
// the service's name), pins its host port in 14000–14999 and registers an
// alias per route. It keeps two files per project in compose/:
//
//	<project>.json        the rewritten compose model it started (removed
//	                      by `down`, or when a foreground `up` ends)
//	<project>.ports.json  "service:target" → host port, kept so a restart
//	                      reuses the same ports (removed by `down`)
//
// Portplane reads both, starts and stops projects through `portless compose`
// and edits the portless.name label in the user's compose file.

// Compose labels portless reads.
const (
	LabelEnable = "portless.enable"
	LabelName   = "portless.name"
	LabelPorts  = "portless.ports"
)

// ComposeFileNames are the files docker compose looks for in a folder, in
// its order.
var ComposeFileNames = []string{"compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"}

// nonHTTPPorts keep their published port (portless's NON_HTTP_PORTS).
var nonHTTPPorts = map[int]bool{1433: true, 1521: true, 2181: true, 3306: true, 4222: true, 5432: true, 5672: true, 6379: true, 9042: true, 9092: true, 11211: true, 26257: true, 27017: true}

// ComposePort is one port a service publishes.
type ComposePort struct {
	Target int `json:"target"`
	// HostPort is the port on 127.0.0.1 (portless's, for a routed port).
	HostPort int `json:"hostPort,omitempty"`
	// Routed: portless gives this port an address.
	Routed bool `json:"routed"`
	// Reason says why a port keeps its own published port.
	Reason string `json:"reason,omitempty"`
}

// ComposeService is one service of a project.
type ComposeService struct {
	Name string `json:"name"`
	// Label is the hostname part: portless.name, else the service's name,
	// made a valid label.
	Label string `json:"label"`
	// NameLabel is portless.name as written, when set.
	NameLabel string        `json:"nameLabel,omitempty"`
	Enabled   bool          `json:"enabled"`
	Image     string        `json:"image,omitempty"`
	Ports     []ComposePort `json:"ports"`
}

// ComposeProject is one project portless knows.
type ComposeProject struct {
	Name string `json:"name"`
	// Label is the hostname suffix (<service>.<label>.<tld>).
	Label string `json:"label"`
	// Started: compose/<project>.json exists, so portless started the
	// project and hasn't brought it down.
	Started bool `json:"started"`
	// Ports maps "service:target" to the host port portless reserved.
	Ports    map[string]int   `json:"ports"`
	Services []ComposeService `json:"services"`
	// Dirs are folders the model mentions (build contexts, bind mounts),
	// where the compose file is likely to be.
	Dirs []string `json:"-"`
}

// ComposeLabel turns a name into a hostname label, as portless does
// (toLabel): lowercase, runs of other characters become one dash, at most
// 63 characters (longer ones end in a short hash).
func ComposeLabel(name string) string {
	l := strings.Trim(composeLabelRe.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(l) <= MaxLabel {
		return l
	}
	sum := sha256.Sum256([]byte(l))
	return strings.TrimRight(l[:MaxLabel-7], "-") + "-" + hex.EncodeToString(sum[:])[:6]
}

var composeLabelRe = regexp.MustCompile(`[^a-z0-9-]+`)

// ComposeNameProblem says why name can't be a compose service's portless
// name, or "". It is one hostname part: no dots.
func ComposeNameProblem(name string) string {
	name = strings.TrimSpace(name)
	switch {
	case name == "":
		return "Type a name."
	case strings.Contains(name, "."):
		return "A compose service's name is one part, without dots: it goes in front of the project's name."
	case name != strings.ToLower(name):
		return "Use lowercase letters."
	case strings.HasPrefix(name, "-") || strings.HasSuffix(name, "-"):
		return "Start and end the name with a letter or a digit."
	case len(name) > MaxLabel:
		return fmt.Sprintf("Use at most %d characters.", MaxLabel)
	case ComposeLabel(name) != name:
		return "Use letters, digits and dashes only."
	}
	// portless's own command names are fine here: a compose name never
	// follows `portless` on a command line.
	return ""
}

// ParseComposeModel reads compose/<project>.json, which is `docker compose
// config --format json` as portless rewrote it.
func ParseComposeModel(b []byte) (ComposeProject, error) {
	var raw struct {
		Name     string `json:"name"`
		Services map[string]struct {
			Image       string            `json:"image"`
			Labels      map[string]string `json:"labels"`
			NetworkMode string            `json:"network_mode"`
			Ports       []struct {
				Target    int    `json:"target"`
				Published any    `json:"published"`
				Protocol  string `json:"protocol"`
			} `json:"ports"`
			Build *struct {
				Context string `json:"context"`
			} `json:"build"`
			Volumes []struct {
				Type   string `json:"type"`
				Source string `json:"source"`
			} `json:"volumes"`
			EnvFile []struct {
				Path string `json:"path"`
			} `json:"env_file"`
		} `json:"services"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return ComposeProject{}, errors.New("the compose state file isn't valid JSON")
	}
	p := ComposeProject{Name: raw.Name, Label: ComposeLabel(raw.Name), Ports: map[string]int{}, Services: []ComposeService{}}
	dirs := map[string]bool{}
	names := make([]string, 0, len(raw.Services))
	for n := range raw.Services {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		svc := raw.Services[n]
		s := ComposeService{Name: n, Image: svc.Image, Ports: []ComposePort{}}
		enable := strings.ToLower(strings.TrimSpace(svc.Labels[LabelEnable]))
		s.Enabled = enable != "false" && enable != "0" && svc.NetworkMode != "host"
		s.NameLabel = strings.TrimSpace(svc.Labels[LabelName])
		s.Label = ComposeLabel(n)
		if s.NameLabel != "" {
			s.Label = ComposeLabel(s.NameLabel)
		}
		only := map[int]bool{}
		for _, part := range strings.Split(svc.Labels[LabelPorts], ",") {
			if v, err := strconv.Atoi(strings.TrimSpace(part)); err == nil {
				only[v] = true
			}
		}
		seen := map[int]bool{}
		for _, port := range svc.Ports {
			cp := ComposePort{Target: port.Target, HostPort: publishedPort(port.Published)}
			proto := port.Protocol
			if proto == "" {
				proto = "tcp"
			}
			switch {
			case !s.Enabled && svc.NetworkMode == "host":
				cp.Reason = "host network"
			case !s.Enabled:
				cp.Reason = LabelEnable + "=false"
			case proto != "tcp":
				cp.Reason = proto
			case len(only) > 0 && !only[port.Target]:
				cp.Reason = "not in " + LabelPorts
			case len(only) == 0 && nonHTTPPorts[port.Target]:
				cp.Reason = "not HTTP"
			case seen[port.Target]:
				cp.Reason = "the container port is already routed"
			default:
				cp.Routed = true
				seen[port.Target] = true
			}
			s.Ports = append(s.Ports, cp)
		}
		if svc.Build != nil && composeAbs(svc.Build.Context) {
			dirs[svc.Build.Context] = true
		}
		for _, v := range svc.Volumes {
			if v.Type == "bind" && composeAbs(v.Source) {
				dirs[v.Source] = true
			}
		}
		for _, e := range svc.EnvFile {
			if composeAbs(e.Path) {
				dirs[composeDir(e.Path)] = true
			}
		}
		p.Services = append(p.Services, s)
	}
	for d := range dirs {
		p.Dirs = append(p.Dirs, d)
	}
	sort.Strings(p.Dirs)
	return p, nil
}

func publishedPort(v any) int {
	switch x := v.(type) {
	case float64:
		return int(x)
	case string:
		n, _ := strconv.Atoi(x)
		return n
	}
	return 0
}

// ParseComposePorts reads compose/<project>.ports.json.
func ParseComposePorts(b []byte) (map[string]int, error) {
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, err
	}
	out := map[string]int{}
	for k, v := range raw {
		if n, ok := v.(float64); ok && n > 0 {
			out[k] = int(n)
		}
	}
	return out, nil
}

// ComposeProjects reads every project in compose/: the ones portless
// started (<project>.json) and the ones it only keeps ports for.
func (c *Client) ComposeProjects() ([]ComposeProject, error) {
	if c.StateDir == "" {
		return []ComposeProject{}, nil
	}
	dir := filepath.Join(c.StateDir, "compose")
	files, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return []ComposeProject{}, nil
	}
	if err != nil {
		return nil, err
	}
	byName := map[string]*ComposeProject{}
	var order []string
	get := func(name string) *ComposeProject {
		if p, ok := byName[name]; ok {
			return p
		}
		p := &ComposeProject{Name: name, Label: ComposeLabel(name), Ports: map[string]int{}, Services: []ComposeService{}}
		byName[name] = p
		order = append(order, name)
		return p
	}
	for _, f := range files {
		name := f.Name()
		switch {
		case strings.HasSuffix(name, ".ports.json"):
			b, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				continue
			}
			ports, err := ParseComposePorts(b)
			if err != nil {
				continue
			}
			get(strings.TrimSuffix(name, ".ports.json")).Ports = ports
		case strings.HasSuffix(name, ".json"):
			b, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				continue
			}
			m, err := ParseComposeModel(b)
			if err != nil {
				continue
			}
			project := strings.TrimSuffix(name, ".json")
			p := get(project)
			p.Started, p.Services, p.Dirs = true, m.Services, m.Dirs
		}
	}
	out := make([]ComposeProject, 0, len(order))
	for _, n := range order {
		p := byName[n]
		// A project without its model still has its ports: one service
		// per "service:target".
		if !p.Started {
			p.Services = servicesFromPorts(p.Ports)
		}
		for i := range p.Services {
			for j := range p.Services[i].Ports {
				port := &p.Services[i].Ports[j]
				if hp, ok := p.Ports[fmt.Sprintf("%s:%d", p.Services[i].Name, port.Target)]; ok && port.Routed {
					port.HostPort = hp
				}
			}
		}
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func servicesFromPorts(ports map[string]int) []ComposeService {
	byName := map[string]*ComposeService{}
	var names []string
	for k, hp := range ports {
		svc, target, ok := strings.Cut(k, ":")
		if !ok {
			continue
		}
		t, _ := strconv.Atoi(target)
		s, ok := byName[svc]
		if !ok {
			s = &ComposeService{Name: svc, Label: ComposeLabel(svc), Enabled: true, Ports: []ComposePort{}}
			byName[svc] = s
			names = append(names, svc)
		}
		s.Ports = append(s.Ports, ComposePort{Target: t, HostPort: hp, Routed: true})
	}
	sort.Strings(names)
	out := make([]ComposeService, 0, len(names))
	for _, n := range names {
		s := byName[n]
		sort.Slice(s.Ports, func(i, j int) bool { return s.Ports[i].Target < s.Ports[j].Target })
		out = append(out, *s)
	}
	return out
}

// Hostnames are the addresses portless gives a service for one TLD: the
// first routed port gets <label>.<project>, each port gets
// <target>.<label>.<project> when the service routes several.
func (s ComposeService) Hostnames(project, tld string) []string {
	var targets []int
	for _, p := range s.Ports {
		if p.Routed {
			targets = append(targets, p.Target)
		}
	}
	if len(targets) == 0 {
		return nil
	}
	suffix := "." + ComposeLabel(project) + "." + tld
	out := []string{s.Label + suffix}
	if len(targets) > 1 {
		for _, t := range targets {
			out = append(out, fmt.Sprintf("%d.%s%s", t, s.Label, suffix))
		}
	}
	return out
}

// ServiceFor finds the service a route of this project belongs to: by the
// host port, else by the hostname.
func (p ComposeProject) ServiceFor(hostname string, port int) (ComposeService, bool) {
	for _, s := range p.Services {
		for _, cp := range s.Ports {
			if cp.Routed && cp.HostPort != 0 && cp.HostPort == port {
				return s, true
			}
		}
	}
	for _, s := range p.Services {
		prefix := s.Label + "." + p.Label + "."
		if strings.HasPrefix(hostname, prefix) || strings.Contains(hostname, "."+prefix) {
			return s, true
		}
	}
	return ComposeService{}, false
}

// ComposeProjectName is the project name docker compose gives a folder
// without a `name:`: its base name, lowercase, letters, digits, dashes and
// underscores only.
func ComposeProjectName(dir string) string {
	base := strings.ToLower(filepath.Base(dir))
	var b strings.Builder
	for _, r := range base {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	return strings.TrimLeft(b.String(), "-_")
}

// ComposeFileProject reads the project name a compose file sets (name:),
// or the one docker compose derives from its folder.
func ComposeFileProject(path string) string {
	if b, err := os.ReadFile(path); err == nil {
		var top struct {
			Name string `yaml:"name"`
		}
		if yaml.Unmarshal(b, &top) == nil && top.Name != "" && !strings.Contains(top.Name, "${") {
			return top.Name
		}
	}
	return ComposeProjectName(filepath.Dir(path))
}

// FindComposeFile looks in dir for a compose file docker compose would use.
func FindComposeFile(dir string) string {
	for _, n := range ComposeFileNames {
		p := filepath.Join(dir, n)
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	return ""
}

// GuessComposeFile looks for project's compose file around the folders its
// model mentions: each folder and up to three parents.
func GuessComposeFile(project string, dirs []string) string {
	seen := map[string]bool{}
	for _, d := range dirs {
		for i := 0; i < 4 && d != "" && !seen[d]; i++ {
			seen[d] = true
			if f := FindComposeFile(d); f != "" && ComposeFileProject(f) == project {
				return f
			}
			parent := filepath.Dir(d)
			if parent == d {
				break
			}
			d = parent
		}
	}
	return ""
}

// ComposeCommand is `portless compose …` in a task's command: its folder
// and the -f and -p it passes.
type ComposeCommand struct {
	Files   []string
	Project string
}

// ParseComposeCommand recognises `portless compose [globals] <command>`.
func ParseComposeCommand(argv []string) (ComposeCommand, bool) {
	words, _ := unwrapCmd(argv)
	i := indexOfPortless(words)
	if i < 0 || i+1 >= len(words) || words[i+1] != "compose" {
		return ComposeCommand{}, false
	}
	var c ComposeCommand
	for j := i + 2; j < len(words); j++ {
		a := words[j]
		if !strings.HasPrefix(a, "-") {
			break
		}
		val := ""
		name, v, eq := strings.Cut(a, "=")
		if eq {
			val = v
		} else if j+1 < len(words) {
			val = words[j+1]
		}
		switch name {
		case "-f", "--file":
			c.Files = append(c.Files, val)
		case "-p", "--project-name":
			c.Project = val
		default:
			continue
		}
		if !eq {
			j++
		}
	}
	return c, true
}

// ComposeUpArgs are the arguments of `portless compose … up -d`, detached
// so the routes stay after the command returns.
func ComposeUpArgs(project, file string) []string {
	args := []string{"compose"}
	if project != "" {
		args = append(args, "-p", project)
	}
	if file != "" {
		args = append(args, "-f", file)
	}
	return append(args, "up", "-d")
}

// ComposeDownArgs are the arguments of `portless compose … down`, which
// stops and removes the project's containers and its routes; volumes and
// images stay.
func ComposeDownArgs(project, file string) []string {
	args := []string{"compose", "-p", project}
	if file != "" {
		args = append(args, "-f", file)
	}
	return append(args, "down")
}

var composeStartedRe = regexp.MustCompile(`(?m)^\s*portless compose (\S+)\s*$`)

// ComposeStartedProject reads the project name `portless compose up`
// prints first.
func ComposeStartedProject(output string) string {
	if m := composeStartedRe.FindStringSubmatch(stripANSI(output)); m != nil {
		return m[1]
	}
	return ""
}

// ComposeRun runs `portless compose …` in dir, streaming its output to out.
// Pulling images and building can take minutes.
func (c *Client) ComposeRun(ctx context.Context, dir string, out io.Writer, args ...string) (string, error) {
	return c.runWith(ctx, dir, 20*time.Minute, out, args...)
}

// SetComposeName returns the compose file src with the portless.name label
// of service set to name. Labels written as a mapping or as a list of
// key=value both work; a service without labels gets them. Anchors, merge
// keys and services defined elsewhere give dekit.ErrNotEditable or an
// error that says so.
func SetComposeName(src []byte, service, name string) ([]byte, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(src, &doc); err != nil {
		return nil, err
	}
	labels, found, err := composeLabelsNode(&doc, service)
	if err != nil {
		return nil, err
	}
	if !found {
		return dekit.InsertEntry(src, []string{"services", service}, "labels", map[string]string{LabelName: name})
	}
	if labels.Kind == yaml.MappingNode {
		return dekit.SetKey(src, []string{"services", service, "labels"}, LabelName, name)
	}
	return dekit.EditBlock(src, []string{"services", service, "labels"}, func(n *yaml.Node) error {
		if n.Kind != yaml.SequenceNode {
			return dekit.ErrNotEditable
		}
		var style yaml.Style
		for _, item := range n.Content {
			if item.Kind != yaml.ScalarNode {
				return dekit.ErrNotEditable
			}
			style = item.Style
			k, _, _ := strings.Cut(item.Value, "=")
			if strings.TrimSpace(k) == LabelName {
				item.Value = LabelName + "=" + name
				return nil
			}
		}
		n.Content = append(n.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: LabelName + "=" + name, Style: style})
		return nil
	})
}

func composeLabelsNode(doc *yaml.Node, service string) (*yaml.Node, bool, error) {
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, false, dekit.ErrNotEditable
	}
	services := mapValue(doc.Content[0], "services")
	if services == nil {
		return nil, false, errors.New("this file has no services: the project may be split across several files")
	}
	svc := mapValue(services, service)
	if svc == nil {
		return nil, false, fmt.Errorf("the service %q isn't defined in this file; it may come from another file the project includes", service)
	}
	if svc.Kind != yaml.MappingNode || svc.Anchor != "" {
		return nil, false, dekit.ErrNotEditable
	}
	// A merge key may bring labels of its own, which new ones would hide.
	for i := 0; i+1 < len(svc.Content); i += 2 {
		if k := svc.Content[i]; k.Kind == yaml.AliasNode || k.Value == "<<" {
			return nil, false, dekit.ErrNotEditable
		}
	}
	l := mapValue(svc, "labels")
	return l, l != nil, nil
}

func mapValue(m *yaml.Node, key string) *yaml.Node {
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

// composeAbs reports whether a path from Docker's compose model is
// absolute: Unix-style as Docker writes it on Linux and macOS, or the
// host's own (Windows).
func composeAbs(p string) bool {
	return strings.HasPrefix(p, "/") || filepath.IsAbs(p)
}

// composeDir is the folder of a path from Docker's compose model.
func composeDir(p string) string {
	if strings.HasPrefix(p, "/") {
		return path.Dir(p)
	}
	return filepath.Dir(p)
}
