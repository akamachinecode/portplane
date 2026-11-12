//go:build linux

package gtkwindow

import (
	"errors"
	"fmt"
	"unsafe"

	"github.com/ebitengine/purego"
)

// The C libraries are loaded at run time (dlopen), so the binary builds
// without CGO and only needs GTK where it runs. Each Go variable below is
// bound to the C function of the same name.

// GLib and GObject.
var (
	g_idle_add                   func(fn, data uintptr) uint32
	g_free                       func(p uintptr)
	g_error_free                 func(err uintptr)
	g_set_prgname                func(name string)
	g_set_application_name       func(name string)
	g_signal_connect_data        func(instance uintptr, signal string, handler, data, destroy uintptr, flags int32) uint64
	g_object_unref               func(obj uintptr)
	g_object_new_with_properties func(gtype uintptr, n uint32, names, values unsafe.Pointer) uintptr
	g_value_init                 func(v unsafe.Pointer, gtype uintptr) uintptr
	g_value_set_object           func(v unsafe.Pointer, obj uintptr)
	g_value_unset                func(v unsafe.Pointer)
)

// GIO.
var (
	g_application_run                 func(app uintptr, argc int32, argv uintptr) int32
	g_application_quit                func(app uintptr)
	g_simple_action_new               func(name string, paramType uintptr) uintptr
	g_action_map_add_action           func(m, action uintptr)
	g_menu_new                        func() uintptr
	g_menu_append                     func(menu uintptr, label, action string)
	g_menu_append_section             func(menu, label, section uintptr)
	g_file_get_path                   func(file uintptr) uintptr
	g_app_info_launch_default_for_uri func(uri string, ctx, err uintptr) bool
)

// GTK 4.
var (
	gtk_init_check                             func() bool
	gtk_application_new                        func(id string, flags uint32) uintptr
	gtk_application_window_new                 func(app uintptr) uintptr
	gtk_application_set_accels_for_action      func(app uintptr, action string, accels unsafe.Pointer)
	gtk_window_set_title                       func(w uintptr, title string)
	gtk_window_set_default_size                func(w uintptr, width, height int32)
	gtk_window_get_default_size                func(w uintptr, width, height *int32)
	gtk_window_maximize                        func(w uintptr)
	gtk_window_is_maximized                    func(w uintptr) bool
	gtk_window_set_child                       func(w, child uintptr)
	gtk_window_set_titlebar                    func(w, titlebar uintptr)
	gtk_window_set_startup_id                  func(w uintptr, id string)
	gtk_window_present                         func(w uintptr)
	gtk_window_close                           func(w uintptr)
	gtk_window_set_default_icon_name           func(name string)
	gtk_widget_set_size_request                func(w uintptr, width, height int32)
	gtk_widget_set_tooltip_text                func(w uintptr, text string)
	gtk_widget_grab_focus                      func(w uintptr) bool
	gtk_header_bar_new                         func() uintptr
	gtk_header_bar_pack_end                    func(bar, child uintptr)
	gtk_menu_button_new                        func() uintptr
	gtk_menu_button_set_icon_name              func(b uintptr, name string)
	gtk_menu_button_set_menu_model             func(b, model uintptr)
	gtk_menu_button_set_primary                func(b uintptr, primary bool)
	gtk_widget_add_css_class                   func(w uintptr, class string)
	gtk_css_provider_new                       func() uintptr
	gtk_css_provider_load_from_data            func(p uintptr, data string, length int)
	gdk_display_get_default                    func() uintptr
	gtk_style_context_add_provider_for_display func(display, provider uintptr, priority uint32)
)

// GTK 4.10 and later: the folder picker and the URI launcher (both go
// through the desktop portal when there is one). Nil when missing.
var (
	gtk_file_dialog_new                  func() uintptr
	gtk_file_dialog_set_title            func(d uintptr, title string)
	gtk_file_dialog_set_accept_label     func(d uintptr, label string)
	gtk_file_dialog_set_modal            func(d uintptr, modal bool)
	gtk_file_dialog_select_folder        func(d, parent, cancellable, cb, data uintptr)
	gtk_file_dialog_select_folder_finish func(d, result uintptr, err *uintptr) uintptr
	gtk_uri_launcher_new                 func(uri string) uintptr
	gtk_uri_launcher_launch              func(l, parent, cancellable, cb, data uintptr)
)

// WebKitGTK 6.0.
var (
	webkit_web_view_get_type                                    func() uintptr
	webkit_network_session_new_ephemeral                        func() uintptr
	webkit_web_view_load_uri                                    func(v uintptr, uri string)
	webkit_web_view_get_title                                   func(v uintptr) uintptr
	webkit_web_view_reload                                      func(v uintptr)
	webkit_web_view_set_background_color                        func(v uintptr, rgba *gdkRGBA)
	webkit_web_view_get_settings                                func(v uintptr) uintptr
	webkit_settings_set_enable_back_forward_navigation_gestures func(s uintptr, on bool)
	webkit_navigation_policy_decision_get_navigation_action     func(d uintptr) uintptr
	webkit_navigation_action_get_request                        func(a uintptr) uintptr
	webkit_uri_request_get_uri                                  func(r uintptr) uintptr
	webkit_policy_decision_ignore                               func(d uintptr)
	webkit_hit_test_result_context_is_editable                  func(h uintptr) bool
	webkit_hit_test_result_context_is_selection                 func(h uintptr) bool
	webkit_hit_test_result_context_is_link                      func(h uintptr) bool
)

// libadwaita, when installed: the window and the page follow the desktop's
// light or dark style. Nil when missing.
var (
	adw_init                      func()
	adw_style_manager_get_default func() uintptr
	adw_style_manager_get_dark    func(m uintptr) bool
)

type gdkRGBA struct{ R, G, B, A float32 }

// gValue matches GValue on 64-bit systems: a GType and two 8-byte words.
type gValue struct {
	gtype uintptr
	data  [2]uint64
}

const (
	gTypeObject   = 20 << 2 // G_TYPE_OBJECT
	gAppNonUnique = 1 << 5  // G_APPLICATION_NON_UNIQUE
)

type binding struct {
	fn   any
	name string
}

// load opens the libraries and binds the functions. It fails when GTK 4 or
// WebKitGTK 6.0 is missing; GTK 4.10 functions and libadwaita are optional.
func load() error {
	open := func(names ...string) (uintptr, error) {
		var errs []error
		for _, n := range names {
			h, err := purego.Dlopen(n, purego.RTLD_NOW|purego.RTLD_GLOBAL)
			if err == nil {
				return h, nil
			}
			errs = append(errs, err)
		}
		return 0, errors.Join(errs...)
	}
	glib, err := open("libglib-2.0.so.0")
	if err != nil {
		return err
	}
	gobject, err := open("libgobject-2.0.so.0")
	if err != nil {
		return err
	}
	gio, err := open("libgio-2.0.so.0")
	if err != nil {
		return err
	}
	gtk, err := open("libgtk-4.so.1")
	if err != nil {
		return fmt.Errorf("GTK 4 is not installed: %w", err)
	}
	webkit, err := open("libwebkitgtk-6.0.so.4")
	if err != nil {
		return fmt.Errorf("WebKitGTK 6.0 is not installed: %w", err)
	}

	required := []struct {
		lib uintptr
		fns []binding
	}{
		{glib, []binding{
			{&g_idle_add, "g_idle_add"}, {&g_free, "g_free"}, {&g_error_free, "g_error_free"},
			{&g_set_prgname, "g_set_prgname"}, {&g_set_application_name, "g_set_application_name"},
		}},
		{gobject, []binding{
			{&g_signal_connect_data, "g_signal_connect_data"}, {&g_object_unref, "g_object_unref"},
			{&g_object_new_with_properties, "g_object_new_with_properties"},
			{&g_value_init, "g_value_init"}, {&g_value_set_object, "g_value_set_object"}, {&g_value_unset, "g_value_unset"},
		}},
		{gio, []binding{
			{&g_application_run, "g_application_run"}, {&g_application_quit, "g_application_quit"},
			{&g_simple_action_new, "g_simple_action_new"}, {&g_action_map_add_action, "g_action_map_add_action"},
			{&g_menu_new, "g_menu_new"}, {&g_menu_append, "g_menu_append"}, {&g_menu_append_section, "g_menu_append_section"},
			{&g_file_get_path, "g_file_get_path"}, {&g_app_info_launch_default_for_uri, "g_app_info_launch_default_for_uri"},
		}},
		{gtk, []binding{
			{&gtk_init_check, "gtk_init_check"},
			{&gtk_application_new, "gtk_application_new"}, {&gtk_application_window_new, "gtk_application_window_new"},
			{&gtk_application_set_accels_for_action, "gtk_application_set_accels_for_action"},
			{&gtk_window_set_title, "gtk_window_set_title"}, {&gtk_window_set_default_size, "gtk_window_set_default_size"},
			{&gtk_window_get_default_size, "gtk_window_get_default_size"}, {&gtk_window_maximize, "gtk_window_maximize"},
			{&gtk_window_is_maximized, "gtk_window_is_maximized"}, {&gtk_window_set_child, "gtk_window_set_child"},
			{&gtk_window_set_titlebar, "gtk_window_set_titlebar"}, {&gtk_window_set_startup_id, "gtk_window_set_startup_id"},
			{&gtk_window_present, "gtk_window_present"}, {&gtk_window_close, "gtk_window_close"},
			{&gtk_window_set_default_icon_name, "gtk_window_set_default_icon_name"},
			{&gtk_widget_set_size_request, "gtk_widget_set_size_request"}, {&gtk_widget_set_tooltip_text, "gtk_widget_set_tooltip_text"},
			{&gtk_widget_grab_focus, "gtk_widget_grab_focus"},
			{&gtk_header_bar_new, "gtk_header_bar_new"}, {&gtk_header_bar_pack_end, "gtk_header_bar_pack_end"},
			{&gtk_menu_button_new, "gtk_menu_button_new"}, {&gtk_menu_button_set_icon_name, "gtk_menu_button_set_icon_name"},
			{&gtk_menu_button_set_menu_model, "gtk_menu_button_set_menu_model"}, {&gtk_menu_button_set_primary, "gtk_menu_button_set_primary"},
			{&gtk_widget_add_css_class, "gtk_widget_add_css_class"}, {&gtk_css_provider_new, "gtk_css_provider_new"},
			{&gtk_css_provider_load_from_data, "gtk_css_provider_load_from_data"}, {&gdk_display_get_default, "gdk_display_get_default"},
			{&gtk_style_context_add_provider_for_display, "gtk_style_context_add_provider_for_display"},
		}},
		{webkit, []binding{
			{&webkit_web_view_get_type, "webkit_web_view_get_type"},
			{&webkit_network_session_new_ephemeral, "webkit_network_session_new_ephemeral"},
			{&webkit_web_view_load_uri, "webkit_web_view_load_uri"}, {&webkit_web_view_get_title, "webkit_web_view_get_title"},
			{&webkit_web_view_reload, "webkit_web_view_reload"},
			{&webkit_web_view_set_background_color, "webkit_web_view_set_background_color"},
			{&webkit_web_view_get_settings, "webkit_web_view_get_settings"},
			{&webkit_settings_set_enable_back_forward_navigation_gestures, "webkit_settings_set_enable_back_forward_navigation_gestures"},
			{&webkit_navigation_policy_decision_get_navigation_action, "webkit_navigation_policy_decision_get_navigation_action"},
			{&webkit_navigation_action_get_request, "webkit_navigation_action_get_request"},
			{&webkit_uri_request_get_uri, "webkit_uri_request_get_uri"},
			{&webkit_policy_decision_ignore, "webkit_policy_decision_ignore"},
			{&webkit_hit_test_result_context_is_editable, "webkit_hit_test_result_context_is_editable"},
			{&webkit_hit_test_result_context_is_selection, "webkit_hit_test_result_context_is_selection"},
			{&webkit_hit_test_result_context_is_link, "webkit_hit_test_result_context_is_link"},
		}},
	}
	for _, lib := range required {
		for _, b := range lib.fns {
			if err := bind(lib.lib, b); err != nil {
				return err
			}
		}
	}

	bindOptional(gtk, []binding{
		{&gtk_file_dialog_new, "gtk_file_dialog_new"}, {&gtk_file_dialog_set_title, "gtk_file_dialog_set_title"},
		{&gtk_file_dialog_set_accept_label, "gtk_file_dialog_set_accept_label"}, {&gtk_file_dialog_set_modal, "gtk_file_dialog_set_modal"},
		{&gtk_file_dialog_select_folder, "gtk_file_dialog_select_folder"},
		{&gtk_file_dialog_select_folder_finish, "gtk_file_dialog_select_folder_finish"},
	})
	bindOptional(gtk, []binding{
		{&gtk_uri_launcher_new, "gtk_uri_launcher_new"}, {&gtk_uri_launcher_launch, "gtk_uri_launcher_launch"},
	})
	if adw, err := open("libadwaita-1.so.0"); err == nil {
		bindOptional(adw, []binding{
			{&adw_init, "adw_init"}, {&adw_style_manager_get_default, "adw_style_manager_get_default"},
			{&adw_style_manager_get_dark, "adw_style_manager_get_dark"},
		})
	}
	return nil
}

func bind(lib uintptr, b binding) error {
	sym, err := purego.Dlsym(lib, b.name)
	if err != nil {
		return fmt.Errorf("%s: %w", b.name, err)
	}
	purego.RegisterFunc(b.fn, sym)
	return nil
}

// bindOptional binds a group of functions only when all of them exist, so a
// group is either complete or left nil.
func bindOptional(lib uintptr, group []binding) {
	syms := make([]uintptr, len(group))
	for i, b := range group {
		sym, err := purego.Dlsym(lib, b.name)
		if err != nil {
			return
		}
		syms[i] = sym
	}
	for i, b := range group {
		purego.RegisterFunc(b.fn, syms[i])
	}
}

// goString copies a NUL-terminated C string (nil is "").
func goString(p uintptr) string {
	if p == 0 {
		return ""
	}
	ptr := *(*unsafe.Pointer)(unsafe.Pointer(&p))
	n := 0
	for *(*byte)(unsafe.Add(ptr, n)) != 0 {
		n++
	}
	return string(unsafe.Slice((*byte)(ptr), n))
}

// cStrings is a NULL-terminated array of C strings in Go memory, for calls
// that copy it before returning.
type cStrings struct {
	bufs [][]byte
	ptrs []uintptr
}

func newCStrings(ss ...string) *cStrings {
	c := &cStrings{}
	for _, s := range ss {
		b := append([]byte(s), 0)
		c.bufs = append(c.bufs, b)
		c.ptrs = append(c.ptrs, uintptr(unsafe.Pointer(&b[0])))
	}
	c.ptrs = append(c.ptrs, 0)
	return c
}

func (c *cStrings) ptr() unsafe.Pointer { return unsafe.Pointer(&c.ptrs[0]) }
