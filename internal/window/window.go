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
	"regexp"
	"strings"
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

// SaveFile shows the save dialog over the window, for a file named name,
// and returns the chosen path, or "" when the user cancels. It returns
// ErrNoWindow when no window can show it.
func SaveFile(ctx context.Context, name string) (string, error) { return saveFile(ctx, name) }

// Themes the window follows: the desktop's, or a fixed one.
const (
	ThemeSystem = "system"
	ThemeLight  = "light"
	ThemeDark   = "dark"
)

// NormalizeTheme returns theme when it is one the window knows, and
// ThemeSystem otherwise.
func NormalizeTheme(theme string) string {
	switch theme {
	case ThemeLight, ThemeDark:
		return theme
	}
	return ThemeSystem
}

// SetTheme makes the window's title bar, and the colours the page gets from
// the system, follow theme: "system", "light" or "dark" (ADR-0024). It
// applies to the open window and to the next one.
func SetTheme(theme string) { setTheme(NormalizeTheme(theme)) }

var fragmentRE = regexp.MustCompile(`^#/[A-Za-z0-9\-._~!$&'()*+,;=:@/%?]*$`)

// ValidFragment reports whether f is a route of the UI, such as
// "#/apps/local/%2Fhome%2Fdev%2Fcode%23web": a "#/" and URL characters only.
func ValidFragment(f string) bool { return len(f) <= 2048 && fragmentRE.MatchString(f) }

// Navigate shows the UI at fragment (see ValidFragment) in the open
// window. It does nothing when no window is open, or for an invalid
// fragment: call Show first.
func Navigate(fragment string) {
	if ValidFragment(fragment) {
		navigate(fragment)
	}
}

// AppRoute is the route of an app's detail panel in the UI.
func AppRoute(machine, appID string) string {
	return "#/apps/" + escapeSegment(machine) + "/" + escapeSegment(appID)
}

// ProjectRoute is the route of a dekit project on a machine.
func ProjectRoute(machine, root string) string {
	return "#/projects/" + escapeSegment(machine) + "/" + escapeSegment(root)
}

// escapeSegment escapes s like JavaScript's encodeURIComponent, so routes
// built here match the UI's router (web/src/lib/router.ts).
func escapeSegment(s string) string {
	const keep = "-_.!~*'()"
	var b strings.Builder
	for _, c := range []byte(s) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte(keep, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		const hex = "0123456789ABCDEF"
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&15])
	}
	return b.String()
}

// RouteURL is the UI's address home with a route as its fragment.
func RouteURL(home, fragment string) string {
	u, err := url.Parse(home)
	if err != nil {
		return home + fragment
	}
	u.Fragment, u.RawFragment = "", ""
	s := u.String()
	if u.Path == "" {
		s += "/"
	}
	return s + fragment
}

// ExternalURL returns raw when it is an http(s) address that may open in
// the browser, and "" otherwise.
func ExternalURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return u.String()
}
