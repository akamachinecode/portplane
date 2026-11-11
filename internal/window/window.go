// Package window shows the UI in a native window (ADR-0017, ADR-0018): a
// WKWebView in the tray's run loop on macOS, a GTK 4 window with WebKitGTK
// 6.0 in its own process (portplane-window) on Linux, and a WebView2 window
// on its own thread on Windows. Where none can open, Supported is false and
// the UI opens in the browser.
package window

import (
	"context"
	"errors"
	"net/url"
)

// Options describe the window. Start takes them once, before Show.
type Options struct {
	URL        string // the UI on loopback
	BrowserURL string // what Open in Browser opens (Linux)
	StatePath  string // where the window keeps its size (Linux)
	// Quit runs when the user chooses Quit Portplane in the window.
	Quit func()
	// Closed runs when the user closes the window (Linux, Windows).
	Closed func()
}

// ErrNoWindow means no window can show the folder picker (only the Linux
// window has one); the caller uses another picker.
var ErrNoWindow = errors.New("no window")

// PickFolder shows the folder picker over the window and returns the chosen
// folder, or "" when the user cancels. It returns ErrNoWindow when no window
// can show it.
func PickFolder(ctx context.Context) (string, error) { return pickFolder(ctx) }

// ExternalURL returns raw when it is an http(s) address that may open in
// the browser, and "" otherwise.
func ExternalURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return u.String()
}
