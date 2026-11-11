// Package autostart starts Portplane when the user logs in: a LaunchAgent on
// macOS, an XDG autostart entry on Linux and a Run key on Windows. Each one
// starts `portplane serve` without opening a window.
package autostart

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Label identifies the entry on every OS.
const Label = "dev.portplane.portplane"

// Args are passed to the binary at login.
var Args = []string{"serve"}

// Home is replaceable in tests.
var Home = os.UserHomeDir

// Executable is replaceable in tests.
var Executable = func() (string, error) {
	p, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(p)
}

// Enabled reports whether Portplane starts at login.
func Enabled() (bool, error) {
	return enabled()
}

// Enable makes Portplane start at login with the current executable.
func Enable() error {
	exe, err := Executable()
	if err != nil {
		return err
	}
	if strings.Contains(exe, "go-build") {
		return fmt.Errorf("refusing to start a temporary go run build at login (%s); install portplane first", exe)
	}
	if strings.Contains(exe, "/AppTranslocation/") || strings.HasPrefix(exe, "/Volumes/") {
		return fmt.Errorf("running from the disk image (%s): move Portplane to Applications first, then turn this on", exe)
	}
	return enable(exe)
}

// Disable removes the entry.
func Disable() error { return disable() }

// plist is the macOS LaunchAgent.
func plist(exe string) string {
	args := "    <string>" + xmlEscape(exe) + "</string>\n"
	for _, a := range Args {
		args += "    <string>" + xmlEscape(a) + "</string>\n"
	}
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>` + Label + `</string>
  <key>ProgramArguments</key>
  <array>
` + args + `  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`
}

// desktopEntry is the XDG autostart file.
func desktopEntry(exe string) string {
	return "[Desktop Entry]\nType=Application\nName=Portplane\nComment=Every dev server, on every machine, in one window\nExec=" +
		desktopQuote(exe) + " " + strings.Join(Args, " ") + "\nIcon=portplane\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

func desktopQuote(s string) string {
	if !strings.ContainsAny(s, " \t\"'\\$`") {
		return s
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "`", "\\`", "$", `\$`).Replace(s) + `"`
}

func entryPath() (string, error) {
	home, err := Home()
	if err != nil {
		return "", err
	}
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "LaunchAgents", Label+".plist"), nil
	default:
		dir := os.Getenv("XDG_CONFIG_HOME")
		if dir == "" {
			dir = filepath.Join(home, ".config")
		}
		return filepath.Join(dir, "autostart", "portplane.desktop"), nil
	}
}

func writeFile(path, body string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(body), 0o644)
}
