// Package desktop talks to the user's desktop: open a URL in the browser,
// reveal a folder, ask for a folder.
package desktop

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ErrCancelled means the user closed the folder picker.
var ErrCancelled = errors.New("cancelled")

// ErrUnsupported means no folder picker is available.
var ErrUnsupported = errors.New("no folder picker available")

// OpenURL opens an http(s) URL in the default browser.
func OpenURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("refusing to open %q", raw)
	}
	return start(opener(u.String()))
}

// OpenApp opens the UI as an app window when a Chromium-based browser is
// found (ADR-0004), and in the default browser otherwise.
func OpenApp(raw string) error {
	if bin := chromium(); bin != "" {
		if err := start(append([]string{bin}, "--app="+raw)); err == nil {
			return nil
		}
	}
	return OpenURL(raw)
}

// Reveal opens a folder in the file manager.
func Reveal(dir string) error {
	fi, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s is not a folder", dir)
	}
	switch runtime.GOOS {
	case "darwin":
		return start([]string{"open", dir})
	case "windows":
		return start([]string{"explorer", dir})
	default:
		return start([]string{"xdg-open", dir})
	}
}

func opener(target string) []string {
	switch runtime.GOOS {
	case "darwin":
		return []string{"open", target}
	case "windows":
		return []string{"rundll32", "url.dll,FileProtocolHandler", target}
	default:
		return []string{"xdg-open", target}
	}
}

func start(argv []string) error {
	cmd := exec.Command(argv[0], argv[1:]...) //nolint:noctx // detached: it must outlive the request
	cmd.Stdout, cmd.Stderr = nil, nil
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func chromium() string {
	switch runtime.GOOS {
	case "darwin":
		for _, app := range []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		} {
			if _, err := os.Stat(app); err == nil {
				return app
			}
		}
	case "windows":
		for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "LocalAppData"} {
			base := os.Getenv(env)
			if base == "" {
				continue
			}
			for _, rel := range []string{`Google\Chrome\Application\chrome.exe`, `Microsoft\Edge\Application\msedge.exe`, `BraveSoftware\Brave-Browser\Application\brave.exe`} {
				p := filepath.Join(base, rel)
				if _, err := os.Stat(p); err == nil {
					return p
				}
			}
		}
	default:
		for _, name := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"} {
			if p, err := exec.LookPath(name); err == nil {
				return p
			}
		}
	}
	return ""
}

// CanPickFolder reports whether PickFolder can work here.
func CanPickFolder() bool { return pickerCommand() != nil }

func pickerCommand() []string {
	switch runtime.GOOS {
	case "darwin":
		return []string{"osascript", "-e", `POSIX path of (choose folder with prompt "Choose a folder with projects")`}
	case "windows":
		return []string{"powershell", "-NoProfile", "-STA", "-Command",
			`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose a folder with projects'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 1 }`}
	default:
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return nil
		}
		if p, err := exec.LookPath("zenity"); err == nil {
			return []string{p, "--file-selection", "--directory", "--title=Choose a folder with projects"}
		}
		if p, err := exec.LookPath("kdialog"); err == nil {
			return []string{p, "--getexistingdirectory", os.Getenv("HOME"), "--title", "Choose a folder with projects"}
		}
	}
	return nil
}

// CanPickImage reports whether PickImage can work here.
func CanPickImage() bool { return imagePickerCommand() != nil }

func imagePickerCommand() []string {
	switch runtime.GOOS {
	case "darwin":
		return []string{"osascript", "-e", `POSIX path of (choose file with prompt "Choose an icon" of type {"public.image", "public.svg-image"})`}
	case "windows":
		return []string{"powershell", "-NoProfile", "-STA", "-Command",
			`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = 'Choose an icon'; $d.Filter = 'Images|*.svg;*.png;*.ico;*.webp;*.jpg;*.jpeg;*.gif'; if ($d.ShowDialog() -eq 'OK') { $d.FileName } else { exit 1 }`}
	default:
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return nil
		}
		if p, err := exec.LookPath("zenity"); err == nil {
			return []string{p, "--file-selection", "--title=Choose an icon", "--file-filter=Images | *.svg *.png *.ico *.webp *.jpg *.jpeg *.gif"}
		}
		if p, err := exec.LookPath("kdialog"); err == nil {
			return []string{p, "--getopenfilename", os.Getenv("HOME"), "*.svg *.png *.ico *.webp *.jpg *.jpeg *.gif|Images", "--title", "Choose an icon"}
		}
	}
	return nil
}

// PickImage shows the OS file picker for an image and returns the chosen file.
func PickImage(ctx context.Context) (string, error) {
	return runPicker(ctx, imagePickerCommand())
}

// PickFolder shows the OS folder picker and returns the chosen folder.
func PickFolder(ctx context.Context) (string, error) {
	return runPicker(ctx, pickerCommand())
}

func runPicker(ctx context.Context, argv []string) (string, error) {
	if argv == nil {
		return "", ErrUnsupported
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", ErrCancelled
	}
	p := strings.TrimSpace(out.String())
	if p == "" {
		return "", ErrCancelled
	}
	return filepath.Clean(p), nil
}
