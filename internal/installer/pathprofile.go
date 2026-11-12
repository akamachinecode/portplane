package installer

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// PathStatus says whether a terminal finds the tools in BinDir, and what
// Portplane would add to the shell's profile so it does. Portplane itself
// never needs it: it runs the tools by absolute path.
type PathStatus struct {
	Dir    string `json:"dir"`
	OnPath bool   `json:"onPath"`
	// Shell is zsh, bash, fish, sh or windows.
	Shell string `json:"shell"`
	// File is the profile Portplane would add Line to (on Windows, the
	// user's Path in the registry).
	File string `json:"file,omitempty"`
	Line string `json:"line,omitempty"`
	// Present means File already has Line.
	Present bool `json:"present"`
}

// ProfileMarker is the comment above the line Portplane adds.
const ProfileMarker = "# Added by Portplane: dekit and portless live here."

// ProfileFor returns the profile file a login shell reads and the line that
// puts dir on PATH, for shell (a path or a name such as "/bin/zsh").
func ProfileFor(goos, shell, home, dir string) (name, file, line string) {
	name = filepath.Base(shell)
	shown := dir
	if rel, err := filepath.Rel(home, dir); err == nil && filepath.IsLocal(rel) {
		shown = "$HOME/" + filepath.ToSlash(rel)
	}
	sh := `export PATH="` + shown + `:$PATH"`
	switch name {
	case "zsh":
		return name, filepath.Join(home, ".zshrc"), sh
	case "bash":
		if goos == "darwin" {
			return name, filepath.Join(home, ".bash_profile"), sh
		}
		return name, filepath.Join(home, ".bashrc"), sh
	case "fish":
		return name, filepath.Join(home, ".config", "fish", "conf.d", "portplane.fish"),
			"contains -- " + shown + " $PATH; or set -gx PATH " + shown + " $PATH"
	default:
		return "sh", filepath.Join(home, ".profile"), sh
	}
}

// AddLine appends line, under ProfileMarker, to file unless the file
// already has it. It creates the file (and its folder) when needed, keeps
// its permissions, writes through a symlinked profile, and reports whether
// it changed anything. Calling it twice never adds the line twice.
func AddLine(file, line string) (bool, error) {
	if real, err := filepath.EvalSymlinks(file); err == nil {
		file = real
	}
	old, err := os.ReadFile(file)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if hasLine(old, line) {
		return false, nil
	}
	var b bytes.Buffer
	b.Write(old)
	if len(old) > 0 {
		if !bytes.HasSuffix(old, []byte("\n")) {
			b.WriteByte('\n')
		}
		b.WriteByte('\n')
	}
	b.WriteString(ProfileMarker + "\n" + line + "\n")
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return false, err
	}
	mode := os.FileMode(0o644)
	if fi, err := os.Stat(file); err == nil {
		mode = fi.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(file), "."+filepath.Base(file)+".*")
	if err != nil {
		return false, err
	}
	if _, err := tmp.Write(b.Bytes()); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return false, err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return false, err
	}
	if err := os.Chmod(tmp.Name(), mode); err != nil {
		_ = os.Remove(tmp.Name())
		return false, err
	}
	if err := os.Rename(tmp.Name(), file); err != nil {
		_ = os.Remove(tmp.Name())
		return false, err
	}
	return true, nil
}

func hasLine(content []byte, line string) bool {
	for _, l := range strings.Split(string(content), "\n") {
		if strings.TrimSpace(l) == strings.TrimSpace(line) {
			return true
		}
	}
	return false
}

// onPathList reports whether dir is one of the entries of a PATH value.
func onPathList(goos, list, dir, home string) bool {
	sep := ":"
	if goos == "windows" {
		sep = ";"
	}
	want := filepath.Clean(dir)
	for _, d := range strings.Split(list, sep) {
		d = strings.TrimSpace(d)
		if d == "" {
			continue
		}
		if strings.HasPrefix(d, "~/") || strings.HasPrefix(d, "$HOME/") {
			d = filepath.Join(home, d[strings.Index(d, "/")+1:])
		}
		d = filepath.Clean(d)
		if d == want || (goos == "windows" && strings.EqualFold(d, want)) {
			return true
		}
	}
	return false
}

// PathStatus checks whether BinDir is on the PATH a new terminal gets.
func (in *Installer) PathStatus(ctx context.Context) PathStatus {
	st := PathStatus{Dir: in.BinDir}
	if in.GOOS == "windows" {
		st.Shell, st.File, st.Line = "windows", `HKCU\Environment\Path`, in.BinDir
		user, err := userPath()
		st.OnPath = err == nil && onPathList("windows", user, in.BinDir, in.Home)
		st.Present = st.OnPath
		return st
	}
	shell := envFrom(in.environ())("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	st.Shell, st.File, st.Line = ProfileFor(in.GOOS, shell, in.Home, in.BinDir)
	if b, err := os.ReadFile(st.File); err == nil {
		st.Present = hasLine(b, st.Line)
	}
	st.OnPath = st.Present || onPathList(in.GOOS, loginShellPath(ctx, shell), in.BinDir, in.Home)
	return st
}

// AddToPath adds BinDir to the shell profile (or, on Windows, the user's
// Path), after the user agreed to the exact line PathStatus showed.
func (in *Installer) AddToPath(ctx context.Context) (PathStatus, error) {
	st := in.PathStatus(ctx)
	if st.OnPath && st.Present {
		return st, nil
	}
	if in.GOOS == "windows" {
		if err := addUserPath(in.BinDir); err != nil {
			return st, err
		}
	} else if _, err := AddLine(st.File, st.Line); err != nil {
		return st, err
	}
	return in.PathStatus(ctx), nil
}

// loginShellPath asks the user's shell, as an interactive login shell (so
// zsh reads ~/.zshrc too), for its PATH. The script is a fixed literal.
func loginShellPath(ctx context.Context, shell string) string {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	args := []string{"-l", "-i", "-c", `printf '%s' "$PATH"`}
	if filepath.Base(shell) == "fish" {
		args = []string{"-l", "-i", "-c", `printf '%s' (string join : $PATH)`}
	}
	cmd := exec.CommandContext(ctx, shell, args...)
	cmd.Stdin = nil
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		return ""
	}
	return strings.TrimSpace(out.String())
}
