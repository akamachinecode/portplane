# ADR-0028: Organise the app by objects and how often they are used: the work in the sidebar, the tools in Settings

- **Status:** Accepted
- **Date:** 2026-11-12
- **Builds on:** [ADR-0027](0027-projects-first-layout.md) (projects first, the inset panel, the macOS window), [ADR-0024](0024-app-shell.md) (router, palette, drawer, jobs). It replaces ADR-0027's sidebar groups for dekit and portless, its "Get started" checklist on Apps, and the full-window guided setup.

## What it has to do

A week of daily use of the M5.7 layout brought these complaints:

- **Nothing says where a feature lives.** The sidebar had Apps, Health and Machines, then dekit (Configuration, Runners), then portless (Routes, Proxy & HTTPS, Sharing, Doctor), with 14 tabs behind them. The same thing had several homes: starting a runner from 4 places through 2 APIs, renaming an address from 3, sharing from 3, folder setup from 7, and the dependencies of an app 3 times in one panel.
- **dekit's Configuration and Runners showed the same objects twice.** A runner is dekit's supervisor for one folder with a `dekit.yaml`; Configuration listed those folders on the left and Runners listed them again, with dekit's version card on top.
- **Routes looked broken.** It showed only portless's live routes (two, with two apps running), cached from when the page first opened, while Apps showed every app's address. Aliases sat on another tab, and the URL tab of an app linked to neither.
- **The proxy read "stopped" while it ran.** Its status was read once when Portplane started and never again; portless doctor, run fresh, said it answered on port 443.
- **Health was empty when all was well,** so it never said what it checks.
- **Setup was a separate mode.** The first run hid the app behind a ten-step full-window wizard; afterwards its record was gone.

Facts:

- Portplane is used in two ways: every day, to see and drive apps (start, stop, open, read the output, find an address), and now and then, to set up or fix the tools under them (the proxy, certificates, runners, sharing providers).
- The objects are: **app** (a dev server), **project** (repositories and their checkouts), **address** (a `.localhost` name and where it sends requests), **machine**, **runner** (one per `dekit.yaml` folder), **proxy**, **certificate**, **share**, **problem** and **setup step**.
- Linear separates the same two ways of working: its sidebar lists what you work on (inbox, issues, projects, teams), and Settings replaces the sidebar with its own, grouped by account, workspace and features. Every object has one page; lists link to it.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| One home per object; every other place is a link to it | High | The duplicates above |
| Daily work one click away; configuration two | High | How often each is used |
| Every dekit and portless feature still reachable without a terminal | High | M5's promise (roadmap criterion 2) |
| Old links keep working | Medium | The tray, notifications and bookmarks use hash routes |
| Reuse what M5 built | Medium | One maintainer |

## Options

| | Keep ADR-0027 and trim tabs | Group by tool (a dekit app and a portless app) | Objects in the sidebar, tools in Settings |
|---|---|---|---|
| Where is "the address of my app"? | Routes or the app's URL tab | portless | Addresses, and the app's Address tab |
| Where is the runner's `dekit.yaml`? | Configuration or Runners | dekit | Settings › dekit › Runners, and the project's Configuration tab |
| Sidebar entries | 11 + projects | 2 + projects | 3 + projects |
| Feels like the apps people compare it to | No | No | Yes (Linear, Raycast) |

## Verdict

**The sidebar holds the work, Settings holds the tools.** The method: list the objects and what people do with each, rank the tasks by how often they happen, then give each object one page and put the frequent ones in the sidebar.

```
Sidebar (the work)
├── Set up Portplane · 3 of 4      while something is left; then "Setup" at the foot
├── Apps                            every app by project and checkout · the app drawer
│                                     (Summary · Output · Config · Address)
├── Addresses                       every .localhost name: apps (running or not),
│                                     aliases, Compose, Portplane; filters; New alias
├── Health                          problems with their fix, then every check
│                                     (tools, HTTPS, runners, apps, portless doctor, machines)
├── Projects
│   └── <project>                   icon · checkouts · actions · tabs Apps | Configuration
├── Setup                           the timeline of every setup step and what it found
└── Settings                        swaps the sidebar for its own:
    ├── Portplane   General · Notifications · Folders · Machines · Updates · Advanced
    ├── dekit       Runners (› a dekit.yaml: Tasks · Settings · YAML) · About dekit
    └── portless    Proxy (+ hosts file) · Certificates · Sharing (tailnet and public ·
                    local network) · portless.json · About portless
```

- **Addresses** joins Routes, Aliases and Compose. Each row is a name, the port it sends to, where it comes from (an app, an alias, Compose, a terminal, Portplane, another machine) and its state (live, starting, off, stale). Stopped apps keep their row: their name is reserved for them. A stale route shows as a notice with "Clean up". The routes and the proxy's status are read again whenever the snapshot says the proxy or an app's address changed, when the window comes to the front, and every 30 seconds.
- **Health is a board, never empty.** "Needs attention" lists the problems, each with its fix; below, every check of this computer grouped as Tools, HTTPS and addresses, Portplane, and Runners and apps (from the guided setup's check and the snapshot), then portless doctor's findings, then the other machines. The Doctor page goes away.
- **Setup is a page, not a mode.** The guided setup runs inside the window, with the sidebar, as a timeline: each step says in one line what it found (versions, the proxy's port, the folders, how many apps), read from the live check and snapshot, so work done in a terminal counts; the open step does its work in place. The first run opens it and checks the computer at once. It sits at the top of the sidebar until everything is done, then at the foot as a record.
- **Runners is the list of `dekit.yaml` folders;** opening one edits it. A project's own tasks are also on the project's Configuration tab, with Add an app and Run a command. dekit's version card moves to About dekit, and the bulk actions (clean stale records, upgrade every runner) to a menu.
- **The proxy explains itself** on its page: the browser asks for `https://web.localhost`, the proxy answers on one fixed port with the trusted certificate, and passes the request to the app's current port.
- **Names:** one per concept. Address (not route, URL or domain in the UI), Setup (not onboarding, guided setup or Get started), Runner, Project.
- **Old links** open the page that took their place: `#/domains/routes|aliases|compose` → Addresses, `#/domains/doctor` → Health, `#/settings/tools` → About dekit, `#/settings/network` → Advanced.

**Cost we accept:**

- Configuring the proxy, a certificate or a runner takes one more click (Settings, then the page) than in M5.7.
- People who learned M5.7's sidebar relearn it; the palette finds every page by its old name too.
- Health runs the setup check and portless doctor when it opens: a few seconds of work in the background each time.
- The Addresses list depends on two sources (portless's routes and the snapshot) that can disagree for a moment, until the next read.

**What would make us revisit it:** people opening Settings every day for the same page (it belongs in the sidebar), or asking for a per-tool view again; a machine with hundreds of addresses, where one list needs grouping.
