# ADR-0030: Give every app and project an icon: the user's choice, else its own favicon or logo, else its initials

- **Status:** Accepted
- **Date:** 2026-11-12
- **Builds on:** [ADR-0026](0026-remote-parity.md) (machine areas tunnelled to remote agents), [ADR-0008](0008-local-api-security.md) (token and CSP)

## What it has to do

With a dozen projects in the sidebar and their apps in long lists, names alone are slow to scan. The owner asked for each project and app to show its favicon or icon, with initials when there is none, and a way to set an SVG of one's own.

Facts:

- The agent knows each app's folder (`dir`), its checkout and its repository; a project knows its repositories. Frameworks keep icons in known places: `public/favicon.svg`, `app/icon.svg` (Next.js), `static/favicon.png` (SvelteKit), `favicon.ico`, `public/logo.svg`…
- Every `/api` request needs the `X-Portplane-Token` header, so an `<img src="/api/…">` cannot load; the CSP allows images from `'self'` and `data:` only.
- A remote machine's folders can only be read by its agent, through the tunnelled machine areas (ADR-0026).
- The macOS window's web view has no file dialog for `<input type="file">`; Portplane already shows the OS folder picker through `osascript`, PowerShell, zenity or kdialog.
- Preferences are one JSON document checked field by field by the server.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| Works with no setup for most projects | High | The point is a list that scans at a glance |
| Never shows a file that isn't an image | High | The API reads paths from the user's disk |
| Works for remote machines | Medium | Remote parity (ADR-0026) |
| Nothing written into the user's projects | Medium | Portplane keeps no state in repositories unless asked (ADR-0009) |
| Small | Medium | One maintainer |

## Options

| | Load the running app's `/favicon.ico` through its URL | Read icon files from the folder | Only initials and colours |
|---|---|---|---|
| Stopped apps | No icon | Icon | Initials |
| Remote machines | Through the tunnel, when running | Through the agent | Yes |
| CSP and token | Needs `img-src https:` | Fine as `data:` | Fine |
| Custom icon | No | A file the user picks | Letters and colour only |

## Verdict

**Read icon images from the folders, through the agent of the machine they are on; let the user pick initials, one of the project's images or a file; and show initials when there is nothing else.**

- **Search.** `internal/appicon` looks in the app's folder, then each parent up to its checkout (never above), for a fixed list of places, best first: `.portplane/icon.svg|png` (a team's explicit choice, committed with the code), then SVGs (`public/favicon.svg`, `app/icon.svg`, `logo.svg`…), then large PNGs meant as app icons, then `favicon.ico`. A project uses its repository's folder.
- **Only images.** A file is read only with an image extension, under 512 KB, and when its bytes match its type (an SVG must contain `<svg`, an ICO its header, a PNG its signature). Anything else is refused, whatever path is asked for. Images travel as base64 in JSON and show as `data:` URLs; SVGs in `<img>` never run scripts.
- **Routes,** in the `icons/` machine area so a remote agent answers for its own folders: `GET /api/icons/find?dir=&root=`, `GET /api/icons/candidates?root=` (up to 24 images in the project whose names say icon, logo, favicon, mark or brand, four folders deep, skipping `node_modules`, builds and caches), `GET /api/icons/file?path=`, and `POST /api/icons/pick` (this computer's file picker; a remote agent answers 501).
- **Choice.** Preferences gain `icons`, keyed `project:<machine>|<name>` or `app:<machine>|<appId>`: `initials` (up to 3 letters and one of 8 tints), `file` (a machine and an absolute path), or nothing for automatic. The icon dialog opens from the icon on a project's page or in an app's drawer.
- **Fallbacks.** An app with no image of its own shows its project's icon; with none either, its project's initials on a colour taken from the project's name, the same on every machine. Images are read once per session and cached; picking a new icon reads them again.

**Cost we accept:**

- A request per app and project the first time a list shows (small, cached, and only for the icons on screen).
- An icon chosen as a file breaks when the file moves; it then falls back to automatic.
- An agent older than this decision answers 501 for icons: its apps show initials, and Health offers to update the agent.

**What would make us revisit it:** frameworks that keep icons somewhere the list misses (add the place); people wanting icons shared across their machines (sync the preference); a large monorepo where finding candidates is slow.
