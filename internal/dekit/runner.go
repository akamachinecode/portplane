package dekit

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// HostRunner names the host runner (machine-wide tasks, config in
// ~/.config/dekit/host/dekit.yaml) wherever dekit takes a runner.
const HostRunner = "host"

// HostConfigFile returns the host runner's dekit.yaml, or "" without a
// home folder. dekit keeps it under ~/.config on every system.
func HostConfigFile() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "dekit", "host", ConfigFile)
}

// RunnerStatus is `dekit runner status --json`. Status is running,
// starting, stale (a record whose process is gone), failed or absent.
type RunnerStatus struct {
	Status          string   `json:"status"`
	Kind            string   `json:"kind,omitempty"`
	Root            string   `json:"root,omitempty"`
	PID             int      `json:"pid,omitempty"`
	Version         string   `json:"version,omitempty"`
	Binary          string   `json:"binary,omitempty"`
	SelectedBinary  string   `json:"selected_binary,omitempty"`
	SelectionError  *string  `json:"selection_error,omitempty"`
	RestartRequired bool     `json:"restart_required,omitempty"`
	StartedAt       int64    `json:"started_at,omitempty"` // Unix seconds
	Warnings        []string `json:"warnings,omitempty"`
}

// runnerArgs selects a runner: the host runner by name, a project by -C.
func runnerArgs(root string, args ...string) []string {
	if root == HostRunner {
		return append(args, HostRunner)
	}
	return append([]string{"-C", root}, args...)
}

// Status returns the runner of the project at root (or HostRunner).
func (c *CLI) Status(ctx context.Context, root string) (RunnerStatus, error) {
	out, err := c.run(ctx, 5*time.Second, runnerArgs(root, "runner", "status", "--json")...)
	if err != nil {
		return RunnerStatus{}, err
	}
	return ParseRunnerStatus(out)
}

// ParseRunnerStatus reads `dekit runner status --json`.
func ParseRunnerStatus(b []byte) (RunnerStatus, error) {
	var s RunnerStatus
	if err := json.Unmarshal(b, &s); err != nil {
		return s, fmt.Errorf("dekit runner status: %w", err)
	}
	if s.Status == "" {
		s.Status = "absent"
	}
	return s, nil
}

// ParseRunnerList reads `dekit runner list --json`.
func ParseRunnerList(b []byte) ([]RunnerRecord, error) {
	var recs []RunnerRecord
	if err := json.Unmarshal(b, &recs); err != nil {
		return nil, fmt.Errorf("dekit runner list: %w", err)
	}
	return recs, nil
}

// RunnerAction is something to do to a whole runner.
type RunnerAction string

const (
	RunnerUp      RunnerAction = "up"      // start the runner and its saved and autostart tasks
	RunnerDown    RunnerAction = "down"    // stop it, saving the tasks for the next up
	RunnerStop    RunnerAction = "stop"    // stop it without saving (dekit runner stop)
	RunnerRestart RunnerAction = "restart" // restart it live, reloading dekit.yaml
	RunnerUpgrade RunnerAction = "upgrade" // switch it live to its selected kernel
)

// Valid reports whether a is a known runner action.
func (a RunnerAction) Valid() bool {
	switch a {
	case RunnerUp, RunnerDown, RunnerStop, RunnerRestart, RunnerUpgrade:
		return true
	}
	return false
}

// UpWaitTimeout is how long "Start" waits for the tasks to be ready.
const UpWaitTimeout = 3 * time.Minute

// RunnerArgs is the dekit argv (after the binary) for a runner action.
func RunnerArgs(root string, a RunnerAction) ([]string, error) {
	switch a {
	case RunnerUp:
		return runnerArgs(root, "up", "--wait", "--wait-timeout", fmt.Sprintf("%ds", int(UpWaitTimeout.Seconds())), "--json"), nil
	case RunnerDown:
		return runnerArgs(root, "down", "--json"), nil
	case RunnerStop:
		return runnerArgs(root, "runner", "stop", "--json"), nil
	case RunnerRestart:
		return runnerArgs(root, "runner", "restart", "--json"), nil
	case RunnerUpgrade:
		return runnerArgs(root, "runner", "upgrade", "--json"), nil
	}
	return nil, fmt.Errorf("unknown runner action %q", a)
}

// WaitTask is one task of `up --wait --json` or `wait --json`.
type WaitTask struct {
	TaskState
	Wait string `json:"wait"` // met, failed, pending
	Why  *Why   `json:"why,omitempty"`
}

// WaitResult is what `--wait --json` prints: whether every task got there.
type WaitResult struct {
	Wait  string     `json:"wait"` // met, failed, timeout
	Tasks []WaitTask `json:"tasks"`
}

// ParseWait reads the JSON of `up --wait --json` and `wait --json`.
func ParseWait(b []byte) (WaitResult, error) {
	var w WaitResult
	if err := json.Unmarshal(b, &w); err != nil {
		return w, fmt.Errorf("dekit wait: %w", err)
	}
	return w, nil
}

// RunLong runs dekit with args for up to timeout, copying its output to w
// as it comes (a job's log). Stdout is also returned, for --json output.
func (c *CLI) RunLong(ctx context.Context, w io.Writer, timeout time.Duration, args ...string) ([]byte, error) {
	bin := c.Path()
	if bin == "" {
		return nil, ErrNotInstalled
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if c.Exec != nil {
		out, errb, err := c.Exec(ctx, CleanEnv(os.Environ()), bin, args...)
		_, _ = w.Write(errb)
		return out, wrapErr(args, errb, err)
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = CleanEnv(os.Environ())
	cmd.WaitDelay = 2 * time.Second
	var out, errb strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = io.MultiWriter(w, &errb)
	err := cmd.Run()
	return []byte(out.String()), wrapErr(args, []byte(errb.String()), err)
}

func wrapErr(args []string, errb []byte, err error) error {
	if err == nil {
		return nil
	}
	msg := strings.TrimSpace(string(errb))
	if strings.Contains(msg, "Runner is not running") {
		return ErrRunnerDown
	}
	if i := strings.LastIndex(msg, "\nError: "); i >= 0 {
		msg = msg[i+1:]
	}
	if msg == "" {
		msg = err.Error()
	}
	msg = strings.TrimPrefix(msg, "Error: ")
	return fmt.Errorf("dekit %s: %s", strings.Join(args, " "), msg)
}

// UpgradeAllArgs switches every runner on an older copy of this dekit.
func UpgradeAllArgs() []string { return []string{"runner", "upgrade", "--all"} }

// Clean removes the records of runners that are gone. Running ones stay.
func (c *CLI) Clean(ctx context.Context) error {
	_, err := c.run(ctx, 15*time.Second, "runner", "clean")
	return err
}
