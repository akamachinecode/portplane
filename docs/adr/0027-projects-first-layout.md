# ADR-0027: Lay the app out around projects, with dekit and portless in the sidebar, and draw the macOS title bar ourselves

- **Status:** Accepted
- **Date:** 2026-11-12
- **Builds on:** [ADR-0017](0017-native-window-macos.md) (the macOS window), [ADR-0024](0024-app-shell.md) (the app shell). It keeps ADR-0024's router, palette, jobs and drawer, and replaces its layout: what the sidebar lists, where a view's title and actions go, and how a first run starts.

## What it has to do

The first daily use of the macOS app (v0.3.0, and then the M5 shell) brought five complaints:

- **The window looked dated.** A grey system title bar sat above the page, unlike the apps it shares the Dock with (Linear, Raycast, OrbStack, Notion), where the sidebar runs up to the top edge and the traffic lights sit inside it.
- **Worktrees showed apart from their projects.** Someone with one `dekit.yaml` for every repository keeps the linked worktrees' tasks in a `worktrees/` folder of it. Portplane grouped apps by runner and task folder, so a card called "worktrees" listed the worktrees of three different repositories, while each repository showed elsewhere without them.
- **The dekit and portless features were hard to find.** Portplane is a GUI for both tools, but the M5 shell named them "Projects", "Runners" and "Domains", and hid portless's eleven sections behind one sidebar entry and a second column.
- **The Apps view was ragged.** Project cards in a two-column grid had very different heights, and fourteen stopped apps of idle worktrees took the screen.
- **The first run took the whole window** for a ten-step wizard before showing the app at all.

Facts:

- The agent knows each app's git repository and checkout (`internal/gitinfo`), reading `.git` directly. The branch is one small file (`HEAD`) per checkout.
- A WKWebView has no `-webkit-app-region` (that is Electron's), so the page cannot mark areas that move the window. AppKit can start a window drag from a mouse-down event (`performWindowDragWithEvent:`), and a page can message native code (`WKScriptMessageHandler`).
- The macOS title bar's height and the traffic lights' position change between macOS versions, and the traffic lights go away in full screen.
- The native windows on Linux (GTK 4) and Windows (WebView2) keep their system frames (ADR-0018).

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| Matches how the user thinks about their work | High | Repositories and their branches, not dekit runners |
| Every dekit and portless feature one click away | High | The reason Portplane exists (M5) |
| Feels like a current Mac app | High | The owner's report; the product is judged on it |
| No change to the agent protocol beyond new optional fields | High | Remote agents of another version keep working (ADR-0026) |
| Native code CI cannot check | Medium | The macOS window is compiled on the macOS runner and checked by hand (ADR-0017) |
| Small, and reusing what M5 built | Medium | One maintainer |

## Options

**Grouping**

| | By runner and task folder (today) | By git repository | By task folder, joined with the repositories configured in it |
|---|---|---|---|
| A worktree declared in another folder or file | Shows apart | Under its repository | Under its repository's project |
| A repository with tasks in two `dekit.yaml` files | Two projects | One | One |
| A folder for a product of three repositories (`acme/api`, `acme/web`, `acme/app`) | One | Three projects, all called "acme" | One, with a checkout per repository |
| Apps outside git | By task folder | By task folder | By task folder, joining a repository's project of the same name |

**Title bar on macOS**

| | System title bar (today) | Hidden title, page under a transparent bar, drag through a script message | Same, plus an empty unified toolbar to centre the traffic lights in 52 pt |
|---|---|---|---|
| Looks current | No | Yes | Yes |
| Page controls in the top strip | n/a | Yes | No: the toolbar takes the clicks of the top 52 pt |
| Native code | None | ~80 lines | ~90 lines |

**Navigation**

| | M5 sidebar (Apps, Projects, Domains, Runners, Machines, Health) | Sidebar with projects and the tools' sections |
|---|---|---|
| portless's sections | One entry, then a second column of 11 | Four entries under "portless", their sections as tabs |
| dekit | "Projects" and "Runners", which read like Portplane's own | "Configuration" and "Runners" under "dekit" |
| Projects | Only as cards in Apps | Listed with their state; each has its own page |

## Verdict

**The app is laid out around projects, each a task folder with the git repositories configured in it and all their worktrees; the sidebar lists dekit's and portless's sections by name, then the projects; and on macOS the page draws the title bar.**

- **A project is a task folder joined with its repositories.** The agent fills `repo`, `checkout` and `branch` on every app (the branch read from `HEAD` once per checkout and collection, the repository by its real path so symbolic links and Windows short names agree). `Group` links each main checkout's repository with the task folder its tasks sit in, and puts every linked worktree with its repository, wherever the worktree's task is declared. Tasks outside git in a folder named like a repository's project join it. A project takes the name of its one task folder, or the repository's folder name when one repository's tasks sit under several names or only its worktrees are configured. `Group` also renames each app's project to match. Each checkout is one group (`path`, `branch`, `repo`, `runner`): a product of three repositories has three main checkouts, named after their repositories. A project lists its repositories in `repos` when there are several, and its runners in `runners` when its apps come from several, in which case it has no `prefix` and the UI acts on it with one target per runner. All new fields are optional: an older agent's snapshot shows as before.
- **The Apps view is one column of projects.** Each project folds, and inside it each checkout (the main one first, then each worktree with its branch and folder) folds too. A linked worktree with nothing running or failing starts folded. Rows line up under their project, and their secondary actions show on hover, while start or stop and the menu always show. The keyboard skips folded rows. The table layout stays.
- **Each project has a page** (`#/project/<machine>/<name>`): its checkouts and apps, its actions, its folder, and links to the `dekit.yaml` files that declare it.
- **The sidebar** has Apps, Health and Machines, then **dekit** (Configuration, Runners) and **portless** (Routes, Proxy & HTTPS, Sharing, Doctor), then **Projects** with a state dot and a running count each, last because it is the long list; Settings and the setup progress sit at the foot. Groups fold. portless's eleven sections become four pages with tabs. Each tool page names its tool in the toolbar ("portless / Routes").
- **The view sits in a rounded panel beside the sidebar, with a toolbar along its top.** `ViewHeader` renders a view's title, a short summary and its actions into the toolbar through a portal, and its description at the top of the page. The panel scrolls, the window does not. Hiding the sidebar hides it completely, and the toolbar shows the button to bring it back. Under 760 px a tab bar replaces the sidebar.
- **macOS window:** `NSWindowStyleMaskFullSizeContentView`, a transparent title bar and a hidden title (kept for the Window menu). Before the page loads, the window sets `data-window="mac"` on `<html>`, plus `--titlebar-h` and `--traffic-w` measured from the window (the title bar's height, and the zoom button's right edge plus 12 pt). It updates `data-fullscreen` and `data-active` (key window) as they change. The sidebar leaves that strip for the traffic lights. A mouse-down on an element inside `[data-drag-region]` that is not a control posts `"drag"` to the `portplane` message handler, and the window calls `performWindowDragWithEvent:` with the mouse-down it kept from a local event monitor. A double-click posts `"zoom"`, which does what `AppleActionOnDoubleClick` says (zoom, minimise or nothing). No toolbar: the top strip stays clickable. Linux and Windows keep their system frames.
- **First run:** the app opens on Apps, with **Get started** at the top: four steps (install dekit and portless, turn on HTTPS, add your projects, start your first app), each read from the live snapshot so steps done from a terminal tick too. Each step leads into the guided setup at the right place, and the guided setup returns to the app. Get started hides itself when all four are done, or when the user hides it (Settings › General brings it back).

**Cost we accept:**

- One project can mean actions over several runners, sent as one request per runner.
- Someone who split one repository's tasks into several task folders on purpose now sees one project; the table still tells the apps apart.
- A task folder that mixes unrelated repositories becomes one project with all of them.
- About 80 more lines of Objective-C that only the macOS runner compiles and only a person can check: the drag, the zoom, the traffic lights' corner in full screen and with the sidebar hidden.
- The page, not AppKit, decides what drags the window: a new control in the toolbar that is not a button, link or field needs `data-no-drag`.
- The traffic lights keep their default position (the top 28 pt or so), not centred in the 52 pt toolbar.

**What would make us revisit it:** monorepos where one repository holds unrelated projects that people want apart, or task folders that group repositories people think of as separate; a WKWebView that supports app regions; macOS changes that move or hide the traffic lights in a way the measured variables do not cover; Linux or Windows users asking for the same frameless window.
