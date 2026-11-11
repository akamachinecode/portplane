package dekit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/envpath"
)

// ErrRunnerDown means the project's runner is not running (`dekit up` starts it).
var ErrRunnerDown = errors.New("dekit runner is not running")

// ErrNotInstalled means no dekit binary was found.
var ErrNotInstalled = errors.New("dekit is not installed")

// Exec runs a program and returns its stdout and stderr.
type Exec func(ctx context.Context, env []string, name string, args ...string) (stdout, stderr []byte, err error)

// CLI calls the dekit command line.
type CLI struct {
	// Bin is dekit's path. Empty: dekit is looked up on PATH, again every
	// few seconds, so one installed while Portplane runs is found.
	Bin  string
	Exec Exec
	// Lookup finds a program; envpath.Lookup when nil.
	Lookup func(name string) string
}

// NewCLI returns a CLI that finds dekit on PATH.
func NewCLI() *CLI {
	return &CLI{Exec: runProcess}
}

// Path is dekit's path now, or "" when it is not installed.
func (c *CLI) Path() string {
	if c.Bin != "" {
		return c.Bin
	}
	if c.Lookup != nil {
		return c.Lookup("dekit")
	}
	return envpath.Lookup("dekit")
}

func runProcess(ctx context.Context, env []string, name string, args ...string) ([]byte, []byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = env
	cmd.WaitDelay = 2 * time.Second
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	return out.Bytes(), errb.Bytes(), err
}

// Available reports whether dekit was found.
func (c *CLI) Available() bool { return c.Path() != "" }

func (c *CLI) run(ctx context.Context, timeout time.Duration, args ...string) ([]byte, error) {
	bin := c.Path()
	if bin == "" {
		return nil, ErrNotInstalled
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	run := c.Exec
	if run == nil {
		run = runProcess
	}
	out, errb, err := run(ctx, CleanEnv(os.Environ()), bin, args...)
	if err != nil {
		msg := strings.TrimSpace(string(errb))
		if strings.Contains(msg, "Runner is not running") {
			return out, ErrRunnerDown
		}
		if msg == "" {
			msg = err.Error()
		}
		msg = strings.TrimPrefix(msg, "Error: ")
		return out, fmt.Errorf("dekit %s: %s", strings.Join(args, " "), msg)
	}
	return out, nil
}

// Version returns dekit's version, such as "0.10.3".
func (c *CLI) Version(ctx context.Context) (string, error) {
	out, err := c.run(ctx, 5*time.Second, "--version")
	if err != nil {
		return "", err
	}
	v := strings.TrimSpace(string(out))
	v = strings.TrimPrefix(v, "dekit ")
	return v, nil
}

// RunnerRecord is one entry of `dekit runner list --json`.
type RunnerRecord struct {
	PID     int    `json:"pid"`
	Root    string `json:"root"`
	Kind    string `json:"kind"`
	Running bool   `json:"running"`
	Version string `json:"version"`
}

// Runners lists the runner records on this machine.
func (c *CLI) Runners(ctx context.Context) ([]RunnerRecord, error) {
	out, err := c.run(ctx, 5*time.Second, "runner", "list", "--json")
	if err != nil {
		return nil, err
	}
	var recs []RunnerRecord
	if err := json.Unmarshal(out, &recs); err != nil {
		return nil, fmt.Errorf("dekit runner list: %w", err)
	}
	return recs, nil
}

// TaskState is one entry of `dekit ls --json`.
type TaskState struct {
	ID       int             `json:"id"`
	Path     string          `json:"path"`
	Label    string          `json:"label,omitempty"`
	Kind     string          `json:"kind"`
	State    string          `json:"state"`
	ExitCode *int            `json:"exit_code,omitempty"`
	Signal   json.RawMessage `json:"signal,omitempty"`
	Reason   string          `json:"reason,omitempty"`
}

// SignalName returns the signal as text, whatever JSON type dekit used.
func (t TaskState) SignalName() string {
	if len(t.Signal) == 0 || string(t.Signal) == "null" {
		return ""
	}
	var s string
	if json.Unmarshal(t.Signal, &s) == nil {
		return s
	}
	var n int
	if json.Unmarshal(t.Signal, &n) == nil {
		return strconv.Itoa(n)
	}
	return string(t.Signal)
}

// List returns the live state of every task in the project at root.
func (c *CLI) List(ctx context.Context, root string) ([]TaskState, error) {
	out, err := c.run(ctx, 5*time.Second, "-C", root, "ls", "--json")
	if err != nil {
		return nil, err
	}
	var res struct {
		Tasks []TaskState `json:"tasks"`
	}
	if err := json.Unmarshal(out, &res); err != nil {
		return nil, fmt.Errorf("dekit ls: %w", err)
	}
	return res.Tasks, nil
}

// Act runs start, stop or restart on a target (a task path, glob or +tag).
func (c *CLI) Act(ctx context.Context, root, verb, target string) error {
	switch verb {
	case "start", "stop", "restart":
	default:
		return fmt.Errorf("unknown verb %q", verb)
	}
	_, err := c.run(ctx, 30*time.Second, "-C", root, verb, target)
	return err
}

// Up starts the project's runner and its saved and autostart tasks.
func (c *CLI) Up(ctx context.Context, root string) error {
	_, err := c.run(ctx, 30*time.Second, "-C", root, "up")
	return err
}

// Reload applies config changes to a running runner.
func (c *CLI) Reload(ctx context.Context, root string) error {
	_, err := c.run(ctx, 30*time.Second, "-C", root, "reload", "--yes")
	return err
}

// Screen returns what a task's terminal shows now.
func (c *CLI) Screen(ctx context.Context, root, task string) (string, error) {
	out, err := c.run(ctx, 5*time.Second, "-C", root, "screen", "--json", task)
	if err != nil {
		return "", err
	}
	var res struct {
		Screen string `json:"screen"`
	}
	if err := json.Unmarshal(out, &res); err != nil {
		return "", fmt.Errorf("dekit screen: %w", err)
	}
	return res.Screen, nil
}

// agentVars are environment variables that make some dev tools change
// behaviour when they think a coding agent runs them (field notes: Astro 7
// moves `astro dev` to the background). A runner started by Portplane must
// not pass them on to every task.
var agentVars = []string{"AI_AGENT", "AGENT", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "CODEX_SANDBOX", "CURSOR_TRACE_ID", "CURSOR_AGENT", "GEMINI_CLI", "OPENCODE"}

// CleanEnv returns env without the variables that identify a coding agent.
func CleanEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		drop := false
		for _, a := range agentVars {
			if strings.EqualFold(k, a) {
				drop = true
				break
			}
		}
		if !drop {
			out = append(out, kv)
		}
	}
	return out
}
