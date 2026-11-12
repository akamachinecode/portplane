package dekit

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Suggestion is a command "Add an app" offers for a folder (plan §4.6),
// from the files it finds there.
type Suggestion struct {
	ID     string   `json:"id"`
	Label  string   `json:"label"`  // "pnpm run dev", "Django development server"
	Source string   `json:"source"` // the file it came from: package.json, manage.py...
	Lang   string   `json:"lang"`   // node, python, go, ruby, php, docker, procfile
	Cmd    []string `json:"cmd"`
	// Wrap: portless can wrap the command (it reads PORT, or portless
	// passes --port). Otherwise Port is the fixed port it listens on, for
	// a portless alias, when the file says.
	Wrap  bool   `json:"wrap"`
	Port  int    `json:"port,omitempty"`
	Ready *Ready `json:"ready,omitempty"`
	Job   bool   `json:"job,omitempty"` // runs once (an install step)
	Note  string `json:"note,omitempty"`
}

// Ready is a suggested readiness check.
type Ready struct {
	Log  string `json:"log,omitempty"`
	TCP  int    `json:"tcp,omitempty"`
	HTTP string `json:"http,omitempty"`
}

// Suggest looks at a folder and proposes commands to run it, best first.
// goos decides whether a POSIX shell is available for commands that need
// $PORT spelled out.
func Suggest(dir, goos string) []Suggestion {
	var out []Suggestion
	sh := goos != "windows"
	out = append(out, nodeSuggestions(dir)...)
	out = append(out, pythonSuggestions(dir, sh)...)
	out = append(out, rubySuggestions(dir, sh)...)
	out = append(out, phpSuggestions(dir, sh)...)
	out = append(out, goSuggestions(dir)...)
	out = append(out, procfileSuggestions(dir, sh)...)
	out = append(out, composeSuggestions(dir)...)
	if out == nil {
		out = []Suggestion{}
	}
	for i := range out {
		out[i].ID = strconv.Itoa(i)
	}
	return out
}

func exists(dir, name string) bool {
	_, err := os.Stat(filepath.Join(dir, name))
	return err == nil
}

// shPort runs a command that needs the port spelled out, through sh.
func shPort(cmd string) []string {
	return []string{"sh", "-c", "exec " + cmd}
}

func nodeSuggestions(dir string) []Suggestion {
	b, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return nil
	}
	var pj struct {
		Scripts         map[string]string `json:"scripts"`
		Dependencies    map[string]string `json:"dependencies"`
		DevDependencies map[string]string `json:"devDependencies"`
	}
	if json.Unmarshal(b, &pj) != nil {
		return nil
	}
	pm := "npm"
	switch {
	case exists(dir, "pnpm-lock.yaml") || exists(dir, "pnpm-workspace.yaml"):
		pm = "pnpm"
	case exists(dir, "yarn.lock"):
		pm = "yarn"
	case exists(dir, "bun.lockb") || exists(dir, "bun.lock"):
		pm = "bun"
	}
	var out []Suggestion
	for _, name := range []string{"dev", "start", "serve", "preview"} {
		script, ok := pj.Scripts[name]
		if !ok {
			continue
		}
		s := Suggestion{Label: pm + " run " + name, Source: "package.json", Lang: "node", Cmd: []string{pm, "run", name}, Wrap: true}
		if m := regexp.MustCompile(`(?:--port[ =]|-p )(\d{2,5})`).FindStringSubmatch(script); m != nil {
			s.Note = "The script sets its own port (" + m[1] + "): remove the flag so portless can choose one."
		}
		switch {
		case strings.Contains(script, "vite") || strings.Contains(script, "astro"):
			s.Ready = &Ready{Log: "ready in"}
		case strings.Contains(script, "next"):
			s.Ready = &Ready{Log: "Ready in"}
		}
		out = append(out, s)
	}
	if exists(dir, "node_modules") || len(pj.Dependencies)+len(pj.DevDependencies) > 0 {
		install := []string{pm, "install"}
		if pm == "pnpm" {
			install = []string{"pnpm", "install", "--frozen-lockfile"}
		}
		out = append(out, Suggestion{Label: strings.Join(install, " "), Source: "package.json", Lang: "node", Cmd: install, Job: true, Note: "An install step the app can depend on."})
	}
	return out
}

func pythonRunner(dir string) []string {
	switch {
	case exists(dir, "uv.lock"):
		return []string{"uv", "run"}
	case exists(dir, "poetry.lock"):
		return []string{"poetry", "run"}
	}
	return nil
}

func pythonSuggestions(dir string, sh bool) []Suggestion {
	var out []Suggestion
	run := pythonRunner(dir)
	if exists(dir, "manage.py") {
		s := Suggestion{Label: "Django development server", Source: "manage.py", Lang: "python", Ready: &Ready{Log: "Starting development server"}}
		prefix := strings.Join(append(append([]string{}, run...), "python"), " ")
		if sh {
			s.Cmd = shPort(prefix + ` manage.py runserver "127.0.0.1:$PORT"`)
			s.Wrap = true
			s.Note = "Django doesn't read PORT, so the command passes it."
		} else {
			s.Cmd = append(append(append([]string{}, run...), "python"), "manage.py", "runserver", "127.0.0.1:8000")
			s.Port = 8000
		}
		out = append(out, s)
	}
	for _, f := range []string{"app.py", "main.py"} {
		b, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			continue
		}
		mod := strings.TrimSuffix(f, ".py")
		text := string(b)
		switch {
		case strings.Contains(text, "FastAPI("):
			cmd := append(append([]string{}, run...), "uvicorn", mod+":app", "--host", "127.0.0.1")
			s := Suggestion{Label: "FastAPI with uvicorn", Source: f, Lang: "python", Ready: &Ready{Log: "Application startup complete"}}
			if sh {
				s.Cmd = shPort(strings.Join(cmd, " ") + ` --port "$PORT"`)
				s.Wrap = true
			} else {
				cmd = append(cmd, "--port", "8000")
				s.Cmd, s.Port = cmd, 8000
			}
			out = append(out, s)
		case strings.Contains(text, "Flask("):
			cmd := append(append([]string{}, run...), "flask", "--app", mod, "run", "--host", "127.0.0.1")
			s := Suggestion{Label: "Flask development server", Source: f, Lang: "python", Ready: &Ready{Log: "Running on"}}
			if sh {
				s.Cmd = shPort(strings.Join(cmd, " ") + ` --port "$PORT"`)
				s.Wrap = true
			} else {
				cmd = append(cmd, "--port", "5000")
				s.Cmd, s.Port = cmd, 5000
			}
			out = append(out, s)
		}
	}
	return out
}

func rubySuggestions(dir string, sh bool) []Suggestion {
	if !exists(dir, "Gemfile") {
		return nil
	}
	var out []Suggestion
	if exists(dir, "bin/rails") || exists(dir, "config/application.rb") {
		// Rails (Puma) reads PORT.
		out = append(out, Suggestion{Label: "Rails server", Source: "Gemfile", Lang: "ruby", Cmd: []string{"bin/rails", "server", "-b", "127.0.0.1"}, Wrap: true, Ready: &Ready{Log: "Listening on"}})
	} else if exists(dir, "config.ru") {
		s := Suggestion{Label: "Rack app (rackup)", Source: "Gemfile", Lang: "ruby", Ready: &Ready{Log: "Listening on"}}
		if sh {
			s.Cmd, s.Wrap = shPort(`bundle exec rackup --host 127.0.0.1 --port "$PORT"`), true
		} else {
			s.Cmd, s.Port = []string{"bundle", "exec", "rackup", "--host", "127.0.0.1", "--port", "9292"}, 9292
		}
		out = append(out, s)
	}
	out = append(out, Suggestion{Label: "bundle install", Source: "Gemfile", Lang: "ruby", Cmd: []string{"bundle", "install"}, Job: true, Note: "An install step the app can depend on."})
	return out
}

func phpSuggestions(dir string, sh bool) []Suggestion {
	var out []Suggestion
	if exists(dir, "artisan") {
		s := Suggestion{Label: "Laravel (artisan serve)", Source: "artisan", Lang: "php", Ready: &Ready{Log: "Server running"}}
		if sh {
			s.Cmd, s.Wrap = shPort(`php artisan serve --host 127.0.0.1 --port "$PORT"`), true
		} else {
			s.Cmd, s.Port = []string{"php", "artisan", "serve", "--host", "127.0.0.1", "--port", "8000"}, 8000
		}
		out = append(out, s)
	}
	if exists(dir, "composer.json") || exists(dir, "index.php") || exists(dir, "public/index.php") {
		docroot := "."
		if exists(dir, "public/index.php") {
			docroot = "public"
		}
		if !exists(dir, "artisan") {
			out = append(out, Suggestion{Label: "PHP built-in server", Source: firstExisting(dir, "composer.json", "index.php", "public/index.php"), Lang: "php", Cmd: []string{"php", "-S", "127.0.0.1:8000", "-t", docroot}, Port: 8000, Ready: &Ready{TCP: 8000}, Note: "php -S listens on a fixed port, so the URL is a portless alias to it."})
		}
	}
	if exists(dir, "composer.json") {
		out = append(out, Suggestion{Label: "composer install", Source: "composer.json", Lang: "php", Cmd: []string{"composer", "install"}, Job: true, Note: "An install step the app can depend on."})
	}
	return out
}

func firstExisting(dir string, names ...string) string {
	for _, n := range names {
		if exists(dir, n) {
			return n
		}
	}
	return names[0]
}

func goSuggestions(dir string) []Suggestion {
	if !exists(dir, "go.mod") {
		return nil
	}
	return []Suggestion{{Label: "go run .", Source: "go.mod", Lang: "go", Cmd: []string{"go", "run", "."}, Wrap: true, Note: "portless sets PORT: the server should listen on it (os.Getenv(\"PORT\"))."}}
}

func procfileSuggestions(dir string, sh bool) []Suggestion {
	f, err := os.Open(filepath.Join(dir, "Procfile"))
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()
	var out []Suggestion
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		name, cmd, ok := strings.Cut(line, ":")
		if !ok || strings.HasPrefix(line, "#") || strings.ContainsAny(name, " \t") {
			continue
		}
		cmd = strings.TrimSpace(cmd)
		s := Suggestion{Label: "Procfile: " + name, Source: "Procfile", Lang: "procfile", Wrap: name == "web"}
		words, err := SplitWords(cmd)
		switch {
		case err == nil && ShellMetachar(cmd) == "":
			s.Cmd = words
		case sh:
			s.Cmd = shPort(cmd)
		default:
			continue
		}
		out = append(out, s)
	}
	return out
}

var composePort = regexp.MustCompile(`^\s*-\s*["']?(?:[\d.]+:)?(\d{2,5}):\d{2,5}`)

func composeSuggestions(dir string) []Suggestion {
	name := firstExisting(dir, "compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml")
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return nil
	}
	var ports []int
	for _, l := range strings.Split(string(b), "\n") {
		if m := composePort.FindStringSubmatch(l); m != nil {
			if p, err := strconv.Atoi(m[1]); err == nil {
				ports = append(ports, p)
			}
		}
	}
	sort.Ints(ports)
	s := Suggestion{Label: "docker compose up", Source: name, Lang: "docker", Cmd: []string{"docker", "compose", "up"}, Note: "Containers publish fixed ports, so the URL is a portless alias to one of them."}
	if len(ports) > 0 {
		s.Port = ports[0]
		s.Ready = &Ready{TCP: ports[0]}
		if len(ports) > 1 {
			s.Note += fmt.Sprintf(" It publishes %d ports; the first is used.", len(ports))
		}
	}
	return []Suggestion{s}
}

var hostLabel = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)

// ValidURLName checks a portless name such as "web" or "api.shop" (the
// URL becomes https://<name>.localhost).
func ValidURLName(name string) error {
	name = strings.TrimSuffix(name, ".localhost")
	if name == "" {
		return fmt.Errorf("enter a name for the URL, such as web")
	}
	for _, l := range strings.Split(name, ".") {
		if !hostLabel.MatchString(l) || len(l) > 63 {
			return fmt.Errorf("%q: use lowercase letters, digits and hyphens, with dots between parts", name)
		}
	}
	return nil
}
