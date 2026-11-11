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
| [0004](0004-desktop-shell.md) | Serve the UI in the browser and add a tray icon; no embedded web view in v1 | Accepted; the window on macOS superseded by 0017 |
| [0005](0005-every-machine-is-an-agent.md) | Treat the local machine as an agent running in-process | Accepted |
| [0006](0006-adapters.md) | Read dekit and portless through adapters, and parse dekit config ourselves | Accepted |
| [0007](0007-portless-state.md) | Read portless routes from its state directory, behind the router adapter | Accepted |
| [0008](0008-local-api-security.md) | Protect the loopback API with a Host allowlist and a per-run token | Accepted |
| [0009](0009-generated-config-location.md) | Write generated tasks to a `.portplane/tasks.yaml` fragment loaded from `dekit.yaml` | Accepted |
| [0010](0010-cross-platform-commands.md) | Generate shell-free commands, with a `portplane port-exec` wrapper for tools that ignore `PORT` | Accepted |
| [0011](0011-failures-not-logs.md) | Show the last lines of a failed app, never a log view | Accepted |
| [0012](0012-tooling-and-releases.md) | mise, release-please, goreleaser and cosign; no OS code signing for v1 | Accepted |
| [0013](0013-windows-support-level.md) | Windows is beta until someone uses it daily | Accepted |
| [0014](0014-setup-scope.md) | Setup understands JavaScript workspaces in v1 and guides installs without running them | Accepted |
| [0015](0015-remote-transport.md) | Reach other machines with the system ssh and an uploaded agent speaking over stdio | Accepted |
| [0016](0016-remote-urls.md) | Open remote apps at `https://<app>.<machine>.localhost` through an HTTP proxy per app | Accepted |
| [0017](0017-native-window-macos.md) | Show the UI in a native window on macOS; keep the browser window elsewhere | Accepted |

Pending decisions are tracked in [../open-questions.md](../open-questions.md).
