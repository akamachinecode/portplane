# ADR-0017: Show the UI in a native window on macOS; keep the browser window elsewhere

- **Status:** Accepted
- **Date:** 2026-11-11
- **Supersedes:** the window part of [ADR-0004](0004-desktop-shell.md) on macOS. The tray, the loopback server and the browser window on Linux and Windows stay as ADR-0004 says.

## What it has to do

The first user report on v0.2.0 was the one ADR-0004 named as a reason to revisit it: opening Portplane.app showed a Chrome app-mode window. The Dock, Cmd-Tab and the menu bar said Chrome, the window used Chrome's icon and menus, and what opened depended on which browser was installed. On macOS, opening Portplane must open Portplane:

- Its own window, with the Portplane name and icon in the Dock and in Cmd-Tab while it is open.
- The menus a Mac user expects: Cmd-Q, Cmd-W, Cmd-H, and Cmd-C and Cmd-V in text fields.
- No dependency on a browser being installed.
- When the window closes, Portplane goes back to being a menu-bar app.

What ADR-0004 required still holds: the same darwin binary must start headless as a remote agent over SSH, the tray stays, and the build must not need a new toolchain.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| Looks and behaves like a Mac app | High | The user reported the browser window as the problem |
| Same binary still runs headless | High | It is uploaded to remote Macs as the agent (ADR-0015) |
| Fits the tray's run loop | High | `fyne.io/systray` already runs `[NSApp run]` on the main thread; AppKit allows one |
| Build complexity | Medium | One maintainer; darwin builds already use CGO on a macOS runner (ADR-0004, ADR-0012) |
| New dependencies | Medium | Each one is code to trust and update |

## Options

| | Chrome app mode (today) | Own `NSWindow` + `WKWebView` through cgo | Wails v3 | `webview/webview` |
|---|---|---|---|---|
| Mac app identity | No: the window belongs to Chrome | Yes | Yes | Yes |
| Headless start | Yes | Yes: WebKit.framework is part of every macOS, and nothing is created until a window is asked for | Yes on macOS | Yes on macOS |
| Run loop | n/a | Joins the tray's loop: the window is created on the main queue | Wails owns `NSApplication` and has its own tray, so `fyne.io/systray` would go on macOS (and on Windows to share code) | Runs its own `[NSApp run]`, which clashes with the tray's |
| New dependency | None | None (~250 lines of Objective-C in the repo) | Large; v3.1.0, its first stable release, came out on 2026-11-01 | Small C/C++ library |
| Linux | Unchanged | Unchanged | Links WebKitGTK (the reason ADR-0004 turned it down) | Links WebKitGTK |

## Verdict

**On macOS, Portplane shows its UI in its own `NSWindow` with a `WKWebView`, written in Objective-C under cgo (`internal/window`), in the run loop the tray already runs.**

- The window opens from the tray's "Open Portplane", from opening Portplane.app again (the reopen Apple event), from a second `portplane` start, and at launch. While it is open the app switches to a regular app, with a Dock icon and a menu bar with Portplane, File, Edit, View and Window menus. When it closes, the page is dropped (no event stream stays open, so polling slows down again) and the app goes back to a menu-bar app. `LSUIElement` stays on in `Info.plist`, so the app starts without a Dock icon.
- The window loads `http://127.0.0.1:<port>`, not `https://portplane.localhost`. The loopback address needs neither the portless CA in the keychain nor `.localhost` name resolution in WebKit, and ADR-0008 already allows that Host. The page still receives its token in `index.html`. The window uses a non-persistent website data store: nothing is written to disk, since the origin and the token change every run.
- Only the UI's origin loads in the window. Other `http(s)` links, including `target="_blank"`, open in the default browser. `window.open` returns `null`, so the UI falls back to asking Portplane to open the address (`POST /api/open`).
- The window title follows the page title ("Portplane · 3 running"). The frame is remembered between runs.
- Cmd-Q goes through the same shutdown as the tray's Quit, so portless aliases and SSH forwards are removed.
- A second start used to open the browser at the running instance's URL. Now it asks the running instance to show its window through `POST /api/window`, with the token from the instance file. That file is private to the user (0600), which is no weaker than the page that carries the same token (ADR-0008). If the running instance is older and has no such route, the second start opens the browser as before.
- A build without CGO (`CGO_ENABLED=0`), or `portplane serve --no-tray`, has no run loop and keeps the browser window.

Linux and Windows keep the browser window from ADR-0004 for now:

- **Windows:** the WebView2 runtime ships with Windows 10 and 11 and is loaded through COM, so a pure-Go binding (such as `github.com/wailsapp/go-webview2`) could give the same window without CGO. It is the next step once someone uses Windows daily (ADR-0013).
- **Linux:** WebKitGTK would have to be loaded at run time (`dlopen`) to keep a static binary that starts on a headless server. Until then, the browser window stays.

**Cost we accept:**

- About 250 lines of Objective-C. CI compiles them only on the macOS runner, and they are checked by hand, since nothing in CI shows a window.
- The macOS window and the window on the other systems behave differently.
- The browser's developer tools are not available in the window. Opening `https://portplane.localhost` in a browser still works for that.

**What would make us revisit it:** Windows or Linux users reporting the browser window as a problem; a cross-platform shell that loads its web view at run time and coexists with the tray; or AppKit changes that break the switch between a menu-bar app and a regular app.
