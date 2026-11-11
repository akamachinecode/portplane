# ADR-0004: Serve the UI in the browser and add a tray icon; no embedded web view in v1

- **Status:** Accepted. On macOS, the window is superseded by [ADR-0017](0017-native-window-macos.md) (a native window); the tray and the loopback server stand.
- **Date:** 2026-11-11
- **Resolves:** A3 in [open-questions.md](../open-questions.md)

## What it has to do

- Give the user a window with the view (ADR-0003), one click away.
- Show at a glance, without opening the window, how many servers run.
- Keep the binary usable as a remote agent on a headless machine (principle 4 in the vision).
- Build for six targets from CI without a desktop toolchain per target.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| The desktop binary also runs headless | High | It is copied to remote machines that may have no GUI libraries |
| Native feel | Medium | A tray icon matters more than window chrome for a glanceable tool |
| Build complexity | Medium | One maintainer |
| Attack surface | Medium | A loopback HTTP server must be protected (ADR-0008) |

## Options

| | Browser UI + tray icon | Wails v3 window + tray | Tauri |
|---|---|---|---|
| Status | Mature | v3.1.0, first stable, released 2026-11-01 | Stable |
| Linux binary | Static, no GUI libraries | Links `webkit2gtk-4.1`: the binary does not start on a headless server without it | Rust toolchain, links WebKitGTK |
| Same file as agent | Yes | No: needs a second, headless build | No |
| CGO | macOS only (tray uses Cocoa, always present) | macOS and Linux | n/a |
| HTTP listener | Yes, loopback | No | No |

Spike, 2026-11-11: `fyne.io/systray` v1.12.2 (Apache-2.0) builds with `CGO_ENABLED=0` for Linux (it speaks D-Bus StatusNotifierItem) and Windows, and needs CGO only on macOS.

## Verdict

**The binary serves the UI on loopback, reachable at `https://portplane.localhost` through a portless alias (or `http://127.0.0.1:<port>` without portless), and shows a tray or menu-bar icon** with the count of running servers and shortcuts. "Open Portplane" opens the default browser; where a Chromium-based browser is found, it opens in app mode (`--app=<url>`) so it looks like a window.

The darwin builds use CGO for the tray and are built on a macOS runner; every other target is built with `CGO_ENABLED=0`. A darwin binary built without CGO has no tray and works otherwise.

**Cost we accept:** the UI lives in a browser tab or app-mode window instead of a native window, and the loopback listener needs the protections in ADR-0008. On GNOME, the tray needs the AppIndicator extension; without it, Portplane still works.

**What would make us revisit it:** Wails (or another shell) loading its web view at runtime, so the same binary still starts on a headless machine; or users reporting that the browser window is a real problem.
