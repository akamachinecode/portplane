package privileged

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// HelperCommand is the hidden portplane subcommand that macOS and Windows
// start as administrator. The system dialogs there cannot pass output back,
// so the helper runs the argv with its environment, writes the output to a
// file the user's Portplane reads as it grows, and the exit status to
// another. Both files are created beforehand by the user, in a private
// folder, so root only writes to them.
const HelperCommand = "elevated-run"

func helperArgs(c Command, outPath, codePath string) []string {
	args := []string{HelperCommand, "--out", outPath, "--code", codePath}
	for _, kv := range envList(c.Env) {
		args = append(args, "--env", kv)
	}
	args = append(args, "--")
	return append(args, c.Argv...)
}

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

// RunHelper is the helper's main; args follow the subcommand name. It
// returns the program's exit status.
func RunHelper(args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet(HelperCommand, flag.ContinueOnError)
	fs.SetOutput(stderr)
	outPath := fs.String("out", "", "file to append the output to")
	codePath := fs.String("code", "", "file to write the exit status to")
	var env multiFlag
	fs.Var(&env, "env", "K=V added to the environment")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	argv := fs.Args()
	if len(argv) == 0 || *outPath == "" || *codePath == "" {
		fmt.Fprintln(stderr, "usage: portplane elevated-run --out FILE --code FILE [--env K=V]... -- PROGRAM [ARGS]...")
		return 2
	}
	out, err := os.OpenFile(*outPath, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	defer func() { _ = out.Close() }()
	code := runChild(argv, env, out)
	if f, err := os.OpenFile(*codePath, os.O_WRONLY|os.O_TRUNC, 0); err == nil {
		_, _ = f.WriteString(strconv.Itoa(code))
		_ = f.Close()
	}
	return code
}

func runChild(argv, env []string, out io.Writer) int {
	cmd := exec.CommandContext(context.Background(), argv[0], argv[1:]...)
	cmd.Env = mergeEnv(os.Environ(), env)
	cmd.Stdout, cmd.Stderr = out, out
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &exit):
		if c := exit.ExitCode(); c >= 0 {
			return c
		}
		return 1
	default:
		fmt.Fprintln(out, err)
		return 127
	}
}

// mergeEnv returns base with the K=V pairs of extra replacing the same keys.
func mergeEnv(base, extra []string) []string {
	keys := map[string]bool{}
	for _, kv := range extra {
		k, _, _ := strings.Cut(kv, "=")
		keys[strings.ToUpper(k)] = true
	}
	out := make([]string, 0, len(base)+len(extra))
	for _, kv := range base {
		k, _, _ := strings.Cut(kv, "=")
		if !keys[strings.ToUpper(k)] {
			out = append(out, kv)
		}
	}
	return append(out, extra...)
}

// helperFiles creates the private folder and the two files the helper
// writes to.
func helperFiles() (dir, outPath, codePath string, err error) {
	dir, err = os.MkdirTemp("", "portplane-elevated-")
	if err != nil {
		return "", "", "", err
	}
	outPath = filepath.Join(dir, "output")
	codePath = filepath.Join(dir, "status")
	for _, p := range []string{outPath, codePath} {
		f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600) // root writes it anyway
		if err != nil {
			_ = os.RemoveAll(dir)
			return "", "", "", err
		}
		_ = f.Close()
	}
	return dir, outPath, codePath, nil
}

// follow copies what is appended to path into out until done is closed,
// then copies the rest.
func follow(path string, out io.Writer, done <-chan struct{}) {
	f, err := os.Open(path)
	if err != nil {
		<-done
		return
	}
	defer func() { _ = f.Close() }()
	buf := make([]byte, 32*1024)
	drain := func() {
		for {
			n, err := f.Read(buf)
			if n > 0 {
				_, _ = out.Write(buf[:n])
			}
			if err != nil || n == 0 {
				return
			}
		}
	}
	t := time.NewTicker(200 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-done:
			drain()
			return
		case <-t.C:
			drain()
		}
	}
}

// helperStatus reads the exit status the helper wrote; -1 when it wrote
// none, which means it never ran.
func helperStatus(codePath string) int {
	b, err := os.ReadFile(codePath)
	if err != nil {
		return -1
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		return -1
	}
	return n
}

func statusError(code int) error {
	switch code {
	case 0:
		return nil
	case -1:
		return errors.New("the command did not run")
	default:
		return fmt.Errorf("the command failed with exit status %d", code)
	}
}
