//go:build windows

package window

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/akamachinecode/portplane/internal/desktop"
	"github.com/akamachinecode/portplane/internal/icon"
)

// On Windows the window is a WebView2 (the runtime ships with Windows 10
// and 11) loaded without CGO through go-webview2, on a thread of its own
// next to the tray's (ADR-0018). The window is created once: closing it
// hides it and drops the page, because go-webview2 cannot release a web
// view, and a destroyed one would leave its browser processes behind.

var (
	mu    sync.Mutex
	opts  Options
	cur   *win
	theme string // ThemeLight or ThemeDark override the system's; "" or ThemeSystem follow it

	runtimeOnce sync.Once
	hasRuntime  bool
)

type win struct {
	view    webview2.WebView // nil until the window exists
	hwnd    uintptr
	shown   bool // the page is loaded (UI thread only)
	closing bool // Portplane is quitting
}

// Supported reports whether the WebView2 runtime is installed.
func Supported() bool {
	runtimeOnce.Do(func() {
		v, err := webviewloader.GetInstalledVersion()
		hasRuntime = err == nil && v != ""
	})
	return hasRuntime
}

// NeedsTray is false: the window runs its own message loop.
func NeedsTray() bool { return false }

// Start keeps the options for the window.
func Start(_ context.Context, o Options) {
	mu.Lock()
	opts = o
	mu.Unlock()
}

// Show opens the window, or brings it to the front. The activation token is
// a Linux matter and is ignored.
func Show(string) error {
	mu.Lock()
	if w := cur; w != nil {
		view := w.view
		mu.Unlock()
		if view != nil { // else it is still starting, and shows up then
			view.Dispatch(w.show)
		}
		return nil
	}
	w := &win{}
	cur = w
	o := opts
	mu.Unlock()

	errc := make(chan error, 1)
	go w.run(o, errc)
	select {
	case err := <-errc:
		if err != nil {
			mu.Lock()
			cur = nil
			mu.Unlock()
		}
		return err
	case <-time.After(30 * time.Second):
		return nil // slow to start, but it shows up when ready
	}
}

// Close hides the window; Portplane is quitting, and WebView2 ends with it.
func Close() {
	mu.Lock()
	var view webview2.WebView
	w := cur
	if w != nil {
		w.closing = true
		view = w.view
	}
	mu.Unlock()
	if view != nil {
		view.Dispatch(func() { _, _, _ = procShowWindow.Call(w.hwnd, swHide) })
	}
}

// CanPick is false: the folder picker on Windows is the PowerShell one.
func CanPick() bool { return false }

func pickFolder(context.Context) (string, error) { return "", ErrNoWindow }

// saveFile: the save dialog on Windows is the PowerShell one.
func saveFile(context.Context, string) (string, error) { return "", ErrNoWindow }

func setTheme(t string) {
	mu.Lock()
	theme = t
	w := cur
	var view webview2.WebView
	if w != nil {
		view = w.view
	}
	mu.Unlock()
	if view != nil {
		view.Dispatch(func() { applyTheme(w.hwnd) })
	}
}

// navigate loads the route: within the loaded page only the fragment
// changes, so the page keeps its state.
func navigate(fragment string) {
	mu.Lock()
	w := cur
	var view webview2.WebView
	if w != nil {
		view = w.view
	}
	home := opts.URL
	mu.Unlock()
	if view == nil {
		return
	}
	view.Dispatch(func() {
		view.Navigate(RouteURL(home, fragment))
		w.shown = true
	})
}

var (
	user32                           = windows.NewLazySystemDLL("user32.dll")
	dwmapi                           = windows.NewLazySystemDLL("dwmapi.dll")
	procShowWindow                   = user32.NewProc("ShowWindow")
	procIsIconic                     = user32.NewProc("IsIconic")
	procSetForegroundWindow          = user32.NewProc("SetForegroundWindow")
	procSendMessageW                 = user32.NewProc("SendMessageW")
	procSetWindowLongPtrW            = user32.NewProc("SetWindowLongPtrW")
	procCallWindowProcW              = user32.NewProc("CallWindowProcW")
	procCreateIconFromResourceEx     = user32.NewProc("CreateIconFromResourceEx")
	procSetThreadDpiAwarenessContext = user32.NewProc("SetThreadDpiAwarenessContext")
	procGetDpiForSystem              = user32.NewProc("GetDpiForSystem")
	procDwmSetWindowAttribute        = dwmapi.NewProc("DwmSetWindowAttribute")
)

const (
	swHide    = 0
	swShow    = 5
	swRestore = 9

	wmClose         = 0x0010
	wmSetIcon       = 0x0080
	wmSettingChange = 0x001A
	iconSmall       = 0
	iconBig         = 1
	gwlpWndProc     = ^uintptr(3) // -4

	dwmwaUseImmersiveDarkMode = 20
	dpiPerMonitorAwareV2      = ^uintptr(3) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4)
)

// The window's procedure before ours, and ours: one window per process.
var (
	baseProc uintptr
	ourProc  = windows.NewCallback(wndProc)
)

func (w *win) run(o Options, errc chan<- error) {
	runtime.LockOSThread() // a window belongs to the thread that made it
	// go-webview2 sets up COM on the main thread only; this one needs it too.
	_ = windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED)
	// Sharp text on high-DPI screens: this thread's windows are DPI aware.
	if procSetThreadDpiAwarenessContext.Find() == nil {
		_, _, _ = procSetThreadDpiAwarenessContext.Call(dpiPerMonitorAwareV2)
	}
	scale := func(px uint) uint { return px * systemDPI() / 96 }

	dataDir, err := os.UserCacheDir() // %LocalAppData%
	if err != nil {
		dataDir = os.TempDir()
	}
	view := webview2.NewWithOptions(webview2.WebViewOptions{
		DataPath:  filepath.Join(dataDir, "portplane", "WebView2"),
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  "Portplane",
			Width:  scale(1120),
			Height: scale(760),
			Center: true,
		},
	})
	if view == nil {
		errc <- errors.New("WebView2 could not start")
		return
	}
	w.hwnd = uintptr(view.Window())
	view.SetSize(int(scale(560)), int(scale(400)), webview2.HintMin)
	setIcon(w.hwnd)
	applyTheme(w.hwnd)
	baseProc, _, _ = procSetWindowLongPtrW.Call(w.hwnd, gwlpWndProc, ourProc)

	// Links leave for the default browser and the page title becomes the
	// window title; WebView2 events are not reachable through go-webview2,
	// so a script reports them.
	_ = view.Bind("portplaneOpen", func(raw string) {
		if u := ExternalURL(raw); u != "" {
			_ = desktop.OpenURL(u)
		}
	})
	_ = view.Bind("portplaneTitle", func(t string) {
		if t == "" {
			t = "Portplane"
		}
		view.SetTitle(t)
	})
	view.Init(pageScript)
	view.Navigate(o.URL)
	w.shown = true
	mu.Lock()
	w.view = view
	mu.Unlock()
	errc <- nil
	view.Run()
}

// show brings the window back, with the page, to the front.
func (w *win) show() {
	if !w.shown {
		mu.Lock()
		url := opts.URL
		mu.Unlock()
		w.view.Navigate(url)
		w.shown = true
	}
	if r, _, _ := procIsIconic.Call(w.hwnd); r != 0 {
		_, _, _ = procShowWindow.Call(w.hwnd, swRestore)
	} else {
		_, _, _ = procShowWindow.Call(w.hwnd, swShow)
	}
	_, _, _ = procSetForegroundWindow.Call(w.hwnd)
}

// hide is what closing the window does: it goes away, and so does the page,
// so no event stream stays open.
func (w *win) hide() {
	_, _, _ = procShowWindow.Call(w.hwnd, swHide)
	w.view.Navigate("about:blank")
	w.shown = false
	mu.Lock()
	quitting := w.closing
	closed := opts.Closed
	mu.Unlock()
	if !quitting && closed != nil {
		go closed()
	}
}

func wndProc(hwnd, msg, wp, lp uintptr) uintptr {
	mu.Lock()
	w := cur
	mu.Unlock()
	if w != nil && hwnd == w.hwnd {
		switch msg {
		case wmClose:
			w.hide()
			return 0
		case wmSettingChange: // light or dark mode switched
			applyTheme(hwnd)
		}
	}
	r, _, _ := procCallWindowProcW.Call(baseProc, hwnd, msg, wp, lp)
	return r
}

// pageScript runs in every page before its own scripts.
const pageScript = `(() => {
  const leave = (href) => {
    const u = new URL(href, location.href);
    if (u.protocol === "http:" || u.protocol === "https:") window.portplaneOpen(u.href);
  };
  // window.open returns null, so the UI asks Portplane to open the address.
  window.open = (href) => { if (href) leave(href); return null; };
  const onLink = (e) => {
    if (e.defaultPrevented || (e.type === "auxclick" && e.button !== 1)) return; // middle click only
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a) return;
    const u = new URL(a.href, location.href);
    if (u.origin === location.origin && a.target !== "_blank" && e.button === 0 && !e.ctrlKey && !e.shiftKey) return;
    e.preventDefault();
    leave(u.href);
  };
  window.addEventListener("click", onLink);
  window.addEventListener("auxclick", onLink);
  let last = null;
  const title = () => { if (document.title !== last) { last = document.title; window.portplaneTitle(last); } };
  document.addEventListener("DOMContentLoaded", () => {
    title();
    if (document.head) new MutationObserver(title).observe(document.head, { subtree: true, childList: true, characterData: true });
  });
})();`

func systemDPI() uint {
	if procGetDpiForSystem.Find() != nil {
		return 96
	}
	dpi, _, _ := procGetDpiForSystem.Call()
	if dpi == 0 {
		return 96
	}
	return uint(dpi)
}

// setIcon gives the window, and its taskbar button, the Portplane icon.
func setIcon(hwnd uintptr) {
	for _, s := range []struct {
		which uintptr
		size  int
	}{{iconSmall, 16}, {iconBig, 32}} {
		png := icon.PNG(s.size*int(systemDPI())/96, 2)
		h, _, _ := procCreateIconFromResourceEx.Call(uintptr(unsafe.Pointer(&png[0])), uintptr(len(png)), 1, 0x00030000, 0, 0, 0)
		if h != 0 {
			_, _, _ = procSendMessageW.Call(hwnd, wmSetIcon, s.which, h)
		}
	}
}

// applyTheme gives the title bar the dark look when the theme chosen in
// Portplane is dark, or, with the system theme, when Windows uses dark mode
// for apps; the page follows the same choice on its own.
func applyTheme(hwnd uintptr) {
	if procDwmSetWindowAttribute.Find() != nil {
		return
	}
	mu.Lock()
	t := theme
	mu.Unlock()
	var dark uint32
	switch t {
	case ThemeDark:
		dark = 1
	case ThemeLight:
	default:
		if k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE); err == nil {
			if v, _, err := k.GetIntegerValue("AppsUseLightTheme"); err == nil && v == 0 {
				dark = 1
			}
			_ = k.Close()
		}
	}
	_, _, _ = procDwmSetWindowAttribute.Call(hwnd, dwmwaUseImmersiveDarkMode, uintptr(unsafe.Pointer(&dark)), 4)
}
