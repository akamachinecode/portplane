# ADR-0018: Show the UI in a native window on Linux and Windows too

- **Status:** Accepted
- **Date:** 2026-11-11
- **Supersedes:** the browser window that [ADR-0017](0017-native-window-macos.md) kept on Linux and Windows. The tray, the loopback server and the macOS window stay as they are.

## What it has to do

The second user report, on v0.3.0 for Linux, was the same as the first one on macOS: opening Portplane opened a browser tab. With Firefox there is no app mode, so it was a full tab, with the browser's tabs, address bar and extensions. The user asked for a dedicated app on every system and accepted a larger download for it.

- Opening Portplane opens Portplane: its own window, with the Portplane name and icon in the dock or taskbar. Its title follows the page ("Portplane · 3 running").
- Links to apps open in the default browser, never inside the window.
- A second start, the tray's Open Portplane, and the app launcher bring the same window to the front.
- The folder picker opens over the window.
- If the native window cannot open, Portplane falls back to the browser.

What ADR-0004 and ADR-0017 required still holds:

- The `portplane` binary stays the remote agent (ADR-0015). It must start on a server with no desktop libraries. On Linux that means a static binary.
- The tray stays.
- The release still builds every target on the macOS runner, without a C toolchain per target.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| Looks and behaves like an app of the system | High | The user reported the browser window as the problem |
| `portplane` still starts headless, static on Linux | High | It is uploaded to remote machines as the agent |
| Small change to what works | High | The macOS window, the tray and the release pipeline work today |
| Build complexity | Medium | One maintainer; the release runs on one macOS runner (ADR-0012) |
| New dependencies | Medium | Each one is code to trust and update |

## Options

**Linux**

| | GTK 4 + WebKitGTK through purego, in a second binary | A webview library through CGO, in a second binary | Wails v3 for the whole app | Electron |
|---|---|---|---|---|
| App identity | Yes: its own app ID, matching the `.desktop` file | Yes | Yes | Yes |
| `portplane` stays static | Yes: only `portplane-window` loads GTK | Yes | No: the app links WebKitGTK, so the agent would be split off | Yes |
| Links leave for the browser | Yes: WebKit's navigation policy | No: webview/webview has no navigation hook | Not checked | Yes |
| Build | Pure Go (`CGO_ENABLED=0`), cross-compiled on the macOS runner | CGO on Linux runners, one per architecture, with WebKit headers | CGO on Linux runners; Wails owns the run loop and has its own tray, so the macOS window and `fyne.io/systray` would be redone | A Node project and electron-builder |
| Size | ~4.6 MB binary; WebKitGTK comes from the system | Small | Medium | ~100 MB per package |

**Windows**

| | WebView2 through `github.com/jchv/go-webview2`, in `portplane` | Wails v3 |
|---|---|---|
| Runtime | WebView2 ships with Windows 10 and 11 | Same |
| Build | Pure Go, no CGO; the binary still starts headless, and WebView2 loads only when the window opens | Replaces the tray and the run loop |
| Navigation events | Not exposed by the library: a script in the page sends links and the title to Go | Yes |

A spike on 2026-11-11 on Fedora 44 (GNOME 50, GTK 4.22, WebKitGTK 2.54, libadwaita 1.9) found that purego, already in the module graph through gopsutil, can do the whole Linux window without CGO. It loads `libgtk-4.so.1` and `libwebkitgtk-6.0.so.4`, and its callbacks cover the GTK signals. The binary it makes needs glibc's loader, which is why the window is a second binary and not part of `portplane`.

## Verdict

**Every system shows the UI in a native window. Portplane draws each one with the system's own web view and adds no framework.**

**Linux.** `portplane-window` is a second, pure-Go binary that ships next to `portplane` in the `.deb`, the `.rpm`, the archive and `install.sh`.

- It loads GTK 4, WebKitGTK 6.0 and, when present, libadwaita at run time.
- Portplane starts it when the window opens and talks to it over two pipes (fds 3 and 4), one JSON message per line (`internal/window/proto.go`). Messages bring the window forward, show the folder picker, and report Quit.
- Closing the window ends the process, and with it the web view's memory and event stream.
- The window:
  - Its app ID is `dev.portplane.app`, which matches `dev.portplane.app.desktop`.
  - It has a GNOME header bar with the page's background and a menu (Open in Browser, Reload, Quit Portplane), plus Ctrl+Q, Ctrl+W and Ctrl+R.
  - It follows the desktop's light or dark style through libadwaita, and remembers its size.
  - Its web storage is not kept on disk.
- External links and `target="_blank"` open in the default browser through the desktop portal. `window.open` returns `null`, so the UI asks Portplane to open the address (`POST /api/open`), as on macOS.
- The folder picker is GTK's own, which goes through the desktop portal, over the window. zenity and kdialog remain the fallback.
- A second start passes its XDG activation token on (`POST /api/window`), so Wayland lets the window take focus.
- The packages recommend WebKitGTK 6.0 and libadwaita, by package name in the `.deb` and by soname in the `.rpm`. `dnf` and `apt` install recommended packages by default.
- If GTK or WebKitGTK is missing, the helper exits with code 3 and Portplane opens the browser, as before.
- Without a tray icon on screen (GNOME without the AppIndicator extension), closing a window that Portplane opened at start quits Portplane. A Portplane started at login keeps running.
- CI checks that `cmd/portplane` does not import purego on Linux and that its binary is static.

**Windows.** The window is a WebView2 on a thread of its own, next to the tray's.

- The library cannot release a web view, and a destroyed one leaves its browser processes behind. So closing the window hides it and loads `about:blank`, which drops the page and its event stream, as on macOS.
- A script injected into the page does two jobs:
  - It sends external links, `target="_blank"` and `window.open` to Go, which opens them in the default browser.
  - It reports the page title.
- The title bar turns dark with Windows' dark mode for apps. The window and its taskbar button use the Portplane icon, and its windows are DPI aware.
- WebView2 keeps its profile in `%LocalAppData%\portplane\WebView2`.
- A second start calls `AllowSetForegroundWindow`, so the running Portplane may bring its window forward.
- If the WebView2 runtime is missing, Portplane opens the browser.

**macOS** is unchanged (ADR-0017).

Checked by hand on 2026-11-11 on Fedora 44 GNOME (Wayland):

- The window shows the real UI in light and dark style, with the title bar blending into the page's top bar.
- A second start brings back the same window and does not open a second one.
- Ctrl+Q and closing the window both end Portplane with no tray icon, removing `instance.json`, and no window process is left behind.
- The folder picker opens through the portal.
- `window.open` returns `null`.
- The `.rpm` installs both binaries and recommends `libwebkitgtk-6.0.so.4()(64bit)`.

**Windows was not run by hand.** No Windows machine was available. CI compiles it and runs the tests on Windows. It needs a hand check before a release.

**Cost we accept:**

- About 850 lines of GTK calls through purego (`internal/gtkwindow`). A wrong signature there crashes the window process, not Portplane, and only a run on a desktop finds it.
- A second binary on Linux, and its pipe protocol.
- On Windows, a page script stands in for WebView2's navigation events. A navigation that a script starts, such as `location.href` to another site, stays in the window.
- Three implementations instead of one framework.

**What would make us revisit it:** a framework that loads its web view at run time, so one binary can still be the agent, and that coexists with the tray; or the Windows window needing WebView2 events the library does not expose.
