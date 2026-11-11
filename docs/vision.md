# Vision

> **Portplane**: every dev server, on every machine, in one window.

The binary is `portplane`. It started under the working name "Localhost Control Plane".

## The problem

A developer working on several projects at once runs many dev servers: a website, an admin, an API, a CMS studio, a video editor. Monorepos have several apps each, and git worktrees duplicate them. Every server picks a port on its own or has one hard-coded in a script.

That breaks down in predictable ways:

- **Ports collide.** "Start everything" fails because two apps want `3000`, or two installs race each other.
- **Ports move.** Stop a few servers, start others, start the first ones again, and they come back on different ports. Bookmarks and browser tab groups stop working, so you hunt for `localhost:51xx` every time you want to look at a change.
- **Nothing shows the whole picture.** To know what is running and where, you read terminal output, process-manager screens or `lsof`. That is slow exactly when you are switching quickly between projects, reviewing changes and writing prompts.
- **Several machines make it worse.** A laptop and a Linux workstation (often joined by Tailscale) each run their own servers. From the laptop you cannot see what runs on the workstation, and its `*.localhost` URLs do not resolve.

Good tools already solve parts of this:

- A process manager such as [dekit](https://dekit.run) starts, stops and supervises the servers.
- [portless](https://github.com/vercel-labs/portless) gives each one a stable `https://<name>.localhost` URL, whatever port it lands on.

Wiring them together by hand works, but the setup is fiddly. The prototype in this repo needed a dozen non-obvious fixes ([field notes](field-notes.md)). And once it is wired, you still cannot *see* it.

## The idea

A small desktop app that sits on top of the tools you already use.

- **See.** Every dev server, across all your project folders and machines, shows:
  - its state: on, starting, failed or off;
  - its stable URL and the port behind it;
  - the project and worktree it belongs to.

  Ports open outside those tools also appear, so nothing is hidden.
- **Act.** Start, stop or restart an app or a whole project. Open a server with one click, or open everything a project has running.
- **Set up.** Pick one or more folders. The app finds the projects and their dev servers and proposes a stable URL for each. With your confirmation, it writes the dekit and portless configuration using field-tested defaults.
- **Reach.** Add another machine over SSH, Tailscale included. Its servers appear next to your local ones, and clicking one opens it through the SSH connection.

No terminal output, no logs on screen by default. The point is to see the state of things at a glance.

## How it fits with dekit and portless

| Piece | Owns | Portplane's part |
|---|---|---|
| dekit | Running and supervising processes, dependencies between tasks, restart policy | Generates its config, calls its CLI, reads `dekit ls --json` |
| portless | Stable `.localhost` URLs, the local HTTPS proxy, the trusted CA, port assignment | Wraps commands with `portless <name>`, reads its routes, registers aliases |
| Portplane | Discovering projects, the combined view, remote machines, onboarding | Itself |

Rules that follow from this:

- **No forks.** Portplane uses released versions of both tools. When it needs something they lack, such as a stable JSON output, the change goes upstream.
- **No lock-in.** The config it writes is plain dekit config that you can read, edit and keep using without the app.
- **Degrades gracefully.** Without dekit or portless, the app still shows a read-only view of the ports open on each machine and the folder each one is serving.

## Who it is for

- Developers juggling several local projects or monorepos, on one or more machines.
- Coding agents, which also start dev servers. The app should make it easy for an agent to find the right URL without starting a second copy.

## Core flows

1. **First run.** Choose folders, then check what is installed:
   - **dekit or portless missing:** the app explains why each one helps and how to install it. You can also keep the read-only mode.
   - **Both present:** the app scans the folders and proposes apps and URLs. You confirm and it writes the config. The main view appears with everything off and every URL already known, so you can bookmark them.
2. **Daily use.** Open the app or its menu-bar/tray icon, see what is on, click to open, start or stop what you need.
3. **Add a machine.** Pick a host from `~/.ssh/config` or your Tailscale peers. The app tests the connection, installs its small agent and asks which folders to watch there. From then on, the machine is a section of the same view.
4. **Things change.** New worktrees and new apps show up without editing anything by hand. The app re-scans, shows what changed and asks before changing the config.

## Principles

1. **Work with the user's tools, do not replace them.** Portplane never runs servers itself and never forks dekit or portless.
2. **Zero configuration for the common case.** Every guess (command, folder, URL) is visible and editable, and nothing is written without confirmation.
3. **Local-first, nothing central.** No accounts, no relay, no cloud service, zero telemetry.
4. **One binary per OS.** The same binary is the desktop app and the remote agent.
5. **Safe by default.**
   - No network listener on the machine.
   - Remote machines are reached only over SSH, with the user's existing keys and config.
   - Actions on another machine need the same rights you have when you SSH into it.
6. **Cross-platform.** macOS, Linux and Windows. No mobile app: a phone has no localhost.
7. **A well-run open-source project.** Every technical decision is an ADR, with clear versions, Conventional Commits and signed releases.

## Non-goals

- **Being a process manager, a proxy or a tunnel product.** That is dekit, portless and SSH.
- **A terminal or log viewer.** At most, a short excerpt of the error when a server fails.
- **A hosted relay or "connect" service.** Remote access is SSH only.
- **Production monitoring or container orchestration.** Docker-published ports may be *shown* later.
- **Mobile apps.**

## Milestones (proposed)

| Milestone | Scope |
|---|---|
| M0: Design | Vision, field notes, open questions resolved into ADRs (this phase) |
| M1: Local view | Binary with embedded UI. Local collector for macOS, Linux and Windows (ports, process folder). dekit and portless adapters. Multiple folders. Start, stop, restart and open |
| M2: Setup | Project scanner (JS/TS workspaces and common frameworks first). Config generation with the field-note defaults. Re-scan and diff for new worktrees and apps |
| M3: Remote | Same binary as agent over SSH. Add a machine from `~/.ssh/config` or Tailscale peers. Remote servers open through the SSH connection |
| M4: Desktop | Native window and tray or menu-bar icon. Start at login. Signed packages for each OS |
