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
	OpPresent  = "present"  // bring the window to the front; Token is an XDG activation token
	OpPick     = "pick"     // show the folder picker; the answer is OpPicked with the same ID
	OpSave     = "save"     // show the save dialog for a file named Path; the answer is OpSaved with the same ID
	OpTheme    = "theme"    // follow Theme (system, light or dark): the title bar and the page's system colours
	OpNavigate = "navigate" // show the UI at Path, a fragment such as "#/health"
	OpClose    = "close"    // close the window and exit
)

// Operations from the window to Portplane.
const (
	OpReady  = "ready"  // the window is on screen
	OpPicked = "picked" // the folder picker closed: Path, or empty when cancelled
	OpSaved  = "saved"  // the save dialog closed: Path, or empty when cancelled
	OpQuit   = "quit"   // the user chose Quit Portplane
)

// ErrPickerUnsupported is the Error of an OpPicked or OpSaved when the
// window's GTK has no file dialog (before 4.10).
const ErrPickerUnsupported = "unsupported"

// Message is one line of the protocol.
type Message struct {
	Op    string `json:"op"`
	Token string `json:"token,omitempty"`
	ID    int    `json:"id,omitempty"`
	Path  string `json:"path,omitempty"`
	Theme string `json:"theme,omitempty"`
	Error string `json:"error,omitempty"`
}
