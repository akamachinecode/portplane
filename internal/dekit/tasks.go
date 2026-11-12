package dekit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Task verbs dekit's CLI takes on a target (plan §4.2).
var taskVerbs = map[string]bool{"start": true, "stop": true, "restart": true, "kill": true, "veto": true, "rm": true}

// ActArgs is the dekit argv for a task verb on a target. A bare "**" is
// refused: it would stop every task in the runner, helpers included
// (field notes); Portplane always names what it touches.
func ActArgs(root, verb, target string) ([]string, error) {
	if !taskVerbs[verb] {
		return nil, fmt.Errorf("unknown verb %q", verb)
	}
	if target == "" || target == "**" || target == "*" {
		return nil, fmt.Errorf("refusing to %s every task: name the tasks", verb)
	}
	return []string{"-C", root, verb, target}, nil
}

// ForceRestart stops a task with a hard kill, waits until it is down and
// starts it again: the CLI side of the console's force-restart, for a task
// that does not answer a normal stop. A stopped task just starts.
func (c *CLI) ForceRestart(ctx context.Context, root, task string) error {
	args, err := ActArgs(root, "kill", task)
	if err != nil {
		return err
	}
	if _, err := c.run(ctx, 30*time.Second, append(args, "--wait", "--wait-timeout", "20s")...); err != nil {
		return err
	}
	return c.Act(ctx, root, "start", task)
}

// WhyDep is one dependency in `dekit why --json`.
type WhyDep struct {
	Path      string          `json:"path"`
	State     string          `json:"state"`
	ExitCode  *int            `json:"exit_code,omitempty"`
	Signal    json.RawMessage `json:"signal,omitempty"`
	Reason    string          `json:"reason,omitempty"`
	Wanted    bool            `json:"wanted"`
	Satisfied bool            `json:"satisfied"`
}

// Why is `dekit why --json`: why a task is (not) running.
type Why struct {
	ID         int             `json:"id"`
	Path       string          `json:"path"`
	State      string          `json:"state"`
	ExitCode   *int            `json:"exit_code,omitempty"`
	Signal     json.RawMessage `json:"signal,omitempty"`
	Reason     string          `json:"reason,omitempty"`
	Wanted     bool            `json:"wanted"`    // something wants it running
	Supported  bool            `json:"supported"` // its dependencies let it run
	Vetoed     bool            `json:"vetoed"`    // kept stopped (dekit veto)
	Pinned     bool            `json:"pinned"`    // started by hand, not only as a dependency
	RequiredBy []string        `json:"required_by"`
	Deps       []WhyDep        `json:"deps"`
	Attempts   int             `json:"attempts"` // restart attempts since it last started by hand
}

// ParseWhy reads `dekit why --json`.
func ParseWhy(b []byte) (Why, error) {
	var w Why
	if err := json.Unmarshal(b, &w); err != nil {
		return w, fmt.Errorf("dekit why: %w", err)
	}
	if w.RequiredBy == nil {
		w.RequiredBy = []string{}
	}
	if w.Deps == nil {
		w.Deps = []WhyDep{}
	}
	return w, nil
}

// Why explains one task's state.
func (c *CLI) Why(ctx context.Context, root, task string) (Why, error) {
	if task == "" || strings.ContainsAny(task, "*?[+") {
		return Why{}, errors.New("why takes one task path")
	}
	out, err := c.run(ctx, 5*time.Second, "-C", root, "why", "--json", task)
	if err != nil {
		return Why{}, err
	}
	return ParseWhy(out)
}

// SpawnSpec is a one-off task for `dekit spawn` (plan §4.7).
type SpawnSpec struct {
	Path string            `json:"path"` // task path, such as "tmp/migrate"
	Cmd  []string          `json:"cmd"`
	Cwd  string            `json:"cwd,omitempty"`
	Env  map[string]string `json:"env,omitempty"`
	Deps []string          `json:"deps,omitempty"`
	Tags []string          `json:"tags,omitempty"`
}

// Validate checks a spawn before dekit sees it.
func (s SpawnSpec) Validate() error {
	if err := ValidTaskPath(s.Path); err != nil {
		return err
	}
	if len(s.Cmd) == 0 || strings.TrimSpace(s.Cmd[0]) == "" {
		return errors.New("enter the command to run")
	}
	for k := range s.Env {
		if k == "" || strings.ContainsAny(k, "= \t") {
			return fmt.Errorf("%q is not a variable name", k)
		}
	}
	for _, t := range s.Tags {
		if err := validTag(t); err != nil {
			return err
		}
	}
	for _, d := range s.Deps {
		if strings.TrimSpace(d) == "" || strings.HasPrefix(d, "-") {
			return fmt.Errorf("%q is not a task", d)
		}
	}
	return nil
}

// SpawnArgs is the dekit argv for a spawn.
func SpawnArgs(root string, s SpawnSpec) []string {
	args := []string{"-C", root, "spawn", s.Path}
	if s.Cwd != "" {
		args = append(args, "--cwd", s.Cwd)
	}
	keys := make([]string, 0, len(s.Env))
	for k := range s.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, "--env", k+"="+s.Env[k])
	}
	for _, d := range s.Deps {
		args = append(args, "--dep", d)
	}
	for _, t := range s.Tags {
		args = append(args, "--tag", t)
	}
	args = append(args, "--json", "--")
	return append(args, s.Cmd...)
}

// Spawn adds a dynamic task and starts it, without touching dekit.yaml.
func (c *CLI) Spawn(ctx context.Context, root string, s SpawnSpec) error {
	if err := s.Validate(); err != nil {
		return err
	}
	_, err := c.run(ctx, 30*time.Second, SpawnArgs(root, s)...)
	return err
}

// ValidTaskPath checks a task path such as "web" or "tools/lint".
func ValidTaskPath(p string) error {
	switch {
	case strings.TrimSpace(p) == "":
		return errors.New("enter a task path, such as tmp/migrate")
	case strings.HasPrefix(p, "/") || strings.HasSuffix(p, "/") || strings.Contains(p, "//"):
		return fmt.Errorf("%q: use names separated by /, such as tmp/migrate", p)
	case strings.HasPrefix(p, "@") || strings.HasPrefix(p, "-") || strings.HasPrefix(p, "+"):
		return fmt.Errorf("%q can't start with %c", p, p[0])
	case strings.ContainsAny(p, "*?[]{} \t\n:"):
		return fmt.Errorf("%q: a task path has no spaces or wildcards", p)
	}
	return nil
}

// ReservedTags are the runner's own tags; dekit.yaml may not set them.
var ReservedTags = []string{"autostart", "dynamic"}

func validTag(t string) error {
	for _, r := range ReservedTags {
		if t == r {
			return fmt.Errorf("the tag %q is dekit's own", t)
		}
	}
	if t == "" || strings.ContainsAny(t, " \t+*?/") {
		return fmt.Errorf("%q is not a tag", t)
	}
	return nil
}
