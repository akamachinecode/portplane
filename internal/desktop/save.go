package desktop

import (
	"bufio"
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// SaveFile shows the desktop's save dialog for a file named name and
// returns the chosen path. It returns ErrCancelled when the user closes
// it, and ErrUnsupported when there is no dialog to show (no zenity or
// kdialog on Linux, no display).
func SaveFile(ctx context.Context, name string) (string, error) {
	argv, env := saveCommand(name)
	if argv == nil {
		return "", ErrUnsupported
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Stdout = &out
	if env != nil {
		cmd.Env = append(os.Environ(), env...)
	}
	if err := cmd.Run(); err != nil {
		return "", ErrCancelled
	}
	p := strings.TrimSpace(out.String())
	if p == "" {
		return "", ErrCancelled
	}
	return filepath.Clean(p), nil
}

// saveCommand is the dialog's argv. The file name is data: an argument of
// a fixed AppleScript, an environment variable of a fixed PowerShell
// script, or one argument to zenity or kdialog.
func saveCommand(name string) (argv, env []string) {
	switch runtime.GOOS {
	case "darwin":
		return []string{"osascript",
			"-e", "on run argv",
			"-e", "POSIX path of (choose file name with prompt (item 2 of argv) default name (item 3 of argv))",
			"-e", "end run",
			"portplane", "Save the diagnostic report", name}, nil
	case "windows":
		return []string{"powershell", "-NoProfile", "-STA", "-Command",
				`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.SaveFileDialog; $d.Title = 'Save the diagnostic report'; $d.FileName = $env:PORTPLANE_SAVE_NAME; $d.Filter = 'Zip archive (*.zip)|*.zip'; if ($d.ShowDialog() -eq 'OK') { $d.FileName } else { exit 1 }`},
			[]string{"PORTPLANE_SAVE_NAME=" + name}
	default:
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return nil, nil
		}
		start := filepath.Join(DownloadsDir(), name)
		if p, err := exec.LookPath("zenity"); err == nil {
			return []string{p, "--file-selection", "--save", "--confirm-overwrite", "--title=Save the diagnostic report", "--filename=" + start}, nil
		}
		if p, err := exec.LookPath("kdialog"); err == nil {
			return []string{p, "--getsavefilename", start, "*.zip", "--title", "Save the diagnostic report"}, nil
		}
	}
	return nil, nil
}

// DownloadsDir is the user's downloads folder: XDG_DOWNLOAD_DIR from
// user-dirs.dirs on Linux (it is translated on many desktops), else
// ~/Downloads.
func DownloadsDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return os.TempDir()
	}
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		cfg := os.Getenv("XDG_CONFIG_HOME")
		if cfg == "" {
			cfg = filepath.Join(home, ".config")
		}
		if d := xdgDownloadDir(filepath.Join(cfg, "user-dirs.dirs"), home); d != "" {
			return d
		}
	}
	return filepath.Join(home, "Downloads")
}

// xdgDownloadDir reads XDG_DOWNLOAD_DIR="$HOME/Downloads" from a
// user-dirs.dirs file; "" when it is missing.
func xdgDownloadDir(file, home string) string {
	f, err := os.Open(file)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		v, ok := strings.CutPrefix(strings.TrimSpace(sc.Text()), "XDG_DOWNLOAD_DIR=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"`)
		v = strings.Replace(v, "$HOME", home, 1)
		if !filepath.IsAbs(v) || filepath.Clean(v) == filepath.Clean(home) {
			return "" // "$HOME" itself means the folder is off
		}
		return filepath.Clean(v)
	}
	return ""
}
