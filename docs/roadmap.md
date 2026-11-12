# Roadmap to v1.0

Everything that stands between today (design phase, no code) and a v1.0 that people can install on macOS, Linux and Windows and use every day. It expands the milestones in [vision.md](vision.md) into concrete work. Each phase lists its exit criteria; a phase is done when they hold, not when its checklist is ticked.

## What v1.0 means

- **See, act, set up and reach** work as described in the vision: local and remote servers in one view, start/stop/restart/open, guided setup of dekit and portless, remote machines over SSH.
- **Installable:** installers for macOS, Linux and Windows (beta), downloaded from the landing page or GitHub Releases. Binaries are not code-signed by Apple or Microsoft; integrity comes from cosign-signed checksums, and the install docs explain the one-time Gatekeeper and SmartScreen prompts.
- **Safe:** the security model is written down and reviewed; nothing listens on the network; nothing privileged runs without being shown first.
- **Stable contracts:** the generated config, the app-agent protocol and the CLI follow semantic versioning from v1.0 on.
- **Dogfooded:** used daily on macOS and Linux for at least two weeks with no known data-loss or config-corruption bug.

Out of v1.0 (tracked for later): MCP server for agents (P6), Docker ports (P7), runners other than dekit, project detection beyond JS/TS.

## Phase 0: Publish the repo

- [x] Commit identity that keeps personal and employer details private (GitHub noreply address).
- [x] `LICENSE` (Apache-2.0) and ADR-0001 recording it, before the first public commit.
- [x] Community files: `CONTRIBUTING.md` (DCO sign-off, Conventional Commits, how ADRs work), `CODE_OF_CONDUCT.md`, `SECURITY.md` (private vulnerability reporting), issue and PR templates.
- [x] `.gitignore`, `.editorconfig`.
- [x] Create the public GitHub repo: description, topics, default branch protection (PR required, DCO check), private vulnerability reporting on.
- [x] GitHub milestones M1–M4 and v1.0.
- [ ] One issue per remaining item in this roadmap.

**Exit:** the repo is public, licensed, and a newcomer can tell from the README how to follow and contribute.

## Phase 1: Decide (closes M0)

Turn the open questions that shape the code into ADRs. Each one checks current facts (maintenance status, versions, platform support) instead of relying on the starting proposal.

| ADR | Decision | Resolves |
|---|---|---|
| 0001 | License: Apache-2.0 | R1 |
| 0002 | Language: Go | A1 |
| 0003 | UI: React + Vite SPA embedded in the binary | A2 |
| 0004 | Desktop shell: serve the UI first, native webview (Wails v3) in M4 if stable | A3 |
| 0005 | One model for every machine: the local machine is an agent running in-process, speaking the same messages as a remote agent | A4 (shape), M3 risk |
| 0006 | Adapter interfaces: runner (dekit) and router (portless); the collector never imports an adapter | A6 |
| 0007 | Reading portless state: `routes.json` behind the adapter, `portless list --json` proposed upstream | A7 |
| 0008 | Local API security: loopback only, Host check, per-session token, no CORS | A3, safety principle |
| 0009 | Where generated config lives: `.portplane/tasks.yaml` fragment plus a `load:` line | P2 |
| 0010 | Cross-platform commands: no `sh -c`; the binary ships a small wrapper for tools that ignore `PORT` | A8 |
| 0011 | Failures and logs: no log view, last error lines with a copy button | P4 |
| 0012 | Repo and release tooling: mise, release-please, goreleaser, cosign; no Apple notarization or Windows code signing for v1 | R4, R2 |
| 0013 | Windows support level | R3 |

All thirteen are accepted; see the [ADR index](adr/README.md). Facts checked along the way changed two starting proposals: dekit already offers `dekit screen --json` for a task's last lines, and Wails v3 would tie the Linux binary to WebKitGTK, so the desktop shell stays a browser UI with a tray icon.

Upstream, in parallel (drafts in [upstream.md](upstream.md)):

- [ ] dekit: resolved `cmd` and `cwd` in `dekit ls --json`, and a stable JSON contract.
- [ ] portless: propose `portless list --json`.

**Exit:** ADRs 0001–0013 accepted; upstream issues opened.

## Phase 2: Foundation

- [x] `mise.toml` pinning Go, Node and pnpm.
- [x] Layout: `cmd/portplane`, `internal/{model,agent,collector,adapters/dekit,adapters/portless,api,setup}`, `web/`.
- [x] The repo's own `dekit.yaml`, so contributors run the UI dev server and the app through dekit and portless (dogfooding).
- [x] CI on macOS, Linux and Windows: Go lint and tests, web typecheck, lint and tests, DCO and Conventional Commit checks.
- [x] Release pipeline dry run: release-please PRs, goreleaser snapshot builds for all targets, cosign-signed checksums.

**Exit:** a tagged pre-release (`v0.1.0`) produces signed binaries for every target that print their version.

## Phase 3: M1, local view

Model and collection:

- [x] Domain model: machine → project → worktree → app → server, with states on, starting, failed, off and unknown, and the source of each fact (dekit, portless, OS).
- [x] OS collector on all three platforms: listening ports, owning PID, process working directory. Spike first on Windows working-directory support.
- [x] Project mapping: working directory → nearest `.git`; worktrees from `git worktree list --porcelain`.
- [x] dekit adapter: find configs in the chosen folders, read `dekit ls --json`, start, stop and restart by task or project, detect a stopped runner and offer `dekit up`.
- [x] portless adapter: URL per app, internal port, aliases.
- [x] State reconciliation: "on" needs both a live task and a listening port; "starting" shows the current step; "failed" shows the last error lines.
- [x] Change detection: polling (2 s while the UI is open, 15 s otherwise) with config re-read on change; updates pushed to the UI over server-sent events.

App and UI:

- [x] Single-instance lock; settings in the OS app-data directory; multiple folders.
- [x] Local API per ADR-0008, reachable at `https://portplane.localhost` through a portless alias.
- [x] Main view: grouped and ordered by activity, state at a glance, URL and port, project and worktree.
- [x] Actions: open, open everything running in a project, start, stop and restart per app and per project, stop all (project by project), copy URL, reveal folder.
- [x] "Other ports" section for servers not started by dekit.
- [x] Read-only mode when dekit or portless is missing.
- [x] Empty, loading and error states; keyboard navigation; light and dark themes.

Quality:

- [x] Unit tests on recorded fixtures (`dekit ls --json`, `routes.json`, `lsof` and `/proc` samples).
- [x] Integration test in CI on Linux: real dekit, a dummy server, assert the state transitions (`scripts/integration.sh`).

**Exit:** feature parity with `prototype/` on macOS and Linux, plus multiple folders and Windows beta. The prototype is no longer needed day to day.

## Phase 4: M2, setup

- [x] Dependency check with an explanation and the exact install command per OS; privileged steps (`portless service install`) shown, never run silently.
- [x] Scanner: npm, pnpm, yarn and bun workspaces; Next, Vite, Astro, React Router, Nuxt, SvelteKit, Sanity, Remotion; dev script and hard-coded port detection.
- [x] Naming: `<app>.<worktree>.<project>.localhost`, with the main web app at `<worktree>.<project>.localhost`; names editable (in the fragment, kept across scans, or as overrides in the API).
- [x] Generator applying the field-note defaults: run from the app folder, `<pm> run <script>`, a single install job per checkout, agent variables unset, the cross-platform wrapper from ADR-0010. (`portless alias` jobs for servers that cannot be wrapped are recognised when written by hand.)
- [x] Preview as a diff, write only after confirmation (digest-checked), never touch hand-written config.
- [x] Re-scan: new apps and worktrees appear as a proposed diff.
- [ ] Add an app by hand from the UI (command and folder); after v1 (ADR-0014). A hand-written task in `dekit.yaml` works today.
- [x] Warnings the app cannot fix: parent cookie domain, CORS allowlists.

**Exit:** on a fresh machine with Node, the setup flow takes a real monorepo with worktrees from nothing to every app reachable at its stable URL, with no hand edits.

## Phase 5: M3, remote machines

- [x] `portplane agent --stdio`: versioned JSON-lines protocol with a handshake and capability negotiation (the same messages as the in-process agent from ADR-0005).
- [x] Agent install: detect the remote OS and architecture, upload the matching build to a versioned cache directory, verify its checksum, replace it on upgrade.
- [x] Add a machine from `~/.ssh/config` or `tailscale status --json`; test the connection; choose folders on that machine.
- [x] Port forwarding over the same SSH session, with `https://<app>.<machine>.localhost` registered as a portless alias. Verify Host-header behaviour (Vite `allowedHosts`, cookie domains).
- [x] Reconnect with backoff, offline state per machine, actions with the remote user's rights only.
- [x] End-to-end test over a real SSH server (`internal/remote/realssh_test.go`, run with a throwaway sshd); CI covers the protocol with in-memory pipes.

**Exit:** a Linux workstation's servers appear in the macOS app, start and stop from it, and open at their `.<machine>.localhost` URLs, surviving a network drop.

## Phase 6: M4, desktop

- [x] Open the UI as an app-mode browser window where a Chromium-based browser exists (ADR-0004).
- [x] On macOS, a native window instead, with a Dock icon and menus while it is open (ADR-0017).
- [x] On Linux, a native GTK 4 window with WebKitGTK loaded at run time, in a second binary so `portplane` stays static; on Windows, a WebView2 window (ADR-0018). The browser stays the fallback.
- [x] Tray or menu-bar icon: count of running servers, open the window, quick start and stop.
- [x] Start at login on each OS.
- [x] Installers on GitHub Releases: macOS `.dmg` (unsigned), Linux `.tar.gz`, `.deb` and `.rpm`, Windows `.zip` or `.msi`, all with cosign-signed checksums.
- [x] A one-line install script per OS that verifies the checksum, plus our own Homebrew tap (needs a `homebrew-tap` repository and a token; not set up yet).
- [ ] Update notice: none in v1 (no network calls; see docs/security.md). Revisit after v1.

**Exit:** a user installs from the landing page or GitHub Releases, the app starts at login, and the tray reflects the real state.

## Phase 7: v1.0 release

- [ ] Namespaces claimed for `portplane`: domain, npm, Homebrew tap, winget.
- [x] Landing page (GitHub Pages) with the pitch, screenshots and a download button that picks the right installer for the visitor's OS.
- [x] Documentation: install per OS (including how to get past Gatekeeper and SmartScreen for an unsigned app), first run, the `portless service install` step and CA trust, troubleshooting, FAQ, security model.
- [ ] Security review: local API, agent upload and execution, command generation (injection, quoting), file paths.
- [ ] Budgets met: idle CPU under 1 %, memory under 100 MB, a state change visible in under a second locally.
- [ ] Accessibility pass on the main view and setup flow.
- [ ] Compatibility policy: semver for the CLI, the generated config format and the agent protocol.
- [ ] Dogfooding period (see "What v1.0 means"), then release notes and announcement.

## After v1.0

- MCP server so coding agents find running servers instead of starting duplicates (P6).
- Docker and Compose ports, read-only (P7).
- More runners (mprocs, overmind, Compose) and routers through the adapter interfaces.
- Project detection for Python, Ruby, PHP and Go.
