# Open questions

Decisions that are still pending, plus a short list of the ones already resolved. Each pending one becomes an ADR in [adr/](adr/README.md) once it is resolved, evaluated from first principles. Each entry carries a *starting proposal* to argue with, not a decision.

## Resolved

- **P1, name:** Portplane, binary `portplane`. Chosen on 2026-11-11 after checking npm, GitHub, Homebrew and the `.com`, `.dev`, `.sh`, `.app` and `.io` domains, all free at the time.
- **R1, license:** Apache-2.0, see [ADR-0001](adr/0001-license.md).

## Product

| # | Question | Starting proposal | Blocks |
|---|---|---|---|
| P2 | **Where generated config lives.** At the root of each chosen folder (`dekit.yaml`, so `dekit ls` keeps working there) or in the app's data directory | Root of the folder. The app owns one fragment (`.portplane/tasks.yaml`), and `dekit.yaml` only gets a `load:` line, so a hand-written `dekit.yaml` survives | M2 |
| P3 | **Which projects the scanner understands in v1** | JS/TS first: npm, pnpm, yarn and bun workspaces; Next, Vite, Astro, Remix/React Router, Nuxt, SvelteKit, Sanity and Remotion. Anything else can be added by hand (command + folder). Python, Ruby, PHP and Go detection later | M2 |
| P4 | **Logs.** The user wants no terminal output on screen | No log view. A failed server shows the last few error lines and a "copy" button | M1 |
| P5 | **Installing the dependencies.** Should the app install dekit, portless and Node 24, or guide the user | Guide: detect, explain, give the exact command per OS (one button where safe). Privileged steps (`portless service install`) are always shown, never run silently | M2 |
| P6 | **Agents.** Expose an MCP server ("list servers", "URL of X", "start X") like Exhale does? portless already has `portless mcp` | Yes, as a small later milestone: it is the cleanest fix for agents starting duplicate servers | After M3 |
| P7 | **Docker.** Show ports published by `docker ps` / Compose | Read-only, later | After M3 |

## Architecture

| # | Question | Starting proposal | Blocks |
|---|---|---|---|
| A1 | **Language** | Go, as in Exhale: one static binary per OS, cross-compiled with goreleaser, and `gopsutil` for ports and processes on all three OSes. Rust + Tauri is the alternative: smaller UI shell, but a second toolchain to maintain | M1 |
| A2 | **UI technology** | React + Vite SPA embedded in the binary, the same stack as Exhale, so components, tooling and lessons carry over | M1 |
| A3 | **Desktop shell.** (a) the binary serves the UI on `https://portplane.localhost` and adds a tray icon; (b) a native webview window (Wails v3 for Go) with a tray icon | Start with (a) to ship M1 fast. Move to (b) in M4 if Wails v3 is stable by then. (b) needs no HTTP listener, which also removes the CSRF and DNS-rebinding surface | M1 / M4 |
| A4 | **Remote transport** | The same binary runs as `agent --stdio` over the system `ssh` (honours `~/.ssh/config`, agents, ProxyJump, Tailscale SSH; works on Windows' OpenSSH). The app uploads the right agent build on first connect, as VS Code Remote and Zed do. JSON messages over stdin/stdout, with the agent pushing changes. The alternative is agentless (run `ss`/`lsof`/`dekit ls` per poll): simpler, but slower, and it needs ControlMaster, which Windows lacks | M3 |
| A5 | **Opening remote URLs.** A remote `https://x.localhost` does not resolve locally | The agent forwards TCP streams over the same SSH session. The app opens a local port and registers `portless alias <app>.<machine> <port>`, so a remote app gets `https://<app>.<machine>.localhost`. To check: the Host header the remote server expects (Vite `allowedHosts`, cookie domains) | M3 |
| A6 | **Adapters** | One interface per runner (dekit first; mprocs, overmind and Compose later) and per router (portless). The collector never imports adapters directly | M1 |
| A7 | **portless state** | Read `routes.json` for now, behind the adapter; propose `portless list --json` upstream | M1 |
| A8 | **Cross-platform commands** | Generated commands must not depend on `sh -c` (see field notes) | M2 |

## Project

| # | Question | Starting proposal | Blocks |
|---|---|---|---|
| R2 | **Signing.** macOS notarization needs an Apple Developer membership (USD 99/year); Windows SmartScreen warns on unsigned binaries | Decided direction for v1: no Apple notarization and no Windows code signing. Installers come from the landing page and GitHub Releases with cosign-signed checksums, and the docs explain the first-launch prompts. To record in ADR-0012 | M4 |
| R3 | **Windows support level** | CI builds and smoke tests from M1, labelled "beta" until someone uses it daily | M1 |
| R4 | **Repo conventions** | Same as Exhale: Conventional Commits, DCO sign-off, release-please, goreleaser, mise for tooling | M1 |
