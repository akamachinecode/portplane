//go:build !darwin || cgo

package tray

import (
	"context"
	"os"
	"runtime"

	"fyne.io/systray"

	"github.com/akamachinecode/portplane/internal/icon"
)

// Available reports whether a tray can be shown here.
func Available() bool {
	switch runtime.GOOS {
	case "darwin", "windows":
		return true
	}
	// Linux and BSDs: needs a desktop session bus (StatusNotifierItem).
	return os.Getenv("DBUS_SESSION_BUS_ADDRESS") != "" && (os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "")
}

func setIcon(lit int) {
	if lit > 3 {
		lit = 3
	}
	switch runtime.GOOS {
	case "darwin":
		systray.SetTemplateIcon(icon.TemplatePNG(44, lit), icon.PNG(44, lit))
	case "windows":
		systray.SetIcon(icon.ICO(icon.PNG(16, lit), icon.PNG(32, lit)))
	default:
		systray.SetIcon(icon.PNG(64, lit))
	}
}

func run(ctx context.Context, o Options) {
	onReady := func() {
		setIcon(0)
		systray.SetTooltip("Portplane")
		status := systray.AddMenuItem("Starting…", "")
		status.Disable()
		open := systray.AddMenuItem("Open Portplane", "Open the Portplane window")
		systray.AddSeparator()
		on := false
		if o.Autostart != nil {
			on, _ = o.Autostart()
		}
		login := systray.AddMenuItemCheckbox("Start at login", "Start Portplane when you log in", on)
		systray.AddSeparator()
		quit := systray.AddMenuItem("Quit Portplane", "Stop Portplane (your dev servers keep running)")

		go func() {
			lastLit := -1
			for {
				select {
				case <-ctx.Done():
					systray.Quit()
					return
				case s := <-o.Updates:
					c := Count(s)
					status.SetTitle(c.Summary())
					systray.SetTooltip("Portplane: " + c.Summary())
					if runtime.GOOS == "darwin" {
						if c.Running > 0 {
							systray.SetTitle(" " + itoa(c.Running))
						} else {
							systray.SetTitle("")
						}
					}
					lit := c.Running
					if lit > 3 {
						lit = 3
					}
					if lit != lastLit {
						setIcon(lit)
						lastLit = lit
					}
				case <-open.ClickedCh:
					if o.Open != nil {
						o.Open()
					}
				case <-login.ClickedCh:
					if o.SetAutostart == nil {
						continue
					}
					want := !login.Checked()
					if err := o.SetAutostart(want); err != nil {
						if o.ReportFailure != nil {
							o.ReportFailure(err)
						}
						continue
					}
					if want {
						login.Check()
					} else {
						login.Uncheck()
					}
				case <-quit.ClickedCh:
					if o.Quit != nil {
						o.Quit()
					}
					systray.Quit()
					return
				}
			}
		}()
	}
	systray.Run(onReady, func() {})
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return itoa(n/10) + string(rune('0'+n%10))
}
