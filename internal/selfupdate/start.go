package selfupdate

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// AfterPIDEnv tells a Portplane started by Start which process it
// replaces: it waits for that one to quit before it starts serving. Older
// versions ignore it, so a restart never fails on an unknown flag.
const AfterPIDEnv = "PORTPLANE_AFTER_PID"

// Start runs exe with args as a new Portplane that outlives this process
// (pid): in its own session on macOS and Linux, with its own hidden console
// on Windows (so the programs it runs share that console, as at login). On
// macOS and Linux a fixed /bin/sh script waits for pid to quit and then
// execs exe, so the restart works whatever version exe is.
func Start(exe string, args []string, pid int) error {
	argv := waitThen(pid, append([]string{exe}, args...))
	cmd := exec.Command(argv[0], argv[1:]...) //nolint:noctx // it must outlive this process
	cmd.Env = append(withoutEnv(os.Environ(), AfterPIDEnv), AfterPIDEnv+"="+strconv.Itoa(pid))
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.SysProcAttr = detached()
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// waitScript waits up to 30 s for process $1 to quit, then runs the rest of
// its arguments. It is a constant: paths reach it as arguments only.
const waitScript = `i=0; while kill -0 "$1" 2>/dev/null && [ "$i" -lt 150 ]; do sleep 0.2; i=$((i+1)); done; shift; exec "$@"`

func withoutEnv(env []string, name string) []string {
	out := env[:0:0]
	for _, kv := range env {
		if !strings.HasPrefix(kv, name+"=") {
			out = append(out, kv)
		}
	}
	return out
}

// RestartArgs are the arguments of the Portplane that replaces one started
// with args: the same serve flags, with its window open.
func RestartArgs(args []string) []string {
	if len(args) == 0 || args[0] != "serve" {
		return []string{"serve", "--open"}
	}
	out := []string{"serve"}
	open := false
	for _, a := range args[1:] {
		if a == "--open" || a == "-open" || strings.HasPrefix(a, "--open=") || strings.HasPrefix(a, "-open=") {
			open = true
			a = "--open"
		}
		out = append(out, a)
	}
	if !open {
		out = append(out, "--open")
	}
	return out
}
