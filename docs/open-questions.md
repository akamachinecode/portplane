# Open questions

Decisions that are still pending, plus a short list of the ones already resolved. Each pending one becomes an ADR in [adr/](adr/README.md) once it is resolved, evaluated from first principles. Each entry carries a *starting proposal* to argue with, not a decision.

## Resolved

- **P1, name:** Portplane, binary `portplane`. Chosen on 2026-11-11 after checking npm, GitHub, Homebrew and the `.com`, `.dev`, `.sh`, `.app` and `.io` domains, all free at the time.
- **R1, license:** Apache-2.0, see [ADR-0001](adr/0001-license.md).
- **P2, generated config:** a `.portplane/tasks.yaml` fragment loaded from `dekit.yaml`, see [ADR-0009](adr/0009-generated-config-location.md).
- **P4, logs:** no log view; the last lines of a failed app with a copy button, see [ADR-0011](adr/0011-failures-not-logs.md).
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
- **P5, installing dependencies:** guide with exact commands, never install or run privileged steps, see [ADR-0014](adr/0014-setup-scope.md).
- **A4, remote transport:** system ssh, an uploaded agent and yamux over stdio, see [ADR-0015](adr/0015-remote-transport.md).
- **A5, remote URLs:** an HTTP proxy per remote app with a portless alias `<app>.<machine>`, see [ADR-0016](adr/0016-remote-urls.md).

## Product

| # | Question | Starting proposal | Blocks |
|---|---|---|---|
| P6 | **Agents.** Expose an MCP server ("list servers", "URL of X", "start X") like Exhale does? portless already has `portless mcp` | Yes, as a small later milestone: it is the cleanest fix for agents starting duplicate servers | After M3 |
| P7 | **Docker.** Show ports published by `docker ps` / Compose | Read-only, later | After M3 |
