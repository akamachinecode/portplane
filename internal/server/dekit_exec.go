package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/envpath"
)

func goos() string { return runtime.GOOS }

func yamlUnmarshal(b []byte, v any) error { return yaml.Unmarshal(b, v) }

// runCommand runs a program found on PATH (a package manager) for a job,
// with argv only and output streamed to w.
func runCommand(ctx context.Context, w io.Writer, argv []string) error {
	if len(argv) == 0 {
		return errors.New("nothing to run")
	}
	bin := envpath.Lookup(argv[0])
	if bin == "" {
		return fmt.Errorf("%s isn't installed or isn't on PATH", argv[0])
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, argv[1:]...)
	cmd.Env = dekit.CleanEnv(os.Environ())
	cmd.Stdout, cmd.Stderr = w, w
	cmd.WaitDelay = 2 * time.Second
	return cmd.Run()
}
