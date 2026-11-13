# Architecture Decision Records

Every significant technical decision is recorded here, so that anyone exploring or contributing to the project understands **why** it is built the way it is.

## How we decide

Every decision is evaluated from first principles, always with the same structure:

1. **What it physically has to do** in *this* app.
2. **Criteria** that actually matter here, and how much each one weighs.
3. **Options** compared against those criteria, with evidence: maintenance status, dependencies, measurements.
4. **Verdict**, the **cost we accept**, and **what would make us revisit it**.

Accepted ADRs are not rewritten. A decision that changes gets a new ADR that supersedes the old one.

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-license.md) | License the project under Apache-2.0 | Accepted |
| [0002](0002-language-go.md) | Write Portplane in Go | Accepted |
| [0003](0003-ui-react-vite.md) | Build the UI as a React + Vite SPA embedded in the binary | Accepted |
| [0004](0004-desktop-shell.md) | Serve the UI in the browser and add a tray icon; no embedded web view in v1 | Accepted; the window superseded by 0017 (macOS) and 0018 (Linux, Windows) |
| [0005](0005-every-machine-is-an-agent.md) | Treat the local machine as an agent running in-process | Accepted |
| [0006](0006-adapters.md) | Read dekit and portless through adapters, and parse dekit config ourselves | Accepted |
| [0007](0007-portless-state.md) | Read portless routes from its state directory, behind the router adapter | Accepted |
| [0008](0008-local-api-security.md) | Protect the loopback API with a Host allowlist and a per-run token | Accepted |
| [0009](0009-generated-config-location.md) | Write generated tasks to a `.portplane/tasks.yaml` fragment loaded from `dekit.yaml` | Accepted; amended by 0022 (editing hand-written config) |
| [0010](0010-cross-platform-commands.md) | Generate shell-free commands, with a `portplane port-exec` wrapper for tools that ignore `PORT` | Accepted |
| [0011](0011-failures-not-logs.md) | Show the last lines of a failed app, never a log view | Accepted; "never a log view" superseded by 0021 |
| [0012](0012-tooling-and-releases.md) | mise, release-please, goreleaser and cosign; no OS code signing for v1 | Accepted |
| [0013](0013-windows-support-level.md) | Windows is beta until someone uses it daily | Accepted |
| [0014](0014-setup-scope.md) | Setup understands JavaScript workspaces in v1 and guides installs without running them | Accepted; installing dependencies (P5) superseded by 0019 and 0020 |
| [0015](0015-remote-transport.md) | Reach other machines with the system ssh and an uploaded agent speaking over stdio | Accepted |
| [0016](0016-remote-urls.md) | Open remote apps at `https://<app>.<machine>.localhost` through an HTTP proxy per app | Accepted |
| [0017](0017-native-window-macos.md) | Show the UI in a native window on macOS; keep the browser window elsewhere | Accepted; the browser window on Linux and Windows superseded by 0018 |
| [0018](0018-native-window-linux-windows.md) | Show the UI in a native window on Linux (GTK 4 and WebKitGTK in a second binary) and Windows (WebView2) | Accepted |
| [0019](0019-install-tools.md) | Install dekit and portless from their official sources, and a private Node 24 when there is none, without privileges | Accepted |
| [0020](0020-privileged-steps.md) | Run privileged portless steps only on a click, through the system's password dialog, as argv | Accepted |
| [0021](0021-task-output.md) | Show a task's output on demand, in an Output panel | Accepted |
| [0022](0022-edit-dekit-config.md) | Edit dekit config from the UI, keeping the user's file as they wrote it | Accepted |
| [0023](0023-portless-cli.md) | Act on portless through its CLI, read its state files, and parse its text with versioned fixtures | Accepted |
| [0024](0024-app-shell.md) | Turn the UI into an app shell with a sidebar, a hash router and background jobs | Accepted; the layout superseded by 0027 |
| [0025](0025-network-use.md) | Use the network only for downloads the user starts and update checks the user asks for | Accepted; "it does not replace itself" superseded by 0031 |
| [0026](0026-remote-parity.md) | Serve setup, dekit and portless on every machine by tunnelling API requests to the agent | Accepted |
| [0027](0027-projects-first-layout.md) | Lay the app out around projects, with dekit and portless in the sidebar, and draw the macOS title bar ourselves | Accepted; the sidebar groups and first run superseded by 0028 |
| [0028](0028-information-architecture.md) | Organise the app by objects and how often they are used: the work in the sidebar, the tools in Settings | Accepted |
| [0029](0029-visual-system.md) | A quieter visual system: neutral greys, Portplane's green as the one colour, Inter and Geist Mono, more room | Accepted |
| [0030](0030-app-icons.md) | Give every app and project an icon: the user's choice, else its own favicon or logo, else its initials | Accepted |
| [0031](0031-self-update.md) | Portplane updates itself on a click, and asks once whether to check every day | Accepted |
| [0032](0032-calm-by-default.md) | Calm by default: every fact said once, colour only for state, details on demand, type that is easy to read | Accepted |

Pending decisions are tracked in [../open-questions.md](../open-questions.md).
