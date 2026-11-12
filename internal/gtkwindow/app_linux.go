//go:build linux

package gtkwindow

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"golang.org/x/sys/unix"

	"github.com/akamachinecode/portplane/internal/window"
)

// GTK must run on the thread that started it, and GApplication expects the
// main thread: the main goroutine stays on it.
func init() { runtime.LockOSThread() }

// The file descriptors Portplane passes with --ipc: it writes Messages to
// ipcIn and reads them from ipcOut.
const (
	ipcIn  = 3
	ipcOut = 4
)

// Main runs the window until it closes and returns the exit code.
func Main(args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet(window.HelperName, flag.ContinueOnError)
	fs.SetOutput(stderr)
	var o options
	fs.StringVar(&o.url, "url", "", "the address of the UI")
	fs.StringVar(&o.browserURL, "browser-url", "", "the address Open in Browser opens (default: --url)")
	fs.StringVar(&o.statePath, "state", "", "file that keeps the window size")
	fs.StringVar(&o.token, "activation-token", "", "XDG activation token for the first present")
	fs.StringVar(&o.theme, "theme", window.ThemeSystem, "system, light or dark: the title bar and the page's system colours")
	ipc := fs.Bool("ipc", false, "talk to Portplane over file descriptors 3 and 4")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	home, err := url.Parse(o.url)
	if err != nil || (home.Scheme != "http" && home.Scheme != "https") || home.Host == "" {
		fmt.Fprintln(stderr, "portplane-window: --url must be an http(s) address")
		return 2
	}
	o.home = home
	if o.browserURL == "" {
		o.browserURL = o.url
	}

	if err := load(); err != nil {
		fmt.Fprintln(stderr, "portplane-window:", err)
		return window.ExitUnavailable
	}
	if !gtk_init_check() {
		fmt.Fprintln(stderr, "portplane-window: cannot open the display")
		return window.ExitUnavailable
	}

	a := &app{opts: o, state: loadState(o.statePath), inbox: make(chan window.Message, 16), theme: window.NormalizeTheme(o.theme)}
	if *ipc {
		// Not inherited by the web processes WebKit starts.
		unix.CloseOnExec(ipcIn)
		unix.CloseOnExec(ipcOut)
		a.out = json.NewEncoder(os.NewFile(ipcOut, "ipc-out"))
		go a.read(os.NewFile(ipcIn, "ipc-in"))
	}
	current = a
	return a.run()
}

type options struct {
	url, browserURL, statePath, token, theme string
	home                                     *url.URL
}

type app struct {
	opts  options
	state state

	gapp, win, view, css uintptr
	actions              []func()
	picks                map[uintptr]int // folder dialogs waiting for an answer, by dialog
	saves                map[uintptr]int // save dialogs waiting for an answer, by dialog
	theme                string          // window.ThemeSystem, ThemeLight or ThemeDark

	inbox chan window.Message
	outMu sync.Mutex
	out   *json.Encoder
}

// current is the one app of this process, for the C callbacks.
var current *app

// Callbacks into Go. purego has a fixed number of them, so each is made
// once and told apart by its user data.
var (
	cbOnce                                  sync.Once
	cbActivate, cbAction, cbTitle, cbPolicy uintptr
	cbCreate, cbContextMenu, cbTerminated   uintptr
	cbCloseRequest, cbIdle, cbPicked        uintptr
	cbStyle, cbSaved                        uintptr
)

func makeCallbacks() {
	cbActivate = purego.NewCallback(func(_, _ uintptr) { current.activate() })
	cbAction = purego.NewCallback(func(_, _, i uintptr) { current.actions[i]() })
	cbTitle = purego.NewCallback(func(_, _, _ uintptr) { current.syncTitle() })
	cbPolicy = purego.NewCallback(func(_, decision, kind, _ uintptr) uintptr {
		return boolToC(current.decidePolicy(decision, int32(kind)))
	})
	cbCreate = purego.NewCallback(func(_, action, _ uintptr) uintptr {
		current.openExternal(navigationURI(action))
		return 0 // no new web view: window.open returns null and the UI asks Portplane
	})
	cbContextMenu = purego.NewCallback(func(_, _, hit, _ uintptr) uintptr {
		return boolToC(suppressContextMenu(hit))
	})
	cbTerminated = purego.NewCallback(func(view, reason, _ uintptr) {
		if int32(reason) != terminatedByAPI {
			webkit_web_view_reload(view)
		}
	})
	cbCloseRequest = purego.NewCallback(func(_, _ uintptr) uintptr {
		current.saveState()
		return 0 // let it close
	})
	cbIdle = purego.NewCallback(func(_ uintptr) uintptr {
		current.drain()
		return 0 // G_SOURCE_REMOVE
	})
	cbPicked = purego.NewCallback(func(dialog, result, _ uintptr) { current.picked(dialog, result) })
	cbSaved = purego.NewCallback(func(dialog, result, _ uintptr) { current.saved(dialog, result) })
	cbStyle = purego.NewCallback(func(_, _, _ uintptr) { current.applyStyle() })
}

const (
	policyNavigation = 0 // WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION
	policyNewWindow  = 1 // WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION
	terminatedByAPI  = 2 // WEBKIT_WEB_PROCESS_TERMINATED_BY_API
)

func boolToC(b bool) uintptr {
	if b {
		return 1
	}
	return 0
}

func connect(obj uintptr, signal string, cb, data uintptr) {
	g_signal_connect_data(obj, signal, cb, data, 0, 0)
}

func (a *app) run() int {
	cbOnce.Do(makeCallbacks)
	g_set_prgname(window.AppID)
	g_set_application_name("Portplane")
	if adw_init != nil {
		adw_init()
	}
	a.applyScheme()
	gtk_window_set_default_icon_name("portplane")
	a.loadCSS()
	// Not unique: Portplane already keeps one window per user, and it
	// starts this process only when no window is open.
	a.gapp = gtk_application_new(window.AppID, gAppNonUnique)
	connect(a.gapp, "activate", cbActivate, 0)
	a.addAction(a.gapp, "quit", a.quit)
	a.accels("app.quit", "<Control>q")
	a.accels("win.close", "<Control>w")
	a.accels("win.reload", "<Control>r", "F5")
	status := g_application_run(a.gapp, 0, 0)
	g_object_unref(a.gapp)
	return int(status)
}

// The title bar takes the page's background and loses its shadow, so it
// and the page's top bar read as one header (--bg in web/src/styles.css).
// It follows the desktop's light or dark style, like the page does.
var (
	pageLight = gdkRGBA{0xf6 / 255.0, 0xf6 / 255.0, 0xf7 / 255.0, 1}
	pageDark  = gdkRGBA{0x0f / 255.0, 0x10 / 255.0, 0x13 / 255.0, 1}
)

func (a *app) loadCSS() {
	a.css = gtk_css_provider_new()
	gtk_style_context_add_provider_for_display(gdk_display_get_default(), a.css, 600) // GTK_STYLE_PROVIDER_PRIORITY_APPLICATION
	a.applyStyle()
	if adw_style_manager_get_default != nil {
		connect(adw_style_manager_get_default(), "notify::dark", cbStyle, 0)
	}
}

// dark reports whether the window shows its dark style: the theme the user
// chose in Portplane, else the desktop's.
func (a *app) dark() bool {
	switch a.theme {
	case window.ThemeDark:
		return true
	case window.ThemeLight:
		return false
	}
	return adw_style_manager_get_dark != nil && adw_style_manager_get_dark(adw_style_manager_get_default())
}

// applyScheme tells libadwaita which style to use, so the title bar and the
// page's prefers-color-scheme follow the theme chosen in Portplane.
func (a *app) applyScheme() {
	if adw_style_manager_set_color_scheme == nil {
		return
	}
	scheme := int32(adwColorSchemeDefault)
	switch a.theme {
	case window.ThemeLight:
		scheme = adwColorSchemeForceLight
	case window.ThemeDark:
		scheme = adwColorSchemeForceDark
	}
	adw_style_manager_set_color_scheme(adw_style_manager_get_default(), scheme)
}

func (a *app) setTheme(theme string) {
	a.theme = window.NormalizeTheme(theme)
	a.applyScheme()
	a.applyStyle()
}

func (a *app) applyStyle() {
	bg := pageLight
	if a.dark() {
		bg = pageDark
	}
	css := fmt.Sprintf("headerbar.portplane { background: rgb(%d,%d,%d); box-shadow: none; }",
		int(bg.R*255+0.5), int(bg.G*255+0.5), int(bg.B*255+0.5))
	gtk_css_provider_load_from_data(a.css, css, -1)
	if a.view != 0 {
		// The page's own background until it paints: no white flash in dark mode.
		webkit_web_view_set_background_color(a.view, &bg)
	}
}

func (a *app) accels(action string, keys ...string) {
	c := newCStrings(keys...)
	gtk_application_set_accels_for_action(a.gapp, action, c.ptr())
	runtime.KeepAlive(c)
}

// addAction adds a GAction named name to actionMap (the application or the
// window) that runs fn.
func (a *app) addAction(actionMap uintptr, name string, fn func()) {
	act := g_simple_action_new(name, 0)
	a.actions = append(a.actions, fn)
	connect(act, "activate", cbAction, uintptr(len(a.actions)-1))
	g_action_map_add_action(actionMap, act)
	g_object_unref(act)
}

func (a *app) activate() {
	if a.win != 0 {
		a.present("")
		return
	}
	win := gtk_application_window_new(a.gapp)
	a.win = win
	gtk_window_set_title(win, "Portplane")
	gtk_widget_set_size_request(win, 560, 400)
	w, h := a.state.Width, a.state.Height
	if w < 560 || h < 400 {
		w, h = 1120, 760
	}
	gtk_window_set_default_size(win, int32(w), int32(h))
	if a.state.Maximized {
		gtk_window_maximize(win)
	}

	header := gtk_header_bar_new()
	gtk_widget_add_css_class(header, "portplane")
	menu := gtk_menu_button_new()
	gtk_menu_button_set_icon_name(menu, "open-menu-symbolic")
	gtk_menu_button_set_menu_model(menu, mainMenu())
	gtk_menu_button_set_primary(menu, true) // F10
	gtk_widget_set_tooltip_text(menu, "Main Menu")
	gtk_header_bar_pack_end(header, menu)
	gtk_window_set_titlebar(win, header)

	a.view = a.newWebView()
	a.applyStyle()
	gtk_window_set_child(win, a.view)

	a.addAction(win, "close", func() { gtk_window_close(a.win) })
	a.addAction(win, "reload", func() { webkit_web_view_reload(a.view) })
	a.addAction(win, "open-browser", func() { a.openExternal(a.opts.browserURL) })
	connect(win, "close-request", cbCloseRequest, 0)

	webkit_web_view_load_uri(a.view, a.opts.home.String())
	a.present(a.opts.token)
	gtk_widget_grab_focus(a.view)
	a.send(window.Message{Op: window.OpReady})
	if afterActivate != nil {
		afterActivate(a)
	}
}

// afterActivate lets a local, untracked harness look at the window.
var afterActivate func(*app)

func mainMenu() uintptr {
	page := g_menu_new()
	g_menu_append(page, "Open in Browser", "win.open-browser")
	g_menu_append(page, "Reload", "win.reload")
	quit := g_menu_new()
	g_menu_append(quit, "Quit Portplane", "app.quit")
	menu := g_menu_new()
	g_menu_append_section(menu, 0, page)
	g_menu_append_section(menu, 0, quit)
	g_object_unref(page)
	g_object_unref(quit)
	return menu
}

func (a *app) newWebView() uintptr {
	// Nothing is kept on disk: the page lives on a new loopback port each
	// run, and its token changes with it (ADR-0008).
	session := webkit_network_session_new_ephemeral()
	names := newCStrings("network-session")
	var v gValue
	g_value_init(unsafe.Pointer(&v), gTypeObject)
	g_value_set_object(unsafe.Pointer(&v), session)
	view := g_object_new_with_properties(webkit_web_view_get_type(), 1, names.ptr(), unsafe.Pointer(&v))
	g_value_unset(unsafe.Pointer(&v))
	runtime.KeepAlive(names)
	g_object_unref(session)

	webkit_settings_set_enable_back_forward_navigation_gestures(webkit_web_view_get_settings(view), false)
	connect(view, "notify::title", cbTitle, 0)
	connect(view, "decide-policy", cbPolicy, 0)
	connect(view, "create", cbCreate, 0)
	connect(view, "context-menu", cbContextMenu, 0)
	connect(view, "web-process-terminated", cbTerminated, 0)
	return view
}

func (a *app) present(token string) {
	if token != "" {
		gtk_window_set_startup_id(a.win, token)
	}
	gtk_window_present(a.win)
}

// syncTitle shows the page title ("Portplane · 3 running") in the title bar.
func (a *app) syncTitle() {
	t := goString(webkit_web_view_get_title(a.view))
	if t == "" {
		t = "Portplane"
	}
	gtk_window_set_title(a.win, t)
}

// decidePolicy keeps the window on the UI: other http(s) addresses open in
// the default browser and anything else is refused. It reports whether it
// decided (true) or leaves the default, which loads the page.
func (a *app) decidePolicy(decision uintptr, kind int32) bool {
	if kind != policyNavigation && kind != policyNewWindow {
		return false
	}
	uri := navigationURI(webkit_navigation_policy_decision_get_navigation_action(decision))
	if kind == policyNavigation && staysInWindow(uri, a.opts.home) {
		return false
	}
	a.openExternal(uri)
	webkit_policy_decision_ignore(decision)
	return true
}

func navigationURI(action uintptr) string {
	if action == 0 {
		return ""
	}
	return goString(webkit_uri_request_get_uri(webkit_navigation_action_get_request(action)))
}

// staysInWindow reports whether a navigation loads in the window: the UI's
// own origin, or about:blank.
func staysInWindow(raw string, home *url.URL) bool {
	if raw == "about:blank" {
		return true
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Scheme, home.Scheme) && strings.EqualFold(u.Host, home.Host)
}

// openExternal opens an http(s) address in the default browser, through
// the desktop portal when there is one, so the browser comes to the front.
func (a *app) openExternal(raw string) {
	u := window.ExternalURL(raw)
	if u == "" {
		return
	}
	if gtk_uri_launcher_new != nil {
		l := gtk_uri_launcher_new(u)
		gtk_uri_launcher_launch(l, a.win, 0, 0, 0)
		g_object_unref(l)
		return
	}
	g_app_info_launch_default_for_uri(u, 0, 0)
}

// suppressContextMenu hides the page menu (Back, Reload) but keeps the one
// for text fields, selections and links.
func suppressContextMenu(hit uintptr) bool {
	return !webkit_hit_test_result_context_is_editable(hit) &&
		!webkit_hit_test_result_context_is_selection(hit) &&
		!webkit_hit_test_result_context_is_link(hit)
}

func (a *app) quit() {
	a.send(window.Message{Op: window.OpQuit})
	a.close()
}

func (a *app) close() {
	if a.win != 0 {
		gtk_window_close(a.win)
		return
	}
	g_application_quit(a.gapp)
}

// pick shows the folder picker over the window; the answer goes back as
// OpPicked with the same id.
func (a *app) pick(id int) {
	if gtk_file_dialog_new == nil || a.win == 0 {
		a.send(window.Message{Op: window.OpPicked, ID: id, Error: window.ErrPickerUnsupported})
		return
	}
	a.present("")
	d := gtk_file_dialog_new()
	gtk_file_dialog_set_title(d, "Choose a folder with projects")
	gtk_file_dialog_set_accept_label(d, "Add")
	gtk_file_dialog_set_modal(d, true)
	if a.picks == nil {
		a.picks = map[uintptr]int{}
	}
	a.picks[d] = id
	gtk_file_dialog_select_folder(d, a.win, 0, cbPicked, 0)
}

func (a *app) picked(dialog, result uintptr) {
	id := a.picks[dialog]
	delete(a.picks, dialog)
	var gerr uintptr
	file := gtk_file_dialog_select_folder_finish(dialog, result, &gerr)
	g_object_unref(dialog)
	msg := window.Message{Op: window.OpPicked, ID: id}
	if file == 0 {
		if gerr != 0 {
			g_error_free(gerr) // cancelled
		}
	} else {
		if p := g_file_get_path(file); p != 0 {
			msg.Path = goString(p)
			g_free(p)
		}
		g_object_unref(file)
	}
	a.send(msg)
}

// save shows the save dialog over the window for a file named name; the
// answer goes back as OpSaved with the same id.
func (a *app) save(id int, name string) {
	if gtk_file_dialog_save == nil || a.win == 0 {
		a.send(window.Message{Op: window.OpSaved, ID: id, Error: window.ErrPickerUnsupported})
		return
	}
	a.present("")
	d := gtk_file_dialog_new()
	gtk_file_dialog_set_title(d, "Save the diagnostic report")
	gtk_file_dialog_set_accept_label(d, "Save")
	gtk_file_dialog_set_modal(d, true)
	if name != "" {
		gtk_file_dialog_set_initial_name(d, name)
	}
	if a.saves == nil {
		a.saves = map[uintptr]int{}
	}
	a.saves[d] = id
	gtk_file_dialog_save(d, a.win, 0, cbSaved, 0)
}

func (a *app) saved(dialog, result uintptr) {
	id := a.saves[dialog]
	delete(a.saves, dialog)
	var gerr uintptr
	file := gtk_file_dialog_save_finish(dialog, result, &gerr)
	g_object_unref(dialog)
	msg := window.Message{Op: window.OpSaved, ID: id}
	if file == 0 {
		if gerr != 0 {
			g_error_free(gerr) // cancelled
		}
	} else {
		if p := g_file_get_path(file); p != 0 {
			msg.Path = goString(p)
			g_free(p)
		}
		g_object_unref(file)
	}
	a.send(msg)
}

// navigate shows the UI at a route ("#/health"): within the loaded page
// only the fragment changes, so the page keeps its state.
func (a *app) navigate(fragment string) {
	if a.view == 0 || !window.ValidFragment(fragment) {
		return
	}
	webkit_web_view_load_uri(a.view, window.RouteURL(a.opts.home.String(), fragment))
}

// read forwards Portplane's messages to the GTK thread. When Portplane goes
// away, the window closes.
func (a *app) read(r io.Reader) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		var m window.Message
		if json.Unmarshal(sc.Bytes(), &m) == nil {
			a.inbox <- m
			g_idle_add(cbIdle, 0)
		}
	}
	a.inbox <- window.Message{Op: window.OpClose}
	g_idle_add(cbIdle, 0)
}

func (a *app) drain() {
	for {
		select {
		case m := <-a.inbox:
			switch m.Op {
			case window.OpPresent:
				if a.win != 0 {
					a.present(m.Token)
				}
			case window.OpPick:
				a.pick(m.ID)
			case window.OpSave:
				a.save(m.ID, m.Path)
			case window.OpTheme:
				a.setTheme(m.Theme)
			case window.OpNavigate:
				a.navigate(m.Path)
			case window.OpClose:
				a.close()
			}
		default:
			return
		}
	}
}

func (a *app) send(m window.Message) {
	if a.out == nil {
		return
	}
	a.outMu.Lock()
	defer a.outMu.Unlock()
	_ = a.out.Encode(m)
}

// state is what the window remembers between runs.
type state struct {
	Width     int  `json:"width,omitempty"`
	Height    int  `json:"height,omitempty"`
	Maximized bool `json:"maximized,omitempty"`
}

func loadState(path string) state {
	var s state
	if path == "" {
		return s
	}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	return s
}

func saveState(path string, s state) error {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (a *app) saveState() {
	if a.opts.statePath == "" || a.win == 0 {
		return
	}
	a.state.Maximized = gtk_window_is_maximized(a.win)
	if !a.state.Maximized {
		var w, h int32
		gtk_window_get_default_size(a.win, &w, &h)
		if w > 0 && h > 0 {
			a.state.Width, a.state.Height = int(w), int(h)
		}
	}
	_ = saveState(a.opts.statePath, a.state)
}
