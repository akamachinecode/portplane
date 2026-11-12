package window

// On Linux the window runs in its own process, portplane-window (ADR-0018),
// and talks to Portplane over its stdin and stdout: one JSON Message per
// line.

// AppID names Portplane to the desktop: the Wayland app ID of the window and
// the name of its .desktop file, so the dock shows the Portplane icon.
const AppID = "dev.portplane.app"

// HelperName is the window process's executable.
const HelperName = "portplane-window"

// ExitUnavailable is the window process's exit code when it cannot show a
// window here: no display, or no GTK 4 or WebKitGTK 6.0 to load.
const ExitUnavailable = 3

// Operations from Portplane to the window.
const (
	OpPresent = "present" // bring the window to the front; Token is an XDG activation token
	OpPick    = "pick"    // show the folder picker; the answer is OpPicked with the same ID
	OpClose   = "close"   // close the window and exit
)

// Operations from the window to Portplane.
const (
	OpReady  = "ready"  // the window is on screen
	OpPicked = "picked" // the folder picker closed: Path, or empty when cancelled
	OpQuit   = "quit"   // the user chose Quit Portplane
)

// ErrPickerUnsupported is the Error of an OpPicked when the window's GTK has
// no folder picker (before 4.10).
const ErrPickerUnsupported = "unsupported"

// Message is one line of the protocol.
type Message struct {
	Op    string `json:"op"`
	Token string `json:"token,omitempty"`
	ID    int    `json:"id,omitempty"`
	Path  string `json:"path,omitempty"`
	Error string `json:"error,omitempty"`
}
