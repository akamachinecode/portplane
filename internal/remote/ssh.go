package remote

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/akamachinecode/portplane/internal/buildinfo"
)

// SSH reaches a machine with the system ssh, so ~/.ssh/config, agents,
// ProxyJump and Tailscale SSH all work as they do in a terminal.
type SSH struct {
	Host string // ssh destination
	// Bin is the ssh program; "ssh" by default. Tests use a fake.
	Bin string
	// Args are extra ssh options (for example -p, -F, -i).
	Args []string
	// Binaries finds a portplane build for another OS/arch (downloads).
	Binaries func(ctx context.Context, goos, goarch string) (string, error)
	// Self is the binary uploaded to machines of this OS/arch; the running
	// executable by default.
	Self string

	mu        sync.Mutex
	remoteCmd string
}

// Platform is a remote machine's OS and architecture, as Go names them.
type Platform struct {
	OS, Arch string
}

func (s *SSH) bin() string {
	if s.Bin != "" {
		return s.Bin
	}
	return "ssh"
}

func (s *SSH) baseArgs() []string {
	args := []string{"-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=15"}
	args = append(args, s.Args...)
	return append(args, s.Host)
}

// run executes a remote shell command and returns its stdout.
func (s *SSH) run(ctx context.Context, stdin io.Reader, script string) (string, error) {
	cmd := exec.CommandContext(ctx, s.bin(), append(s.baseArgs(), shWrap(script))...)
	cmd.Stdin = stdin
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return out.String(), errors.New(lastLine(msg))
	}
	return out.String(), nil
}

// shWrap runs a POSIX script whatever the remote login shell is (fish, zsh…).
func shWrap(script string) string {
	return "sh -c '" + strings.ReplaceAll(script, "'", `'\''`) + "'"
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndex(s, "\n"); i >= 0 {
		return strings.TrimSpace(s[i+1:])
	}
	return s
}

// Probe asks the machine for its platform and home directory.
func (s *SSH) Probe(ctx context.Context) (Platform, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := s.run(ctx, nil, "uname -s -m")
	if err != nil {
		return Platform{}, fmt.Errorf("ssh %s: %w", s.Host, err)
	}
	return parseUname(out)
}

func parseUname(out string) (Platform, error) {
	f := strings.Fields(out)
	if len(f) < 2 {
		return Platform{}, fmt.Errorf("unexpected uname output %q (Windows machines are not supported as remotes yet)", strings.TrimSpace(out))
	}
	var p Platform
	switch strings.ToLower(f[0]) {
	case "linux":
		p.OS = "linux"
	case "darwin":
		p.OS = "darwin"
	default:
		return p, fmt.Errorf("unsupported remote OS %q", f[0])
	}
	switch f[1] {
	case "x86_64", "amd64":
		p.Arch = "amd64"
	case "aarch64", "arm64":
		p.Arch = "arm64"
	default:
		return p, fmt.Errorf("unsupported remote architecture %q", f[1])
	}
	return p, nil
}

var safeDir = regexp.MustCompile(`[^A-Za-z0-9._+-]`)

// Install makes sure a portplane agent of this exact build exists on the
// machine and returns the command that starts it. It uploads the binary
// over the same ssh connection when needed and checks its SHA-256.
func (s *SSH) Install(ctx context.Context) (string, error) {
	p, err := s.Probe(ctx)
	if err != nil {
		return "", err
	}
	bin, err := s.binaryFor(ctx, p)
	if err != nil {
		return "", err
	}
	sum, err := fileSHA256(bin)
	if err != nil {
		return "", err
	}
	dir := "$HOME/.cache/portplane/" + safeDir.ReplaceAllString(buildinfo.Version(), "_") + "-" + sum[:12]
	path := dir + "/portplane"
	check := fmt.Sprintf(`p="%s"; if [ -x "$p" ]; then (sha256sum "$p" 2>/dev/null || shasum -a 256 "$p") | cut -d' ' -f1; fi`, path)
	ictx, cancel := context.WithTimeout(ctx, 30*time.Second)
	have, err := s.run(ictx, nil, check)
	cancel()
	if err != nil {
		return "", fmt.Errorf("ssh %s: %w", s.Host, err)
	}
	if strings.TrimSpace(have) != sum {
		f, err := os.Open(bin)
		if err != nil {
			return "", err
		}
		defer func() { _ = f.Close() }()
		upload := fmt.Sprintf(`set -e; d="%s"; mkdir -p "$d"; t="$d/portplane.part.$$"; cat > "$t"; chmod 755 "$t"; mv "$t" "$d/portplane"; (sha256sum "$d/portplane" 2>/dev/null || shasum -a 256 "$d/portplane") | cut -d' ' -f1`, dir)
		uctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		got, err := s.run(uctx, f, upload)
		cancel()
		if err != nil {
			return "", fmt.Errorf("uploading the agent to %s: %w", s.Host, err)
		}
		if strings.TrimSpace(got) != sum {
			return "", fmt.Errorf("the agent uploaded to %s does not match (checksum %s, want %s)", s.Host, strings.TrimSpace(got), sum)
		}
	}
	cmd := shWrap(`exec "` + path + `" agent --stdio`)
	s.mu.Lock()
	s.remoteCmd = cmd
	s.mu.Unlock()
	return cmd, nil
}

func (s *SSH) binaryFor(ctx context.Context, p Platform) (string, error) {
	if p.OS == runtime.GOOS && p.Arch == runtime.GOARCH {
		if s.Self != "" {
			return s.Self, nil
		}
		return os.Executable()
	}
	if s.Binaries == nil {
		return "", fmt.Errorf("%s is %s/%s and this build cannot fetch a matching agent; install portplane there", s.Host, p.OS, p.Arch)
	}
	return s.Binaries(ctx, p.OS, p.Arch)
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Reset forgets the cached start command, so the next Connect installs again.
func (s *SSH) Reset() {
	s.mu.Lock()
	s.remoteCmd = ""
	s.mu.Unlock()
}

// Connect installs the agent if needed and starts it, returning its stdio.
func (s *SSH) Connect(ctx context.Context) (io.ReadWriteCloser, error) {
	s.mu.Lock()
	cmdline := s.remoteCmd
	s.mu.Unlock()
	if cmdline == "" {
		c, err := s.Install(ctx)
		if err != nil {
			return nil, err
		}
		cmdline = c
	}
	cmd := exec.Command(s.bin(), append(s.baseArgs(), cmdline)...) //nolint:noctx // lives as long as the session
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var errb tail
	cmd.Stderr = &errb
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &process{cmd: cmd, stdin: stdin, stdout: stdout, stderr: &errb, done: make(chan struct{})}
	go func() {
		p.err = cmd.Wait()
		close(p.done)
	}()
	go func() {
		select {
		case <-ctx.Done():
			_ = p.Close()
		case <-p.done:
		}
	}()
	return p, nil
}

// process is a running ssh as a ReadWriteCloser. Reads after it exits
// report its stderr, which usually says why.
type process struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr *tail
	done   chan struct{}
	err    error
	once   sync.Once
}

func (p *process) Read(b []byte) (int, error) {
	n, err := p.stdout.Read(b)
	if err != nil && n == 0 {
		select {
		case <-p.done:
		case <-time.After(2 * time.Second):
		}
		if msg := lastLine(p.stderr.String()); msg != "" {
			return 0, errors.New(msg)
		}
	}
	return n, err
}

func (p *process) Write(b []byte) (int, error) { return p.stdin.Write(b) }

func (p *process) Close() error {
	p.once.Do(func() {
		_ = p.stdin.Close()
		select {
		case <-p.done:
		case <-time.After(3 * time.Second):
			if p.cmd.Process != nil {
				_ = p.cmd.Process.Kill()
			}
		}
	})
	return nil
}

// tail keeps the last few KB written to it.
type tail struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tail) Write(b []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, b...)
	if len(t.buf) > 8192 {
		t.buf = t.buf[len(t.buf)-8192:]
	}
	return len(b), nil
}

func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}
