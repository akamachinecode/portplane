//go:build darwin && cgo

package window

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <stdatomic.h>
#include <stdlib.h>

// Everything below runs on the main thread, inside the run loop the tray
// starts (fyne.io/systray calls [NSApp run]). Go only queues work there and
// polls a counter for Quit (no callbacks across the cgo boundary).

static atomic_int ppQuits = 0;

static BOOL ppIsWeb(NSURL *u) {
	NSString *s = u.scheme.lowercaseString;
	return [s isEqualToString:@"http"] || [s isEqualToString:@"https"];
}

static BOOL ppSameOrigin(NSURL *a, NSURL *b) {
	if (a == nil || b == nil || a.host == nil || b.host == nil) {
		return NO;
	}
	BOOL samePort = (a.port == nil && b.port == nil) ||
		(a.port != nil && b.port != nil && [a.port isEqualToNumber:b.port]);
	return samePort &&
		[a.scheme.lowercaseString isEqualToString:b.scheme.lowercaseString] &&
		[a.host.lowercaseString isEqualToString:b.host.lowercaseString];
}

static void ppActivate(void) {
	// Not -activate (macOS 14): it is cooperative and only works when the
	// active app yields, which neither Finder, the terminal nor the tray
	// menu does, so the window opened behind the frontmost app. The window
	// only opens on an explicit request (launch, tray, Dock, a second start).
	[NSApp activateIgnoringOtherApps:YES];
}

static NSMenu *ppSubmenu(NSMenu *bar, NSString *title) {
	NSMenuItem *holder = [bar addItemWithTitle:title action:nil keyEquivalent:@""];
	NSMenu *m = [[NSMenu alloc] initWithTitle:title];
	holder.submenu = m;
	return m;
}

static NSMenuItem *ppItem(NSMenu *m, NSString *title, SEL action, NSString *key, NSEventModifierFlags mods, id target) {
	NSMenuItem *i = [m addItemWithTitle:title action:action keyEquivalent:key];
	if (mods != 0) {
		i.keyEquivalentModifierMask = mods;
	}
	i.target = target; // nil: the first responder (the web view, the window, NSApp)
	return i;
}

// ppMenu is the menu bar while the window is open: the standard items, so
// Cmd-Q, Cmd-W, Cmd-C and Cmd-V do what a Mac user expects.
static NSMenu *ppMenu(id owner) {
	NSEventModifierFlags cmdOpt = NSEventModifierFlagCommand | NSEventModifierFlagOption;
	NSEventModifierFlags cmdShift = NSEventModifierFlagCommand | NSEventModifierFlagShift;
	NSMenu *bar = [NSMenu new];

	NSMenu *app = ppSubmenu(bar, @"Portplane");
	ppItem(app, @"About Portplane", @selector(orderFrontStandardAboutPanel:), @"", 0, nil);
	[app addItem:[NSMenuItem separatorItem]];
	ppItem(app, @"Hide Portplane", @selector(hide:), @"h", 0, nil);
	ppItem(app, @"Hide Others", @selector(hideOtherApplications:), @"h", cmdOpt, nil);
	ppItem(app, @"Show All", @selector(unhideAllApplications:), @"", 0, nil);
	[app addItem:[NSMenuItem separatorItem]];
	ppItem(app, @"Quit Portplane", @selector(quit:), @"q", 0, owner);

	NSMenu *file = ppSubmenu(bar, @"File");
	ppItem(file, @"Close Window", @selector(performClose:), @"w", 0, nil);

	NSMenu *edit = ppSubmenu(bar, @"Edit");
	ppItem(edit, @"Undo", @selector(undo:), @"z", 0, nil);
	ppItem(edit, @"Redo", @selector(redo:), @"z", cmdShift, nil);
	[edit addItem:[NSMenuItem separatorItem]];
	ppItem(edit, @"Cut", @selector(cut:), @"x", 0, nil);
	ppItem(edit, @"Copy", @selector(copy:), @"c", 0, nil);
	ppItem(edit, @"Paste", @selector(paste:), @"v", 0, nil);
	ppItem(edit, @"Select All", @selector(selectAll:), @"a", 0, nil);

	NSMenu *view = ppSubmenu(bar, @"View");
	ppItem(view, @"Reload", @selector(reloadPage:), @"r", 0, owner);

	NSMenu *win = ppSubmenu(bar, @"Window");
	ppItem(win, @"Minimize", @selector(performMiniaturize:), @"m", 0, nil);
	ppItem(win, @"Zoom", @selector(performZoom:), @"", 0, nil);
	[win addItem:[NSMenuItem separatorItem]];
	ppItem(win, @"Bring All to Front", @selector(arrangeInFront:), @"", 0, nil);
	NSApp.windowsMenu = win;

	return bar;
}

@interface PPWindow : NSObject <NSWindowDelegate, WKNavigationDelegate, WKUIDelegate>
@property (strong) NSURL *home;
@property (strong) NSWindow *window;
@property (strong) WKWebView *web;
@property (strong) WKWebsiteDataStore *store;
@end

@implementation PPWindow

- (void)show {
	if (self.window == nil) {
		NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
			NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
		NSWindow *w = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1120, 760)
		                                          styleMask:style
		                                            backing:NSBackingStoreBuffered
		                                              defer:NO];
		w.title = @"Portplane";
		w.releasedWhenClosed = NO;
		w.delegate = self;
		w.minSize = NSMakeSize(560, 400);
		w.tabbingMode = NSWindowTabbingModeDisallowed;
		[w center];
		[w setFrameAutosaveName:@"Portplane"];
		[w setFrameUsingName:@"Portplane"];
		self.window = w;
		// Nothing is kept on disk: the page lives on a new loopback port each
		// run, and its token changes with it (ADR-0008). The store outlives a
		// closed window, so small UI state survives until Portplane quits.
		self.store = [WKWebsiteDataStore nonPersistentDataStore];
		NSApp.mainMenu = ppMenu(self);
	}
	if (self.web == nil) {
		WKWebViewConfiguration *c = [WKWebViewConfiguration new];
		c.websiteDataStore = self.store;
		WKWebView *web = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:c];
		web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
		web.navigationDelegate = self;
		web.UIDelegate = self;
		// Let the window background show until the page paints (no white
		// flash in dark mode).
		[web setValue:@NO forKey:@"drawsBackground"];
		[web addObserver:self forKeyPath:@"title" options:NSKeyValueObservingOptionNew context:NULL];
		self.window.contentView = web;
		self.web = web;
		[web loadRequest:[NSURLRequest requestWithURL:self.home]];
	}
	// A Dock icon and a menu bar while the window is open; back to a
	// menu-bar-only app when it closes (Info.plist sets LSUIElement).
	[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
	[self.window makeKeyAndOrderFront:nil];
	ppActivate();
}

- (void)quit:(id)sender {
	atomic_fetch_add(&ppQuits, 1);
}

- (void)reloadPage:(id)sender {
	[self.web reload];
}

// The page title ("Portplane · 3 running") becomes the window title.
- (void)observeValueForKeyPath:(NSString *)path ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
	NSString *t = self.web.title;
	self.window.title = t.length > 0 ? t : @"Portplane";
}

- (void)windowWillClose:(NSNotification *)note {
	// Drop the page: a closed window keeps no event stream open, so
	// Portplane goes back to its slow polling.
	if (self.web != nil) {
		[self.web removeObserver:self forKeyPath:@"title"];
		[self.web stopLoading];
		self.web.navigationDelegate = nil;
		self.web.UIDelegate = nil;
		self.web = nil;
	}
	self.window.contentView = [[NSView alloc] initWithFrame:NSZeroRect];
	self.window.title = @"Portplane";
	[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
}

// Only the UI loads in the window. Any other http(s) address opens in the
// default browser; anything else is refused.
- (void)webView:(WKWebView *)web decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decide {
	NSURL *u = action.request.URL;
	if (ppSameOrigin(u, self.home) || [u.absoluteString isEqualToString:@"about:blank"]) {
		decide(WKNavigationActionPolicyAllow);
		return;
	}
	if (ppIsWeb(u)) {
		[[NSWorkspace sharedWorkspace] openURL:u];
	}
	decide(WKNavigationActionPolicyCancel);
}

// target="_blank" and window.open: the address opens in the default browser
// and window.open returns null, so the UI falls back to POST /api/open.
- (WKWebView *)webView:(WKWebView *)web createWebViewWithConfiguration:(WKWebViewConfiguration *)c forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {
	NSURL *u = action.request.URL;
	if (u != nil && ppIsWeb(u)) {
		[[NSWorkspace sharedWorkspace] openURL:u];
	}
	return nil;
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)web {
	[web reload];
}

@end

static PPWindow *ppWindow;

static void ppShow(const char *raw) {
	NSURL *u = [NSURL URLWithString:[NSString stringWithUTF8String:raw]];
	dispatch_async(dispatch_get_main_queue(), ^{
		if (ppWindow == nil) {
			ppWindow = [PPWindow new];
		}
		if (u != nil) {
			ppWindow.home = u;
		}
		[ppWindow show];
	});
}

// ppSetIcon gives a bare binary (no Portplane.app around it) the Portplane
// icon in the Dock; inside the bundle, Info.plist names the .icns.
static void ppSetIcon(const void *png, int n) {
	NSData *d = [NSData dataWithBytes:png length:n];
	dispatch_async(dispatch_get_main_queue(), ^{
		if (NSBundle.mainBundle.bundleIdentifier == nil) {
			NSApp.applicationIconImage = [[NSImage alloc] initWithData:d];
		}
	});
}

// Quit in the Dock menu, Cmd-Tab Q, logout and scripts send a Quit Apple
// event, which AppKit answers with terminate: and exit(), skipping Go's
// cleanup (instance.json, the portless alias). Count it like Cmd-Q instead.
@interface PPQuitEvent : NSObject
- (void)handle:(NSAppleEventDescriptor *)event reply:(NSAppleEventDescriptor *)reply;
@end

@implementation PPQuitEvent
- (void)handle:(NSAppleEventDescriptor *)event reply:(NSAppleEventDescriptor *)reply {
	atomic_fetch_add(&ppQuits, 1);
}
@end

static PPQuitEvent *ppQuitEvent;

static void ppRegisterQuit(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		ppQuitEvent = [PPQuitEvent new];
		[[NSAppleEventManager sharedAppleEventManager] setEventHandler:ppQuitEvent
			andSelector:@selector(handle:reply:)
			forEventClass:kCoreEventClass
			andEventID:kAEQuitApplication];
	});
}

static int ppTakeQuits(void) { return atomic_exchange(&ppQuits, 0); }
*/
import "C"

import (
	"context"
	"sync"
	"time"
	"unsafe"

	"github.com/akamachinecode/portplane/internal/icon"
)

// Supported reports whether Show opens a native window in this build.
func Supported() bool { return true }

var iconOnce sync.Once

// Show opens the window on url, or brings it to the front. It may be called
// from any goroutine; the window appears once the tray's run loop runs.
func Show(url string) {
	iconOnce.Do(func() {
		png := icon.PNG(512, 2)
		C.ppSetIcon(unsafe.Pointer(&png[0]), C.int(len(png)))
	})
	cs := C.CString(url)
	defer C.free(unsafe.Pointer(cs))
	C.ppShow(cs)
}

// OnQuit calls quit when the user chooses Quit Portplane in the window's
// menu (Cmd-Q) or the app gets a Quit Apple event (the Dock's Quit, logout).
// It stops watching when ctx ends.
func OnQuit(ctx context.Context, quit func()) {
	C.ppRegisterQuit()
	go func() {
		t := time.NewTicker(250 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if C.ppTakeQuits() > 0 {
					quit()
					return
				}
			}
		}
	}()
}
