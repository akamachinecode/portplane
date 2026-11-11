# Open questions

Decisions that are still pending, plus a short list of the ones already resolved. Each pending one becomes an ADR in [adr/](adr/README.md) once it is resolved, evaluated from first principles. Each entry carries a *starting proposal* to argue with, not a decision.

## Resolved

- **P1, name:** Portplane, binary `portplane`. Chosen on 2026-11-11 after checking npm, GitHub, Homebrew and the `.com`, `.dev`, `.sh`, `.app` and `.io` domains, all free at the time.
- **R1, license:** Apache-2.0, see [ADR-0001](adr/0001-license.md).
- **P2, generated config:** a `.portplane/tasks.yaml` fragment loaded from `dekit.yaml`, see [ADR-0009](adr/0009-generated-config-location.md).
- **P4, logs:** the last lines of a failed app with a copy button, see [ADR-0011](adr/0011-failures-not-logs.md); since M5, any app's output on demand in an Output panel, see [ADR-0021](adr/0021-task-output.md).
- **A1, language:** Go, see [ADR-0002](adr/0002-language-go.md).
- **A2, UI:** React + Vite embedded in the binary, see [ADR-0003](adr/0003-ui-react-vite.md).
- **A3, desktop shell:** browser UI plus a tray icon, no embedded web view in v1, see [ADR-0004](adr/0004-desktop-shell.md) and [ADR-0008](adr/0008-local-api-security.md).
- **A6, adapters:** runner and router interfaces; Portplane parses `dekit.yaml` itself, see [ADR-0005](adr/0005-every-machine-is-an-agent.md) and [ADR-0006](adr/0006-adapters.md).
- **A7, portless state:** read `routes.json` behind the adapter, see [ADR-0007](adr/0007-portless-state.md).
- **A8, cross-platform commands:** shell-free arrays and `portplane port-exec`, see [ADR-0010](adr/0010-cross-platform-commands.md).
- **R2, signing:** cosign-signed checksums, no Apple notarization or Windows code signing for v1, see [ADR-0012](adr/0012-tooling-and-releases.md).
- **R3, Windows:** beta until someone uses it daily, see [ADR-0013](adr/0013-windows-support-level.md).
- **R4, repo conventions:** mise, release-please, goreleaser, see [ADR-0012](adr/0012-tooling-and-releases.md).
- **P3, scanner scope:** JavaScript workspaces and the common frameworks first, see [ADR-0014](adr/0014-setup-scope.md).
- **P5, installing dependencies:** first guide-only ([ADR-0014](adr/0014-setup-scope.md)); since M5, Portplane installs dekit, portless and, when needed, a private Node 24 without privileges, see [ADR-0019](adr/0019-install-tools.md), and runs the privileged portless steps on a click through the system's password dialog, see [ADR-0020](adr/0020-privileged-steps.md).
- **A4, remote transport:** system ssh, an uploaded agent and yamux over stdio, see [ADR-0015](adr/0015-remote-transport.md).
- **A5, remote URLs:** an HTTP proxy per remote app with a portless alias `<app>.<machine>`, see [ADR-0016](adr/0016-remote-urls.md).
- **M5 decisions:** editing dekit config ([ADR-0022](adr/0022-edit-dekit-config.md)), talking to portless ([ADR-0023](adr/0023-portless-cli.md)), the app shell ([ADR-0024](adr/0024-app-shell.md)) and network use ([ADR-0025](adr/0025-network-use.md)).

## Product

| # | Question | Starting proposal | Blocks |
|---|---|---|---|
| P6 | **Agents.** Expose an MCP server ("list servers", "URL of X", "start X") like Exhale does? portless already has `portless mcp` | Yes, as a small later milestone: it is the cleanest fix for agents starting duplicate servers | After M3 |
| P7 | **Docker.** Show ports published by `docker ps` / Compose | Read-only, later | After M3 |

## Spikes before M5 code

Questions the M5 ADRs leave to a spike. An answer that changes a decision becomes a new ADR.

| # | Question | Blocks |
|---|---|---|
| S1 | **Browser trust.** Which browsers ignore the system's trust store, per OS and per packaging (snap, flatpak), and does a per-profile NSS entry fix each one? ([ADR-0020](adr/0020-privileged-steps.md)) | M5.1 |
| S2 | **Windows elevation.** How the environment reaches portless and how its output comes back through UAC ([ADR-0020](adr/0020-privileged-steps.md)) | M5.1 on Windows |
| S3 | **Root-owned binaries.** Should privileged steps run a root-owned copy of Node and portless, instead of the user's? Part of the security review ([ADR-0020](adr/0020-privileged-steps.md)) | M5.1 |
| S4 | **YAML round trip.** What yaml.v3 changes outside the edited task on real `dekit.yaml` files, and whether flow lists can be edited safely ([ADR-0022](adr/0022-edit-dekit-config.md)) | M5.3 |
| S5 | **Reload review.** Whether `dekit reload --json` has a format we can rely on ([ADR-0022](adr/0022-edit-dekit-config.md)) | M5.3 |

## Waiting on upstream

Requests drafted in [upstream.md](upstream.md). Portplane works without them; each one replaces a workaround.

| # | Ask | Workaround meanwhile | Unblocks |
|---|---|---|---|
| U1 | **portless:** `--json` for `list`, `doctor` and `service status` | Routes from `routes.json` ([ADR-0007](adr/0007-portless-state.md)); `doctor` and `service status` text parsed with fixtures per version, raw text when parsing fails ([ADR-0023](adr/0023-portless-cli.md)) | Dropping the text parsers |
| U2 | **dekit:** the attach RPC published as stable | Output phase 1 shows `dekit screen --json` once a second while the panel is open ([ADR-0021](adr/0021-task-output.md)) | Output phase 2: an interactive terminal |
