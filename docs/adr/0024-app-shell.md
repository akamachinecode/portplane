# ADR-0024: Turn the UI into an app shell with a sidebar, a hash router and background jobs

- **Status:** Accepted
- **Date:** 2026-11-12
- **Builds on:** [ADR-0003](0003-ui-react-vite.md). React, Vite, plain CSS with custom properties, and the JSON API with its event stream all stay.

## What it has to do

Today the UI is one scrolling page with dialogs on top: the machine sections, then Setup, Settings and the machine dialogs. M5 adds onboarding, a portless center (proxy, routes, aliases, certificates, hosts), a dekit center (runners, project config, task forms), an Output panel, a health view and long installs. More stacked dialogs do not scale to that.

- Several top-level views, each with its own address, so Back works and the tray or a notification can open one app.
- A fast way to reach any app or action from the keyboard.
- An app's detail (summary, why, output, config, URL) without leaving the list.
- Long operations (installs, the proxy service, `dekit up --wait`) that keep running while the user moves around, with progress the tray can show too.
- A theme the user can pick (today it only follows the system), and a compact density for long lists.
- Usable in a narrow window.

Facts:

- The binary serves `index.html` at `/` with the per-run token written in (ADR-0008). It pushes the whole snapshot as `event: snapshot` on `/api/events`.
- The native windows keep no web storage on disk (ADR-0017, ADR-0018), so `localStorage` does not survive a restart there.
- All styles live in one stylesheet, `web/src/styles.css`, about 2,500 lines today.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| Scales to M5's screens | High | Onboarding, two centers, Output, health |
| Deep links work in the browser and in the native windows | High | The tray and notifications open one app |
| No change to the API's security | High | ADR-0008 |
| New dependencies | Medium | ADR-0003: no component framework |
| Keyboard and screen reader | Medium | Accessibility pass before v1.0 (roadmap) |

## Options

**Routing**

| | A hash router of our own (`#/apps/…`) | Path routes (`/apps/…`) | A routing library (React Router, TanStack Router) |
|---|---|---|---|
| Server change | None: the page is always `/` | Serve `index.html`, with the token, for every UI path | Depends on hash or path mode |
| Deep links and Back | Yes | Yes | Yes |
| New dependency | None | None | One |

**Jobs**

| | `event: job` on the existing stream | One stream per job | Polling a job endpoint |
|---|---|---|---|
| New connections | None | One per job | None |
| Progress | Live | Live | Every poll |
| After a reconnect | Fetch the job's state, as with `GET /api/snapshot` | Same | Nothing to do |

## Verdict

**A sidebar app shell, with a hash router, a command palette, an app detail drawer and background jobs on the existing event stream.**

- **Layout.** A collapsible sidebar with Apps, Projects, Domains, Runners, Machines, Health and Settings, with counts and a problems badge. Below 760 px wide it becomes a bottom tab bar. A top bar holds search, the connection state, and the state of the proxy and the runners.
- **Router.** A small hash router of our own: `#/apps`, `#/apps/<machine>/<runner>/<task>`, `#/domains`… Back, forward and links from the tray and notifications work, and the server does not change.
- **Command palette.** Ctrl+K, or ⌘K on macOS. It goes to any app and runs start, stop, restart, open and copy URL, plus actions such as "Run command…", "New alias", "Add app", "Run diagnosis" and "Reload dekit.yaml".
- **Keyboard in lists.** `j` and `k` or the arrows move, `Enter` opens the detail, `s` starts or stops, `r` restarts, `o` opens, `c` copies the URL, `/` searches and `?` lists the shortcuts. No single-key shortcut fires while a text field has focus.
- **App detail drawer.** It opens beside the list, with tabs: Summary (with dekit's "why"), Output (ADR-0021), Configuration (ADR-0022) and URL.
- **Jobs.** Every long operation is a job with an id, stages, output lines and a result. The binary sends job changes as `event: job` on `/api/events`, next to `event: snapshot`. After a reconnect, the UI fetches the state of the jobs it shows. A job card shows progress in the UI, and the tray lists running jobs.
- **Styles.** `styles.css` splits into a tokens file (spacing, type scale, radii, shadows, motion, colours), a base file, and one CSS file per view or component, imported next to it. It stays plain CSS with custom properties: one accent colour, and green, amber and red only for state.
- **Theme and density.** Theme: system, light or dark. Density: comfortable or compact. Both are stored in Portplane's `settings.json` through the API, not in browser storage, so they survive in the native windows. The native window's title bar follows the chosen theme.
- **New dependencies,** only where writing our own would be unreasonable: xterm.js for Output (ADR-0021) and CodeMirror for the YAML editor (ADR-0022). Vite splits both into chunks loaded on first use.
- **Motion** respects `prefers-reduced-motion`.

**Cost we accept:**

- A rework of the UI's structure. M5.0 brings the shell and the router with today's views inside, before any new view.
- A router and a palette of our own to maintain and test, keyboard and screen reader included.
- Addresses with a hash (`#/apps`) instead of clean paths.
- Two larger dependencies, even if loaded on demand.

**What would make us revisit it:** routes nested deeply enough that our router turns into a library; the shell missing M5.5's target of a first paint under 300 ms in the native window; a native window that cannot host the web UI (ADR-0003's own trigger).
