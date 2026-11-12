//go:build windows

package notify

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"unicode/utf16"

	"github.com/akamachinecode/portplane/internal/window"
)

// toastSender shows a toast through PowerShell and the WinRT API. The
// script is fixed; the title, body and address travel in environment
// variables and are XML-escaped inside it. A click opens the route in the
// browser.
type toastSender struct{ o Options }

func newSender(o Options) (Sender, error) {
	if _, err := exec.LookPath("powershell.exe"); err != nil {
		return nil, err
	}
	return toastSender{o: o}, nil
}

// toastScript shows one toast from PORTPLANE_TOAST_* variables. It runs as
// PowerShell's own app id, which Windows always accepts for toasts.
const toastScript = `$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$e = { param($s) [System.Security.SecurityElement]::Escape([string]$s) }
$t = & $e $env:PORTPLANE_TOAST_TITLE
$b = & $e $env:PORTPLANE_TOAST_BODY
$l = & $e $env:PORTPLANE_TOAST_LAUNCH
$launch = ''
if ($l) { $launch = ' activationType="protocol" launch="' + $l + '"' }
$xml = '<toast' + $launch + '><visual><binding template="ToastGeneric"><text>' + $t + '</text><text>' + $b + '</text></binding></visual></toast>'
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)
`

// encodedCommand is a script as powershell -EncodedCommand takes it:
// base64 of its UTF-16LE text.
func encodedCommand(script string) string {
	u := utf16.Encode([]rune(script))
	b := make([]byte, 0, len(u)*2)
	for _, c := range u {
		b = append(b, byte(c), byte(c>>8))
	}
	return base64.StdEncoding.EncodeToString(b)
}

func toastEnv(o Options, n Notification) []string {
	title := n.Title
	if o.AppName != "" {
		title = o.AppName + ": " + title
	}
	launch := ""
	if o.LaunchBase != "" && n.Route != "" && window.ValidFragment(n.Route) {
		launch = window.RouteURL(o.LaunchBase, n.Route)
	}
	clean := func(s string) string { return strings.ReplaceAll(s, "\x00", "") }
	return []string{"PORTPLANE_TOAST_TITLE=" + clean(title), "PORTPLANE_TOAST_BODY=" + clean(n.Body), "PORTPLANE_TOAST_LAUNCH=" + clean(launch)}
}

func (s toastSender) Send(ctx context.Context, n Notification) error {
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encodedCommand(toastScript))
	cmd.Env = append(os.Environ(), toastEnv(s.o, n)...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("toast: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (toastSender) Close() error { return nil }
